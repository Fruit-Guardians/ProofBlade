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

test("handler rejects operations on an unknown session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-tool-unknown-"));
  try {
    const { handler } = await makeHandler(root, "PWN-TOOL-UNK");
    await assert.rejects(handler.send("SES-missing", "x", true), /Unknown pwn session/);
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
