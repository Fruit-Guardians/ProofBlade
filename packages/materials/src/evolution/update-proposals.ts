import type { ControlStore, DomainCommand, UpdateEvaluationControlPort } from "../control/control-store.js";
import type { UpdateProposal, UpdateProposalKind } from "../domain/types.js";
import { canonicalJson, id } from "../domain/utils.js";
import { evaluateUpdateGate, metricsForUpdateGate, validateUpdateEvaluationGate, type UpdateEvaluationGateReport, type UpdateEvaluationInput } from "./evaluation-gates.js";

export interface CreateUpdateProposalInput {
  kind: UpdateProposalKind;
  baseVersion: string;
  candidateVersion: string;
  candidateHash: string;
  sourceArtifactIds?: string[];
  triggerFailureIds?: string[];
  triggerDataset: string;
  retentionDataset: string;
  migrationDataset: string;
  safetyDataset: string;
}

/** ControlStore-backed proposal lifecycle. Activation is explicit and rollback is hash-bound. */
export class UpdateProposalManager {
  public constructor(
    private readonly controlStore: ControlStore,
    private readonly updateEvaluation: UpdateEvaluationControlPort,
  ) {}

  public async create(runId: string, input: CreateUpdateProposalInput, lane: "main" | "planner" = "planner"): Promise<UpdateProposal> {
    const proposal: Omit<UpdateProposal, "createdSeq" | "updatedSeq" | "runId" | "status"> = {
      id: id("UP"),
      schemaVersion: 1,
      kind: input.kind,
      baseVersion: input.baseVersion,
      candidateVersion: input.candidateVersion,
      candidateHash: input.candidateHash,
      sourceArtifactIds: [...(input.sourceArtifactIds ?? [])],
      triggerFailureIds: [...(input.triggerFailureIds ?? [])],
      retentionDataset: input.retentionDataset,
      migrationDataset: input.migrationDataset,
      safetyDataset: input.safetyDataset,
      evaluationSets: {
        trigger: [input.triggerDataset],
        retention: [input.retentionDataset],
        migration: [input.migrationDataset],
        safety: [input.safetyDataset],
      },
    };
    await this.controlStore.dispatch(runId, { type: "update_proposal_created", proposal, lane });
    return (await this.controlStore.snapshot(runId)).updateProposals[proposal.id]!;
  }

  public async evaluate(runId: string, proposalId: string, report: UpdateEvaluationGateReport): Promise<UpdateProposal> {
    const proposal = await this.read(runId, proposalId);
    assertReportMatchesProposal(proposal, report);
    await this.updateEvaluation.dispatch(runId, { type: "update_proposal_evaluated", proposalId, evaluationHash: report.hash, metrics: metricsForUpdateGate(report), gate: report });
    return this.read(runId, proposalId);
  }

  /** Evaluate and persist the four-set release gate with its bounded measurement. */
  public async evaluateWithGate(runId: string, proposalId: string, input: UpdateEvaluationInput): Promise<{ proposal: UpdateProposal; report: UpdateEvaluationGateReport }> {
    const current = await this.read(runId, proposalId);
    if (!current.evaluationSets || canonicalJson(current.evaluationSets) !== canonicalJson(input.canonical.evaluationSets)) throw new Error(`Evaluation sets do not match update proposal: ${proposalId}`);
    if (input.canonical.candidateHash !== current.candidateHash) throw new Error(`Evaluation candidate hash does not match update proposal: ${proposalId}`);
    const report = evaluateUpdateGate(input);
    const proposal = await this.evaluate(runId, proposalId, report);
    return { proposal, report };
  }

  public async approve(runId: string, proposalId: string, reason = "Evaluation passed the configured gates."): Promise<UpdateProposal> {
    const current = await this.read(runId, proposalId);
    if (!current.evaluationGate || !current.evaluationHash || !current.evaluationSets || current.metrics?.gatePassed === undefined) throw new Error(`Cannot approve update proposal before a valid passing evaluation gate is persisted: ${proposalId}`);
    validateUpdateEvaluationGate(current.evaluationGate, {
      candidateHash: current.candidateHash,
      evaluationSets: current.evaluationSets,
      evaluationHash: current.evaluationHash,
      gatePassed: current.metrics.gatePassed,
    });
    if (!current.evaluationGate.passed || current.metrics.gatePassed !== 1) throw new Error(`Cannot approve update proposal before a valid passing evaluation gate is persisted: ${proposalId}`);
    await this.controlStore.dispatch(runId, { type: "update_proposal_approved", proposalId, reason, lane: "planner" });
    return this.read(runId, proposalId);
  }

  public async activate(runId: string, proposalId: string): Promise<UpdateProposal> {
    const current = await this.read(runId, proposalId);
    if (current.status !== "APPROVED") throw new Error(`Only APPROVED proposals can be activated: ${proposalId}`);
    await this.controlStore.dispatch(runId, { type: "update_proposal_activated", proposalId, lane: "planner" });
    return this.read(runId, proposalId);
  }

  public async reject(runId: string, proposalId: string, reason: string): Promise<UpdateProposal> {
    await this.controlStore.dispatch(runId, { type: "update_proposal_rejected", proposalId, reason, lane: "planner" });
    return this.read(runId, proposalId);
  }

  public async rollback(runId: string, proposalId: string, reason = "Release failed a post-activation check."): Promise<UpdateProposal> {
    const current = await this.read(runId, proposalId);
    if (current.status !== "ACTIVE") throw new Error(`Only ACTIVE proposals can be rolled back: ${proposalId}`);
    await this.controlStore.dispatch(runId, { type: "update_proposal_rolled_back", proposalId, candidateHash: current.candidateHash, reason, lane: "planner" });
    return this.read(runId, proposalId);
  }

  public async read(runId: string, proposalId: string): Promise<UpdateProposal> {
    const proposal = (await this.controlStore.snapshot(runId)).updateProposals[proposalId];
    if (!proposal) throw new Error(`Unknown update proposal: ${proposalId}`);
    return proposal;
  }

  public async list(runId: string): Promise<UpdateProposal[]> {
    return Object.values((await this.controlStore.snapshot(runId)).updateProposals).sort((a, b) => a.createdSeq - b.createdSeq);
  }
}

function assertReportMatchesProposal(proposal: UpdateProposal, report: UpdateEvaluationGateReport): void {
  if (!proposal.evaluationSets) throw new Error(`Evaluation sets do not match update proposal: ${proposal.id}`);
  validateUpdateEvaluationGate(report, {
    candidateHash: proposal.candidateHash,
    evaluationSets: proposal.evaluationSets,
    evaluationHash: report.hash,
    gatePassed: report.passed ? 1 : 0,
  });
}

export type UpdateProposalCommand = Extract<DomainCommand, { type: `update_proposal_${string}` }>;
