import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../src/control/control-store.js";
import { demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";

/**
 * Currency of the fast projection hint.
 *
 * `loadProjectionHint()` exists to serve GUI list reads without parsing the event
 * stream. Its seal proves a projection is authentic and internally consistent --
 * but NOT that it covers the whole log: a projection sealed at `lastSeq` 1 stays
 * perfectly valid after 10,000 more events. Its only staleness guard used to be
 * "projection mtime >= events mtime", a temporal heuristic that compares EQUAL
 * when timestamp granularity is coarse or a clock moves.
 *
 * With `persistProjection: false` on the hot path, a projection left behind by
 * design is the normal case, so that window is reachable rather than exotic.
 * Currency is now established from content, and these tests pin it.
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

const secret = "projection-currency-secret-0123456789";

async function run(runId: string) {
  const root = await mkdtemp(join(tmpdir(), "proofblade-currency-"));
  const runsRoot = join(root, config.storage.runsDir);
  const control = new ControlStore(new JsonlControlStore(runsRoot), undefined, secret);
  await control.createRun(runId, demoTask(runId, root, config));
  return {
    root,
    control,
    eventsPath: join(runsRoot, runId, "events.jsonl"),
    projectionPath: join(runsRoot, runId, "projection.json"),
  };
}

function deferred(control: ControlStore, runId: string, count: number, offset = 0) {
  return control.append(runId, Array.from({ length: count }, (_, index) => ({
    schemaVersion: 1 as const,
    lane: "executor" as const,
    correlationId: `currency-${offset + index}`,
    actor: "tool" as const,
    type: "tool_result_recorded" as const,
    payload: { toolCallId: `c${offset + index}`, toolName: "read", outputBytes: 64, isError: false },
  })), { persistProjection: false });
}

test("a fresh projection is served by the fast hint", async () => {
  const { root, control } = await run("CURRENCY-1");
  try {
    const snapshot = await control.snapshot("CURRENCY-1");
    const hinted = await control.loadProjectionHint("CURRENCY-1");

    assert.ok(hinted, "a just-created projection must be servable");
    assert.equal(hinted.lastSeq, snapshot.lastSeq);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:projection-hint-currency] the hint withholds a projection that is behind the log", async () => {
  const { root, control } = await run("CURRENCY-2");
  try {
    await deferred(control, "CURRENCY-2", 40);

    const hinted = await control.loadProjectionHint("CURRENCY-2");
    const snapshot = await control.snapshot("CURRENCY-2");
    assert.ok(snapshot.lastSeq > 1, "the log must actually have moved for this test to mean anything");

    // Unconditional: the 40 events were appended with `persistProjection: false`,
    // so the projection on disk really is behind and nothing may serve it. The
    // earlier version of this only asserted `hinted.lastSeq === snapshot.lastSeq`
    // when a hint came back, which passes when the tail read fails for an
    // unrelated reason — the case where withholding is required but absence of a
    // hint would hide a regression.
    assert.equal(hinted, undefined, "a projection behind the log must be withheld");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:projection-hint-currency] an unterminated final record is not counted as committed", async () => {
  // `#loadEvents()` counts a record only once its terminating newline is durable,
  // so `lastEventSeq` must apply the same rule. Without it, a log whose newest
  // record is still in flight reports the *previous* record's seq -- and here the
  // projection IS sealed at that seq, so the wrong reading and the right reading
  // differ in what they say about the file, not just in whether they serve it.
  //
  // The mtime pre-filter has to be neutralised first, and that is not optional.
  // Appending moves the log's mtime past the projection's, so on a first attempt
  // the hint is withheld for a reason that has nothing to do with the terminator
  // rule; an earlier version of this case asserted `undefined` and would have
  // passed under the old rule too. Measured: with the mtimes equalised the hint
  // IS served, at the last committed seq, which is the correct answer for a
  // projection covering every committed event.
  const { root, control, eventsPath, projectionPath } = await run("CURRENCY-6");
  try {
    const before = await control.snapshot("CURRENCY-6");
    assert.ok(await control.loadProjectionHint("CURRENCY-6"), "the baseline projection must be servable");

    const { appendFile } = await import("node:fs/promises");
    await appendFile(eventsPath, JSON.stringify({ schemaVersion: 1, seq: before.lastSeq + 1, torn: true }), "utf8");
    // Remove the mtime pre-filter from the question, the same way CURRENCY-3 does.
    const second = Math.floor(Date.now() / 1000);
    await utimes(projectionPath, second, second);
    await utimes(eventsPath, second, second);

    const hinted = await control.loadProjectionHint("CURRENCY-6");
    assert.ok(hinted, "a projection covering the last committed event is still current");
    assert.equal(
      hinted.lastSeq,
      before.lastSeq,
      "the in-flight record must not be counted: the projection is current at the last COMMITTED seq",
    );
    // And the record really is still in flight, so the assertion above is not
    // vacuous: the authoritative parse also stops at the last committed record.
    assert.equal((await control.events("CURRENCY-6")).length, before.lastSeq);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:projection-hint-currency] the hint refuses an empty log rather than calling it current", async () => {
  // An empty log is the shape left behind by a crash, a partial copy or a
  // restore. A sealed projection describing N events must not be served against
  // a log with none of them. The contract is asserted rather than one particular
  // guard: zero bytes are also rejected by the bounded read and by the terminator
  // rule, so removing any single one of them keeps this green and no mutation
  // pins an individual line.
  const { root, control, eventsPath } = await run("CURRENCY-7");
  try {
    assert.ok(await control.loadProjectionHint("CURRENCY-7"), "the baseline projection must be servable");
    await writeFile(eventsPath, "", "utf8");

    assert.equal(await control.loadProjectionHint("CURRENCY-7"), undefined, "no records means currency cannot be confirmed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:projection-hint-currency] the hint refuses a final record larger than its read window", async () => {
  // The tail window is 64 KiB, and a final record bigger than that contains no
  // newline inside the window: no committed record can be read, so the answer is
  // "unknown" rather than "current" or "the previous record".
  //
  // Two details make this assert the window rule instead of something else:
  //
  // - the mtimes are equalized after the append. Otherwise the appended record
  //   moves the log's mtime past the projection's and the cheap pre-filter answers
  //   `undefined` first, so the assertion holds whether or not the window rule
  //   works -- the same defect the fourth review round found in CURRENCY-6.
  // - the oversized record carries the seq the projection is sealed at, on
  //   purpose. With a fresh seq the currency comparison would refuse it even if
  //   the record had been read, so the test could not tell a bounded read from an
  //   unbounded one. Mutation-verified: making `lastEventSeq` read the whole file
  //   finds this record, matches the projection's own seq, and serves the hint,
  //   which fails the assertion below.
  const { root, control, eventsPath, projectionPath } = await run("CURRENCY-8");
  try {
    const baseline = await control.loadProjectionHint("CURRENCY-8");
    assert.ok(baseline, "the baseline projection must be servable");
    await deferred(control, "CURRENCY-8", 5);
    const { appendFile } = await import("node:fs/promises");
    await appendFile(eventsPath, `{"schemaVersion":1,"seq":${baseline.lastSeq},"padding":"${"p".repeat(80_000)}"}\n`, "utf8");
    const equal = Math.floor(Date.now() / 1000);
    await utimes(projectionPath, equal, equal);
    await utimes(eventsPath, equal, equal);

    assert.equal(await control.loadProjectionHint("CURRENCY-8"), undefined, "a tail bigger than the window is unknown, not current");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:projection-hint-currency] equal mtimes do not make a stale projection look current", async () => {
  // The regression this pins: mtime granularity can make projection and log
  // compare equal while the projection is still behind, and the old
  // mtime-only guard accepted that.
  const { root, control, eventsPath, projectionPath } = await run("CURRENCY-3");
  try {
    await deferred(control, "CURRENCY-3", 60);

    const second = Math.floor(Date.now() / 1000);
    await utimes(projectionPath, second, second);
    await utimes(eventsPath, second, second);

    const hinted = await control.loadProjectionHint("CURRENCY-3");
    const snapshot = await control.snapshot("CURRENCY-3");
    assert.ok(snapshot.lastSeq > 1, "the log must have moved");

    assert.equal(hinted, undefined, "equal mtimes must not let a trailing projection through");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a barrier restores the fast hint after deferred writes", async () => {
  const { root, control } = await run("CURRENCY-4");
  try {
    await deferred(control, "CURRENCY-4", 30);
    await control.flushProjection("CURRENCY-4");

    const snapshot = await control.snapshot("CURRENCY-4");
    const hinted = await control.loadProjectionHint("CURRENCY-4");

    assert.ok(hinted, "after a barrier the projection is current and must be servable again");
    assert.equal(hinted.lastSeq, snapshot.lastSeq);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the hint still refuses a tampered projection", async () => {
  const { root, control, projectionPath } = await run("CURRENCY-5");
  try {
    const { readFile, writeFile } = await import("node:fs/promises");
    const original = JSON.parse(await readFile(projectionPath, "utf8")) as Record<string, unknown>;
    await writeFile(projectionPath, JSON.stringify({ ...original, status: "FINISHED" }), "utf8");

    const hinted = await control.loadProjectionHint("CURRENCY-5");
    // The content hash check must still reject the edited body.
    assert.equal(hinted, undefined, "a tampered projection body must not be served");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
