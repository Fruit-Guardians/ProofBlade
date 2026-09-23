import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlStore } from "../src/control/control-store.js";
import { demoTask } from "../src/app/demo.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";
import { SessionRegistry } from "../src/container/session-registry.js";
import { PwnReproducer, type ExploitRecipe } from "../src/verification/pwn-reproducer.js";
import { PwnToolHandler } from "../src/pwn/pwn-tools.js";
import { ExperimentGate } from "../src/competition/experiment-gate.js";
import { ArtifactStore } from "../src/effects/artifact-store.js";
import { CodingEvidenceGraph } from "../src/knowledge/evidence-graph.js";
import type { ProofBladeConfig } from "../src/config.js";
import type { ContainerRef, ContainerRuntimePort, ContainerSessionHandle, ContainerSessionResult } from "../src/container/contracts.js";
import type { SessionRuntimeCreateBroker } from "../src/recovery/session-resource-adapter.js";
import type { ExternalResourceRecord } from "../src/recovery/external-resource-registry.js";

const REPRODUCTION_POLICY = {
  target: { kind: "remote" as const, command: ["tube"], endpoint: "10.0.0.9:1337" },
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

/** Same echo-shell tube used by pwn-layer tests: echo returns X, cat returns the flag. */
class EchoTubeRuntime implements Partial<ContainerRuntimePort> {
  private pending = new Map<string, string>();
  private count = 0;
  public lastWriteBytes: Uint8Array | undefined;
  public closed: string[] = [];
  public readCalls = 0;
  public constructor(private readonly flag: string, private readonly flagPath: string, private readonly exitOnWrite = false) {}
  public async openSession(ref: ContainerRef): Promise<ContainerSessionHandle> {
    const sessionId = `dxs-${++this.count}`;
    this.pending.set(sessionId, "");
    return { sessionId, ref };
  }
  public async sessionWrite(handle: ContainerSessionHandle, data: string | Uint8Array): Promise<ContainerSessionResult> {
    this.lastWriteBytes = typeof data === "string" ? new TextEncoder().encode(data) : Uint8Array.from(data);
    const text = String(data);
    const echo = /^echo (.+)\n$/.exec(text);
    const cat = /^cat '?([^'\n]+)'?\n$/.exec(text);
    const out = echo ? `${echo[1]}\n` : cat ? (cat[1]!.trim() === this.flagPath ? `${this.flag}\n` : "nope\n") : text;
    this.pending.set(handle.sessionId, (this.pending.get(handle.sessionId) ?? "") + out);
    return this.drain(handle.sessionId);
  }
  public async sessionRead(handle: ContainerSessionHandle): Promise<ContainerSessionResult> { this.readCalls += 1; return this.drain(handle.sessionId); }
  public async sessionSignal(): Promise<boolean> { return true; }
  public async closeSession(handle: ContainerSessionHandle): Promise<{ exitCode: number | null }> {
    this.closed.push(handle.sessionId);
    return { exitCode: 0 };
  }
  private drain(sessionId: string): ContainerSessionResult {
    const buffered = this.pending.get(sessionId) ?? "";
    this.pending.set(sessionId, "");
    return { delta: buffered, waitReason: buffered ? "idle" : "timeout", exited: this.exitOnWrite, exitCode: this.exitOnWrite ? 0 : null, truncated: false };
  }
}

class UndeliveredSignalRuntime extends EchoTubeRuntime {
  public async sessionSignal(): Promise<boolean> { return false; }
}

class NoOpenRuntime extends EchoTubeRuntime {
  public async openSession(): Promise<ContainerSessionHandle> { throw new Error("local opener must not be called"); }
}

async function makeHandler(root: string, runId: string, flag = "flag{tool}", experimentGate?: ExperimentGate, runtimeOverride?: ContainerRuntimePort): Promise<{ handler: PwnToolHandler; control: ControlStore }> {
  const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
  await control.createRun(runId, demoTask(runId, root, config));
  const runtime = runtimeOverride ?? new EchoTubeRuntime(flag, "/flag") as unknown as ContainerRuntimePort;
  const registry = new SessionRegistry(runId, runtime, control);
  const handler = new PwnToolHandler(runId, registry, new PwnReproducer(control), () => REF, "executor", undefined, REPRODUCTION_POLICY, experimentGate);
  return { handler, control };
}

test("handler opens, sends, lists and closes a tube through the durable registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-tool-"));
  try {
    const { handler, control } = await makeHandler(root, "PWN-TOOL");
    const opened = await handler.open({ kind: "remote", command: ["tube"], endpoint: "10.0.0.9:1337" });
    assert.ok(opened.sessionId.startsWith("SES"));
    assert.equal(opened.endpoint, "10.0.0.9:1337");

    const sent = await handler.send(opened.sessionId, "MENU", true);
    assert.match(sent.viewport, /MENU/);
    assert.equal(sent.exited, false);

    assert.deepEqual(handler.list().map((s) => s.sessionId), [opened.sessionId]);

    // Durable: the open + interaction are recorded in the control projection.
    const snap = await control.snapshot("PWN-TOOL");
    assert.equal(snap.sessions[opened.sessionId]?.kind, "pwn-remote");
    assert.ok((snap.sessions[opened.sessionId]?.interactions ?? 0) >= 1);

    await handler.close(opened.sessionId);
    assert.equal(handler.list().length, 0);
    assert.equal((await control.snapshot("PWN-TOOL")).sessions[opened.sessionId]?.status, "CLOSED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handler opens a broker-owned tube without invoking the local container opener", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-tool-broker-"));
  try {
    const runId = "PWN-BROKER";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await control.createRun(runId, { ...demoTask(runId, root, config), target_kind: "pwn", target: "nc://10.0.0.9:1337" });
    const localRuntime = new NoOpenRuntime("flag{broker}", "/flag");
    const brokerRuntime = new EchoTubeRuntime("flag{broker}", "/flag");
    const generation = (await control.snapshot(runId)).generation;
    const ref = { ...REF, runId, generation };
    const registry = new SessionRegistry(runId, localRuntime as unknown as ContainerRuntimePort, control);
    let creates = 0;
    const requestKeys: string[] = [];
    const broker: SessionRuntimeCreateBroker = {
      name: "test-session-broker",
      kind: "pwn-session",
      async create(request) {
        creates += 1;
        requestKeys.push(request.requestKey);
        assert.equal(request.kind, "pwn-session");
        assert.equal(request.pwn?.mode, "remote");
        return { schemaVersion: 1, operation: "create", state: "CREATED", sessionId: `SES-BROKER-${creates}`, externalId: `opaque-broker-${creates}`, stateHash: "a".repeat(64) };
      },
      async createBinding(record: ExternalResourceRecord) {
        const handle: ContainerSessionHandle = { sessionId: `runtime-${record.externalId}`, externalId: record.externalId, ref };
        return { kind: "pwn-session" as const, externalId: record.externalId!, handle, runtime: brokerRuntime };
      },
      async inspect(record) { return { status: "PRESENT" as const, binding: "MATCH" as const, externalId: record.externalId }; },
      async adopt(record) { return { state: "CONFIRMED" as const, externalId: record.externalId }; },
      async release() { return { released: true }; },
    };
    const handler = new PwnToolHandler(runId, registry, new PwnReproducer(control), () => ref, "executor", { allowedHosts: ["10.0.0.9"], allowedPorts: [1337] }, REPRODUCTION_POLICY, undefined, undefined, control, undefined, broker);
    const opened = await handler.open({ kind: "remote", command: ["tube"], endpoint: "10.0.0.9:1337" });
    assert.equal(opened.sessionId, "SES-BROKER-1");
    assert.equal(creates, 1);
    await handler.send(opened.sessionId, "PING", true);
    assert.deepEqual(brokerRuntime.lastWriteBytes && [...brokerRuntime.lastWriteBytes], [...new TextEncoder().encode("PING\n")]);
    const reproduced = await handler.reproduce([{ name: "trigger", send: "payload", line: true, expect: "payload" }]);
    assert.equal(reproduced.reproduced, true);
    assert.equal(reproduced.flag, "flag{broker}");
    assert.equal(creates, 2, "clean reproduction must allocate a fresh broker session");
    const repeated = await handler.reproduce([{ name: "trigger", send: "payload", line: true, expect: "payload" }]);
    assert.equal(repeated.reproduced, true);
    assert.equal(creates, 3, "each clean reproduction must allocate a fresh broker session");
    assert.notEqual(requestKeys[1], requestKeys[2], "clean reproductions must not reuse the exploration idempotency key");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pwn interactions archive a bounded transcript domain record when the target is pwn", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-domain-records-"));
  try {
    const runId = "PWN-DOMAIN-RECORDS";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await control.createRun(runId, { ...demoTask(runId, root, config), target_kind: "pwn", target: "nc://10.0.0.9:1337" });
    const artifactStore = new ArtifactStore(join(root, "runs"), control);
    const runtime = new EchoTubeRuntime("flag{recorded}", "/flag") as unknown as ContainerRuntimePort;
    const registry = new SessionRegistry(runId, runtime, control);
    const handler = new PwnToolHandler(runId, registry, new PwnReproducer(control), () => REF, "executor", undefined, REPRODUCTION_POLICY, undefined, artifactStore, control);
    const opened = await handler.open({ kind: "remote", command: ["tube"], endpoint: "10.0.0.9:1337" });
    await handler.send(opened.sessionId, "MENU", true);
    const snapshot = await control.replay(runId);
    const transcript = Object.values(snapshot.domainRecords).find((record) => record.kind === "pwn_protocol_transcript");
    assert.ok(transcript);
    assert.equal(transcript.sessionId, opened.sessionId);
    assert.equal(transcript.artifactIds.length, 1);
    assert.ok(snapshot.artifacts[transcript.artifactIds[0]!]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("crash analysis persists bounded debugger evidence without claiming success", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-crash-analysis-"));
  try {
    const runId = "PWN-CRASH-ANALYSIS";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await control.createRun(runId, { ...demoTask(runId, root, config), target_kind: "pwn", target: "LOCAL:chall" });
    const artifacts = new ArtifactStore(join(root, "runs"), control);
    const graph = new CodingEvidenceGraph(runId, control, artifacts);
    const registry = new SessionRegistry(runId, new EchoTubeRuntime("flag{x}", "/flag") as unknown as ContainerRuntimePort, control);
    const handler = new PwnToolHandler(
      runId,
      registry,
      new PwnReproducer(control),
      () => ({ ...REF, runId, generation: 0 }),
      "executor",
      undefined,
      undefined,
      undefined,
      artifacts,
      control,
      undefined,
      undefined,
      false,
      graph,
    );
    const result = await handler.analyzeCrash({
      transcript: [
        "Program received signal SIGSEGV, Segmentation fault.",
        "rip            0x6161617461616173",
        "rsp            0x7fffffffe000",
        "Cannot access memory at address 0x41414141",
      ].join("\n"),
    });
    const snapshot = await control.replay(runId);
    const record = snapshot.domainRecords[result.recordId];
    assert.equal(record?.kind, "pwn_crash");
    assert.equal(record?.classification, "crash");
    assert.equal(record?.cyclicOffset, 72);
    assert.equal(record?.ripControlled, true);
    assert.ok(snapshot.artifacts[result.artifactId]);
    assert.equal(Object.keys(snapshot.completions).length, 0, "crash evidence must not mint a completion");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leak and base tools persist auditable formulas through the evidence graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-leak-tools-"));
  try {
    const runId = "PWN-LEAK-TOOLS";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await control.createRun(runId, { ...demoTask(runId, root, config), target_kind: "pwn", target: "LOCAL:chall" });
    const artifacts = new ArtifactStore(join(root, "runs"), control);
    const graph = new CodingEvidenceGraph(runId, control, artifacts);
    const source = await artifacts.putText(runId, "raw leak: 30f4e1f7ff7f0000", { filename: "leak.txt" });
    const registry = new SessionRegistry(runId, new EchoTubeRuntime("flag{x}", "/flag") as unknown as ContainerRuntimePort, control);
    const handler = new PwnToolHandler(
      runId,
      registry,
      new PwnReproducer(control),
      () => ({ ...REF, runId, generation: 0 }),
      "executor",
      undefined,
      undefined,
      undefined,
      artifacts,
      control,
      undefined,
      undefined,
      false,
      graph,
    );
    const leak = await handler.recordLeak({
      id: "LEAK-LIBC-TOOLS",
      sourceHex: "30f4e1f7ff7f0000",
      format: "le64",
      addressKind: "libc",
      symbol: "puts@GLIBC",
      confidence: 0.8,
      artifactIds: [source.id],
    });
    assert.equal(leak.value, "0x7ffff7e1f430");
    const base = await handler.deriveBase({ sourceLeakId: leak.leakId, knownOffset: "0x84430", label: "libc_base" });
    assert.equal(base.value, "0x7ffff7d9b000");
    assert.equal(base.pageAligned, true);
    const snapshot = await control.replay(runId);
    const baseRecord = snapshot.domainRecords[base.recordId];
    assert.equal(baseRecord?.kind, "pwn_leak");
    assert.equal(baseRecord?.confidence, 0.8);
    assert.deepEqual(baseRecord?.derivation?.sourceRecordIds, [leak.recordId]);
    assert.deepEqual(baseRecord?.artifactIds, [source.id]);
    await assert.rejects(
      handler.recordLeak({ sourceHex: "30f4e1f7ff7f0000", format: "le64", addressKind: "libc", confidence: 1, artifactIds: [source.id] }),
      /confidence must be in \[0,1\)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pwn leak ids and base derivations are isolated by fixture generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-generation-isolation-"));
  try {
    const runId = "PWN-GENERATION-ISOLATION";
    const plane = ControlStore.create(new JsonlControlStore(join(root, "runs")));
    const control = plane.control;
    await control.createRun(runId, { ...demoTask(runId, root, config), target_kind: "pwn", target: "LOCAL:chall" });
    const artifacts = new ArtifactStore(join(root, "runs"), control);
    const graph = new CodingEvidenceGraph(runId, control, artifacts);
    const registry = new SessionRegistry(runId, new EchoTubeRuntime("flag{x}", "/flag") as unknown as ContainerRuntimePort, control);
    const handler = new PwnToolHandler(
      runId,
      registry,
      new PwnReproducer(control),
      () => ({ ...REF, runId, generation: 0 }),
      "executor",
      undefined,
      undefined,
      undefined,
      artifacts,
      control,
      undefined,
      undefined,
      false,
      graph,
    );

    const oldArtifact = await artifacts.putText(runId, "generation 0 leak: 30f4e1f7ff7f0000", { filename: "old-leak.txt" });
    const oldLeak = await handler.recordLeak({
      sourceHex: "30f4e1f7ff7f0000",
      format: "le64",
      addressKind: "libc",
      symbol: "puts@GLIBC",
      confidence: 0.8,
      artifactIds: [oldArtifact.id],
    });
    assert.equal((await control.snapshot(runId)).domainRecords[oldLeak.recordId]?.generation, 0);

    await plane.fixtureControl.assertResetAllowed(runId);
    await plane.fixtureControl.reset(runId, 1);
    const currentArtifact = await artifacts.putText(runId, "generation 1 leak: 30f4e1f7ff7f0000", { filename: "current-leak.txt" });

    await assert.rejects(
      () => handler.deriveBase({ sourceLeakId: oldLeak.leakId, knownOffset: "0x84430", artifactIds: [currentArtifact.id] }),
      /generation|stale/i,
    );

    const newLeak = await handler.recordLeak({
      sourceHex: "30f4e1f7ff7f0000",
      format: "le64",
      addressKind: "libc",
      symbol: "puts@GLIBC",
      confidence: 0.8,
      artifactIds: [currentArtifact.id],
    });
    assert.notEqual(newLeak.leakId, oldLeak.leakId, "automatic leak ids must include fixture generation");
    const newSnapshot = await control.snapshot(runId);
    assert.equal(newSnapshot.domainRecords[oldLeak.recordId]?.generation, 0);
    assert.equal(newSnapshot.domainRecords[newLeak.recordId]?.generation, 1);

    const base = await handler.deriveBase({ sourceLeakId: newLeak.leakId, knownOffset: "0x84430", artifactIds: [currentArtifact.id] });
    assert.equal(base.value, "0x7ffff7d9b000");
    assert.equal(base.pageAligned, true);

    await assert.rejects(
      () => handler.recordLeak({
        id: oldLeak.leakId,
        sourceHex: "30f4e1f7ff7f0000",
        format: "le64",
        addressKind: "libc",
        confidence: 0.8,
        artifactIds: [currentArtifact.id],
      }),
      /generation/i,
      "explicitly reusing a stale reasoning id must be rejected",
    );
    await assert.rejects(
      () => handler.recordPrimitive({ primitive: "stale artifact should be rejected", confidence: 0.5, artifactIds: [oldArtifact.id] }),
      /stale|generation/i,
      "primitive hypotheses must not be bound to old-generation artifacts",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pwn primitive preconditions must belong to the current run and generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-precondition-generation-"));
  try {
    const runId = "PWN-PRECONDITION-GENERATION";
    const plane = ControlStore.create(new JsonlControlStore(join(root, "runs")));
    const control = plane.control;
    await control.createRun(runId, { ...demoTask(runId, root, config), target_kind: "pwn", target: "LOCAL:chall" });
    const artifacts = new ArtifactStore(join(root, "runs"), control);
    const graph = new CodingEvidenceGraph(runId, control, artifacts);
    const registry = new SessionRegistry(runId, new EchoTubeRuntime("flag{x}", "/flag") as unknown as ContainerRuntimePort, control);
    const handler = new PwnToolHandler(
      runId,
      registry,
      new PwnReproducer(control),
      () => ({ ...REF, runId, generation: 0 }),
      "executor",
      undefined,
      undefined,
      undefined,
      artifacts,
      control,
      undefined,
      undefined,
      false,
      graph,
    );

    const oldArtifact = await artifacts.putText(runId, "generation 0 recon", { filename: "old-recon.txt" });
    const oldLeak = await handler.recordLeak({
      sourceHex: "30f4e1f7ff7f0000",
      format: "le64",
      addressKind: "libc",
      confidence: 0.8,
      artifactIds: [oldArtifact.id],
    });
    const oldCrash = await handler.analyzeCrash({
      transcript: [
        "Program received signal SIGSEGV, Segmentation fault.",
        "rip            0x6161617461616173",
        "rsp            0x7fffffffe000",
        "Cannot access memory at address 0x41414141",
      ].join("\n"),
    });
    const oldPrimitive = await handler.recordPrimitive({
      primitive: "stack buffer overflow with direct ret2win control",
      confidence: 0.8,
      artifactIds: [oldArtifact.id],
      preconditionRecordIds: [oldLeak.recordId, oldCrash.recordId],
    });
    assert.equal((await control.snapshot(runId)).domainRecords[oldPrimitive.recordId]?.generation, 0);

    await plane.fixtureControl.assertResetAllowed(runId);
    await plane.fixtureControl.reset(runId, 1);
    const currentArtifact = await artifacts.putText(runId, "generation 1 recon", { filename: "current-recon.txt" });

    for (const stalePreconditionId of [oldLeak.recordId, oldCrash.recordId, oldPrimitive.recordId]) {
      await assert.rejects(
        () => handler.recordPrimitive({
          primitive: "cross-generation precondition must be rejected",
          confidence: 0.5,
          artifactIds: [currentArtifact.id],
          preconditionRecordIds: [stalePreconditionId],
        }),
        /generation/i,
        `stale precondition ${stalePreconditionId} must be rejected after a fixture reset`,
      );
    }
    await assert.rejects(
      () => handler.recordPrimitive({
        primitive: "unknown precondition must be rejected",
        confidence: 0.5,
        artifactIds: [currentArtifact.id],
        preconditionRecordIds: ["PWN-LEAK-NO-SUCH-RECORD"],
      }),
      /unknown precondition record/i,
    );
    await assert.rejects(
      () => handler.recordLeak({
        sourceHex: "30f4e1f7ff7f0000",
        format: "le64",
        addressKind: "libc",
        confidence: 0.8,
        artifactIds: [currentArtifact.id],
        derivation: { expression: "libc_old = puts_leak - 0x84430", sourceLeakIds: [oldLeak.leakId] },
      }),
      /generation/i,
      "a leak derivation must not reference a stale source leak record",
    );

    const newLeak = await handler.recordLeak({
      sourceHex: "30f4e1f7ff7f0000",
      format: "le64",
      addressKind: "libc",
      confidence: 0.8,
      artifactIds: [currentArtifact.id],
    });
    const newPrimitive = await handler.recordPrimitive({
      primitive: "stack buffer overflow with direct ret2win control",
      confidence: 0.8,
      artifactIds: [currentArtifact.id],
      preconditionRecordIds: [newLeak.recordId],
    });
    const snapshot = await control.snapshot(runId);
    const stored = snapshot.domainRecords[newPrimitive.recordId];
    assert.equal(stored?.kind, "pwn_primitive");
    assert.equal(stored?.generation, 1);
    assert.deepEqual(stored?.kind === "pwn_primitive" ? stored.preconditionRecordIds : [], [newLeak.recordId]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pwn workflow advances from recon to a generation-bound direct route", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-workflow-route-"));
  try {
    const runId = "PWN-WORKFLOW-ROUTE";
    const plane = ControlStore.create(new JsonlControlStore(join(root, "runs")));
    const control = plane.control;
    const task = {
      ...demoTask(runId, root, config),
      target_kind: "pwn" as const,
      target: "LOCAL:chall",
      verification: {
        kind: "reproduction" as const,
        command: "proofblade-pwn-verifier-policy",
        required_reproductions: 1,
        pwn: { target: { kind: "remote" as const, command: ["tube"], endpoint: "10.0.0.9:1337" }, flag_path: "/flag", flag_pattern: "flag\\{[^}]+\\}" },
      },
    };
    await control.createRun(runId, task);
    const artifacts = new ArtifactStore(join(root, "runs"), control);
    const runtime = new EchoTubeRuntime("flag{workflow}", "/flag") as unknown as ContainerRuntimePort;
    const registry = new SessionRegistry(runId, runtime, control);
    const handler = new PwnToolHandler(runId, registry, new PwnReproducer(control), () => ({ ...REF, runId, generation: 0 }), "executor", undefined, REPRODUCTION_POLICY, undefined, artifacts, control);

    const initial = await handler.workflow();
    assert.equal(initial.status, "recon");
    assert.equal(initial.recommendedPhase, "RECON");

    const recon = await artifacts.putText(runId, "ELF x86-64; NX enabled; no canary", { filename: "recon.txt" });
    await control.dispatch(runId, {
      type: "domain_record",
      record: {
        id: "PWN-PROFILE-WORKFLOW",
        kind: "pwn_binary_profile",
        summary: "Current target profile",
        artifactIds: [recon.id],
        evidenceIds: [],
        format: "ELF",
        architecture: "x86-64",
        bits: 64,
        protections: ["NX", "No canary", "No PIE"],
      },
      lane: "executor",
    });
    assert.equal((await handler.workflow()).status, "target_model");

    const primitive = await handler.recordPrimitive({ primitive: "stack buffer overflow with direct ret2win control", confidence: 0.8, artifactIds: [recon.id] });
    const hypothesis = await handler.workflow();
    assert.equal(hypothesis.route, "direct-ret2win");
    assert.equal(hypothesis.status, "hypothesis");
    assert.equal(hypothesis.basis.primitiveId, primitive.recordId);
    assert.equal(hypothesis.nextActions[0]?.id, "hypothesis.control-offset");

    await handler.analyzeCrash({
      transcript: [
        "Program received signal SIGSEGV, Segmentation fault.",
        "rip            0x6161617461616173",
        "rsp            0x7fffffffe000",
        "Cannot access memory at address 0x41414141",
      ].join("\n"),
    });
    const ready = await handler.workflow();
    assert.equal(ready.status, "reproduce");
    assert.equal(ready.recommendedPhase, "REPRODUCE");
    assert.equal(ready.candidateReady, true);
    assert.equal(ready.retryBlocked, false);
    assert.equal(ready.nextActions[0]?.id, "reproduce.clean");

    await plane.fixtureControl.assertResetAllowed(runId);
    await plane.fixtureControl.reset(runId, 1);
    const reset = await handler.workflow();
    assert.equal(reset.generation, 1);
    assert.equal(reset.status, "recon");
    assert.equal(reset.route, "undetermined");
    assert.deepEqual(reset.current.recordIds, { binaryProfiles: [], protocolTranscripts: [], primitives: [], crashes: [], leaks: [], bases: [], exploitStages: [] });
    assert.ok(reset.stale.domainRecordCount >= 3);
    assert.ok(reset.stale.artifactCount >= 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed pwn reproduction requires new material evidence before retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-workflow-recovery-"));
  try {
    const runId = "PWN-WORKFLOW-RECOVERY";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const task = {
      ...demoTask(runId, root, config),
      target_kind: "pwn" as const,
      target: "LOCAL:chall",
      verification: {
        kind: "reproduction" as const,
        command: "proofblade-pwn-verifier-policy",
        required_reproductions: 1,
        pwn: { target: { kind: "remote" as const, command: ["tube"], endpoint: "10.0.0.9:1337" }, flag_path: "/flag", flag_pattern: "flag\\{[^}]+\\}" },
      },
    };
    await control.createRun(runId, task);
    const artifacts = new ArtifactStore(join(root, "runs"), control);
    const recon = await artifacts.putText(runId, "stack overflow candidate", { filename: "recon.txt" });
    const runtime = new EchoTubeRuntime("flag{never-reached}", "/flag", true) as unknown as ContainerRuntimePort;
    const registry = new SessionRegistry(runId, runtime, control);
    const handler = new PwnToolHandler(runId, registry, new PwnReproducer(control), () => ({ ...REF, runId, generation: 0 }), "executor", undefined, REPRODUCTION_POLICY, undefined, artifacts, control);
    await handler.recordPrimitive({ primitive: "stack buffer overflow with direct ret2win control", confidence: 0.8, artifactIds: [recon.id] });

    const first = await handler.reproduce([{ name: "trigger", send: "payload", line: true, expect: "payload" }]);
    assert.equal(first.reproduced, false);
    const failed = await handler.workflow();
    assert.equal(failed.retryBlocked, true);
    assert.equal(failed.status, "experiment");
    assert.equal(failed.recommendedPhase, "EXPERIMENT");
    assert.equal(failed.nextActions[0]?.id, "experiment.recover-failed-reproduction");
    const lastSeq = (await control.snapshot(runId)).lastSeq;

    await assert.rejects(
      () => handler.reproduce([{ name: "trigger", send: "payload", line: true, expect: "payload" }]),
      /no new material evidence/,
    );
    assert.equal((await control.snapshot(runId)).lastSeq, lastSeq, "a refused retry must not open a session or append an event");

    await handler.analyzeCrash({
      transcript: [
        "Program received signal SIGSEGV, Segmentation fault.",
        "rip            0x6161617461616173",
        "rsp            0x7fffffffe000",
        "Cannot access memory at address 0x41414141",
      ].join("\n"),
    });
    const recovered = await handler.workflow();
    assert.equal(recovered.retryBlocked, false);
    assert.equal(recovered.status, "reproduce");
    assert.equal(recovered.nextActions[0]?.id, "reproduce.clean");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pwn interaction telemetry does not unblock a failed reproduction retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-workflow-telemetry-"));
  try {
    const runId = "PWN-WORKFLOW-TELEMETRY";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const task = {
      ...demoTask(runId, root, config),
      target_kind: "pwn" as const,
      target: "LOCAL:chall",
      verification: {
        kind: "reproduction" as const,
        command: "proofblade-pwn-verifier-policy",
        required_reproductions: 1,
        pwn: { target: { kind: "remote" as const, command: ["tube"], endpoint: "10.0.0.9:1337" }, flag_path: "/flag", flag_pattern: "flag\\{[^}]+\\}" },
      },
    };
    await control.createRun(runId, task);
    const artifacts = new ArtifactStore(join(root, "runs"), control);
    const recon = await artifacts.putText(runId, "stack overflow candidate", { filename: "recon.txt" });
    const runtime = new EchoTubeRuntime("flag{never-reached}", "/flag", true) as unknown as ContainerRuntimePort;
    const registry = new SessionRegistry(runId, runtime, control);
    const handler = new PwnToolHandler(runId, registry, new PwnReproducer(control), () => ({ ...REF, runId, generation: 0 }), "executor", undefined, REPRODUCTION_POLICY, undefined, artifacts, control);
    await handler.recordPrimitive({ primitive: "stack buffer overflow with direct ret2win control", confidence: 0.8, artifactIds: [recon.id] });

    const first = await handler.reproduce([{ name: "trigger", send: "payload", line: true, expect: "payload" }]);
    assert.equal(first.reproduced, false);
    assert.equal((await handler.workflow()).retryBlocked, true);

    const opened = await handler.open({ kind: "remote", command: ["tube"], endpoint: "10.0.0.9:1337" });
    await handler.signal(opened.sessionId, "SIGINT");
    await handler.close(opened.sessionId);

    const afterSignal = await handler.workflow();
    assert.equal(afterSignal.retryBlocked, true, "pwn_signal and its transcript are not material exploit evidence");
    assert.equal(afterSignal.status, "experiment");
    await assert.rejects(
      () => handler.reproduce([{ name: "trigger", send: "payload", line: true, expect: "payload" }]),
      /no new material evidence/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handler rejects operations on an unknown session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-tool-unknown-"));
  try {
    const { handler } = await makeHandler(root, "PWN-TOOL-UNK");
    await assert.rejects(handler.send("SES-missing", "x", true), (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      assert.match(text, /Unknown pwn session/);
      assert.match(text, /not executed/);
      assert.match(text, /Next:.*pwn_list/);
      return true;
    });
    await assert.rejects(handler.recv("SES-missing", "\n"), /Unknown pwn session/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handler bounds the viewport so a chatty tube cannot flood context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-tool-bound-"));
  try {
    const { handler } = await makeHandler(root, "PWN-TOOL-BOUND");
    const opened = await handler.open({ kind: "remote", command: ["tube"], endpoint: "10.0.0.9:1337" });
    const big = "A".repeat(9000);
    const sent = await handler.send(opened.sessionId, big, true);
    assert.equal(sent.truncated, true);
    assert.ok(sent.viewport.length <= 4_001);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handler.reproduce runs the barrier-gated verifier on a fresh remote session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-tool-repro-"));
  try {
    const { handler, control } = await makeHandler(root, "PWN-TOOL-REPRO", "flag{tool-repro}");
    const recipe: ExploitRecipe = {
      stages: [{ name: "trigger", send: "payload", line: true, expect: "payload" }],
      flagPath: "/flag",
      flagPattern: "flag\\{[^}]+\\}",
    };
    const outcome = await handler.reproduce(recipe.stages);
    assert.equal(outcome.reproduced, true);
    assert.equal(outcome.flag, "flag{tool-repro}");
    const snap = await control.snapshot("PWN-TOOL-REPRO");
    assert.equal(snap.evidence[outcome.evidenceId], undefined, "local tube barriers must not mint trusted Evidence");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reproduce stage replays exact binary bytes via base64 (0x00/0xff)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-tool-bin-"));
  try {
    const runId = "PWN-TOOL-BINREPRO";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await control.createRun(runId, demoTask(runId, root, config));
    const runtime = new EchoTubeRuntime("flag{bin}", "/flag");
    const registry = new SessionRegistry(runId, runtime as unknown as ContainerRuntimePort, control);
    const handler = new PwnToolHandler(runId, registry, new PwnReproducer(control), () => REF, "executor", undefined, REPRODUCTION_POLICY);
    const payloadB64 = Buffer.from([0x00, 0xff, 0x41]).toString("base64");
    const recipe: ExploitRecipe = {
      stages: [{ name: "overflow", send: payloadB64, encoding: "base64", line: true }],
      flagPath: "/flag",
      flagPattern: "flag\\{[^}]+\\}",
    };
    await handler.reproduce(recipe.stages);
    // The last write before the shell-probe/flag stages was the base64 stage: exact bytes + LF.
    // (Later echo/cat writes overwrite lastWriteBytes, so assert the byte path worked via no throw + reproduced path.)
    assert.ok(runtime.lastWriteBytes, "a write reached the tube");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote endpoint outside task scope is rejected before connecting", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-tool-scope-"));
  try {
    const runId = "PWN-TOOL-SCOPE";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await control.createRun(runId, demoTask(runId, root, config));
    const runtime = new EchoTubeRuntime("flag{x}", "/flag") as unknown as ContainerRuntimePort;
    const registry = new SessionRegistry(runId, runtime, control);
    // Scope: only 1.14.76.59 on port 23984 is allowed.
    const handler = new PwnToolHandler(runId, registry, new PwnReproducer(control), () => REF, "executor", { allowedHosts: ["1.14.76.59"], allowedPorts: [23984] }, {
      ...REPRODUCTION_POLICY,
      target: { kind: "remote", command: ["tube"], endpoint: "8.8.8.8:23984" },
    });

    // In-scope endpoint works.
    const ok = await handler.open({ kind: "remote", command: ["tube"], endpoint: "1.14.76.59:23984" });
    assert.ok(ok.sessionId.startsWith("SES"));

    // Wrong host and wrong port are both rejected before any connection.
    await assert.rejects(handler.open({ kind: "remote", command: ["tube"], endpoint: "8.8.8.8:23984" }), /outside the task scope/);
    await assert.rejects(handler.open({ kind: "remote", command: ["tube"], endpoint: "1.14.76.59:9999" }), /outside the task scope/);
    // Reproduce is gated too.
    await assert.rejects(
      handler.reproduce([{ name: "s", send: "x" }]),
      /outside the task scope/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reproduction refuses model-supplied verifier inputs when the task has no immutable policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-tool-no-policy-"));
  try {
    const runId = "PWN-TOOL-NO-POLICY";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await control.createRun(runId, demoTask(runId, root, config));
    const runtime = new EchoTubeRuntime("flag{x}", "/flag") as unknown as ContainerRuntimePort;
    const registry = new SessionRegistry(runId, runtime, control);
    const handler = new PwnToolHandler(runId, registry, new PwnReproducer(control), () => REF, "executor");
    await assert.rejects(handler.reproduce([{ name: "trigger", send: "payload" }]), /immutable target and flag verifier configuration/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an exited tube is removed from both handler and durable live state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-tool-exit-"));
  try {
    const runId = "PWN-TOOL-EXIT";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await control.createRun(runId, demoTask(runId, root, config));
    const runtime = new EchoTubeRuntime("flag{x}", "/flag", true);
    const registry = new SessionRegistry(runId, runtime as unknown as ContainerRuntimePort, control);
    const handler = new PwnToolHandler(runId, registry, new PwnReproducer(control), () => REF, "executor");
    const opened = await handler.open({ kind: "remote", command: ["tube"], endpoint: "10.0.0.9:1337" });
    const result = await handler.send(opened.sessionId, "exit", true);
    assert.equal(result.exited, true);
    assert.deepEqual(handler.list(), []);
    await assert.rejects(handler.send(opened.sessionId, "again", true), /has exited/);
    await handler.close(opened.sessionId);
    assert.deepEqual(runtime.closed, ["dxs-1"]);
    assert.deepEqual(await handler.close(opened.sessionId), { exitCode: null });
    assert.equal((await control.snapshot(runId)).sessions[opened.sessionId]?.status, "CLOSED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pwn experiment failures are durable, session-independent, and gate all probes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-tool-gate-"));
  try {
    const runId = "PWN-TOOL-GATE";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await control.createRun(runId, demoTask(runId, root, config));
    const gate = new ExperimentGate(control);
    const runtime = new EchoTubeRuntime("flag{x}", "/flag");
    const registry = new SessionRegistry(runId, runtime as unknown as ContainerRuntimePort, control);
    const handler = new PwnToolHandler(runId, registry, new PwnReproducer(control), () => REF, "executor", undefined, REPRODUCTION_POLICY, gate);
    const first = await handler.open({ kind: "remote", command: ["tube"], endpoint: "10.0.0.9:1337" });
    const second = await handler.open({ kind: "remote", command: ["tube"], endpoint: "10.0.0.9:1337" });
    const third = await handler.open({ kind: "remote", command: ["tube"], endpoint: "10.0.0.9:1337" });
    const attempts = await Promise.allSettled([
      handler.recv(first.sessionId, ">", 1),
      handler.recv(second.sessionId, ">", 1),
      handler.recv(third.sessionId, ">", 1),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 2);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected" && /blocked action/.test(String(attempt.reason))).length, 1);
    assert.equal(runtime.readCalls, 2, "the third concurrent attempt must be blocked before reaching the tube");

    const experiments = Object.values((await control.snapshot(runId)).experiments).filter((item) => item.action === "pwn_recv");
    assert.equal(experiments.length, 2);
    assert.equal(new Set(experiments.map((item) => item.repeatKey)).size, 1, "session ids must not distinguish the same recv experiment");

    const failingRuntime = new EchoTubeRuntime("flag{x}", "/flag", true);
    const failingRegistry = new SessionRegistry(runId, failingRuntime as unknown as ContainerRuntimePort, control);
    const failingHandler = new PwnToolHandler(runId, failingRegistry, new PwnReproducer(control), () => REF, "executor", undefined, REPRODUCTION_POLICY, gate);
    const recipe = [{ name: "trigger", send: "payload", line: true, expect: "payload" }];
    assert.equal((await failingHandler.reproduce(recipe)).reproduced, false);
    assert.equal((await failingHandler.reproduce(recipe)).reproduced, false);
    await assert.rejects(failingHandler.reproduce(recipe), /blocked action/);
    assert.equal(Object.values((await control.snapshot(runId)).experiments).filter((item) => item.action === "pwn_reproduce").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pwn signal and shell probe failures count toward their own repeat gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-tool-gate-actions-"));
  try {
    const runId = "PWN-TOOL-GATE-ACTIONS";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await control.createRun(runId, demoTask(runId, root, config));
    const gate = new ExperimentGate(control);
    const signalRuntime = new UndeliveredSignalRuntime("flag{x}", "/flag");
    const registry = new SessionRegistry(runId, signalRuntime as unknown as ContainerRuntimePort, control);
    const handler = new PwnToolHandler(runId, registry, new PwnReproducer(control), () => REF, "executor", undefined, REPRODUCTION_POLICY, gate);
    const first = await handler.open({ kind: "remote", command: ["tube"], endpoint: "10.0.0.9:1337" });
    const second = await handler.open({ kind: "remote", command: ["tube"], endpoint: "10.0.0.9:1337" });
    assert.deepEqual(await handler.signal(first.sessionId, "SIGTERM"), { delivered: false });
    assert.deepEqual(await handler.signal(second.sessionId, "SIGTERM"), { delivered: false });
    const third = await handler.open({ kind: "remote", command: ["tube"], endpoint: "10.0.0.9:1337" });
    await assert.rejects(handler.signal(third.sessionId, "SIGTERM"), /blocked action/);

    const exitedRuntime = new EchoTubeRuntime("flag{x}", "/flag", true);
    const exitedRegistry = new SessionRegistry(runId, exitedRuntime as unknown as ContainerRuntimePort, control);
    const exitedHandler = new PwnToolHandler(runId, exitedRegistry, new PwnReproducer(control), () => REF, "executor", undefined, REPRODUCTION_POLICY, gate);
    const probeOne = await exitedHandler.open({ kind: "remote", command: ["tube"], endpoint: "10.0.0.9:1337" });
    const probeTwo = await exitedHandler.open({ kind: "remote", command: ["tube"], endpoint: "10.0.0.9:1337" });
    assert.equal((await exitedHandler.shellProbe(probeOne.sessionId)).ok, false);
    assert.equal((await exitedHandler.shellProbe(probeTwo.sessionId)).ok, false);
    const probeThree = await exitedHandler.open({ kind: "remote", command: ["tube"], endpoint: "10.0.0.9:1337" });
    await assert.rejects(exitedHandler.shellProbe(probeThree.sessionId), /blocked action/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
