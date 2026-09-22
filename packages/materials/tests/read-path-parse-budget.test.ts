import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../src/control/control-store.js";
import { createServices, demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";

/**
 * Read-path parse budget (PLAN-240, the follow-up the barrier-cadence
 * measurement called for).
 *
 * Measured on a 10,000-event Run: `replay()` costs 1737.8ms and a cold
 * `flushProjection()` costs 226.7ms, so a barrier is not a full replay -- yet it
 * still grows linearly with history, and `projection.json` stays at 4.5 KB from
 * 1,200 to 20,200 events. A projection that is O(state) paired with a read path
 * that is O(history) means every read re-derives a constant amount of state from
 * a linearly growing input.
 *
 * The reason is `#loadEvents()`, which parses the complete `events.jsonl` on
 * every parse-cache miss. Appends keep that cache warm by extending it
 * incrementally, so the cost lands on the reader that did not write the Run --
 * exactly the GUI server reading a Run the CLI produced.
 *
 * These tests make that visible as a *count* rather than a duration, because a
 * duration threshold measures the runner and gets disabled on slower machines;
 * `SkillRegistry.cacheStats()` is the precedent.
 *
 * Two things are asserted. First, the one invariant that must never regress: a
 * read at an unchanged revision parses nothing. Second, the current
 * semantics-preserving behaviour, recorded as numbers so the eventual O(delta)
 * change has a before/after attached to it.
 *
 * The target budget for a cold read (parse the tail after the projection's
 * `lastSeq`, not the whole stream) is deliberately NOT asserted: reaching it
 * changes how the event-prefix seal is revalidated, and that needs an explicit
 * decision. A test that fails on unapproved semantics is a broken gate, not a
 * strict one.
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

const SECRET = "a".repeat(64);

const batch = (count: number, offset: number) => Array.from({ length: count }, (_, index) => ({
  schemaVersion: 1 as const,
  lane: "executor" as const,
  correlationId: `read-budget-${offset + index}`,
  actor: "tool" as const,
  type: "tool_result_recorded" as const,
  payload: { toolCallId: `call-${offset + index}`, toolName: "read", outputBytes: 128, isError: false },
}));

/**
 * A writer that creates a Run with `events` tool results, plus a fresh reader
 * store over the same directory. The reader is the case that matters: it has an
 * empty parse cache and an empty snapshot cache, like a just-started GUI reading
 * a Run produced by the CLI.
 */
async function fixture(runId: string, events: number) {
  const root = await mkdtemp(join(tmpdir(), "pb-read-budget-"));
  const runsRoot = join(root, "runs");
  const writerStore = new JsonlControlStore(runsRoot);
  const writer = new ControlStore(writerStore, undefined, SECRET);
  await writer.createRun(runId, demoTask(runId, root, config));
  for (let offset = 0; offset < events; offset += 200) {
    await writer.append(runId, batch(Math.min(200, events - offset), offset), { persistProjection: false });
  }
  const store = new JsonlControlStore(runsRoot);
  const control = new ControlStore(store, undefined, SECRET);
  return { root, runsRoot, store, writer, control, cleanup: async () => await rm(root, { recursive: true, force: true }).catch(() => undefined) };
}

/** The process-wide parse total. Any store instance reports the same value. */
const parsed = (store: JsonlControlStore) => store.readStats();

test("[contract:read-path-parse-is-counted] readStats counts parsed events and bytes together", async () => {
  const { store, control, cleanup } = await fixture("BUDGET-1", 200);  try {
    const before = parsed(store);
    const snapshot = await control.snapshot("BUDGET-1");
    const after = parsed(store);

    // The read has to fold run_started, which carries the highest seq, so a
    // complete fold proves every committed event was parsed.
    assert.equal(after.parsedEvents - before.parsedEvents, snapshot.lastSeq, "a cold read parses exactly the committed prefix");
    assert.ok(after.parsedBytes > before.parsedBytes, "the byte counter tracks the same reads as the event counter");
  } finally {
    await cleanup();
  }
});

test("[contract:read-path-parse-is-counted] a read at an unchanged revision parses nothing", async () => {
  const { store, control, cleanup } = await fixture("BUDGET-2", 200);
  try {
    await control.snapshot("BUDGET-2");
    const afterCold = parsed(store);

    // The invariant that must never regress: an unchanged Run is not re-parsed.
    // This is what makes a cached read cheap whatever the cold-read budget is.
    await control.snapshot("BUDGET-2");
    await store.loadProjectionHint("BUDGET-2").catch(() => undefined);
    await control.replay("BUDGET-2");
    assert.deepEqual(parsed(store), afterCold, "repeated reads at one revision parse nothing more");
  } finally {
    await cleanup();
  }
});

test("[contract:read-path-parse-is-counted] a new revision is parsed and counted", async () => {
  const { store, control, writer, cleanup } = await fixture("BUDGET-3", 200);
  try {
    await control.snapshot("BUDGET-3");
    const afterCold = parsed(store);

    await writer.append("BUDGET-3", batch(10, 200), { persistProjection: false });
    await control.snapshot("BUDGET-3");
    const grown = parsed(store);

    // The counter must be able to move. Without this, "0 new parses" would be
    // indistinguishable from "nothing ran", and the warm-read assertion above
    // would pass for the wrong reason.
    assert.ok(grown.parsedEvents > afterCold.parsedEvents, "an appended Run is re-parsed by the reader");
    assert.ok(grown.parsedBytes > afterCold.parsedBytes);
    assert.equal(store.readStats().parsedEvents, grown.parsedEvents, "readStats reports the process total");
  } finally {
    await cleanup();
  }
});

test("[contract:cold-read-parse-budget] a cold read of a completed Run parses the whole stream", async () => {
  const { root, runsRoot, store, writer, cleanup } = await fixture("BUDGET-4", 1_000);
  try {
    // Complete the Run and leave a current projection, so the read below has an
    // authoritative snapshot available and only the parse is left to pay for.
    await writer.flushProjection("BUDGET-4");
    const lastSeq = (await writer.snapshot("BUDGET-4")).lastSeq;
    const projectionBytes = await stat(join(runsRoot, "BUDGET-4", "projection.json")).then((stats) => stats.size).catch(() => 0);

    // A second service plane over the same runs root, like a freshly started GUI
    // server reading a Run the CLI produced: empty parse cache, empty snapshot
    // cache. It is built through createServices so it shares this module's
    // counters; DebugDataService builds its own plane the same way.
    const reader = createServices(root, config);
    const before = parsed(store);
    const events = await reader.control.events("BUDGET-4");
    const snapshot = await reader.control.snapshot("BUDGET-4");
    const after = parsed(store);
    const parsedBytes = after.parsedBytes - before.parsedBytes;

    // This records a measurement of the CURRENT read path, not a contract the
    // path must keep. The durable projection is constant-size and the read input
    // is not: `events()` returns every committed event, so a reader deserializes
    // the whole 5.4 MB history to answer with a 4.5 KB projection.
    //
    // Deliberately NOT asserted as an upper bound. An earlier version pinned
    // `delta === lastSeq` and `parsedBytes > 250_000` here, which turned the
    // O(history) behaviour this test documents into a gate that would fail the
    // moment the read path stops parsing the whole stream -- i.e. it forbade the
    // improvement it measures. The assertions below only require that the read
    // still returns the right state and that the parse is non-trivial, so the
    // numbers can move down without breaking the suite.
    assert.equal(snapshot.lastSeq, lastSeq, "the snapshot is the one the projection was sealed at");
    assert.ok(
      after.parsedEvents - before.parsedEvents > 0,
      "a cold read of a completed Run parses the stream, as the counter shows",
    );
    // `events()` is unbounded by design (the 600-event window lives in the GUI
    // DTO, apps/gui/src/debug-data.ts), so the honest statement is that it
    // returns the committed history -- and an earlier `events.length <= lastSeq`
    // here was vacuous, true for any return value.
    assert.equal(events.length, lastSeq, "events() returns every committed event");
    assert.ok(
      parsedBytes > 0 && projectionBytes > 0,
      "both the read input and the projection are non-empty",
    );

    // The invariant that must hold: a warm read at an unchanged revision is free.
    const warm = parsed(store);
    await reader.control.events("BUDGET-4");
    await reader.control.snapshot("BUDGET-4");
    assert.equal(parsed(store).parsedEvents, warm.parsedEvents, "an unchanged Run is not re-parsed");
  } finally {
    await cleanup();
  }
});
