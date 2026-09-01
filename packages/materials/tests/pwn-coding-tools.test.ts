import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlStore } from "../src/control/control-store.js";
import { ArtifactStore } from "../src/effects/artifact-store.js";
import { createServices, demoTask } from "../src/app/demo.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";
import { SessionRegistry } from "../src/container/session-registry.js";
import { PwnReproducer } from "../src/verification/pwn-reproducer.js";
import { PwnReproductionVerifier } from "../src/verification/pwn-reproduction-verifier.js";
import { PwnReplayRecoveryAdapter } from "../src/verification/pwn-replay-recovery.js";
import { VerificationRecoveryService } from "../src/recovery/verification-recovery.js";
import { beginVerificationRequest } from "../src/verification/verification-key.js";
import { canonicalJson, sha256 } from "../src/domain/utils.js";
import { PwnToolHandler } from "../src/pwn/pwn-tools.js";
import { CodingClaimVerifier } from "../src/verification/claim-verification.js";
import { createPwnCodingTools } from "../src/runtime/pwn-coding-tools.js";
import { codingActiveToolNames, CODING_PWN_TOOL_NAMES } from "../src/runtime/coding-resources.js";
import type { CodingResourceContext } from "../src/runtime/coding-resources.js";
import type { ProofBladeConfig } from "../src/config.js";
import type { ContainerRef, ContainerRuntimePort, ContainerSessionHandle, ContainerSessionResult } from "../src/container/contracts.js";

const REPRODUCTION_POLICY = {
  target: { kind: "remote" as const, command: ["tube"], endpoint: "1.2.3.4:1337" },
  flagPath: "/flag",
  flagPattern: "flag\\{[^}]+\\}",
};

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", model: "test-model",
      modelDiscoveryPath: "/models", apiKeyEnv: "TEST_API_KEY", contextWindow: 4096, maxTokens: 512,
      requestTimeoutMs: 1000, maxRetries: 0, input: ["text"],
    },
  },
};

const REF: ContainerRef = {
  runId: "PWN", generation: 1, containerId: "c1", name: "c1", profile: "pwn",
  image: "img", imageDigest: "sha256:x", workspaceHostPath: "/w", workspaceContainerPath: "/workspace", networkPolicy: "none",
};

class EchoTubeRuntime implements Partial<ContainerRuntimePort> {
  private pending = new Map<string, string>();
  private count = 0;
  public lastWriteBytes: Uint8Array | undefined;
  public constructor(private readonly flag: string, private readonly flagPath: string, private readonly exitOnWrite = false) {}
  public async openSession(ref: ContainerRef): Promise<ContainerSessionHandle> {
    const sessionId = `dxs-${++this.count}`;
    this.pending.set(sessionId, "");
    return { sessionId, ref };
  }
  public async sessionWrite(handle: ContainerSessionHandle, data: string | Uint8Array): Promise<ContainerSessionResult> {
    // Capture the exact bytes so a binary-payload test can assert nothing was
    // mangled by UTF-8 round-tripping.
    this.lastWriteBytes = typeof data === "string" ? new TextEncoder().encode(data) : Uint8Array.from(data);
    const text = String(data);
    const echo = /^echo (.+)\n$/.exec(text);
    const cat = /^cat '?([^'\n]+)'?\n$/.exec(text);
    const out = echo ? `${echo[1]}\n` : cat ? (cat[1]!.trim() === this.flagPath ? `${this.flag}\n` : "nope\n") : text;
    this.pending.set(handle.sessionId, (this.pending.get(handle.sessionId) ?? "") + out);
    return this.drain(handle.sessionId);
  }
  public async sessionRead(handle: ContainerSessionHandle): Promise<ContainerSessionResult> { return this.drain(handle.sessionId); }
  public async sessionSignal(): Promise<boolean> { return true; }
  public async closeSession(): Promise<{ exitCode: number | null }> { return { exitCode: 0 }; }
  private drain(sessionId: string): ContainerSessionResult {
    const buffered = this.pending.get(sessionId) ?? "";
    this.pending.set(sessionId, "");
    return { delta: buffered, waitReason: buffered ? "idle" : "timeout", exited: this.exitOnWrite, exitCode: this.exitOnWrite ? 0 : null, truncated: false };
  }
}

function toolByName(name: string) {
  const tool = createPwnCodingTools().find((item) => item.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool!;
}

function contextWith(handler?: PwnToolHandler): CodingResourceContext {
  return { pwnTools: handler } as unknown as CodingResourceContext;
}

test("pwn coding tools expose a stable, complete tool set", () => {
  const names = createPwnCodingTools().map((tool) => tool.name).sort();
  assert.deepEqual(names, [...CODING_PWN_TOOL_NAMES].sort());
});

test("pwn tools are active only when a container-backed handler is present", () => {
  const base = { tools: ["bash"], skills: [], mcpServers: [] };
  assert.equal(codingActiveToolNames(base).some((n) => n.startsWith("pwn_")), false);
  const enabled = codingActiveToolNames({ ...base, pwnEnabled: true, pwnReproductionEnabled: true });
  for (const name of CODING_PWN_TOOL_NAMES) assert.ok(enabled.includes(name), `expected ${name} active`);
  const withoutVerifier = codingActiveToolNames({ ...base, pwnEnabled: true });
  for (const name of CODING_PWN_TOOL_NAMES.filter((name) => name !== "pwn_reproduce")) assert.ok(withoutVerifier.includes(name), `expected ${name} active without verifier`);
  assert.equal(withoutVerifier.includes("pwn_reproduce"), false);
});

test("pwn tools fail closed with a clear message when no container is attached", async () => {
  // Coding tools signal failure by throwing; the harness adapts it to an error
  // result. A pwn tool without a container must not silently no-op.
  const open = toolByName("pwn_open");
  await assert.rejects(
    open.execute!("t1", { kind: "remote", command: ["tube"], endpoint: "1.2.3.4:1337" }, new AbortController().signal, () => {}, contextWith(undefined)),
    (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      assert.match(text, /no Docker-backed pwn container|unavailable/);
      assert.match(text, /not executed/);
      assert.match(text, /Next:/);
      return true;
    },
  );
});

test("pwn_open explains how to repair a missing remote endpoint", async () => {
  await assert.rejects(
    toolByName("pwn_open").execute!("t-endpoint", { kind: "remote", command: ["tube"] }, new AbortController().signal, () => {}, contextWith()),
    (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      assert.match(text, /Reason:.*endpoint/);
      assert.match(text, /not opened/);
      assert.match(text, /Next:.*task-scoped endpoint/);
      return true;
    },
  );
});

test("pwn_send base64 delivers exact binary bytes (0x00/0xff), not a mangled literal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-ct-bin-"));
  try {
    const runId = "PWN-CT-BIN";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await control.createRun(runId, demoTask(runId, root, config));
    const runtime = new EchoTubeRuntime("flag{x}", "/flag");
    const registry = new SessionRegistry(runId, runtime as unknown as ContainerRuntimePort, control);
    const handler = new PwnToolHandler(runId, registry, new PwnReproducer(control), () => REF, "main");
    const context = contextWith(handler);
    const opened = await toolByName("pwn_open").execute!("t1", { kind: "remote", command: ["tube"], endpoint: "1.2.3.4:1337" }, new AbortController().signal, () => {}, context);
    const sessionId = (opened.details as { sessionId: string }).sessionId;

    // 0x00 0xff 0x41 0x0a as base64 = "AP9BCg==". With line=true a trailing LF byte is appended.
    const payloadB64 = Buffer.from([0x00, 0xff, 0x41]).toString("base64");
    await toolByName("pwn_send").execute!("t2", { sessionId, data: payloadB64, encoding: "base64", line: true }, new AbortController().signal, () => {}, context);
    assert.deepEqual(Array.from(runtime.lastWriteBytes!), [0x00, 0xff, 0x41, 0x0a], "exact bytes + LF must reach stdin");

    // A malformed base64 payload is rejected, not silently shortened.
    await assert.rejects(
      toolByName("pwn_send").execute!("t3", { sessionId, data: "not base64!!", encoding: "base64" }, new AbortController().signal, () => {}, context),
      /base64/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pwn_signal rejects an unknown signal name at the schema boundary", () => {
  const signalTool = toolByName("pwn_signal");
  const schema = signalTool.parameters as { properties: { signal: { enum?: string[] } } };
  assert.ok(Array.isArray(schema.properties.signal.enum), "signal must be a fixed enum, not a free string");
  assert.ok(schema.properties.signal.enum!.includes("SIGINT"));
  assert.equal(schema.properties.signal.enum!.includes("SIGIN"), false, "a typo like SIGIN must not be a valid value");
});

test("pwn_open then pwn_send route through the real handler and durable registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-ct-"));
  try {
    const runId = "PWN-CT";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await control.createRun(runId, demoTask(runId, root, config));
    const runtime = new EchoTubeRuntime("flag{ct}", "/flag") as unknown as ContainerRuntimePort;
    const registry = new SessionRegistry(runId, runtime, control);
    const handler = new PwnToolHandler(runId, registry, new PwnReproducer(control), () => REF, "executor", undefined, REPRODUCTION_POLICY);
    const context = contextWith(handler);

    const opened = await toolByName("pwn_open").execute!("t1", { kind: "remote", command: ["tube"], endpoint: "1.2.3.4:1337" }, new AbortController().signal, () => {}, context);
    assert.equal(opened.isError, false);
    const sessionId = (opened.details as { sessionId: string }).sessionId;
    assert.ok(sessionId.startsWith("SES"));

    const sent = await toolByName("pwn_send").execute!("t2", { sessionId, data: "PING", line: true }, new AbortController().signal, () => {}, context);
    assert.equal(sent.isError, false);
    assert.match((sent.details as { viewport: string }).viewport, /PING/);

    assert.equal((await control.snapshot(runId)).sessions[sessionId]?.kind, "pwn-remote");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pwn_record_primitive persists a bounded hypothesis with provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-primitive-"));
  try {
    const runId = "PWN-PRIMITIVE";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await control.createRun(runId, { ...demoTask(runId, root, config), target_kind: "pwn", target: "LOCAL:chall" });
    const artifacts = new ArtifactStore(join(root, "runs"), control);
    const source = await artifacts.putText(runId, "checksec: no canary; input reaches printf", { filename: "recon.txt" });
    await control.dispatch(runId, {
      type: "evidence",
      evidence: { id: "EV-PWN-PRIMITIVE", kind: "observation", summary: "printf receives attacker-controlled input", source: { artifactId: source.id, generation: 0 }, confidence: 0.8, supports: [], refutes: [] },
      lane: "executor",
    });
    const registry = new SessionRegistry(runId, new EchoTubeRuntime("flag{x}", "/flag") as unknown as ContainerRuntimePort, control);
    const handler = new PwnToolHandler(runId, registry, new PwnReproducer(control), () => REF, "executor", undefined, undefined, undefined, artifacts, control);
    const result = await toolByName("pwn_record_primitive").execute!("t-primitive", {
      primitive: "format-string write to a GOT entry",
      confidence: 0.72,
      artifactIds: [source.id],
      evidenceIds: ["EV-PWN-PRIMITIVE"],
    }, new AbortController().signal, () => {}, contextWith(handler));
    const recordId = (result.details as { recordId: string }).recordId;
    const record = (await control.replay(runId)).domainRecords[recordId];
    assert.equal(record?.kind, "pwn_primitive");
    assert.equal(record?.confidence, 0.72);
    await assert.rejects(
      () => toolByName("pwn_record_primitive").execute!("t-primitive-bad", { primitive: "certain shell", confidence: 1, artifactIds: [source.id] }, new AbortController().signal, () => {}, contextWith(handler)),
      /confidence must be in \[0,1\)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pwn_reproduce routes to the barrier-gated verifier", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-ct-repro-"));
  try {
    const runId = "PWN-CT-REPRO";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await control.createRun(runId, { ...demoTask(runId, root, config), target_kind: "pwn", target: "REMOTE:tube" });
    const artifacts = new ArtifactStore(join(root, "runs"), control);
    const runtime = new EchoTubeRuntime("flag{ct-repro}", "/flag") as unknown as ContainerRuntimePort;
    const registry = new SessionRegistry(runId, runtime, control);
    const handler = new PwnToolHandler(runId, registry, new PwnReproducer(control), () => REF, "executor", undefined, REPRODUCTION_POLICY, undefined, artifacts, control);
    const result = await toolByName("pwn_reproduce").execute!("t1", {
      stages: [{ name: "trigger", send: "payload", line: true, expect: "payload" }],
    }, new AbortController().signal, () => {}, contextWith(handler));
    assert.equal(result.isError, false);
    assert.equal((result.details as { reproduced: boolean; flag?: string }).reproduced, true);
    assert.equal((result.details as { flag?: string }).flag, "flag{ct-repro}");
    const details = result.details as { domainRecordIds?: string[] };
    assert.ok(details.domainRecordIds && details.domainRecordIds.length >= 3);
    const snapshot = await control.replay(runId);
    assert.ok(Object.values(snapshot.domainRecords).some((record) => record.kind === "pwn_exploit_stage" && record.status === "passed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pwn replay recovery resumes only a PROPOSED replay and keeps STARTED fail-closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-replay-recovery-"));
  try {
    const runId = "PWN-REPLAY-RECOVERY";
    const services = createServices(root, config);
    const policy = REPRODUCTION_POLICY;
    const task = {
      ...demoTask(runId, root, config),
      target_kind: "pwn" as const,
      target: "REMOTE:tube",
      verification: { kind: "reproduction" as const, command: "proofblade-pwn-verifier-policy", required_reproductions: 1, pwn: policy },
      scope: { allowed_hosts: ["1.2.3.4"], allowed_ports: [1337], external_network: true, allowed_workspace: root },
    };
    await services.control.createRun(runId, task);
    const stages = [{ name: "trigger", send: "payload", line: true, expect: "payload" }];
    const policyHash = sha256(canonicalJson(policy));
    const request = await beginVerificationRequest(services.control, runId, { kind: "pwn", policyHash, recipeHash: sha256(canonicalJson({ stages })) });
    const prepared = await services.journal.prepareVerifierReplay(runId, {
      verificationRequestId: request.request.id,
      verificationKey: request.request.key,
      kind: "pwn",
      policyHash,
      recipeHash: request.request.recipeHash,
      attemptId: sha256("pwn-replay-attempt"),
      cwd: root,
      recoveryInput: { content: JSON.stringify({ schemaVersion: 1, kind: "pwn", stages }), filename: "pwn-replay.json", mime: "application/json", sensitivity: "secret" },
    });
    const runtime = new EchoTubeRuntime("flag{pwn-recovery}", "/flag");
    const ref = { ...REF, runId, generation: 0 };
    const adapter = new PwnReplayRecoveryAdapter({
      runId,
      controlStore: services.control,
      registry: new SessionRegistry(runId, runtime as unknown as ContainerRuntimePort, services.control),
      refProvider: () => ref,
      policy,
      readRecipe: async (effectId) => await services.journal.readVerifierReplayInput(runId, effectId),
    });
    const recovery = new VerificationRecoveryService(services.control, services.journal, [adapter], services.verificationRecovery);
    const first = await recovery.reconcile(runId);
    assert.equal(first.items[0]?.status, "AMBIGUOUS");
    const snapshot = await services.control.snapshot(runId);
    const effect = snapshot.effects[prepared.effectId]!;
    assert.equal(effect.status, "FINISHED");
    assert.equal(effect.verification, undefined);
    assert.ok(effect.externalId);
    const resultArtifact = snapshot.artifacts[effect.artifactId!];
    assert.ok(resultArtifact);
    const stored = JSON.parse(await services.artifacts.readText(runId, resultArtifact!)) as { stdout: string };
    const envelope = JSON.parse(stored.stdout) as { terminal: boolean; accepted?: boolean; stageSummary?: { reproduced?: boolean } };
    assert.equal(envelope.terminal, false);
    assert.equal(envelope.accepted, undefined);
    assert.equal(envelope.stageSummary?.reproduced, true);
    assert.equal(Object.values(snapshot.sessions).filter((session) => session.kind === "pwn-remote" && session.status === "CLOSED").length, 1);
    const seq = snapshot.lastSeq;
    const second = await recovery.reconcile(runId);
    assert.equal(second.items[0]?.status, "AMBIGUOUS");
    assert.equal((await services.control.snapshot(runId)).lastSeq, seq);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted Pwn reproduction binds clean-process verdicts to a Completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-trusted-repro-"));
  try {
    const runId = "PWN-TRUSTED-REPRO";
    const services = createServices(root, config);
    const task = {
      ...demoTask(runId, root, config),
      target_kind: "pwn" as const,
      target: "REMOTE:tube",
      verification: {
        kind: "reproduction" as const,
        command: "proofblade-pwn-verifier-policy",
        required_reproductions: 2,
        pwn: REPRODUCTION_POLICY,
      },
      scope: { allowed_hosts: ["1.2.3.4"], allowed_ports: [1337], external_network: true, allowed_workspace: root },
    };
    await services.control.createRun(runId, task);
    const runtime = new EchoTubeRuntime("flag{trusted-pwn}", "/flag") as unknown as ContainerRuntimePort;
    const ref = { ...REF, runId, generation: 0 };
    const mainRegistry = new SessionRegistry(runId, runtime, services.control);
    const verifierRegistry = new SessionRegistry(runId, runtime, services.control);
    const claims = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
    const trusted = new PwnReproductionVerifier(services.control, services.artifacts, {
      prepareReplay: (input) => claims.prepareReplay(input),
      startReplay: (effectId, sessionId, externalId) => claims.startReplay(effectId, sessionId, externalId),
      finishReplay: (effectId, result) => claims.finishReplay(effectId, result),
      executeEffect: async (input, signal) => await claims.executePwnReproductionEffect(input, signal),
      recordEvidence: async (_id, evidence) => await claims.recordVerifierEvidence(evidence),
      finalize: async (_id, completionId, accepted, evidenceIds) => await claims.finalizePwnReproduction(completionId, accepted, evidenceIds),
    }, verifierRegistry, () => ref, REPRODUCTION_POLICY);
    const handler = new PwnToolHandler(runId, mainRegistry, new PwnReproducer(services.control), () => ref, "executor", { allowedHosts: ["1.2.3.4"], allowedPorts: [1337] }, REPRODUCTION_POLICY, undefined, services.artifacts, services.control, trusted);
    const outcome = await handler.reproduce([{ name: "trigger", send: "payload", line: true, expect: "payload" }]);
    assert.equal(outcome.reproduced, true);
    assert.equal(outcome.flag, "flag{trusted-pwn}");
    assert.ok(outcome.completionId);
    const snapshot = await services.control.snapshot(runId);
    const completion = snapshot.completions[outcome.completionId!];
    assert.equal(completion?.status, "ACCEPTED");
    const effects = Object.values(snapshot.effects).filter((effect) => effect.operation === "pwn_reproduce");
    assert.equal(effects.length, 2);
    const replayEffects = Object.values(snapshot.effects).filter((effect) => effect.operation === "verification_replay");
    assert.equal(replayEffects.length, 2);
    assert.ok(replayEffects.every((effect) => effect.producerLane === "verifier" && effect.status === "FINISHED" && effect.verification === undefined));
    assert.ok(effects.every((effect) => effect.producerLane === "verifier" && effect.verification?.valid && effect.verification.accepted));
    assert.ok(effects.every((effect) => !Object.hasOwn(effect.args, "stages") && !Object.hasOwn(effect.args, "targetCommand")));
    const evidence = Object.values(snapshot.evidence).filter((item) => item.kind === "reproduction" && item.source.tool === "pwn_reproduce");
    assert.equal(evidence.length, 2);
    assert.ok(evidence.every((item) => item.provenance.recordedBy === "verifier"));
    const resultArtifact = snapshot.artifacts[effects[0]!.artifactId!];
    assert.equal(resultArtifact?.origin.registeredBy, "verifier");
    const payload = JSON.parse(await services.artifacts.readText(runId, resultArtifact!)) as { stdout: string };
    assert.match(payload.stdout, /trusted-pwn/);

    const replayed = await handler.reproduce([{ name: "trigger", send: "payload", line: true, expect: "payload" }]);
    assert.equal(replayed.reproduced, true);
    assert.equal(replayed.shellConfirmed, true);
    assert.deepEqual(replayed.stages.map(({ name, ok }) => ({ name, ok })), [
      { name: "trigger", ok: true },
      { name: "shell_probe", ok: true },
      { name: "flag_extract", ok: true },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted Pwn reproduction matrix covers the core exploit archetype stage contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-trusted-matrix-"));
  try {
    const services = createServices(root, config);
    const scenarios = [
      { id: "ret2libc", payload: "ret2libc-rop" },
      { id: "format-string", payload: "format-string-write" },
      { id: "heap-uaf", payload: "heap-uaf-reclaim" },
      { id: "stack-pivot", payload: "stack-pivot-rop" },
    ] as const;
    for (const scenario of scenarios) {
      const runId = `PWN-MATRIX-${scenario.id.toUpperCase().replaceAll("-", "_")}`;
      const task = {
        ...demoTask(runId, root, config),
        target_kind: "pwn" as const,
        target: "REMOTE:tube",
        verification: {
          kind: "reproduction" as const,
          command: "proofblade-pwn-verifier-policy",
          required_reproductions: 1,
          pwn: REPRODUCTION_POLICY,
        },
        scope: { allowed_hosts: ["1.2.3.4"], allowed_ports: [1337], external_network: true, allowed_workspace: root },
      };
      await services.control.createRun(runId, task);
      const runtime = new EchoTubeRuntime(`flag{matrix-${scenario.id}}`, "/flag") as unknown as ContainerRuntimePort;
      const ref = { ...REF, runId, generation: 0 };
      const claims = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
      const trusted = new PwnReproductionVerifier(services.control, services.artifacts, {
        prepareReplay: (input) => claims.prepareReplay(input),
        startReplay: (effectId, sessionId, externalId) => claims.startReplay(effectId, sessionId, externalId),
        finishReplay: (effectId, result) => claims.finishReplay(effectId, result),
        executeEffect: async (input, signal) => await claims.executePwnReproductionEffect(input, signal),
        recordEvidence: async (_id, evidence) => await claims.recordVerifierEvidence(evidence),
        finalize: async (_id, completionId, accepted, evidenceIds) => await claims.finalizePwnReproduction(completionId, accepted, evidenceIds),
      }, new SessionRegistry(runId, runtime, services.control), () => ref, REPRODUCTION_POLICY);
      const handler = new PwnToolHandler(runId, new SessionRegistry(runId, runtime, services.control), new PwnReproducer(services.control), () => ref, "executor", { allowedHosts: ["1.2.3.4"], allowedPorts: [1337] }, REPRODUCTION_POLICY, undefined, services.artifacts, services.control, trusted);
      const outcome = await handler.reproduce([{ name: scenario.id, send: scenario.payload, line: true, expect: scenario.payload }]);
      assert.equal(outcome.reproduced, true, scenario.id);
      assert.equal(outcome.flag, `flag{matrix-${scenario.id}}`);
      const snapshot = await services.control.replay(runId);
      const stage = Object.values(snapshot.domainRecords).find((record) => record.kind === "pwn_exploit_stage");
      assert.equal(stage?.kind, "pwn_exploit_stage");
      assert.equal(stage?.stageName, scenario.id);
      assert.equal(stage?.status, "passed");
      assert.equal(snapshot.completions[outcome.completionId!]?.status, "ACCEPTED");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted Pwn reproduction rejects a clean-process failure with negative Evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-trusted-negative-"));
  try {
    const runId = "PWN-TRUSTED-NEGATIVE";
    const services = createServices(root, config);
    const task = {
      ...demoTask(runId, root, config),
      target_kind: "pwn" as const,
      target: "REMOTE:tube",
      verification: { kind: "reproduction" as const, command: "proofblade-pwn-verifier-policy", required_reproductions: 2, pwn: REPRODUCTION_POLICY },
      scope: { allowed_hosts: ["1.2.3.4"], allowed_ports: [1337], external_network: true, allowed_workspace: root },
    };
    await services.control.createRun(runId, task);
    const runtime = new EchoTubeRuntime("flag{never-reached}", "/flag", true) as unknown as ContainerRuntimePort;
    const ref = { ...REF, runId, generation: 0 };
    const verifierRegistry = new SessionRegistry(runId, runtime, services.control);
    const claims = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
    const trusted = new PwnReproductionVerifier(services.control, services.artifacts, {
      executeEffect: async (input, signal) => await claims.executePwnReproductionEffect(input, signal),
      recordEvidence: async (_id, evidence) => await claims.recordVerifierEvidence(evidence),
      finalize: async (_id, completionId, accepted, evidenceIds) => await claims.finalizePwnReproduction(completionId, accepted, evidenceIds),
    }, verifierRegistry, () => ref, REPRODUCTION_POLICY);
    const handler = new PwnToolHandler(runId, new SessionRegistry(runId, runtime, services.control), new PwnReproducer(services.control), () => ref, "executor", { allowedHosts: ["1.2.3.4"], allowedPorts: [1337] }, REPRODUCTION_POLICY, undefined, services.artifacts, services.control, trusted);
    const outcome = await handler.reproduce([{ name: "trigger", send: "payload", line: true, expect: "payload" }]);
    assert.equal(outcome.reproduced, false);
    assert.equal(outcome.flag, undefined);
    const snapshot = await services.control.snapshot(runId);
    assert.equal(snapshot.completions[outcome.completionId!]?.status, "REJECTED");
    const effects = Object.values(snapshot.effects).filter((effect) => effect.operation === "pwn_reproduce");
    assert.equal(effects.length, 1, "a failed first reproduction does not burn later attempts");
    assert.equal(effects[0]?.verification?.valid, true);
    assert.equal(effects[0]?.verification?.accepted, false);
    assert.ok(Object.values(snapshot.evidence).some((item) => item.kind === "negative" && item.provenance.recordedBy === "verifier"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted Pwn reproduction rejects a stale container generation before proposing a Completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-trusted-stale-"));
  try {
    const runId = "PWN-TRUSTED-STALE";
    const services = createServices(root, config);
    const task = {
      ...demoTask(runId, root, config),
      target_kind: "pwn" as const,
      target: "REMOTE:tube",
      verification: { kind: "reproduction" as const, command: "proofblade-pwn-verifier-policy", required_reproductions: 1, pwn: REPRODUCTION_POLICY },
      scope: { allowed_hosts: ["1.2.3.4"], allowed_ports: [1337], external_network: true, allowed_workspace: root },
    };
    await services.control.createRun(runId, task);
    const runtime = new EchoTubeRuntime("flag{stale}", "/flag") as unknown as ContainerRuntimePort;
    const ref = { ...REF, runId, generation: 0 };
    const claims = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
    const trusted = new PwnReproductionVerifier(services.control, services.artifacts, {
      executeEffect: async (input, signal) => await claims.executePwnReproductionEffect(input, signal),
      recordEvidence: async (_id, evidence) => await claims.recordVerifierEvidence(evidence),
      finalize: async (_id, completionId, accepted, evidenceIds) => await claims.finalizePwnReproduction(completionId, accepted, evidenceIds),
    }, new SessionRegistry(runId, runtime, services.control), () => ref, REPRODUCTION_POLICY);
    const handler = new PwnToolHandler(runId, new SessionRegistry(runId, runtime, services.control), new PwnReproducer(services.control), () => ref, "executor", { allowedHosts: ["1.2.3.4"], allowedPorts: [1337] }, REPRODUCTION_POLICY, undefined, services.artifacts, services.control, trusted);
    await services.fixtureControl.reset(runId, 1);
    await assert.rejects(() => handler.reproduce([{ name: "trigger", send: "payload" }]), /stale generation/);
    const snapshot = await services.control.snapshot(runId);
    assert.equal(Object.keys(snapshot.completions).length, 0);
    assert.equal(Object.values(snapshot.effects).filter((effect) => effect.operation === "pwn_reproduce").length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pwn_reproduce schema exposes stages only", () => {
  const schema = toolByName("pwn_reproduce").parameters as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(schema.properties), ["stages"]);
});
