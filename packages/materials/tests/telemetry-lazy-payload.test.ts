import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../src/control/control-store.js";
import { ControlEventBatcher } from "../src/observability/pi-events.js";
import { demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";

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

const secret = "telemetry-lazy-secret-0123456789abcdef";

async function run(runId: string) {
  const root = await mkdtemp(join(tmpdir(), "proofblade-telemetry-lazy-"));
  const runsRoot = join(root, config.storage.runsDir);
  const control = new ControlStore(new JsonlControlStore(runsRoot), undefined, secret);
  await control.createRun(runId, demoTask(runId, root, config));
  return { root, control, eventsPath: join(runsRoot, runId, "events.jsonl") };
}

async function events(path: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  try {
    const text = await readFile(path, "utf8");
    return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
  } catch {
    return [];
  }
}

test("a deferred payload is not resolved until the batch is drained", async () => {
  // The whole point: telemetry enrichment must not run on the caller's path.
  const { root, control, eventsPath } = await run("TELEM-1");
  try {
    const batcher = new ControlEventBatcher(control, "TELEM-1", "main");
    let resolved = 0;
    batcher.append("tool_result_recorded", "tool", { toolCallId: "c1" }, async () => {
      resolved += 1;
      return { artifactHashes: ["hash-1"] };
    });

    assert.equal(resolved, 0, "the resolver must not run during append");
    assert.equal((await events(eventsPath)).filter((event) => event.type === "tool_result_recorded").length, 0, "the event must not be written synchronously");

    await batcher.flush();
    assert.equal(resolved, 1, "the resolver must run exactly once, at drain time");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the drained event carries the deferred fields merged into its payload", async () => {
  const { root, control, eventsPath } = await run("TELEM-2");
  try {
    const batcher = new ControlEventBatcher(control, "TELEM-2", "main");
    batcher.append("tool_result_recorded", "tool", { toolCallId: "c1", isError: false }, async () => ({ artifactHashes: ["hash-1"], evidenceAdded: true }));
    await batcher.flush();

    const recorded = (await events(eventsPath)).find((event) => event.type === "tool_result_recorded");
    assert.ok(recorded, "the event must be in the log after the flush");
    assert.equal(recorded.payload.toolCallId, "c1");
    assert.equal(recorded.payload.isError, false);
    assert.deepEqual(recorded.payload.artifactHashes, ["hash-1"]);
    assert.equal(recorded.payload.evidenceAdded, true);
    // The resolver itself must never reach the event log.
    assert.equal("resolve" in recorded.payload, false);
    assert.equal("resolve" in recorded, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a throwing resolver keeps the event and drops only the enrichment", async () => {
  // Telemetry is fail-soft: an enrichment failure must not lose the event, and
  // must never surface to the caller.
  const { root, control, eventsPath } = await run("TELEM-3");
  try {
    const batcher = new ControlEventBatcher(control, "TELEM-3", "main");
    batcher.append("tool_result_recorded", "tool", { toolCallId: "c1" }, async () => {
      throw new Error("snapshot unavailable");
    });
    await batcher.flush();

    const recorded = (await events(eventsPath)).find((event) => event.type === "tool_result_recorded");
    assert.ok(recorded, "the event must still be recorded");
    assert.equal(recorded.payload.toolCallId, "c1");
    assert.equal("artifactHashes" in recorded.payload, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an event without a resolver is written unchanged", async () => {
  const { root, control, eventsPath } = await run("TELEM-4");
  try {
    const batcher = new ControlEventBatcher(control, "TELEM-4", "main");
    batcher.append("tool_call_recorded", "model", { toolCallId: "c1", waitMs: 3 });
    await batcher.flush();

    const recorded = (await events(eventsPath)).find((event) => event.type === "tool_call_recorded");
    assert.ok(recorded);
    assert.equal(recorded.payload.waitMs, 3);
    assert.equal("resolve" in recorded.payload, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolvers run once per sampled event in a batched drain", async () => {
  const { root, control, eventsPath } = await run("TELEM-5");
  try {
    const batcher = new ControlEventBatcher(control, "TELEM-5", "main");
    let resolved = 0;
    for (let index = 0; index < 5; index += 1) {
      batcher.append("tool_result_recorded", "tool", { toolCallId: `c${index}` }, async () => {
        resolved += 1;
        return { artifactHashes: [`hash-${index}`] };
      });
    }
    await batcher.flush();

    assert.equal(resolved, 5);
    const recorded = (await events(eventsPath)).filter((event) => event.type === "tool_result_recorded");
    assert.equal(recorded.length, 5);
    assert.deepEqual(recorded.map((event) => (event.payload.artifactHashes as string[])[0]).sort(), ["hash-0", "hash-1", "hash-2", "hash-3", "hash-4"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("flush is a barrier: nothing queued remains after it resolves", async () => {
  const { root, control, eventsPath } = await run("TELEM-6");
  try {
    const batcher = new ControlEventBatcher(control, "TELEM-6", "main");
    batcher.append("tool_result_recorded", "tool", { toolCallId: "c1" }, async () => ({ evidenceAdded: false }));
    await batcher.flush();

    const recorded = (await events(eventsPath)).filter((event) => event.type === "tool_result_recorded");
    assert.equal(recorded.length, 1, "the barrier must leave the event durable");
    assert.equal(recorded[0]?.payload.evidenceAdded, false, "a false enrichment value must survive the merge");
    assert.equal(batcher.pending(), 0, "a successful flush leaves nothing owed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("flush is best-effort: a failed batch stays owed and is still reported", async () => {
  // "flush is a barrier" is only true when the append succeeds. Telemetry is
  // fail-soft, so a failed batch goes back on the queue for a timer retry and
  // flush() resolves anyway — callers that need to know check pending().
  const { root, control, eventsPath } = await run("TELEM-7");
  try {
    const batcher = new ControlEventBatcher(control, "TELEM-7", "main");
    const append = control.append.bind(control);
    control.append = (async () => { throw new Error("event log unavailable"); }) as typeof control.append;
    batcher.append("tool_result_recorded", "tool", { toolCallId: "c1" });
    await batcher.flush();

    assert.equal(batcher.pending(), 1, "a failed append must stay queued rather than vanish");
    assert.equal(
      (await events(eventsPath)).filter((event) => event.type === "tool_result_recorded").length,
      0,
      "nothing may reach the log while the append is failing",
    );

    control.append = append;
    await batcher.flush();
    assert.equal(batcher.pending(), 0);
    assert.equal((await events(eventsPath)).filter((event) => event.type === "tool_result_recorded").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the coding lane owns exactly one telemetry queue", async () => {
  // A second `ControlEventBatcher` in the lane used to take priority inside
  // `attachPiObservability` and orphan `scheduling.batcher`, leaving two flush
  // barriers racing over one event log. This is a source-shape guard because the
  // original defect was a wiring mistake, not a control-flow one.
  const source = await readFile(join(import.meta.dirname, "../src/runtime/coding-lane.ts"), "utf8");
  assert.doesNotMatch(source, /new ControlEventBatcher\(/, "the lane must not build its own telemetry queue");
  assert.match(source, /scheduling\.batcher\.pending\(\)/, "the lane's close barrier must read the shared queue");
});
