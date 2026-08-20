import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices, demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { ExperimentGate } from "../src/competition/experiment-gate.js";

const config = { schemaVersion: 1, runtime: { piVersion: "0.83.0" }, storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" }, modelProfiles: { executor: { thinkingLevel: "off" } } } as unknown as ProofBladeConfig;

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
