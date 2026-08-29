import assert from "node:assert/strict";
import test from "node:test";
import { evaluateUpdateGate } from "../src/evolution/evaluation-gates.js";

const score = (datasetId: string, total: number, passed: number, regressions?: number) => ({ datasetId, total, passed, ...(regressions === undefined ? {} : { regressions }) });

test("update gate requires trigger improvement, retention preservation, and complete migration/safety", () => {
  const report = evaluateUpdateGate({
    trigger: { baseline: score("trigger-v1", 4, 1), candidate: score("trigger-v2", 4, 3) },
    retention: { baseline: score("retention-v1", 4, 4), candidate: score("retention-v2", 4, 4, 0) },
    migration: score("migration-v2", 2, 2),
    safety: score("safety-v2", 3, 3),
    activation: { eligible: 10, activated: 8, followed: 6 },
  });
  assert.equal(report.passed, true);
  assert.equal(report.activationRate, 0.8);
  assert.equal(report.followingRate, 0.75);
  assert.equal(report.reasons.length, 0);
});

test("retention regression or incomplete safety blocks approval", () => {
  const report = evaluateUpdateGate({
    trigger: { baseline: score("trigger-v1", 2, 1), candidate: score("trigger-v2", 2, 2) },
    retention: { baseline: score("retention-v1", 2, 2), candidate: score("retention-v2", 2, 1, 1) },
    migration: score("migration-v2", 1, 1),
    safety: score("safety-v2", 2, 1),
  });
  assert.equal(report.passed, false);
  assert.deepEqual(report.checks, { trigger: true, retention: false, migration: true, safety: false });
  assert.match(report.reasons.join(";"), /retention/);
  assert.match(report.reasons.join(";"), /safety/);
});
