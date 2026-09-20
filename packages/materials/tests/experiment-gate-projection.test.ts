import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlStore } from "../src/control/control-store.js";
import { ExperimentGate } from "../src/competition/experiment-gate.js";
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

const secret = "experiment-gate-projection-secret-0123456789";

/** A Run with a real store, plus paths for the two durable artifacts. */
async function run(runId: string) {
  const root = await mkdtemp(join(tmpdir(), "proofblade-experiment-gate-"));
  const runsRoot = join(root, config.storage.runsDir);
  const control = new ControlStore(new JsonlControlStore(runsRoot), undefined, secret);
  await control.createRun(runId, demoTask(runId, root, config));
  return {
    root,
    control,
    runDir: join(runsRoot, runId),
    projectionPath: join(runsRoot, runId, "projection.json"),
    eventsPath: join(runsRoot, runId, "events.jsonl"),
  };
}

/** Modification time plus size, so a rewrite that lands in the same tick is still visible. */
async function stamp(path: string): Promise<string> {
  const stats = await stat(path);
  return `${stats.size}:${stats.mtimeMs}`;
}

test("recording an experiment does not rewrite the projection", async () => {
  // PLAN-240 item T3. Every foreground bash records at least one experiment, and
  // ExperimentGate.record() used to serialize the whole RunSnapshot and rewrite
  // projection.json each time, because dispatchTransaction only skips the
  // projection when persistProjection is explicitly false.
  const { root, control, projectionPath, eventsPath } = await run("EXP-GATE-1");
  try {
    const gate = new ExperimentGate(control);
    const projectionBefore = await stamp(projectionPath);
    const eventsBefore = (await readFile(eventsPath, "utf8")).trim().split("\n").length;

    await gate.record({ runId: "EXP-GATE-1", action: "bash", input: { command: "true" }, outcome: "success", summary: "ran" });

    assert.equal(await stamp(projectionPath), projectionBefore, "the derived projection must not be rewritten on the hot path");
    const eventsAfter = (await readFile(eventsPath, "utf8")).trim().split("\n").length;
    assert.ok(eventsAfter > eventsBefore, "the event log append must still happen");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the deferred experiment is still durable in the event log and in the folded snapshot", async () => {
  const { root, control, control: _same } = await run("EXP-GATE-2");
  try {
    const gate = new ExperimentGate(control);
    const result = await gate.record({ runId: "EXP-GATE-2", action: "bash", input: { command: "true" }, outcome: "success", summary: "ran" });

    assert.equal(result.allowed, true);
    assert.ok(result.record, "the record must be returned even when its projection is deferred");

    // Deferring the projection must not defer the fact.
    const snapshot = await control.snapshot("EXP-GATE-2");
    assert.ok(snapshot.experiments[result.record.id], "the experiment must be visible in the folded snapshot");
    const replayed = await new ControlStore(new JsonlControlStore(join(root, config.storage.runsDir)), undefined, secret).replay("EXP-GATE-2");
    assert.ok(replayed.experiments[result.record.id], "the experiment must survive a replay from the event log alone");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("flushProjection writes the deferred experiment, so no barrier loses it", async () => {
  const { root, control, projectionPath } = await run("EXP-GATE-3");
  try {
    const gate = new ExperimentGate(control);
    const projectionBefore = await stamp(projectionPath);
    const result = await gate.record({ runId: "EXP-GATE-3", action: "bash", input: { command: "true" }, outcome: "success", summary: "ran" });

    await control.flushProjection("EXP-GATE-3");

    assert.notEqual(await stamp(projectionPath), projectionBefore, "the barrier must materialize the deferred projection");
    // StoredProjection spreads the snapshot at the top level next to its hash and seal.
    const sealed = JSON.parse(await readFile(projectionPath, "utf8")) as { experiments?: Record<string, unknown>; proofbladeProjectionSeal?: unknown };
    assert.ok(sealed.proofbladeProjectionSeal, "the flushed projection must stay sealed");
    assert.ok(sealed.experiments?.[result.record!.id], "the flushed projection must contain the experiment");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a caller can still demand an immediate projection", async () => {
  const { root, control, projectionPath } = await run("EXP-GATE-4");
  try {
    const gate = new ExperimentGate(control);
    const projectionBefore = await stamp(projectionPath);

    await gate.record({
      runId: "EXP-GATE-4",
      action: "bash",
      input: { command: "true" },
      outcome: "success",
      summary: "ran",
      dispatch: { persistProjection: true },
    });

    assert.notEqual(await stamp(projectionPath), projectionBefore, "an explicit request must not be deferred");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated failing experiments still trip the durable repeat budget", async () => {
  // The gate's contract is unchanged: only the projection write moved.
  const { root, control } = await run("EXP-GATE-5");
  try {
    const gate = new ExperimentGate(control);
    const input = { runId: "EXP-GATE-5", action: "bash", input: { command: "false" }, summary: "failed" } as const;

    await gate.record({ ...input, outcome: "failure" });
    await gate.record({ ...input, outcome: "failure" });
    const third = await gate.record({ ...input, outcome: "failure" });

    assert.equal(third.allowed, false, "the repeat budget must still block after two failures");
    assert.equal(third.previousFailures, 2);
    await assert.rejects(() => gate.assertAllowed(input), /experiment repeat gate blocked/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
