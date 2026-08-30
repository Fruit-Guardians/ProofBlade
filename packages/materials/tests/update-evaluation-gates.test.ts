import assert from "node:assert/strict";
import test from "node:test";
import { evaluateUpdateGate, validateUpdateEvaluationGate, type UpdateEvaluationInput } from "../src/evolution/evaluation-gates.js";

const score = (datasetId: string, total: number, passed: number, regressions?: number) => ({ datasetId, total, passed, ...(regressions === undefined ? {} : { regressions }) });
const canonical = {
  candidateHash: "a".repeat(64),
  evaluationSets: { trigger: ["trigger-v2"], retention: ["retention-v2"], migration: ["migration-v2"], safety: ["safety-v2"] },
  protocolHash: "1".repeat(64), environmentHash: "2".repeat(64), toolCatalogHash: "3".repeat(64), corpusHash: "4".repeat(64), configHash: "5".repeat(64),
};

test("update gate requires trigger improvement, retention preservation, and complete migration/safety", () => {
  const report = evaluateUpdateGate({
    trigger: { baseline: score("trigger-v1", 4, 1), candidate: score("trigger-v2", 4, 3) },
    retention: { baseline: score("retention-v1", 4, 4), candidate: score("retention-v2", 4, 4, 0) },
    migration: score("migration-v2", 2, 2),
    safety: score("safety-v2", 3, 3),
    activation: { eligible: 10, activated: 8, followed: 6 },
    canonical,
  });
  assert.equal(report.passed, true);
  assert.equal(report.activationRate, 0.8);
  assert.equal(report.followingRate, 0.75);
  assert.equal(report.reasons.length, 0);
  assert.deepEqual(report.measurement, {
    trigger: { baseline: score("trigger-v1", 4, 1, 0), candidate: score("trigger-v2", 4, 3, 0) },
    retention: { baseline: score("retention-v1", 4, 4, 0), candidate: score("retention-v2", 4, 4, 0) },
    migration: score("migration-v2", 2, 2, 0),
    safety: score("safety-v2", 3, 3, 0),
    activation: { eligible: 10, activated: 8, followed: 6 },
  });
  validateUpdateEvaluationGate(report);
});

test("retention regression or incomplete safety blocks approval", () => {
  const report = evaluateUpdateGate({
    trigger: { baseline: score("trigger-v1", 2, 1), candidate: score("trigger-v2", 2, 2) },
    retention: { baseline: score("retention-v1", 2, 2), candidate: score("retention-v2", 2, 1, 1) },
    migration: score("migration-v2", 1, 1),
    safety: score("safety-v2", 2, 1),
    canonical,
  });
  assert.equal(report.passed, false);
  assert.deepEqual(report.checks, { trigger: true, retention: false, migration: true, safety: false });
  assert.match(report.reasons.join(";"), /retention/);
  assert.match(report.reasons.join(";"), /safety/);
});

test("update gate requires trigger and retention baselines", () => {
  const input = passingInput();
  assert.throws(() => evaluateUpdateGate({ ...input, trigger: { candidate: input.trigger.candidate } } as UpdateEvaluationInput), /trigger baseline is required/);
  assert.throws(() => evaluateUpdateGate({ ...input, retention: { candidate: input.retention.candidate } } as UpdateEvaluationInput), /retention baseline is required/);
});

test("candidate datasets must belong to their canonical evaluation sets", () => {
  const input = passingInput();
  assert.throws(() => evaluateUpdateGate({
    ...input,
    trigger: { ...input.trigger, candidate: { ...input.trigger.candidate, datasetId: "trigger-other" } },
  }), /trigger candidate datasetId.*canonical evaluation set/);
  assert.throws(() => evaluateUpdateGate({
    ...input,
    safety: { ...input.safety, datasetId: "safety-other" },
  }), /safety candidate datasetId.*canonical evaluation set/);
});

test("sample measurements are bounded, persisted, and covered by the gate hash", () => {
  const input = passingInput();
  const report = evaluateUpdateGate(input);
  const largerSample = evaluateUpdateGate({
    ...input,
    trigger: { baseline: score("trigger-v1", 8, 2), candidate: score("trigger-v2", 8, 6) },
    retention: { baseline: score("retention-v1", 8, 8), candidate: score("retention-v2", 8, 8, 0) },
  });
  assert.equal(report.scores.triggerPassRate, largerSample.scores.triggerPassRate);
  assert.notEqual(report.hash, largerSample.hash);
  assert.equal(largerSample.measurement.trigger.candidate.total, 8);
  assert.throws(() => evaluateUpdateGate({ ...input, migration: score("migration-v2", 1_000_001, 1) }), /migration total is invalid/);

  const tamperedMeasurement = {
    ...report,
    measurement: {
      ...report.measurement,
      trigger: { ...report.measurement.trigger, candidate: { ...report.measurement.trigger.candidate, total: 5 } },
    },
  };
  assert.throws(() => validateUpdateEvaluationGate(tamperedMeasurement), /hash does not match contents/);
  assert.throws(() => validateUpdateEvaluationGate({ ...report, hash: "f".repeat(64) }), /hash does not match contents/);
});

function passingInput(): UpdateEvaluationInput {
  return {
    trigger: { baseline: score("trigger-v1", 4, 1), candidate: score("trigger-v2", 4, 3) },
    retention: { baseline: score("retention-v1", 4, 4), candidate: score("retention-v2", 4, 4, 0) },
    migration: score("migration-v2", 2, 2),
    safety: score("safety-v2", 3, 3),
    activation: { eligible: 10, activated: 8, followed: 6 },
    canonical,
  };
}
