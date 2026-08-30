import assert from "node:assert/strict";
import test from "node:test";
import { estimateDecisionVoi, estimateHeuristicInformation, estimatePmi, estimatePosteriorEIG, estimateVerifiedUplift } from "../src/index.js";

test("heuristic values are explicitly typed and not presented as EIG", () => {
  const estimate = estimateHeuristicInformation({ novelty: .8, evidenceGap: .6, expectedConfidence: .7, cost: .1 });
  assert.equal(estimate.estimatorKind, "heuristic");
  assert.equal(estimate.calibrated, false);
  assert.notEqual(estimate.estimatorKind, "posterior_eig");
});

test("posterior EIG validates priors and likelihoods and computes entropy reduction", () => {
  const estimate = estimatePosteriorEIG([
    { id: "h1", prior: .5, likelihoodByOutcome: { yes: .9, no: .1 } },
    { id: "h2", prior: .5, likelihoodByOutcome: { yes: .1, no: .9 } },
  ]);
  assert.equal(estimate.estimatorKind, "posterior_eig");
  assert.equal(estimate.calibrated, true);
  assert.ok(estimate.score > .5);
  assert.throws(() => estimatePosteriorEIG([{ id: "h1", prior: 1, likelihoodByOutcome: { yes: 1 } }]), /at least two/);
  assert.throws(() => estimatePosteriorEIG([{ id: "h1", prior: .4, likelihoodByOutcome: { yes: .5, no: .5 } }, { id: "h2", prior: .4, likelihoodByOutcome: { yes: .5, no: .5 } }]), /sum to 1/);
});

test("PMI, VOI and verified uplift preserve estimator identity and components", () => {
  const pmi = estimatePmi({ queryCount: 20, contextCount: 30, jointCount: 10, totalCount: 100 });
  assert.equal(pmi.estimatorKind, "pmi");
  const voi = estimateDecisionVoi({ currentUtility: .3, outcomeUtilities: [.9, .2], outcomeProbabilities: [.5, .5], cost: .1 });
  assert.equal(voi.estimatorKind, "decision_voi");
  assert.ok(Object.hasOwn(voi.components, "expectedUtility"));
  const uplift = estimateVerifiedUplift({ baselineSuccessRate: .5, candidateSuccessRate: .7, baselineEvidenceCoverage: .6, candidateEvidenceCoverage: .8, sampleSize: 25 });
  assert.equal(uplift.estimatorKind, "verified_uplift");
  assert.ok(uplift.confidenceInterval);
  assert.equal(uplift.online, false);
});
