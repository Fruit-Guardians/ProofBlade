import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../src/control/control-store.js";
import { demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";

/**
 * Barrier cost discipline (PLAN-240, the follow-up the replay-fallback baseline
 * called for).
 *
 * `flushProjection()` used to answer "is the on-disk projection already current?"
 * with `loadProjection()`, which parses the whole event stream and re-hashes the
 * complete event prefix to revalidate the seal -- measured 13ms at 100 events and
 * 328ms at 10,000. In deferred mode the answer is nearly always "not current", so
 * that cost was paid to avoid a write that was going to happen anyway.
 *
 * These assert the ordering, not a duration: the cheap check must come first, and
 * a barrier must still persist the projection.
 */

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "TEST_API_KEY",
      contextWindow: 4096,
      maxTokens: 512,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      input: ["text"],
    },
  },
};

const secret = "barrier-cost-secret-0123456789abcdef";

async function run(runId: string) {
  const root = await mkdtemp(join(tmpdir(), "proofblade-barrier-"));
  const runsRoot = join(root, config.storage.runsDir);
  const control = new ControlStore(new JsonlControlStore(runsRoot), undefined, secret);
  await control.createRun(runId, demoTask(runId, root, config));
  return { root, runsRoot, control, projectionPath: join(runsRoot, runId, "projection.json") };
}

/** Append one deferred (hot-path style) telemetry event. */
function deferred(control: ControlStore, runId: string, index: number) {
  return control.append(runId, [{
    schemaVersion: 1,
    lane: "executor",
    correlationId: `barrier-${index}`,
    actor: "tool",
    type: "tool_result_recorded",
    payload: { toolCallId: `c${index}`, toolName: "read", outputBytes: 64, isError: false },
  }], { persistProjection: false });
}

test("[contract:barrier-persists-deferred-projection] a barrier writes the projection a deferred commit left stale", async () => {
  const { root, control, projectionPath } = await run("BARRIER-1");
  try {
    const before = await stat(projectionPath);
    for (let index = 0; index < 3; index += 1) await deferred(control, "BARRIER-1", index);

    await control.flushProjection("BARRIER-1");

    // Size is not the signal: these events are telemetry and do not fold into the
    // snapshot, so a rewrite can produce an identically sized file. The write
    // itself is what the barrier owes, so compare mtime.
    const after = await stat(projectionPath);
    assert.ok(after.size > 0, "the barrier must leave a projection on disk");
    assert.ok(after.mtimeMs > before.mtimeMs, "the barrier must have rewritten the stale projection");

    // The flushed projection must be the current state, not an older prefix.
    const snapshot = await control.snapshot("BARRIER-1");
    const sealed = JSON.parse(await readFile(projectionPath, "utf8")) as { lastSeq?: number };
    assert.equal(sealed.lastSeq, snapshot.lastSeq, "the projection must cover the latest sequence");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a barrier is a no-op once the projection is current again", async () => {  const { root, control, projectionPath } = await run("BARRIER-2");
  try {
    await deferred(control, "BARRIER-2", 1);
    await control.flushProjection("BARRIER-2");

    // Re-defer, then flush: this barrier DOES owe a write, because the deferred
    // event moved the stream past the projection.
    await deferred(control, "BARRIER-2", 2);
    await control.flushProjection("BARRIER-2");
    const settled = await stat(projectionPath);

    // Nothing is deferred now. This pins only the cheap early return at
    // `flushProjection`'s `deferredProjectionRuns` guard -- NOT the
    // `#projectionAlreadyCurrent()` check further in. Mutating that check to
    // always report "not current" still leaves this test green, because the
    // guard returns first. See the note below.
    await control.flushProjection("BARRIER-2");
    const after = await stat(projectionPath);

    assert.ok(after.size > 0);
    assert.equal(after.mtimeMs, settled.mtimeMs, "a current projection must not be rewritten");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * NOT PINNED HERE, deliberately -- and the gap is larger than it first looked.
 *
 * The barrier-cost fix moves `#projectionAlreadyCurrent()` ahead of
 * `loadProjection()`, which parses the whole event stream and re-hashes the
 * complete event prefix (13ms at 100 events, 328ms at 10,000).
 *
 * Three mutations were run against these tests, and NO test caught the third:
 *   * disable the memoised version cache      -> caught (version-cache.test.ts)
 *   * serve a rejected build from cache       -> caught (version-cache.test.ts)
 *   * make `#projectionAlreadyCurrent` always report "not current" -> NOT caught
 *
 * The reason is not a weak assertion but an unreachable path: a deferred append
 * moves the stream past the projection, so by the time the barrier reaches that
 * check in deferred mode the answer is always "not current". Reachability was
 * not established, so the check may be dead in practice -- if so, the fix's real
 * saving comes from `loadProjection` being avoided on the absent/stale-hint
 * path, not from this predicate.
 *
 * Pinning it needs a hash-call or hashed-event counter on the barrier path (a
 * source instrument, not an assertion) plus a reachability case. Both belong in
 * their own change rather than being smuggled in here as a test that cannot
 * fail.
 *
 * What IS pinned: an already-current projection is not rewritten, and a stale
 * one is persisted.
 */

test("a barrier repairs a deleted projection rather than throwing", async () => {
  // The cheap check must fail closed: no projection file means "not current",
  // which routes to the write instead of silently reporting success.
  const { root, control, projectionPath } = await run("BARRIER-3");
  try {
    await deferred(control, "BARRIER-3", 1);
    await unlink(projectionPath);

    await control.flushProjection("BARRIER-3");

    const repaired = JSON.parse(await readFile(projectionPath, "utf8")) as { lastSeq?: number; proofbladeProjectionSeal?: unknown };
    assert.ok(repaired.proofbladeProjectionSeal, "a repaired projection must be sealed");
    assert.equal(repaired.lastSeq, (await control.snapshot("BARRIER-3")).lastSeq);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a barrier leaves a tampered projection replaced, not trusted", async () => {
  // The cheap check authenticates the projection file itself, so a tampered body
  // must not be mistaken for current state.
  const { root, control, projectionPath } = await run("BARRIER-4");
  try {
    await deferred(control, "BARRIER-4", 1);
    await control.flushProjection("BARRIER-4");

    const original = JSON.parse(await readFile(projectionPath, "utf8")) as Record<string, unknown>;
    await writeFile(projectionPath, JSON.stringify({ ...original, status: "FINISHED" }), "utf8");

    await deferred(control, "BARRIER-4", 2);
    await control.flushProjection("BARRIER-4");

    const settled = JSON.parse(await readFile(projectionPath, "utf8")) as { status?: string };
    const snapshot = await control.snapshot("BARRIER-4");
    assert.equal(settled.status, snapshot.status, "the barrier must persist real state over a tampered file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("flushing a run with nothing deferred does not touch the projection", async () => {
  const { root, control, projectionPath } = await run("BARRIER-5");
  try {
    const before = await stat(projectionPath);
    await control.flushProjection("BARRIER-5");
    const after = await stat(projectionPath);

    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs, "a run with no deferred writes must not be rewritten");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
