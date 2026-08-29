import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices, demoTask } from "../src/app/demo.js";
import { UpdateProposalManager } from "../src/evolution/update-proposals.js";
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
    const proposals = new UpdateProposalManager(services.control);
    const candidateHash = "a".repeat(64);
    const evaluationHash = "b".repeat(64);
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
    const evaluated = await proposals.evaluate(runId, proposal.id, evaluationHash, { failToPass: 0.8, passToPass: 1, flakyRate: 0 });
    assert.equal(evaluated.status, "EVALUATED");
    const approved = await proposals.approve(runId, proposal.id);
    assert.equal(approved.status, "APPROVED");
    const active = await proposals.activate(runId, proposal.id);
    assert.equal(active.status, "ACTIVE");
    const rolledBack = await proposals.rollback(runId, proposal.id);
    assert.equal(rolledBack.status, "ROLLED_BACK");
    assert.equal(rolledBack.rollbackVersion, "prompt-v1");
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
    const proposals = new UpdateProposalManager(services.control);
    const proposal = await proposals.create(runId, { kind: "skill", baseVersion: "s1", candidateVersion: "s2", candidateHash: "c".repeat(64), retentionDataset: "r", migrationDataset: "m", safetyDataset: "s" });
    await proposals.evaluate(runId, proposal.id, "d".repeat(64), { failToPass: 1 });
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
    const proposals = new UpdateProposalManager(services.control);
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
    });
    assert.equal(evaluated.report.passed, false);
    assert.equal(evaluated.proposal.metrics?.gatePassed, 0);
    await assert.rejects(proposals.approve(runId, proposal.id), /evaluation gates/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
