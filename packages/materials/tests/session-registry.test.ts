import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlStore } from "../src/control/control-store.js";
import { projectionHash } from "../src/control/reducer.js";
import { demoTask } from "../src/app/demo.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";
import { SessionRegistry, SessionRegistryError } from "../src/container/session-registry.js";
import type { ProofBladeConfig } from "../src/config.js";
import type {
  ContainerRef,
  ContainerRuntimePort,
  ContainerSessionHandle,
  ContainerSessionOpenOptions,
  ContainerSessionResult,
} from "../src/container/contracts.js";

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

function refAt(generation: number): ContainerRef {
  return {
    runId: "SES-TEST", generation, containerId: `c-g${generation}`, name: `c-g${generation}`,
    profile: "pwn", image: "img", imageDigest: "sha256:x",
    workspaceHostPath: "/w", workspaceContainerPath: "/workspace", networkPolicy: "none",
  };
}

/** A scripted runtime that records lifecycle calls and returns canned results. */
class FakeRuntime implements Partial<ContainerRuntimePort> {
  public opened: ContainerSessionOpenOptions[] = [];
  public closed: string[] = [];
  public writes: Array<{ id: string; data: string }> = [];
  public failOpenDispatch = false;
  private nextResult: ContainerSessionResult = { delta: "", waitReason: "idle", exited: false, exitCode: null, truncated: false };
  private counter = 0;

  public setResult(result: Partial<ContainerSessionResult>): void {
    this.nextResult = { delta: "", waitReason: "idle", exited: false, exitCode: null, truncated: false, ...result };
  }
  public async openSession(_ref: ContainerRef, options: ContainerSessionOpenOptions): Promise<ContainerSessionHandle> {
    this.opened.push(options);
    return { sessionId: `dxs-${++this.counter}`, ref: _ref };
  }
  public async sessionWrite(handle: ContainerSessionHandle, data: string | Uint8Array): Promise<ContainerSessionResult> {
    this.writes.push({ id: handle.sessionId, data: String(data) });
    return this.nextResult;
  }
  public async sessionRead(): Promise<ContainerSessionResult> { return this.nextResult; }
  public async sessionSignal(): Promise<boolean> { return true; }
  public async closeSession(handle: ContainerSessionHandle): Promise<{ exitCode: number | null }> {
    this.closed.push(handle.sessionId);
    return { exitCode: 0 };
  }
}

async function makeControl(root: string, runId: string): Promise<ControlStore> {
  const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
  await control.createRun(runId, demoTask(runId, root, config));
  return control;
}

test("session registry records open/interact/close as replayable durable events", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-session-reg-"));
  try {
    const runId = "SES-REPLAY";
    const control = await makeControl(root, runId);
    const runtime = new FakeRuntime();
    const registry = new SessionRegistry(runId, runtime as unknown as ContainerRuntimePort, control);

    const opened = await registry.open({ ref: refAt(1), kind: "pwn-remote", ownerLane: "executor", command: ["/bin/cat"], endpoint: "10.0.0.1:1337" });
    assert.equal(opened.status, "OPEN");
    assert.equal(opened.kind, "pwn-remote");
    assert.equal(opened.endpoint, "10.0.0.1:1337");
    assert.equal(opened.interactions, 0);

    (runtime as unknown as FakeRuntime).setResult({ delta: "flag{x}", waitReason: "idle" });
    const w = await registry.write("executor", opened.id, "cat flag\n");
    assert.equal(w.delta, "flag{x}");

    const afterWrite = await control.snapshot(runId);
    assert.equal(afterWrite.sessions[opened.id]?.interactions, 1);
    assert.equal(afterWrite.sessions[opened.id]?.lastWaitReason, "idle");

    await registry.close("executor", opened.id, "done");
    const finalSnap = await control.snapshot(runId);
    assert.equal(finalSnap.sessions[opened.id]?.status, "CLOSED");
    assert.equal(finalSnap.sessions[opened.id]?.closeReason, "done");

    // Deterministic replay: a fresh store reading the same events yields the same hash.
    const replayControl = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const replayed = await replayControl.snapshot(runId);
    assert.equal(projectionHash(replayed), projectionHash(finalSnap));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session registry rejects cross-lane access with a stable code", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-session-owner-"));
  try {
    const runId = "SES-OWNER";
    const control = await makeControl(root, runId);
    const runtime = new FakeRuntime() as unknown as ContainerRuntimePort;
    const registry = new SessionRegistry(runId, runtime, control);
    const opened = await registry.open({ ref: refAt(1), kind: "pwn-local", ownerLane: "executor", command: ["/bin/sh"] });

    await assert.rejects(
      registry.write("verifier", opened.id, "id\n"),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "FOREIGN_SESSION",
    );
    await assert.rejects(
      registry.write("executor", "SES-nonexistent", "id\n"),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "NO_SESSION",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session marked exited when the runtime reports process exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-session-exit-"));
  try {
    const runId = "SES-EXIT";
    const control = await makeControl(root, runId);
    const runtime = new FakeRuntime();
    const registry = new SessionRegistry(runId, runtime as unknown as ContainerRuntimePort, control);
    const opened = await registry.open({ ref: refAt(1), kind: "pwn-local", ownerLane: "executor", command: ["/bin/sh"] });
    (runtime as unknown as FakeRuntime).setResult({ delta: "bye\n", waitReason: "exit", exited: true, exitCode: 3 });
    await registry.read("executor", opened.id);
    const snap = await control.snapshot(runId);
    assert.equal(snap.sessions[opened.id]?.status, "EXITED");
    assert.equal(snap.sessions[opened.id]?.exitCode, 3);
    await assert.rejects(
      registry.write("executor", opened.id, "after-exit\n"),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "NOT_OPEN",
    );
    await registry.close("executor", opened.id, "cleanup exited session");
    assert.deepEqual(runtime.closed, ["dxs-1"]);
    assert.equal((await control.snapshot(runId)).sessions[opened.id]?.status, "CLOSED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supersedeStale marks old-generation sessions superseded without reviving them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-session-super-"));
  try {
    const runId = "SES-SUPER";
    const control = await makeControl(root, runId);
    const runtime = new FakeRuntime() as unknown as ContainerRuntimePort;
    const registry = new SessionRegistry(runId, runtime, control);
    const stale = await registry.open({ ref: refAt(1), kind: "pwn-remote", ownerLane: "executor", command: ["/bin/cat"] });

    const superseded = await registry.supersedeStale(2);
    assert.equal(superseded, 1);
    const snap = await control.snapshot(runId);
    assert.equal(snap.sessions[stale.id]?.status, "SUPERSEDED");

    // A superseded session is no longer live: further writes are rejected.
    await assert.rejects(
      registry.write("executor", stale.id, "x\n"),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "NO_SESSION",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disposeAll closes every live session's runtime process and marks it CLOSED (lane shutdown)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-session-dispose-"));
  try {
    const runId = "SES-DISPOSE";
    const control = await makeControl(root, runId);
    const runtime = new FakeRuntime();
    const registry = new SessionRegistry(runId, runtime as unknown as ContainerRuntimePort, control);
    const a = await registry.open({ ref: refAt(1), kind: "pwn-remote", ownerLane: "executor", command: ["tube"] });
    const b = await registry.open({ ref: refAt(1), kind: "pwn-local", ownerLane: "executor", command: ["sh"] });
    runtime.setResult({ exited: true, waitReason: "exit", exitCode: 0 });
    await registry.read("executor", a.id);

    await registry.disposeAll("lane shutdown");

    // Both runtime children were closed (no orphaned docker-exec host process).
    assert.equal(runtime.closed.length, 2);
    // Both durable sessions are CLOSED, not left OPEN.
    const snap = await control.snapshot(runId);
    assert.equal(snap.sessions[a.id]?.status, "CLOSED");
    assert.equal(snap.sessions[b.id]?.status, "CLOSED");
    // Idempotent: a second disposeAll is a no-op (nothing live or exited left).
    await registry.disposeAll("lane shutdown");
    assert.equal(runtime.closed.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supersedeOrphans marks same-generation OPEN sessions dead after a process restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-session-orphan-"));
  try {
    const runId = "SES-ORPHAN";
    const control = await makeControl(root, runId);
    const runtime = new FakeRuntime() as unknown as ContainerRuntimePort;
    // First "process": opens a session at generation 1 and then the process dies
    // (we simply drop this registry without closing).
    const first = new SessionRegistry(runId, runtime, control);
    const opened = await first.open({ ref: refAt(1), kind: "pwn-remote", ownerLane: "executor", command: ["tube"] });
    assert.equal((await control.snapshot(runId)).sessions[opened.id]?.status, "OPEN");

    // Second "process": a fresh registry recovers the SAME run at the SAME
    // generation. Its live map is empty, so the durable OPEN session is an
    // orphan whose docker-exec child is gone.
    const second = new SessionRegistry(runId, runtime, control);
    const superseded = await second.supersedeOrphans();
    assert.equal(superseded, 1);
    assert.equal((await control.snapshot(runId)).sessions[opened.id]?.status, "SUPERSEDED");

    // A session the fresh registry actually owns is NOT superseded.
    const live = await second.open({ ref: refAt(1), kind: "pwn-local", ownerLane: "executor", command: ["sh"] });
    assert.equal(await second.supersedeOrphans(), 0);
    assert.equal((await control.snapshot(runId)).sessions[live.id]?.status, "OPEN");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed durable open rolls back the runtime process", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-session-rollback-"));
  try {
    const runId = "SES-ROLLBACK";
    const control = await makeControl(root, runId);
    const runtime = new FakeRuntime();
    // Force the durable dispatch to fail by closing the run first is complex; instead
    // wrap control so session_opened throws, proving the runtime child is closed.
    const failing = {
      snapshot: control.snapshot.bind(control),
      dispatch: async (rid: string, cmd: { type: string }) => {
        if (cmd.type === "session_opened") throw new Error("durable write failed");
        return control.dispatch(rid, cmd as never);
      },
    } as unknown as ControlStore;
    const registry = new SessionRegistry(runId, runtime as unknown as ContainerRuntimePort, failing);
    await assert.rejects(registry.open({ ref: refAt(1), kind: "pwn-local", ownerLane: "executor", command: ["/bin/sh"] }), /durable write failed/);
    assert.equal(runtime.closed.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
