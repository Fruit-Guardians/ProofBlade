import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlStore } from "../src/control/control-store.js";
import { demoTask } from "../src/app/demo.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";
import { SessionRegistry } from "../src/container/session-registry.js";
import { PwnReproducer } from "../src/verification/pwn-reproducer.js";
import { PwnToolHandler } from "../src/pwn/pwn-tools.js";
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
  public constructor(private readonly flag: string, private readonly flagPath: string) {}
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
    return { delta: buffered, waitReason: buffered ? "idle" : "timeout", exited: false, exitCode: null, truncated: false };
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
    /no Docker-backed pwn container|unavailable/,
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

test("pwn_reproduce routes to the barrier-gated verifier", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-ct-repro-"));
  try {
    const runId = "PWN-CT-REPRO";
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await control.createRun(runId, demoTask(runId, root, config));
    const runtime = new EchoTubeRuntime("flag{ct-repro}", "/flag") as unknown as ContainerRuntimePort;
    const registry = new SessionRegistry(runId, runtime, control);
    const handler = new PwnToolHandler(runId, registry, new PwnReproducer(control), () => REF, "executor", undefined, REPRODUCTION_POLICY);
    const result = await toolByName("pwn_reproduce").execute!("t1", {
      stages: [{ name: "trigger", send: "payload", line: true, expect: "payload" }],
    }, new AbortController().signal, () => {}, contextWith(handler));
    assert.equal(result.isError, false);
    assert.equal((result.details as { reproduced: boolean; flag?: string }).reproduced, true);
    assert.equal((result.details as { flag?: string }).flag, "flag{ct-repro}");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pwn_reproduce schema exposes stages only", () => {
  const schema = toolByName("pwn_reproduce").parameters as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(schema.properties), ["stages"]);
});
