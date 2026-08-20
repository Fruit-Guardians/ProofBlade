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
import type { ProofBladeConfig } from "../src/config.js";
import type { ContainerRef, ContainerRuntimePort, ContainerSessionHandle, ContainerSessionResult } from "../src/container/contracts.js";

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
  public constructor(private readonly flag: string, private readonly flagPath: string) {}
  public async openSession(ref: ContainerRef): Promise<ContainerSessionHandle> {
    const sessionId = `dxs-${++this.count}`;
    this.pending.set(sessionId, "");
    return { sessionId, ref };
  }
  public async sessionWrite(handle: ContainerSessionHandle, data: string | Uint8Array): Promise<ContainerSessionResult> {
    const text = String(data);
    const echo = /^echo (.+)\n$/.exec(text);
    const cat = /^cat (.+)\n$/.exec(text);
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
    return { delta: buffered, waitReason: buffered ? "idle" : "timeout", exited: false, exitCode: null, truncated: false };
  }
}

async function makeHandler(root: string, runId: string, flag = "flag{tool}"): Promise<{ handler: PwnToolHandler; control: ControlStore }> {
  const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
  await control.createRun(runId, demoTask(runId, root, config));
  const runtime = new EchoTubeRuntime(flag, "/flag") as unknown as ContainerRuntimePort;
  const registry = new SessionRegistry(runId, runtime, control);
  const handler = new PwnToolHandler(runId, registry, new PwnReproducer(control), () => REF, "executor");
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
    const outcome = await handler.reproduce(recipe, { kind: "remote", command: ["tube"], endpoint: "10.0.0.9:1337" });
    assert.equal(outcome.reproduced, true);
    assert.equal(outcome.flag, "flag{tool-repro}");
    const snap = await control.snapshot("PWN-TOOL-REPRO");
    assert.equal(snap.evidence[outcome.evidenceId]?.kind, "reproduction");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
