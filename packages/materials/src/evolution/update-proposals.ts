import type { ControlStore, DomainCommand } from "../control/control-store.js";
import type { UpdateProposal, UpdateProposalKind } from "../domain/types.js";
import { id } from "../domain/utils.js";
import { evaluateUpdateGate, metricsForUpdateGate, type UpdateEvaluationGateReport, type UpdateEvaluationInput } from "./evaluation-gates.js";

export interface CreateUpdateProposalInput {
  kind: UpdateProposalKind;
  baseVersion: string;
  candidateVersion: string;
  candidateHash: string;
  sourceArtifactIds?: string[];
  triggerFailureIds?: string[];
  triggerDataset?: string;
  retentionDataset: string;
  migrationDataset: string;
  safetyDataset: string;
}

/** ControlStore-backed proposal lifecycle. Activation is explicit and rollback is hash-bound. */
export class UpdateProposalManager {
  public constructor(private readonly controlStore: ControlStore) {}

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
      ...(input.triggerDataset ? { evaluationSets: {
        trigger: [input.triggerDataset],
        retention: [input.retentionDataset],
        migration: [input.migrationDataset],
        safety: [input.safetyDataset],
      } } : {}),
    };
    await this.controlStore.dispatch(runId, { type: "update_proposal_created", proposal, lane });
    return (await this.controlStore.snapshot(runId)).updateProposals[proposal.id]!;
  }

  public async evaluate(runId: string, proposalId: string, evaluationHash: string, metrics: NonNullable<UpdateProposal["metrics"]>): Promise<UpdateProposal> {
    await this.controlStore.dispatch(runId, { type: "update_proposal_evaluated", proposalId, evaluationHash, metrics, lane: "planner" });
    return this.read(runId, proposalId);
  }

  /** Evaluate and persist the four-set release gate as ordinary proposal metrics. */
  public async evaluateWithGate(runId: string, proposalId: string, input: UpdateEvaluationInput): Promise<{ proposal: UpdateProposal; report: UpdateEvaluationGateReport }> {
    const report = evaluateUpdateGate(input);
    const proposal = await this.evaluate(runId, proposalId, report.hash, metricsForUpdateGate(report));
    return { proposal, report };
  }

  public async approve(runId: string, proposalId: string, reason = "Evaluation passed the configured gates."): Promise<UpdateProposal> {
    const current = await this.read(runId, proposalId);
    if (current.metrics?.gatePassed === 0) throw new Error(`Cannot approve update proposal before all evaluation gates pass: ${proposalId}`);
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

export type UpdateProposalCommand = Extract<DomainCommand, { type: `update_proposal_${string}` }>;
