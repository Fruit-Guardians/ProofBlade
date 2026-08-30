import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices, demoTask } from "../src/app/demo.js";
import { UpdateProposalManager } from "../src/evolution/update-proposals.js";
import { evaluateUpdateGate } from "../src/evolution/evaluation-gates.js";
import { reduce } from "../src/control/reducer.js";
import type { ProofBladeConfig } from "../src/config.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: { executor: { thinkingLevel: "off" } },
} as unknown as ProofBladeConfig;

test("update proposals require evaluation and support explicit activation and hash-bound rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-proposal-"));
  try {
    const services = createServices(root, config);
    const runId = "PROPOSAL-001";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const proposals = new UpdateProposalManager(services.control, services.updateEvaluation);
    const candidateHash = "a".repeat(64);
    const proposal = await proposals.create(runId, {
      kind: "prompt",
      baseVersion: "prompt-v1",
      candidateVersion: "prompt-v2",
      candidateHash,
      triggerDataset: "trigger-v1",
      retentionDataset: "retention-v1",
      migrationDataset: "migration-v1",
      safetyDataset: "safety-v1",
    });
    assert.equal(proposal.status, "PROPOSED");
    await assert.rejects(proposals.activate(runId, proposal.id), /APPROVED/);
    const evaluated = await proposals.evaluate(runId, proposal.id, passingReport(candidateHash, proposal.evaluationSets!));
    assert.equal(evaluated.status, "EVALUATED");
    assert.equal(evaluated.evaluationGate?.canonical.toolCatalogHash, "3".repeat(64));
    assert.equal(evaluated.evaluationGate?.measurement.trigger.baseline.total, 2);
    const approved = await proposals.approve(runId, proposal.id);
    assert.equal(approved.status, "APPROVED");
    const active = await proposals.activate(runId, proposal.id);
    assert.equal(active.status, "ACTIVE");
    const rolledBack = await proposals.rollback(runId, proposal.id);
    assert.equal(rolledBack.status, "ROLLED_BACK");
    assert.equal(rolledBack.rollbackVersion, "prompt-v1");
    assert.equal((await services.control.replay(runId)).updateProposals[proposal.id]?.evaluationGate?.measurement.retention.candidate.regressions, 0);
    const types = (await services.control.events(runId)).map((event) => event.type);
    assert.deepEqual(types.slice(-5), ["update_proposal_created", "update_proposal_evaluated", "update_proposal_approved", "update_proposal_activated", "update_proposal_rolled_back"]);
    assert.equal((await proposals.list(runId)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update proposal reducer rejects rollback with a different candidate hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-proposal-invalid-"));
  try {
    const services = createServices(root, config);
    const runId = "PROPOSAL-002";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const proposals = new UpdateProposalManager(services.control, services.updateEvaluation);
    const candidateHash = "c".repeat(64);
    const proposal = await proposals.create(runId, { kind: "skill", baseVersion: "s1", candidateVersion: "s2", candidateHash, triggerDataset: "t", retentionDataset: "r", migrationDataset: "m", safetyDataset: "s" });
    await proposals.evaluate(runId, proposal.id, passingReport(candidateHash, proposal.evaluationSets!));
    await proposals.approve(runId, proposal.id);
    await proposals.activate(runId, proposal.id);
    await assert.rejects(services.control.dispatch(runId, { type: "update_proposal_rolled_back", proposalId: proposal.id, candidateHash: "e".repeat(64), lane: "planner" }), /does not match proposal/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update proposal gate is durable and a failed gate cannot be approved", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-proposal-gate-"));
  try {
    const services = createServices(root, config);
    const runId = "PROPOSAL-GATE";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const proposals = new UpdateProposalManager(services.control, services.updateEvaluation);
    const proposal = await proposals.create(runId, {
      kind: "skill",
      baseVersion: "skill-v1",
      candidateVersion: "skill-v2",
      candidateHash: "f".repeat(64),
      triggerDataset: "trigger-v2",
      retentionDataset: "retention-v2",
      migrationDataset: "migration-v2",
      safetyDataset: "safety-v2",
    });
    const evaluated = await proposals.evaluateWithGate(runId, proposal.id, {
      trigger: { baseline: { datasetId: "trigger-v1", total: 2, passed: 1 }, candidate: { datasetId: "trigger-v2", total: 2, passed: 2 } },
      retention: { baseline: { datasetId: "retention-v1", total: 2, passed: 2 }, candidate: { datasetId: "retention-v2", total: 2, passed: 1, regressions: 1 } },
      migration: { datasetId: "migration-v2", total: 1, passed: 1 },
      safety: { datasetId: "safety-v2", total: 1, passed: 0 },
      canonical: canonical("f".repeat(64), { trigger: ["trigger-v2"], retention: ["retention-v2"], migration: ["migration-v2"], safety: ["safety-v2"] }),
    });
    assert.equal(evaluated.report.passed, false);
    assert.equal(evaluated.proposal.metrics?.gatePassed, 0);
    await assert.rejects(proposals.approve(runId, proposal.id), /evaluation gate/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update proposal rejects forged or drifted canonical gate reports", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-proposal-binding-"));
  try {
    const services = createServices(root, config);
    const runId = "PROPOSAL-BINDING";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const proposals = new UpdateProposalManager(services.control, services.updateEvaluation);
    const candidateHash = "9".repeat(64);
    const proposal = await proposals.create(runId, {
      kind: "program", baseVersion: "v1", candidateVersion: "v2", candidateHash,
      triggerDataset: "trigger", retentionDataset: "retention", migrationDataset: "migration", safetyDataset: "safety",
    });
    await assert.rejects(proposals.approve(runId, proposal.id), /valid passing evaluation gate/);
    const report = passingReport(candidateHash, proposal.evaluationSets!);
    await assert.rejects(proposals.evaluate(runId, proposal.id, { ...report, candidateHash: "8".repeat(64) }), /candidate hash/);
    await assert.rejects(services.updateEvaluation.dispatch(runId, {
      type: "update_proposal_evaluated", proposalId: proposal.id, evaluationHash: report.hash,
      metrics: { gatePassed: 1 }, gate: { ...report, canonical: { ...report.canonical, toolCatalogHash: "7".repeat(64) } },
    }), /hash does not match contents|metrics do not match/);
    await assert.rejects(services.updateEvaluation.dispatch(runId, {
      type: "update_proposal_evaluated", proposalId: proposal.id, evaluationHash: report.hash,
      metrics: { gatePassed: 1, triggerPassRate: report.scores.triggerPassRate, retentionPassRate: report.scores.retentionPassRate,
        migrationPassRate: report.scores.migrationPassRate, safetyPassRate: report.scores.safetyPassRate,
        retentionRegressionRate: report.scores.retentionRegressionRate, activationRate: report.activationRate, followingRate: report.followingRate },
      gate: { ...report, measurement: { ...report.measurement, migration: { ...report.measurement.migration, total: 2 } } },
    }), /hash does not match contents/);
    await assert.rejects(services.control.dispatch(runId, {
      type: "update_proposal_evaluated", proposalId: proposal.id, evaluationHash: report.hash,
      metrics: { gatePassed: 1, triggerPassRate: report.scores.triggerPassRate, retentionPassRate: report.scores.retentionPassRate,
        migrationPassRate: report.scores.migrationPassRate, safetyPassRate: report.scores.safetyPassRate,
        retentionRegressionRate: report.scores.retentionRegressionRate, activationRate: report.activationRate, followingRate: report.followingRate },
      gate: report, lane: "planner",
    }), /trusted evaluation service/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update proposal reducer rejects malformed evaluated and approved replay events", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-proposal-replay-"));
  try {
    const services = createServices(root, config);
    const runId = "PROPOSAL-REPLAY";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const proposals = new UpdateProposalManager(services.control, services.updateEvaluation);
    const candidateHash = "6".repeat(64);
    const proposal = await proposals.create(runId, {
      kind: "tool", baseVersion: "v1", candidateVersion: "v2", candidateHash,
      triggerDataset: "trigger", retentionDataset: "retention", migrationDataset: "migration", safetyDataset: "safety",
    });
    const beforeEvaluation = await services.control.snapshot(runId);
    const report = passingReport(candidateHash, proposal.evaluationSets!);
    const evaluatedEvents = await services.updateEvaluation.dispatch(runId, {
      type: "update_proposal_evaluated", proposalId: proposal.id, evaluationHash: report.hash,
      metrics: {
        gatePassed: 1, triggerPassRate: report.scores.triggerPassRate, retentionPassRate: report.scores.retentionPassRate,
        migrationPassRate: report.scores.migrationPassRate, safetyPassRate: report.scores.safetyPassRate,
        retentionRegressionRate: report.scores.retentionRegressionRate, activationRate: report.activationRate, followingRate: report.followingRate,
      },
      gate: report,
    });
    const evaluatedEvent = evaluatedEvents[0]!;
    assert.throws(() => reduce(beforeEvaluation, {
      ...evaluatedEvent,
      payload: { ...evaluatedEvent.payload, gate: undefined },
    }), /gate shape is invalid/);
    assert.throws(() => reduce(beforeEvaluation, {
      ...evaluatedEvent,
      payload: { ...evaluatedEvent.payload, gate: { ...report, candidateHash: "7".repeat(64) } },
    }), /candidate hash does not match proposal/);

    const evaluatedSnapshot = reduce(beforeEvaluation, evaluatedEvent);
    const approvedEvents = await services.control.dispatch(runId, { type: "update_proposal_approved", proposalId: proposal.id, lane: "planner" });
    const approvedEvent = approvedEvents[0]!;
    const hashDrift = structuredClone(evaluatedSnapshot);
    hashDrift.updateProposals[proposal.id]!.evaluationHash = "8".repeat(64);
    assert.throws(() => reduce(hashDrift, approvedEvent), /hash does not match evaluationHash/);
    const candidateDrift = structuredClone(evaluatedSnapshot);
    candidateDrift.updateProposals[proposal.id]!.candidateHash = "7".repeat(64);
    assert.throws(() => reduce(candidateDrift, approvedEvent), /candidate hash does not match proposal/);
    const evaluationSetDrift = structuredClone(evaluatedSnapshot);
    evaluationSetDrift.updateProposals[proposal.id]!.evaluationSets!.trigger = ["trigger-other"];
    assert.throws(() => reduce(evaluationSetDrift, approvedEvent), /evaluation sets do not match proposal/);
    const passedDrift = structuredClone(evaluatedSnapshot);
    passedDrift.updateProposals[proposal.id]!.metrics!.gatePassed = 0;
    assert.throws(() => reduce(passedDrift, approvedEvent), /passed flag does not match gatePassed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function canonical(candidateHash: string, evaluationSets: { trigger: string[]; retention: string[]; migration: string[]; safety: string[] }) {
  return {
    candidateHash,
    evaluationSets,
    protocolHash: "1".repeat(64),
    environmentHash: "2".repeat(64),
    toolCatalogHash: "3".repeat(64),
    corpusHash: "4".repeat(64),
    configHash: "5".repeat(64),
  };
}

function passingReport(candidateHash: string, evaluationSets: { trigger: string[]; retention: string[]; migration: string[]; safety: string[] }) {
  return evaluateUpdateGate({
    trigger: { baseline: { datasetId: "trigger-base", total: 2, passed: 1 }, candidate: { datasetId: evaluationSets.trigger[0]!, total: 2, passed: 2 } },
    retention: { baseline: { datasetId: "retention-base", total: 2, passed: 2 }, candidate: { datasetId: evaluationSets.retention[0]!, total: 2, passed: 2, regressions: 0 } },
    migration: { datasetId: evaluationSets.migration[0]!, total: 1, passed: 1 },
    safety: { datasetId: evaluationSets.safety[0]!, total: 1, passed: 1 },
    canonical: canonical(candidateHash, evaluationSets),
  });
}
