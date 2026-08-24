import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices, demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { ExperimentGate } from "../src/competition/experiment-gate.js";
import { turnPrompt } from "../src/competition/loop.js";
import { fixtureTask } from "../src/app/fixture-task.js";
import { remainingRunDeadlineMs } from "../src/domain/utils.js";
import { RunCoordinator } from "../src/orchestration/run-coordinator.js";

const config = { schemaVersion: 1, runtime: { piVersion: "0.83.0" }, storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" }, modelProfiles: { executor: { thinkingLevel: "off" } } } as unknown as ProofBladeConfig;

test("deadline budget is bounded and visible in the competition turn prompt", () => {
  const task = fixtureTask("PROMPT-DEADLINE", "web-source-1", "/workspace", config);
  const startedAt = "2026-08-24T00:00:00.000Z";
  assert.equal(remainingRunDeadlineMs(startedAt, 5_000, Date.parse(startedAt) + 1_500), 3_500);
  assert.equal(remainingRunDeadlineMs("not-a-date", 5_000, Date.parse(startedAt) + 1_500), 5_000);
  const prompt = turnPrompt(task, 1, "/workspace", { submissionsSoFar: 0, remainingDeadlineMs: 1_501 });
  assert.match(prompt, /Remaining deadline: 2 seconds/);
});

test("domainPhase and ExperimentRecord replay durably and block a third failed repeat", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-convergence-"));
  try {
    const services = createServices(root, config);
    const runId = "CONVERGENCE";
    await services.control.createRun(runId, demoTask(runId, root, config));
    await services.control.dispatch(runId, { type: "set_domain_phase", domainPhase: "RECON", lane: "executor" });
    await services.control.dispatch(runId, { type: "set_domain_phase", domainPhase: "EXPERIMENT", lane: "executor" });
    const gate = new ExperimentGate(services.control);
    const input = { runId, action: "bash", input: { command: "python exploit.py", explanation: "ui-only" }, outcome: "failure" as const, summary: "remote rejected payload" };
    assert.equal((await gate.record(input)).allowed, true);
    assert.equal((await gate.record(input)).allowed, true);
    const third = await gate.record(input);
    assert.equal(third.allowed, false);
    assert.equal(third.previousFailures, 2);
    await assert.rejects(gate.assertAllowed({ runId, action: input.action, input: input.input }), /blocked action/);
    const replayed = await services.control.replay(runId);
    assert.equal(replayed.domainPhase, "EXPERIMENT");
    assert.equal(Object.keys(replayed.experiments).length, 2);
    assert.equal((await services.control.runHash(runId)), (await services.control.runHash(runId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RunCoordinator keeps generic and CTF phase projections in one replayable path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-phase-projection-"));
  try {
    const services = createServices(root, config);
    const runId = "PHASE-PROJECTION";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const coordinator = new RunCoordinator(services.control, services.verifier);

    for (const phase of ["RECON", "TARGET_MODEL", "HYPOTHESIS", "EXPERIMENT", "REPRODUCE"] as const) {
      await coordinator.setDomainPhase(runId, phase);
    }
    // A rejected reproduction is allowed to return to the experiment loop;
    // this is the path used before a refiner schedules the next attempt.
    await coordinator.setDomainPhase(runId, "EXPERIMENT");
    await coordinator.setDomainPhase(runId, "REPORT");
    await coordinator.setDomainPhase(runId, "SUBMIT");

    const snapshot = await services.control.snapshot(runId);
    assert.equal(snapshot.domainPhase, "SUBMIT");
    assert.equal(snapshot.phase, "report");
    assert.deepEqual(
      (await services.control.events(runId)).filter((event) => event.type === "phase_started").map((event) => event.payload?.phase),
      ["reconnaissance", "hypothesis", "experiment", "verification", "experiment", "verification", "report"],
    );
    const replayed = await services.control.replay(runId);
    assert.equal(replayed.domainPhase, snapshot.domainPhase);
    assert.equal(replayed.phase, snapshot.phase);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("experiment repeat keys include canonical input but not object key order", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-repeat-key-"));
  try {
    const services = createServices(root, config);
    const runId = "REPEAT-KEY";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const gate = new ExperimentGate(services.control);
    const first = await gate.record({ runId, action: "capability", input: { b: 2, a: 1 }, outcome: "failure", summary: "failed" });
    const second = await gate.record({ runId, action: " capability ", input: { a: 1, b: 2, explanation: "presentation only" }, outcome: "timeout", summary: "timed out" });
    assert.equal(first.repeatKey, second.repeatKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent failed experiments are serialized by the durable gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-concurrent-gate-"));
  try {
    const services = createServices(root, config);
    const runId = "CONCURRENT-GATE";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const gate = new ExperimentGate(services.control);
    const results = await Promise.all(Array.from({ length: 4 }, () => gate.record({ runId, action: "same", input: { x: 1 }, outcome: "failure", summary: "failed" })));
    assert.equal(results.filter((result) => result.allowed).length, 2);
    assert.equal(Object.values((await services.control.snapshot(runId)).experiments).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
