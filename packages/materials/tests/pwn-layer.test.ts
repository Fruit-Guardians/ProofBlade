import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlStore } from "../src/control/control-store.js";
import { demoTask } from "../src/app/demo.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";
import { ArtifactStore } from "../src/effects/artifact-store.js";
import { CodingEvidenceGraph } from "../src/knowledge/evidence-graph.js";
import { SessionRegistry } from "../src/container/session-registry.js";
import { PwnSession } from "../src/pwn/pwn-session.js";
import { PwnReproducer, type ExploitRecipe } from "../src/verification/pwn-reproducer.js";
import { parseLeakAddress, parseLeakHex, deriveBase, deriveBaseRecord, toHex, isPageAligned } from "../src/pwn/leak.js";
import { compileSafeFlagPattern, matchFlagBounded } from "../src/pwn/pattern.js";
import type { ProofBladeConfig } from "../src/config.js";
import type {
  ContainerRef,
  ContainerRuntimePort,
  ContainerSessionHandle,
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

const REF: ContainerRef = {
  runId: "PWN", generation: 1, containerId: "c1", name: "c1", profile: "pwn",
  image: "img", imageDigest: "sha256:x", workspaceHostPath: "/w", workspaceContainerPath: "/workspace", networkPolicy: "none",
};

/**
 * An in-memory echo-shell tube: `echo X` returns X, `cat <flagPath>` returns the
 * configured flag, and anything else echoes back so send anchors match. This
 * models a real interactive shell closely enough to exercise recvUntil and the
 * reproducer barriers deterministically. Set `dieAfter` to simulate an EOF/exit
 * before the shell marker (the failure the barrier must reject).
 */
class EchoTubeRuntime implements Partial<ContainerRuntimePort> {
  private pending = new Map<string, string>();
  private exited = new Set<string>();
  private writeCount = new Map<string, number>();
  public constructor(private readonly flag: string, private readonly flagPath: string, private readonly dieAfter?: number) {}

  public async openSession(ref: ContainerRef): Promise<ContainerSessionHandle> {
    const sessionId = `dxs-${this.pending.size + 1}-${Math.random().toString(36).slice(2, 8)}`;
    this.pending.set(sessionId, "");
    this.writeCount.set(sessionId, 0);
    void ref;
    return { sessionId, ref };
  }
  public async sessionWrite(handle: ContainerSessionHandle, data: string | Uint8Array): Promise<ContainerSessionResult> {
    const text = String(data);
    const count = (this.writeCount.get(handle.sessionId) ?? 0) + 1;
    this.writeCount.set(handle.sessionId, count);
    if (this.dieAfter !== undefined && count > this.dieAfter) {
      this.exited.add(handle.sessionId);
      return { delta: "", waitReason: "exit", exited: true, exitCode: 1, truncated: false };
    }
    let out: string;
    const echo = /^echo (.+)\n$/.exec(text);
    const cat = /^cat '?([^'\n]+)'?\n$/.exec(text);
    if (echo) out = `${echo[1]}\n`;
    else if (cat) out = cat[1]!.trim() === this.flagPath ? `${this.flag}\n` : "No such file\n";
    else out = text;
    this.pending.set(handle.sessionId, (this.pending.get(handle.sessionId) ?? "") + out);
    return this.drain(handle.sessionId);
  }
  public async sessionRead(handle: ContainerSessionHandle): Promise<ContainerSessionResult> {
    if (this.exited.has(handle.sessionId)) return { delta: "", waitReason: "exit", exited: true, exitCode: 1, truncated: false };
    return this.drain(handle.sessionId);
  }
  public async sessionSignal(): Promise<boolean> { return true; }
  public async closeSession(): Promise<{ exitCode: number | null }> { return { exitCode: 0 }; }
  private drain(sessionId: string): ContainerSessionResult {
    const buffered = this.pending.get(sessionId) ?? "";
    this.pending.set(sessionId, "");
    return { delta: buffered, waitReason: buffered ? "idle" : "timeout", exited: false, exitCode: null, truncated: false };
  }
}

async function makeControl(root: string, runId: string): Promise<ControlStore> {
  const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
  await control.createRun(runId, demoTask(runId, root, config));
  return control;
}

test("leak parsing handles little/big-endian 32/64-bit and base derivation", () => {
  const bytes = new Uint8Array([0x30, 0xf4, 0xe1, 0xf7, 0xff, 0x7f, 0x00, 0x00]);
  const leaked = parseLeakAddress(bytes, "le64");
  assert.equal(toHex(leaked), "0x7ffff7e1f430");
  assert.equal(toHex(parseLeakAddress(new Uint8Array([0xef, 0xbe, 0xad, 0xde]), "le32")), "0xdeadbeef");
  assert.equal(toHex(parseLeakAddress(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), "be32")), "0xdeadbeef");
  // parseLeakHex treats the hex as raw wire bytes (same order as the buffer form).
  assert.equal(toHex(parseLeakHex("30f4e1f7ff7f0000", "le64")), "0x7ffff7e1f430");
  // libc base = leaked puts - puts offset; result should be page-aligned.
  const base = deriveBase(leaked, 0x84420n);
  assert.equal(toHex(base), "0x7ffff7d9b010");
  assert.equal(isPageAligned(0x7ffff7d9b000n), true);
  assert.equal(isPageAligned(base), false);
  assert.throws(() => parseLeakAddress(new Uint8Array([1, 2]), "le64"), /needs 8 bytes/);
  assert.throws(() => deriveBase(0x1000n, 0x2000n), /negative/);
});

test("recordLeak persists an idempotent reasoning node and makes it searchable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-leak-graph-"));
  try {
    const runId = "PWN-LEAK-GRAPH";
    const control = await makeControl(root, runId);
    const graph = new CodingEvidenceGraph(runId, control, new ArtifactStore(root, control));
    const leak = {
      id: "LEAK-LIBC-1",
      sourceHex: "30f4e1f7ff7f0000",
      format: "le64" as const,
      value: "0x7ffff7e1f430",
      addressKind: "libc" as const,
      symbol: "puts@GLIBC",
      confidence: 0.95,
    };
    const first = await graph.recordLeak({ leak, tags: ["base-formula"], explanation: "puts leak is consistent with the libc image." });
    assert.equal(first.reused, false);
    assert.equal(first.node.id, leak.id);
    assert.equal(first.node.kind, "inference");
    assert.equal(first.node.status, "CONFIRMED");
    assert.match(first.node.summary, /0x7ffff7e1f430/);
    assert.ok(first.node.tags.includes("base-formula"));

    const base = deriveBaseRecord(leak, { id: "LEAK-LIBC-BASE", knownOffset: 0x84420n, label: "libc_base" });
    const baseNode = await graph.recordLeak({ leak: base, tags: ["base-formula"] });
    assert.match(baseNode.node.summary, /formula=libc_base = LEAK-LIBC-1/);

    const second = await graph.recordLeak({ leak, tags: ["base-formula"], explanation: "same observation" });
    assert.equal(second.reused, true);
    assert.equal(second.node.createdSeq, first.node.createdSeq);

    const results = await graph.search("puts 0x7ffff7e1f430");
    assert.ok(results.some((item) => item.id === leak.id && item.kind === "reasoning_node"));

    await assert.rejects(
      graph.recordLeak({ leak: { ...leak, value: "0x41414141" }, tags: ["base-formula"] }),
      /different contents/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PwnSession recvUntil accumulates across reads and shellProbe confirms a live marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-sess-"));
  try {
    const runId = "PWN-SESS";
    const control = await makeControl(root, runId);
    const runtime = new EchoTubeRuntime("flag{unit}", "/flag") as unknown as ContainerRuntimePort;
    const registry = new SessionRegistry(runId, runtime, control);
    const session = await PwnSession.openRemote(registry, { ref: REF, ownerLane: "executor", command: ["tube"], endpoint: "10.0.0.9:1337" });

    const banner = await session.sendLine("MENU");
    assert.match(banner.data, /MENU/);
    const probe = await session.shellProbe();
    assert.equal(probe.ok, true);
    assert.match(session.log, new RegExp(probe.marker));
    await session.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PwnReproducer produces a candidate only when shell marker AND flag both succeed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-repro-ok-"));
  try {
    const runId = "PWN-REPRO-OK";
    const control = await makeControl(root, runId);
    const runtime = new EchoTubeRuntime("flag{repro-ok}", "/flag") as unknown as ContainerRuntimePort;
    const registry = new SessionRegistry(runId, runtime, control);
    const reproducer = new PwnReproducer(control);
    const recipe: ExploitRecipe = {
      stages: [{ name: "trigger", send: "payload", line: true, expect: "payload" }],
      flagPath: "/flag",
      flagPattern: "flag\\{[^}]+\\}",
    };
    const outcome = await reproducer.reproduce(runId, recipe, () => PwnSession.openRemote(registry, { ref: REF, ownerLane: "executor", command: ["tube"], endpoint: "10.0.0.9:1337" }));
    assert.equal(outcome.reproduced, true);
    assert.equal(outcome.shellConfirmed, true);
    assert.equal(outcome.flag, "flag{repro-ok}");
    const snap = await control.snapshot(runId);
    assert.equal(snap.evidence[outcome.evidenceId]?.kind, "reproduction");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("flag pattern compiler rejects ReDoS shapes and bounds the match window", () => {
  // A normal anchored flag pattern compiles and matches.
  const ok = compileSafeFlagPattern("flag\\{[^}]+\\}");
  assert.ok(matchFlagBounded(ok, "noise flag{good} tail"));

  // Classic catastrophic-backtracking shapes are rejected before compilation.
  assert.throws(() => compileSafeFlagPattern("(a+)+$"), /catastrophic backtracking/);
  assert.throws(() => compileSafeFlagPattern("(a|aa)+"), /catastrophic backtracking/);
  // Over-long patterns are rejected.
  assert.throws(() => compileSafeFlagPattern("a".repeat(300)), /at most/);

  // The match window is bounded: a match far from the tail of a huge transcript
  // is not scanned (flag is always at the tail after a cat), but a tail match is.
  const huge = "X".repeat(200_000);
  assert.equal(matchFlagBounded(ok, "flag{early}" + huge), null, "beyond the window is not matched");
  assert.ok(matchFlagBounded(ok, huge + "flag{late}"), "a tail match still works");
});

test("readFlag rejects an injecting flagPath so a fake echoed flag is not accepted", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-inject-"));
  try {
    const runId = "PWN-INJECT";
    const control = await makeControl(root, runId);
    // The tube echoes whatever is written; a `cat X; echo flag{fake}` would echo
    // the literal and the pattern would "match" — unless the path is rejected.
    const runtime = new EchoTubeRuntime("flag{real-only-here}", "/flag") as unknown as ContainerRuntimePort;
    const registry = new SessionRegistry(runId, runtime, control);
    const session = await PwnSession.openRemote(registry, { ref: REF, ownerLane: "executor", command: ["tube"], endpoint: "10.0.0.9:1337" });
    await assert.rejects(
      session.readFlag("/flag; echo flag{fake}", /flag\{[^}]+\}/),
      /disallowed characters/,
    );
    // A clean path still works.
    const ok = await session.readFlag("/flag", /flag\{[^}]+\}/);
    assert.equal(ok.flag, "flag{real-only-here}");
    await session.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PwnReproducer records negative evidence when the process dies before the shell marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-pwn-repro-die-"));
  try {
    const runId = "PWN-REPRO-DIE";
    const control = await makeControl(root, runId);
    // dieAfter=1: the first stage send works, but the shell probe write kills it.
    const runtime = new EchoTubeRuntime("flag{never}", "/flag", 1) as unknown as ContainerRuntimePort;
    const registry = new SessionRegistry(runId, runtime, control);
    const reproducer = new PwnReproducer(control);
    const recipe: ExploitRecipe = {
      stages: [{ name: "trigger", send: "payload", line: true, expect: "payload" }],
      flagPath: "/flag",
      flagPattern: "flag\\{[^}]+\\}",
    };
    const outcome = await reproducer.reproduce(runId, recipe, () => PwnSession.openRemote(registry, { ref: REF, ownerLane: "executor", command: ["tube"], endpoint: "10.0.0.9:1337" }));
    assert.equal(outcome.reproduced, false);
    assert.equal(outcome.shellConfirmed, false);
    assert.equal(outcome.flag, undefined);
    const snap = await control.snapshot(runId);
    assert.equal(snap.evidence[outcome.evidenceId]?.kind, "negative");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
