import type {
  Evidence,
  Fact,
  HarnessEvent,
  Hypothesis,
  Intent,
  Lane,
  Phase,
  ReplayPolicy,
  RunSnapshot,
  TaskContract,
  Observation,
  CompletionProposal,
  CheckpointRef,
  JobRecord,
  HandoffRecord,
  PrimaryFailureCategory,
  RunVersionSnapshot,
  ArtifactSemanticMetadata,
  ActionBundle,
  ReasoningEdge,
  ReasoningNode,
  ReasoningTree,
  WorkItem,
  RequestEpoch,
  SessionRecord,
  DomainPhase,
  ExperimentRecord,
  VerificationVerdict,
  RunToolPreparation,
  DomainRecord,
  DomainRecordInput,
  VerificationRequest,
  UpdateProposal,
  UpdateEvaluationGate,
  RunEventEnvelope,
  RunEventStatus,
} from "../domain/types.js";
import type { Intent as SchedulerIntent } from "../domain/intent.js";
import { validateReasoningEdge, validateReasoningNode, validateReasoningTree } from "../domain/reasoning.js";
import { canonicalJson, id, isTerminal, sha256 } from "../domain/utils.js";
import { redactCtfCandidates } from "../domain/candidate.js";
import { handoffKnowledgeVersion } from "../domain/handoff.js";
import { JsonlControlStore, makeEvent, type JsonlRunWriter } from "../storage/jsonl-store.js";
import { resolveControlAuthority } from "../storage/control-authority.js";
import { projectionHash, reduce } from "./reducer.js";
import { KeyedOperationQueue } from "@proofblade/atoms";
import { assertPhaseTransition } from "./phase-machine.js";
import { isAbsolute, relative, resolve } from "node:path";
import { completedWorkItemForCompletion } from "../domain/work-item.js";
import { maxReplansFor, phaseBudget } from "../domain/phase-budget.js";
import { evaluatePhaseGate } from "../domain/phase-gate.js";
import { isPwnDomainRecord, isWebDomainRecord, validateDomainRecordShape } from "../domain/records.js";
import { validateUpdateEvaluationGate } from "../evolution/evaluation-gates.js";

type WithoutLane<T> = T extends unknown ? Omit<T, "lane"> : never;
type ControlAuthority = "public" | "verifier" | "verifier_artifact" | "verifier_input" | "fixture" | "recovery" | "binding" | "evaluation";
type VerifierResultCommand = Extract<WithoutLane<DomainCommand>, { type: "evidence" | "completion_verified" | "fact" | "artifact_annotation" | "domain_record" }>;
type VerifierEvidenceCommand = Extract<VerifierResultCommand, { type: "evidence" }>;
type VerifierEffectCommand = Extract<WithoutLane<DomainCommand>, { type: "effect_proposed" | "effect_started" | "effect_finished" | "effect_reconciled" }>;
type VerifierResultArtifactCommand = Extract<WithoutLane<DomainCommand>, { type: "artifact" }>;
type UpdateEvaluationCommand = Extract<WithoutLane<DomainCommand>, { type: "update_proposal_evaluated" }>;

export interface VerifierControlPort {
  /** Trusted harness-only channel. Never expose this port to a model lane. */
  dispatch(runId: string, command: VerifierResultCommand): Promise<HarnessEvent[]>;
  dispatchBatch(runId: string, commands: VerifierResultCommand[]): Promise<HarnessEvent[]>;
  /** Finish derives the exact Evidence set and result hash from one accepted Completion. */
  finish(runId: string, input: { completionId: string; reason: string }): Promise<HarnessEvent[]>;
}

/** Effect-lifecycle capability used only inside EffectJournal. */
export interface VerifierEffectControlPort {
  dispatch(runId: string, command: VerifierEffectCommand): Promise<HarnessEvent[]>;
  /** Register one immutable result Artifact for a STARTED verifier Effect. */
  registerResultArtifact(runId: string, command: VerifierResultArtifactCommand): Promise<HarnessEvent[]>;
  /** Register one verifier-owned recovery input before its Effect is proposed. */
  registerInputArtifact(runId: string, command: VerifierResultArtifactCommand): Promise<HarnessEvent[]>;
}

export interface FixtureControlPort {
  /** Check authority and lifecycle before mutating the external fixture. */
  assertResetAllowed(runId: string): Promise<void>;
  /** Harness/recovery-only lifecycle transition after the Sandbox attests reset. */
  reset(runId: string, generation: number): Promise<HarnessEvent[]>;
}

/** Recovery-only mutations for verifier requests. No generic event write is exposed. */
export interface VerificationRecoveryControlPort {
  markRequired(runId: string, input: { requestId: string; reason: string }): Promise<HarnessEvent[]>;
  markResolved(runId: string, input: { requestId: string; reason: string }): Promise<HarnessEvent[]>;
}

/** Evaluation-service-only capability for persisting canonical release gates. */
export interface UpdateEvaluationControlPort {
  dispatch(runId: string, command: UpdateEvaluationCommand): Promise<HarnessEvent[]>;
}

export interface ControlPlane {
  control: ControlStore;
  verifier: VerifierControlPort;
  verifierEffects: VerifierEffectControlPort;
  fixtureControl: FixtureControlPort;
  verificationRecovery: VerificationRecoveryControlPort;
  updateEvaluation: UpdateEvaluationControlPort;
}

const TELEMETRY_EVENT_TYPES = new Set<HarnessEvent["type"]>([
  "turn_started",
  "assistant_message",
  "provider_request_started",
  "request_epoch_started",
  "provider_request_queued",
  "provider_request_slot_acquired",
  "provider_request_queue_cancelled",
  "provider_request_retried",
  "provider_request_first_event",
  "provider_request_first_token",
  "provider_request_inter_event_idle",
  "provider_request_stalled",
  "provider_recovery_required",
  "resource_cleanup_recovery_required",
  "provider_response_received",
  "request_epoch_context",
  "model_context_frame_recorded",
  "tool_call_recorded",
  "tool_result_recorded",
  "consolidate_started",
  "consolidate_summary",
  "consolidate_finished",
  "consolidate_failed",
  "compaction_recorded",
  "model_usage",
  "event_ingress_received",
  "event_ingress_processed",
  "observation_consumed",
]);
const VERIFIER_RESULT_COMMAND_TYPES = new Set(["evidence", "completion_verified", "fact", "artifact_annotation", "domain_record"]);
const VERIFIER_EFFECT_COMMAND_TYPES = new Set(["effect_proposed", "effect_started", "effect_finished", "effect_reconciled"]);
const FAILURE_CATEGORIES = new Set<PrimaryFailureCategory>([
  "model_no_tool_call", "bad_tool_args", "tool_timeout", "tool_schema_mismatch", "context_overflow", "context_amnesia", "wrong_hypothesis", "verification_missing", "permission_or_environment", "budget_exhausted", "effect_outcome_unknown", "environment_drift", "prompt_injection_followed", "duplicate_submission", "verifier_disagreement",
]);

export type DomainCommand =
  | { type: "start_phase"; phase: Phase; lane?: Lane }
  | { type: "finish_phase"; phase: Phase; lane?: Lane }
  | { type: "set_domain_phase"; domainPhase: DomainPhase; lane?: Lane }
  | { type: "record_tool_preparation"; preparation: RunToolPreparation; lane?: Lane }
  | { type: "fixture_reset"; generation: number; lane?: Lane }
  | { type: "pause"; reason: string; lane?: Lane }
  | { type: "resume"; lane?: Lane }
  | { type: "cancel"; reason: string; lane?: Lane }
  | { type: "finish"; verified: true; completionId: string; evidenceIds: string[]; reason: string; lane?: Lane }
  | { type: "finish"; verified: false; evidenceIds?: string[]; reason: string; failureCategory?: PrimaryFailureCategory; lane?: Lane }
  | { type: "fail"; reason: string; category: PrimaryFailureCategory; lane?: Lane }
  | { type: "exhaust"; reason: string; lane?: Lane }
  | { type: "fact"; fact: Omit<Fact, "createdSeq" | "runId" | "generation">; lane?: Lane }
  | { type: "observation"; observation: Omit<Observation, "createdSeq" | "runId" | "generation">; lane?: Lane }
  | { type: "evidence"; evidence: Omit<Evidence, "createdSeq" | "provenance">; lane?: Lane }
  | { type: "domain_record"; record: DomainRecordInput; lane?: Lane }
  | { type: "experiment"; experiment: Omit<ExperimentRecord, "createdSeq">; lane?: Lane }
  | { type: "replan_requested"; replan: Omit<RunSnapshot["replans"][string], "createdSeq" | "runId" | "generation">; lane?: Lane }
  | { type: "update_proposal_created"; proposal: Omit<UpdateProposal, "createdSeq" | "updatedSeq" | "runId" | "status">; lane?: Lane }
  | { type: "update_proposal_evaluated"; proposalId: string; evaluationHash: string; metrics?: UpdateProposal["metrics"]; gate: UpdateEvaluationGate; lane?: Lane }
  | { type: "update_proposal_approved"; proposalId: string; reason?: string; lane?: Lane }
  | { type: "update_proposal_activated"; proposalId: string; lane?: Lane }
  | { type: "update_proposal_rejected"; proposalId: string; reason: string; lane?: Lane }
  | { type: "update_proposal_rolled_back"; proposalId: string; candidateHash: string; reason?: string; lane?: Lane }
  | { type: "reasoning_node"; node: Omit<ReasoningNode, "createdSeq" | "updatedSeq">; lane?: Lane }
  | { type: "reasoning_edge"; edge: Omit<ReasoningEdge, "createdSeq">; lane?: Lane }
  | { type: "reasoning_tree"; tree: Omit<ReasoningTree, "createdSeq" | "updatedSeq">; lane?: Lane }
  | { type: "hypothesis"; hypothesis: Omit<Hypothesis, "createdSeq" | "runId" | "generation">; lane?: Lane }
  | { type: "intent"; intent: Omit<Intent, "createdSeq">; lane?: Lane }
  | { type: "scheduler_intent"; intent: SchedulerIntent; lane?: Lane }
  | { type: "completion_proposed"; completion: Omit<CompletionProposal, "createdSeq" | "status" | "evidenceIds" | "runId" | "generation">; lane?: Lane }
  | { type: "verification_requested"; request: Omit<VerificationRequest, "createdSeq" | "status" | "recoveryState" | "recoveryReason" | "recoverySeq" | "runId" | "generation" | "completionId">; lane?: Lane }
  | { type: "verification_recovery_required"; requestId: string; reason: string; lane?: Lane }
  | { type: "verification_recovery_resolved"; requestId: string; reason: string; lane?: Lane }
  | { type: "completion_verified"; completionId: string; accepted: boolean; evidenceIds: string[]; lane?: Lane }
  | { type: "artifact"; generation: number; artifact: Omit<RunSnapshot["artifacts"][string], "runId" | "generation" | "origin">; lane?: Lane }
  | { type: "artifact_annotation"; artifactId: string; semantic: Omit<ArtifactSemanticMetadata, "updatedSeq">; lane?: Lane }
  | { type: "effect_proposed"; effect: Omit<RunSnapshot["effects"][string], "createdSeq" | "runId" | "generation" | "producerLane">; lane?: Lane }
  | { type: "effect_started"; effectId: string; sessionId?: string; externalId?: string; lane?: Lane }
  | { type: "effect_finished"; effectId: string; outcome: "success" | "error" | "timeout" | "unknown"; artifactId?: string; externalId?: string; durationMs?: number; outputBytes?: number; exitCode?: number | null; errorSignature?: string; verification?: VerificationVerdict; lane?: Lane }
  | { type: "effect_reconciled"; effectId: string; outcome: "success" | "error" | "timeout" | "unknown"; lane?: Lane }
  | { type: "lease_acquired"; lease: RunSnapshot["leases"][string]; lane?: Lane }
  | { type: "lease_heartbeat"; resourceKey: string; ownerLane: Lane; generation: number; heartbeatAt: string; expiresAt: string; lane?: Lane }
  | { type: "lease_released"; resourceKey: string; ownerLane?: Lane; generation?: number; lane?: Lane }
  | { type: "checkpoint"; checkpoint: Omit<CheckpointRef, "createdSeq">; lane?: Lane }
  | { type: "job_queued"; job: Omit<JobRecord, "createdSeq">; lane?: Lane }
  | { type: "job_queued_legacy"; job: Omit<JobRecord, "createdSeq" | "backendId" | "backendVersion"> & { backendId?: string; backendVersion?: string }; lane?: Lane }
  | { type: "job_started"; jobId: string; startedAt?: string; lane?: Lane }
  | { type: "job_finished"; jobId: string; status: "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "UNKNOWN"; outcome: "success" | "error" | "timeout" | "unknown"; effectId?: string; artifactId?: string; externalId?: string; error?: string; outputTier?: "small" | "medium" | "large"; finishedAt?: string; lane?: Lane }
  | { type: "job_cancelled"; jobId: string; reason: string; finishedAt?: string; lane?: Lane }
  | { type: "job_reconciled"; jobId: string; reason: string; lane?: Lane }
  | { type: "handoff_proposed"; handoff: Omit<HandoffRecord, "createdSeq">; lane?: Lane }
  | { type: "handoff_accepted"; handoffId: string; lane?: Lane }
  | { type: "handoff_superseded"; handoffId: string; reason: string; lane?: Lane }
  | { type: "handoff_rejected"; handoffId: string; reason: string; lane?: Lane }
  | { type: "work_item_created"; workItem: Omit<WorkItem, "createdSeq" | "updatedSeq">; lane?: Lane }
  | { type: "work_item_ready"; workItemId: string; lane?: Lane }
  | { type: "work_item_claimed"; workItemId: string; ownerLane: Lane; leaseExpiresAt: string; lane?: Lane }
  | { type: "work_item_blocked"; workItemId: string; reason: string; lane?: Lane }
  | { type: "work_item_completed"; workItemId: string; evidenceIds?: string[]; artifactIds?: string[]; lane?: Lane }
  | { type: "work_item_failed"; workItemId: string; reason: string; lane?: Lane }
  | { type: "work_item_cancelled"; workItemId: string; reason: string; lane?: Lane }
  | { type: "work_item_superseded"; workItemId: string; reason: string; lane?: Lane }
  | { type: "request_epoch_started"; epoch: Omit<RequestEpoch, "createdSeq" | "updatedSeq">; lane?: Lane }
  | { type: "session_opened"; session: Omit<SessionRecord, "createdSeq" | "updatedSeq" | "status" | "interactions"> & { interactions?: number }; lane?: Lane }
  | { type: "session_binding_completed"; sessionId: string; bindingTxnId: string; bindingIdentityHash: string; lane?: Lane }
  | { type: "session_interacted"; sessionId: string; waitReason?: SessionRecord["lastWaitReason"]; transcriptArtifactId?: string; stateHash?: string; exited?: boolean; exitCode?: number | null; lane?: Lane }
  | { type: "session_signaled"; sessionId: string; signal: string; delivered?: boolean; lane?: Lane }
  | { type: "session_closed"; sessionId: string; reason?: string; exitCode?: number | null; lane?: Lane }
  | { type: "session_superseded"; sessionId: string; reason: string; lane?: Lane }
  | { type: "context_recovery"; checkpointId: string; lane?: Lane };

export interface IngressClaim {
  ingressId: string;
  envelope: RunEventEnvelope;
  status: Extract<RunEventStatus, "claimed" | "coalesced" | "failed">;
  safePoint: string;
  leaseMs?: number;
  claimToken?: string;
  leaseExpiresAt?: string;
}

type WorkItemCommand = Extract<DomainCommand, { type: `work_item_${string}` }>;

export class ControlStore {
  private readonly operations = new KeyedOperationQueue();
  #authoritySecret: string;
  #authorityHash: string;

  public static create(
    eventStore: JsonlControlStore,
    versionProvider?: () => Promise<RunVersionSnapshot>,
    authoritySecret?: string,
  ): ControlPlane {
    const control = new ControlStore(eventStore, versionProvider, authoritySecret);
    return {
      control,
      verifier: control.#createVerifierPort(),
      verifierEffects: control.#createVerifierEffectPort(),
      fixtureControl: control.#createFixtureControlPort(),
      verificationRecovery: control.#createVerificationRecoveryPort(),
      updateEvaluation: control.#createUpdateEvaluationPort(),
    };
  }

  public constructor(
    private readonly eventStore: JsonlControlStore,
    private readonly versionProvider?: () => Promise<RunVersionSnapshot>,
    authoritySecret?: string,
  ) {
    if (authoritySecret !== undefined && authoritySecret.length < 32) {
      throw new Error("Control authority secret must contain at least 32 characters");
    }
    this.#authoritySecret = authoritySecret ?? resolveControlAuthority();
    this.#authorityHash = sha256(this.#authoritySecret);
  }

  public async createRun(runId: string, task: TaskContract): Promise<RunSnapshot> {
    validateTaskContract(task);
    return await this.operations.run(runId, async () => {
      return await this.eventStore.create(runId, task, await this.versionProvider?.(), this.#authorityHash, this.#authoritySecret);
    });
  }

  public async snapshot(runId: string): Promise<RunSnapshot> {
    await this.#migrateLegacyRunBestEffort(runId);
    return await this.eventStore.replay(runId);
  }

  public async replay(runId: string): Promise<RunSnapshot> {
    await this.#migrateLegacyRunBestEffort(runId);
    return await this.eventStore.replay(runId);
  }

  async #migrateLegacyRunBestEffort(runId: string): Promise<void> {
    try {
      await this.eventStore.migrateLegacyRun(runId, this.#authorityHash);
    } catch {
      // Migration is an availability enhancement, never a replay prerequisite.
      // replay() below still validates the full stream and exposes a legacy Run
      // as read-only when backup/append cannot be completed.
    }
  }

  public async events(runId: string): Promise<HarnessEvent[]> {
    return await this.eventStore.events(runId);
  }

  /** Atomically claim ingress events under the same Run lock used by writes. */
  public async claimIngress(runId: string, claims: readonly IngressClaim[]): Promise<IngressClaim[]> {
    if (claims.length === 0) return [];
    if (claims.length > 256) throw new Error("At most 256 ingress events can be claimed in one batch");
    return await this.operations.run(runId, async () => await this.#withWrite(runId, async (before, writer) => {
      const events = await this.eventStore.events(runId);
      const terminal = new Set(events
        .filter((event) => event.type === "event_ingress_processed" && ["applied", "coalesced", "failed"].includes(String(event.payload?.status)))
        .map((event) => String(event.payload?.ingressId ?? "")));
      const activeClaims = new Map<string, { claimToken: string; leaseExpiresAt: string }>();
      for (const event of events.filter((candidate) => candidate.type === "event_ingress_processed" && candidate.payload?.status === "claimed")) {
        const ingressId = String(event.payload?.ingressId ?? "");
        const claimToken = String(event.payload?.claimToken ?? "");
        const leaseExpiresAt = String(event.payload?.leaseExpiresAt ?? "");
        if (ingressId && claimToken && Number.isFinite(Date.parse(leaseExpiresAt)) && Date.parse(leaseExpiresAt) > Date.now()) {
          activeClaims.set(ingressId, { claimToken, leaseExpiresAt });
        }
      }
      const received = new Map(events
        .filter((event) => event.type === "event_ingress_received" && event.envelope)
        .map((event) => [event.envelope!.id, event]));
      const accepted = [...new Map(claims.map((claim) => [claim.ingressId, claim])).values()]
        .filter((claim) => !terminal.has(claim.ingressId) && !activeClaims.has(claim.ingressId) && received.has(claim.ingressId));
      if (accepted.length === 0) return [];
      const admitted = accepted.map((claim) => claim.status === "claimed"
        ? { ...claim, claimToken: id("IC"), leaseExpiresAt: new Date(Date.now() + normalizeIngressLease(claim.leaseMs)).toISOString() }
        : claim);
      const materialized = admitted.map((claim, index) => {
        const receivedEvent = received.get(claim.ingressId)!;
        return makeEvent(runId, before.lastSeq + index + 1, "event_ingress_processed", "orchestrator", "main", {
          ingressId: claim.ingressId,
          status: claim.status,
          safePoint: claim.safePoint,
          ...(claim.claimToken ? { claimToken: claim.claimToken } : {}),
          ...(claim.leaseExpiresAt ? { leaseExpiresAt: claim.leaseExpiresAt } : {}),
        }, receivedEvent.correlationId, { ...claim.envelope, status: claim.status });
      });
      await writer.append(materialized, this.#authoritySecret);
      await writer.saveProjection(materialized.reduce(reduce, before), this.#authoritySecret);
      return admitted;
    }));
  }

  /** Complete a previously claimed ingress action after its side effect ran. */
  public async completeIngress(
    runId: string,
    input: { ingressId: string; claimToken: string; status: Extract<RunEventStatus, "applied" | "coalesced" | "failed">; safePoint?: string; reason?: string },
  ): Promise<void> {
    if (!input.ingressId || !input.claimToken) throw new Error("Ingress completion requires ingressId and claimToken");
    await this.operations.run(runId, async () => await this.#withWrite(runId, async (before, writer) => {
      const events = await this.eventStore.events(runId);
      const received = events.find((event) => event.type === "event_ingress_received" && event.envelope?.id === input.ingressId);
      if (!received?.envelope) throw new Error(`Unknown ingress event ${input.ingressId}`);
      const processed = events.filter((event) => event.type === "event_ingress_processed" && event.payload?.ingressId === input.ingressId).at(-1);
      const currentStatus = String(processed?.payload?.status ?? "");
      if (["applied", "coalesced", "failed"].includes(currentStatus)) {
        if (currentStatus !== input.status) throw new Error(`Ingress ${input.ingressId} is already ${currentStatus}`);
        return;
      }
      if (currentStatus !== "claimed" || String(processed?.payload?.claimToken ?? "") !== input.claimToken) {
        throw new Error(`Ingress ${input.ingressId} claim is missing or owned by another worker`);
      }
      const leaseExpiresAt = String(processed?.payload?.leaseExpiresAt ?? "");
      if (!Number.isFinite(Date.parse(leaseExpiresAt)) || Date.parse(leaseExpiresAt) <= Date.now()) throw new Error(`Ingress ${input.ingressId} claim lease expired`);
      const completionGeneration = received.envelope.generation;
      const currentGeneration = before.generation;
      const staleGeneration = completionGeneration !== currentGeneration;
      const completionStatus = staleGeneration ? "failed" : input.status;
      const completionReason = staleGeneration
        ? `Ingress generation ${completionGeneration} is stale; current Run generation is ${currentGeneration}`
        : input.reason;
      const materialized = makeEvent(runId, before.lastSeq + 1, "event_ingress_processed", "orchestrator", "main", {
        ingressId: input.ingressId,
        status: completionStatus,
        safePoint: input.safePoint ?? String(processed?.payload?.safePoint ?? "unknown"),
        ...(completionReason ? { reason: completionReason } : {}),
      }, received.correlationId, { ...received.envelope, status: completionStatus });
      const after = reduce(before, materialized);
      await writer.append([materialized], this.#authoritySecret);
      await writer.saveProjection(after, this.#authoritySecret);
    }));
  }

  /**
   * Append one received ingress event with idempotency checked inside the Run
   * lock. The preflight read in the adapter is only an optimization; this
   * method is the durable race boundary for two producers using the same key.
   */
  public async appendIngressReceived(
    runId: string,
    input: { envelope: RunEventEnvelope; payload?: Record<string, unknown> },
  ): Promise<RunEventEnvelope> {
    if (input.envelope.runId !== runId) throw new Error("Ingress envelope belongs to another Run");
    return await this.operations.run(runId, async () => await this.#withWrite(runId, async (before, writer) => {
      const events = await this.eventStore.events(runId);
      const existing = events.find((event) => event.type === "event_ingress_received"
        && event.envelope?.idempotencyKey === input.envelope.idempotencyKey);
      if (existing?.envelope) return existing.envelope;
      const materialized = makeEvent(
        runId,
        before.lastSeq + 1,
        "event_ingress_received",
        "orchestrator",
        "main",
        { envelope: input.envelope, ...(input.payload ? { payload: input.payload } : {}) },
        input.envelope.correlationId,
        input.envelope,
      );
      const after = reduce(before, materialized);
      await writer.append([materialized], this.#authoritySecret);
      await writer.saveProjection(after, this.#authoritySecret);
      return materialized.envelope!;
    }));
  }

  /** Wait for a durable event so long-running tools do not replay the full Run in a polling loop. */
  public async waitForEvents(runId: string, afterSeq: number, timeoutMs = 30_000): Promise<HarnessEvent[]> {
    return await this.eventStore.waitForEvents(runId, afterSeq, timeoutMs);
  }

  /**
   * Atomically acknowledge model-visible observations. Queue state is derived
   * from the event stream; these markers are the only durable cursor and keep
   * restart/replay independent from process memory.
   */
  public async acknowledgeObservations(runId: string, observationIds: readonly string[], lane: Lane = "main"): Promise<string[]> {
    const ids = [...new Set(observationIds.map((value) => String(value).trim()).filter(Boolean))];
    if (ids.length === 0) return [];
    if (ids.length > 128) throw new Error("At most 128 observations can be acknowledged in one batch");
    return await this.operations.run(runId, async () => await this.#withWrite(runId, async (before, writer) => {
      const events = await this.eventStore.events(runId);
      const observationEventIds = new Map<string, string>();
      for (const event of events) {
        if (event.type !== "observation_consumed") {
          observationEventIds.set(event.id, event.id);
          if (event.envelope?.id) observationEventIds.set(event.envelope.id, event.id);
        }
      }
      const normalizedIds = [...new Set(ids.map((observationId) => observationEventIds.get(observationId) ?? observationId))];
      const consumed = new Set(events.filter((event) => event.type === "observation_consumed").map((event) => String(event.payload?.observationId ?? "")));
      const pending = normalizedIds.filter((observationId) => !consumed.has(observationId));
      if (pending.length === 0) return [];
      const materialized = pending.map((observationId, index) => makeEvent(
        runId,
        before.lastSeq + index + 1,
        "observation_consumed",
        "orchestrator",
        lane,
        { observationId },
        `${runId}:${lane}:observation-consumed`,
      ));
      await writer.append(materialized, this.#authoritySecret);
      // Telemetry does not change domain fields, but it still advances the
      // replay cursor. Persist the reduced projection so the materialized
      // snapshot cannot lag the durable event stream after acknowledgement.
      const after = materialized.reduce(reduce, before);
      await writer.saveProjection(after, this.#authoritySecret);
      return pending;
    }));
  }

  /** Serialize slow, replay-safe maintenance operations for one Run. */
  public async withConsolidationLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    return await this.eventStore.withRunMaintenanceLock(runId, operation);
  }

  public async dispatch(runId: string, command: DomainCommand): Promise<HarnessEvent[]> {
    return await this.dispatchBatch(runId, [command]);
  }

  public async dispatchBatch(runId: string, commands: DomainCommand[]): Promise<HarnessEvent[]> {
    if (commands.length === 0) return [];
    return await this.operations.run(runId, async () => await this.#withWrite(runId, async (before, writer) => {
      const { events } = await this.#commitCommands(runId, before, commands, "public", writer);
      return events;
    }));
  }

  public async dispatchTransaction<TResult>(
    runId: string,
    prepare: (snapshot: RunSnapshot) => { commands: DomainCommand[]; project: (after: RunSnapshot) => TResult },
  ): Promise<TResult> {
    return await this.operations.run(runId, async () => await this.#withWrite(runId, async (before, writer) => {
      const transaction = prepare(before);
      if (transaction.commands.length === 0) return transaction.project(before);
      const { after } = await this.#commitCommands(runId, before, transaction.commands, "public", writer);
      return transaction.project(after);
    }));
  }

  /**
   * Commit the final Control Store fence for a broker-owned session binding.
   * This capability is intentionally separate from public lane dispatch so a
   * model cannot forge a BOUND session marker.
   */
  public async dispatchBindingTransaction<TResult>(
    runId: string,
    prepare: (snapshot: RunSnapshot) => { commands: DomainCommand[]; project: (after: RunSnapshot) => TResult },
  ): Promise<TResult> {
    return await this.operations.run(runId, async () => await this.#withWrite(runId, async (before, writer) => {
      const transaction = prepare(before);
      if (transaction.commands.length === 0) return transaction.project(before);
      const { after } = await this.#commitCommands(runId, before, transaction.commands, "binding", writer);
      return transaction.project(after);
    }));
  }

  public async append(runId: string, events: Array<Omit<HarnessEvent, "seq" | "id" | "streamId" | "runId" | "ts">>): Promise<HarnessEvent[]> {
    return await this.operations.run(runId, async () => await this.#withWrite(runId, async (snapshot, writer) => {
      const forbidden = events.filter((event) => !TELEMETRY_EVENT_TYPES.has(event.type));
      if (forbidden.length > 0) {
        throw new Error(`Raw append is restricted to telemetry events; use a validated command for ${forbidden.map((event) => event.type).join(", ")}`);
      }
      const materialized = events.map((event, index) => makeEvent(
        runId,
        snapshot.lastSeq + index + 1,
        event.type,
        event.actor,
        event.lane,
        event.payload,
        event.correlationId,
        { ...event.envelope, generation: event.envelope?.generation ?? snapshot.generation },
      ));
      let validated = snapshot;
      for (const event of materialized) validated = reduce(validated, event);
      await writer.append(materialized, this.#authoritySecret);
      await writer.saveProjection(validated, this.#authoritySecret);
      return materialized;
    }));
  }

  public async runHash(runId: string): Promise<string> {
    const snapshot = await this.replay(runId);
    return sha256(canonicalJson(snapshot));
  }

  /**
   * Rebuild the materialized projection after a process interruption. The
   * event stream is authoritative; a stale or corrupt projection is replaced
   * only after a complete replay succeeds. Legacy untrusted Runs remain
   * read-only and are never rewritten with a trusted projection.
   */
  public async reconcileProjection(runId: string): Promise<{ repaired: boolean; replayHash: string }> {
    return await this.operations.run(runId, async () => {
      await this.#migrateLegacyRunBestEffort(runId);
      return await this.eventStore.withRunLock(runId, async (writer) => {
        const replayed = await this.eventStore.replay(runId);
        const replayHash = projectionHash(replayed);
        if (replayed.authorityHash === "LEGACY-UNTRUSTED") return { repaired: false, replayHash };
        let persisted: RunSnapshot | undefined;
        try {
          persisted = await this.eventStore.loadProjection(runId);
        } catch {
          // A malformed projection is disposable because the event stream has
          // already replayed successfully and remains the source of truth.
        }
        if (persisted && projectionHash(persisted) === replayHash) return { repaired: false, replayHash };
        await writer.saveProjection(replayed, this.#authoritySecret);
        return { repaired: true, replayHash };
      });
    });
  }

  async #withWrite<T>(runId: string, operation: (before: RunSnapshot, writer: JsonlRunWriter) => Promise<T>): Promise<T> {
    await this.#migrateLegacyRunBestEffort(runId);
    return await this.eventStore.withRunLock(runId, async (writer) => await operation(await this.eventStore.replay(runId), writer));
  }

  async #commitCommands(
    runId: string,
    before: RunSnapshot,
    commands: DomainCommand[],
    authority: ControlAuthority,
    writer: JsonlRunWriter,
  ): Promise<{ after: RunSnapshot; events: HarnessEvent[] }> {
    if (authority !== "public" && before.authorityHash !== this.#authorityHash) {
      throw new Error("Trusted control authority does not match the immutable Run anchor");
    }
    if (commands.some((command) => command.type === "fixture_reset") && commands.length !== 1) {
      throw new Error("fixture_reset must be committed as an isolated lifecycle transaction");
    }
    let after = before;
    const events: HarnessEvent[] = [];
    const references = buildBatchReferences(before, commands);
    for (const command of commands) {
      validateCommand(after, command, references, authority);
      const lane = command.lane ?? "main";
      const seq = after.lastSeq + 1;
      const rawPayload = payloadFor(command, seq, after, lane, authority);
      // Candidate-shaped values may appear in any security task's audit
      // metadata. This is a storage-boundary privacy rule, not a CTF mode
      // behavior, so general tasks must not bypass it.
      const payload = redactCtfEventPayload(rawPayload);
      const event = makeEvent(runId, seq, eventType(command), commandActor(command), lane, payload, `${runId}:system`, {
        generation: after.generation,
        source: command.lane === "verifier" ? "verifier" : command.type === "pause" || command.type === "resume" ? "user" : undefined,
        correlationId: `${runId}:command:${command.type}`,
        kind: command.type,
        priority: command.type === "pause" || command.type === "resume" || command.type === "finish" || command.type === "fail" || command.type === "exhaust" ? "urgent" : undefined,
      });
      after = reduce(after, event);
      events.push(event);
    }
    await writer.append(events, this.#authoritySecret);
    await writer.saveProjection(after, this.#authoritySecret);
    return { after, events };
  }

  #createVerifierPort(): VerifierControlPort {
    const dispatchBatch = async (runId: string, commands: VerifierResultCommand[]): Promise<HarnessEvent[]> => {
      if (commands.length === 0) return [];
      if (commands.some((command) => !VERIFIER_RESULT_COMMAND_TYPES.has(command.type))) throw new Error("Verifier result capability only accepts Evidence, Completion, Fact, Domain Record, and trusted annotation commands");
      return await this.operations.run(runId, async () => await this.#withWrite(runId, async (before, writer) => {
        const pending = filterIdempotentVerifierCommands(before, commands);
        if (pending.length === 0) return [];
        const trusted = pending.map((command) => ({ ...command, lane: "verifier" }) as DomainCommand);
        const { events } = await this.#commitCommands(runId, before, trusted, "verifier", writer);
        return events;
      }));
    };
    return Object.freeze({
      dispatch: async (runId: string, command: VerifierResultCommand) => await dispatchBatch(runId, [command]),
      dispatchBatch,
      finish: async (runId: string, input: { completionId: string; reason: string }) => await this.operations.run(runId, async () => await this.#withWrite(runId, async (snapshot, writer) => {
        const completion = snapshot.completions[input.completionId];
        if (!completion) throw new Error(`Unknown completion ${input.completionId}`);
        const command: DomainCommand = {
          type: "finish",
          verified: true,
          completionId: completion.id,
          evidenceIds: [...completion.evidenceIds],
          reason: input.reason,
          lane: "verifier",
        };
        const { events } = await this.#commitCommands(runId, snapshot, [command], "verifier", writer);
        return events;
      })),
    });
  }

  #createVerifierEffectPort(): VerifierEffectControlPort {
    return Object.freeze({
      dispatch: async (runId: string, command: VerifierEffectCommand): Promise<HarnessEvent[]> => await this.operations.run(runId, async () => await this.#withWrite(runId, async (snapshot, writer) => {
        if (!VERIFIER_EFFECT_COMMAND_TYPES.has(command.type)) throw new Error("Verifier Effect capability only accepts Effect lifecycle commands");
        const trusted = { ...command, lane: "verifier" } as DomainCommand;
        const { events } = await this.#commitCommands(runId, snapshot, [trusted], "verifier", writer);
        return events;
      })),
      registerResultArtifact: async (runId: string, command: VerifierResultArtifactCommand): Promise<HarnessEvent[]> => await this.operations.run(runId, async () => await this.#withWrite(runId, async (snapshot, writer) => {
        if (command.type !== "artifact") throw new Error("Verifier Artifact capability only accepts Artifact registration commands");
        const trusted = { ...command, lane: "verifier" } as DomainCommand;
        const { events } = await this.#commitCommands(runId, snapshot, [trusted], "verifier_artifact", writer);
        return events;
      })),
      registerInputArtifact: async (runId: string, command: VerifierResultArtifactCommand): Promise<HarnessEvent[]> => await this.operations.run(runId, async () => await this.#withWrite(runId, async (snapshot, writer) => {
        if (command.type !== "artifact") throw new Error("Verifier input capability only accepts Artifact registration commands");
        const trusted = { ...command, lane: "verifier" } as DomainCommand;
        const { events } = await this.#commitCommands(runId, snapshot, [trusted], "verifier_input", writer);
        return events;
      })),
    });
  }

  #createFixtureControlPort(): FixtureControlPort {
    return Object.freeze({
      assertResetAllowed: async (runId: string): Promise<void> => await this.operations.run(runId, async () => {
        const snapshot = await this.snapshot(runId);
        if (snapshot.authorityHash !== this.#authorityHash) throw new Error("Trusted control authority does not match the immutable Run anchor");
        validateFixtureResetState(snapshot);
      }),
      reset: async (runId: string, generation: number) => await this.operations.run(runId, async () => await this.#withWrite(runId, async (snapshot, writer) => {
        const command: DomainCommand = { type: "fixture_reset", generation, lane: "main" };
        const { events } = await this.#commitCommands(runId, snapshot, [command], "fixture", writer);
        return events;
      })),
    });
  }

  #createVerificationRecoveryPort(): VerificationRecoveryControlPort {
    const mark = async (
      runId: string,
      command: Extract<DomainCommand, { type: "verification_recovery_required" | "verification_recovery_resolved" }>,
    ): Promise<HarnessEvent[]> => await this.operations.run(runId, async () => await this.#withWrite(runId, async (snapshot, writer) => {
      const request = snapshot.verificationRequests[command.requestId];
      if (!request) throw new Error(`Unknown verification request ${command.requestId}`);
      if ((command.type === "verification_recovery_required" && request.recoveryState === "RECOVERY_REQUIRED")
        || (command.type === "verification_recovery_resolved" && request.recoveryState === "RECOVERED")) return [];
      const trusted = { ...command, lane: "verifier" } as DomainCommand;
      const { events } = await this.#commitCommands(runId, snapshot, [trusted], "recovery", writer);
      return events;
    }));
    return Object.freeze({
      markRequired: async (runId: string, input: { requestId: string; reason: string }) => await mark(runId, { type: "verification_recovery_required", ...input }),
      markResolved: async (runId: string, input: { requestId: string; reason: string }) => await mark(runId, { type: "verification_recovery_resolved", ...input }),
    });
  }

  #createUpdateEvaluationPort(): UpdateEvaluationControlPort {
    return Object.freeze({
      dispatch: async (runId: string, command: UpdateEvaluationCommand): Promise<HarnessEvent[]> => await this.operations.run(runId, async () => await this.#withWrite(runId, async (snapshot, writer) => {
        if (command.type !== "update_proposal_evaluated") throw new Error("Update evaluation capability only accepts evaluated proposal commands");
        const trusted = { ...command, lane: "planner" } as DomainCommand;
        const { events } = await this.#commitCommands(runId, snapshot, [trusted], "evaluation", writer);
        return events;
      })),
    });
  }
}

function eventType(command: DomainCommand): HarnessEvent["type"] {
  switch (command.type) {
    case "start_phase": return "phase_started";
    case "finish_phase": return "phase_finished";
    case "set_domain_phase": return "domain_phase_changed";
    case "record_tool_preparation": return "tool_preparation_recorded";
    case "fixture_reset": return "fixture_reset";
    case "pause": return "run_paused";
    case "resume": return "run_resumed";
    case "cancel": return "run_finished";
    case "finish": return "run_finished";
    case "fail": return "run_failed";
    case "exhaust": return "run_finished";
    case "fact": return "fact_added";
    case "observation": return "observation_added";
    case "evidence": return "evidence_added";
    case "domain_record": return "domain_record_added";
    case "experiment": return "experiment_recorded";
    case "replan_requested": return "replan_requested";
    case "update_proposal_created": return "update_proposal_created";
    case "update_proposal_evaluated": return "update_proposal_evaluated";
    case "update_proposal_approved": return "update_proposal_approved";
    case "update_proposal_activated": return "update_proposal_activated";
    case "update_proposal_rejected": return "update_proposal_rejected";
    case "update_proposal_rolled_back": return "update_proposal_rolled_back";
    case "reasoning_node": return "reasoning_node_upserted";
    case "reasoning_edge": return "reasoning_edge_added";
    case "reasoning_tree": return "reasoning_tree_upserted";
    case "hypothesis": return "hypothesis_added";
    case "intent": return "intent_changed";
    case "scheduler_intent": return "scheduler_intent_changed";
    case "completion_proposed": return "completion_proposed";
    case "verification_requested": return "verification_requested";
    case "verification_recovery_required": return "verification_recovery_required";
    case "verification_recovery_resolved": return "verification_recovery_resolved";
    case "completion_verified": return "completion_verified";
    case "artifact": return "artifact_registered";
    case "artifact_annotation": return "artifact_annotated";
    case "effect_proposed": return "effect_proposed";
    case "effect_started": return "effect_started";
    case "effect_finished": return "effect_finished";
    case "effect_reconciled": return "effect_reconciled";
    case "lease_acquired": return "lease_acquired";
    case "lease_heartbeat": return "lease_heartbeat";
    case "lease_released": return "lease_released";
    case "checkpoint": return "checkpoint_created";
    case "job_queued":
    case "job_queued_legacy": return "job_queued";
    case "job_started": return "job_started";
    case "job_finished": return "job_finished";
    case "job_cancelled": return "job_cancelled";
    case "job_reconciled": return "job_reconciled";
    case "handoff_proposed": return "handoff_proposed";
    case "handoff_accepted": return "handoff_accepted";
    case "handoff_superseded": return "handoff_superseded";
    case "handoff_rejected": return "handoff_rejected";
    case "work_item_created": return "work_item_created";
    case "work_item_ready": return "work_item_ready";
    case "work_item_claimed": return "work_item_claimed";
    case "work_item_blocked": return "work_item_blocked";
    case "work_item_completed": return "work_item_completed";
    case "work_item_failed": return "work_item_failed";
    case "work_item_cancelled": return "work_item_cancelled";
    case "work_item_superseded": return "work_item_superseded";
    case "request_epoch_started": return "request_epoch_started";
    case "session_opened": return "session_opened";
    case "session_binding_completed": return "session_binding_completed";
    case "session_interacted": return "session_interacted";
    case "session_signaled": return "session_signaled";
    case "session_closed": return "session_closed";
    case "session_superseded": return "session_superseded";
    case "context_recovery": return "context_overflow_recovered";
  }
}

function commandActor(command: DomainCommand): HarnessEvent["actor"] {
  return command.type === "effect_finished" || command.type === "effect_started" ? "tool" : "orchestrator";
}

/**
 * Control events are the replay/audit surface, not a second transcript. A
 * model can put a recovered flag into an otherwise harmless annotation,
 * evidence summary, or failure message, so redact every CTF-shaped value at
 * the event boundary while keeping its stable hash for correlation.
 */
function redactCtfEventPayload(value: unknown): Record<string, unknown> {
  const redact = (current: unknown): unknown => {
    if (typeof current === "string") return redactCtfCandidates(current, (candidate) => `[candidate sha256=${sha256(candidate)}]`);
    if (Array.isArray(current)) return current.map(redact);
    if (current && typeof current === "object") return Object.fromEntries(Object.entries(current).map(([key, item]) => [key, redact(item)]));
    return current;
  };
  return (redact(value) as Record<string, unknown>);
}

function payloadFor(command: DomainCommand, seq: number, snapshot: RunSnapshot, lane: Lane, authority: ControlAuthority): Record<string, unknown> {
  switch (command.type) {
    case "start_phase": return { phase: command.phase };
    case "finish_phase": return { phase: command.phase };
    case "set_domain_phase": return { domainPhase: command.domainPhase };
    case "record_tool_preparation": return { preparation: command.preparation };
    case "fixture_reset": return { generation: command.generation };
    case "pause": return { reason: command.reason };
    case "resume": return {};
    case "cancel": return { status: "CANCELLED", verified: false, evidenceIds: [], reason: command.reason };
    case "finish": {
      if (!command.verified) return { status: "FAILED", verified: false, evidenceIds: command.evidenceIds ?? [], reason: command.reason, failureCategory: command.failureCategory ?? "verification_missing" };
      const completion = snapshot.completions[command.completionId]!;
      return {
        status: "SUCCEEDED",
        verified: true,
        completionId: completion.id,
        candidateHash: completion.candidateHash,
        artifactId: completion.artifactId,
        evidenceIds: [...completion.evidenceIds],
        generation: completion.generation,
        reason: command.reason,
      };
    }
    case "fail": return { reason: command.reason, failureCategory: command.category };
    case "exhaust": return { status: "EXHAUSTED", verified: false, evidenceIds: [], reason: command.reason, failureCategory: "budget_exhausted" };
    case "fact": return { fact: { ...command.fact, runId: snapshot.runId, generation: snapshot.generation, createdSeq: seq } };
    case "observation": return { observation: { ...command.observation, runId: snapshot.runId, generation: snapshot.generation, createdSeq: seq } };
    case "evidence": {
      const artifactIds = evidenceArtifactIds(command.evidence);
      const effect = command.evidence.source.effectId ? snapshot.effects[command.evidence.source.effectId] : undefined;
      return {
        evidence: {
          ...command.evidence,
          source: { ...command.evidence.source, generation: snapshot.generation },
          provenance: {
            schemaVersion: 1,
            runId: snapshot.runId,
            generation: snapshot.generation,
            // `lane` is caller-supplied on the public API. Only the unforgeable
            // control capability, not the label, may attest verifier provenance.
            recordedBy: authority === "verifier" ? "verifier" : "agent",
            artifactIds,
            ...(effect ? {
              effect: {
                id: effect.id,
                operation: effect.operation,
                status: "FINISHED",
                outcome: effect.outcome ?? "unknown",
                exitCode: effect.exitCode ?? null,
                commandHash: effect.commandHash,
                sessionId: effect.sessionId,
              },
            } : {}),
          },
          createdSeq: seq,
        },
      };
    }
    case "domain_record": return { record: { ...command.record, runId: snapshot.runId, generation: snapshot.generation, createdSeq: seq } };
    case "experiment": return { experiment: { ...command.experiment, createdSeq: seq } };
    case "replan_requested": return {
      replan: {
        ...command.replan,
        runId: snapshot.runId,
        generation: snapshot.generation,
        createdSeq: seq,
        prohibitedRepeatKeys: [...command.replan.prohibitedRepeatKeys],
      },
    };
    case "update_proposal_created": return {
      proposal: {
        ...command.proposal,
        runId: snapshot.runId,
        status: "PROPOSED",
        sourceArtifactIds: [...command.proposal.sourceArtifactIds],
        triggerFailureIds: [...command.proposal.triggerFailureIds],
        createdSeq: seq,
        updatedSeq: seq,
      },
    };
    case "update_proposal_evaluated": return { proposalId: command.proposalId, evaluationHash: command.evaluationHash, metrics: command.metrics, gate: command.gate };
    case "update_proposal_approved": return { proposalId: command.proposalId, reason: command.reason };
    case "update_proposal_activated": return { proposalId: command.proposalId };
    case "update_proposal_rejected": return { proposalId: command.proposalId, reason: command.reason };
    case "update_proposal_rolled_back": return { proposalId: command.proposalId, candidateHash: command.candidateHash, reason: command.reason };
    case "reasoning_node": return { node: command.node };
    case "reasoning_edge": return { edge: command.edge };
    case "reasoning_tree": return { tree: command.tree };
    case "hypothesis": return { hypothesis: { ...command.hypothesis, runId: snapshot.runId, generation: snapshot.generation, createdSeq: seq } };
    case "intent": return { intent: { ...command.intent, createdSeq: seq } };
    case "scheduler_intent": return { intent: command.intent };
    case "completion_proposed": return { completion: { ...command.completion, runId: snapshot.runId, generation: snapshot.generation, status: "PROPOSED", evidenceIds: [], createdSeq: seq } };
    case "verification_requested": return { request: { ...command.request, runId: snapshot.runId, generation: snapshot.generation, status: "PENDING", createdSeq: seq } };
    case "verification_recovery_required": return { requestId: command.requestId, reason: command.reason };
    case "verification_recovery_resolved": return { requestId: command.requestId, reason: command.reason };
    case "completion_verified": return { completionId: command.completionId, accepted: command.accepted, evidenceIds: command.evidenceIds };
    case "artifact": return {
      artifact: {
        ...command.artifact,
        runId: snapshot.runId,
        generation: command.generation,
        origin: {
          schemaVersion: 1,
          registeredBy: authority === "verifier_artifact" || authority === "verifier_input" ? "verifier" : "agent",
          operation: command.artifact.sourceEffectId ? snapshot.effects[command.artifact.sourceEffectId]?.operation : undefined,
          tags: [...(command.artifact.semantic?.tags ?? [])],
        },
        ...(command.artifact.semantic ? { semantic: { ...command.artifact.semantic, updatedSeq: seq } } : {}),
      },
    };
    case "artifact_annotation": return { artifactId: command.artifactId, semantic: { ...command.semantic, updatedSeq: seq } };
    case "effect_proposed": return {
      effect: {
        ...command.effect,
        runId: snapshot.runId,
        generation: snapshot.generation,
        producerLane: lane,
        commandHash: command.effect.command ? sha256(command.effect.command) : undefined,
        createdSeq: seq,
      },
    };
    case "effect_started": return { effectId: command.effectId, sessionId: command.sessionId, externalId: command.externalId };
    case "effect_finished": return { effectId: command.effectId, outcome: command.outcome, artifactId: command.artifactId, externalId: command.externalId, durationMs: command.durationMs, outputBytes: command.outputBytes, exitCode: command.exitCode, errorSignature: command.errorSignature, verification: command.verification };
    case "effect_reconciled": return { effectId: command.effectId, outcome: command.outcome };
    case "lease_acquired": return { lease: command.lease };
    case "lease_heartbeat": return { resourceKey: command.resourceKey, ownerLane: command.ownerLane, generation: command.generation, heartbeatAt: command.heartbeatAt, expiresAt: command.expiresAt };
    case "lease_released": return { resourceKey: command.resourceKey };
    case "checkpoint": return { checkpoint: { ...command.checkpoint, createdSeq: seq } };
    case "job_queued":
    case "job_queued_legacy": return { job: { ...command.job, createdSeq: seq } };
    case "job_started": return { jobId: command.jobId, startedAt: command.startedAt ?? new Date().toISOString() };
    case "job_finished": return { jobId: command.jobId, status: command.status, outcome: command.outcome, effectId: command.effectId, artifactId: command.artifactId, externalId: command.externalId, error: command.error, outputTier: command.outputTier, finishedAt: command.finishedAt ?? new Date().toISOString() };
    case "job_cancelled": return { jobId: command.jobId, reason: command.reason, finishedAt: command.finishedAt ?? new Date().toISOString() };
    case "job_reconciled": return { jobId: command.jobId, reason: command.reason };
    case "handoff_proposed": return { handoff: { ...command.handoff, createdSeq: seq } };
    case "handoff_accepted": return { handoffId: command.handoffId };
    case "handoff_superseded": return { handoffId: command.handoffId, reason: command.reason };
    case "handoff_rejected": return { handoffId: command.handoffId, reason: command.reason };
    case "work_item_created": return { workItem: { ...command.workItem, createdSeq: seq, updatedSeq: seq } };
    case "work_item_ready": return { workItemId: command.workItemId };
    case "work_item_claimed": return { workItemId: command.workItemId, ownerLane: command.ownerLane, leaseExpiresAt: command.leaseExpiresAt, acquiredAt: new Date().toISOString() };
    case "work_item_blocked": return { workItemId: command.workItemId, reason: command.reason };
    case "work_item_completed": return { workItemId: command.workItemId, evidenceIds: command.evidenceIds ?? [], artifactIds: command.artifactIds ?? [] };
    case "work_item_failed": return { workItemId: command.workItemId, reason: command.reason };
    case "work_item_cancelled": return { workItemId: command.workItemId, reason: command.reason };
    case "work_item_superseded": return { workItemId: command.workItemId, reason: command.reason };
    case "request_epoch_started": return { epoch: { ...command.epoch, createdSeq: seq, updatedSeq: seq } };
    case "session_opened": return { session: { ...command.session, status: "OPEN", interactions: command.session.interactions ?? 0, createdSeq: seq, updatedSeq: seq } };
    case "session_binding_completed": return { sessionId: command.sessionId, bindingTxnId: command.bindingTxnId, bindingIdentityHash: command.bindingIdentityHash };
    case "session_interacted": return { sessionId: command.sessionId, waitReason: command.waitReason, transcriptArtifactId: command.transcriptArtifactId, stateHash: command.stateHash, exited: command.exited, exitCode: command.exitCode };
    case "session_signaled": return { sessionId: command.sessionId, signal: command.signal, delivered: command.delivered ?? false };
    case "session_closed": return { sessionId: command.sessionId, reason: command.reason, exitCode: command.exitCode };
    case "session_superseded": return { sessionId: command.sessionId, reason: command.reason };
    case "context_recovery": return { checkpointId: command.checkpointId };
  }
}

function validateCommand(snapshot: RunSnapshot, command: DomainCommand, references: BatchReferences, authority: ControlAuthority): void {
  const trustedVerifier = authority === "verifier";
  const trustedVerifierArtifact = authority === "verifier_artifact";
  const trustedVerifierInput = authority === "verifier_input";
  const trustedRecovery = authority === "recovery";
  const bindingAuthority = authority === "binding";
  const trustedEvaluation = authority === "evaluation";
  if (bindingAuthority && command.type !== "session_opened" && command.type !== "session_binding_completed") {
    throw new Error("Binding authority is restricted to session binding commands");
  }
  if (snapshot.status === "PAUSED" && (command.type === "finish" || command.type === "fail" || command.type === "exhaust")) {
    throw new Error(`Cannot ${command.type} a paused run; resume it first`);
  }
  if (requiresVerifierAuthority(command) && !trustedVerifier) {
    throw new Error(`${protectedCommandLabel(command)} is restricted to the trusted verifier service`);
  }
  if ((trustedVerifier || trustedVerifierArtifact || trustedVerifierInput) && command.lane !== "verifier") throw new Error("Trusted verifier commands must use the verifier lane");
  if (trustedVerifierArtifact && command.type !== "artifact") throw new Error("Verifier Artifact authority is restricted to Artifact registration");
  if (trustedVerifierInput && command.type !== "artifact") throw new Error("Verifier input authority is restricted to Artifact registration");
  if (trustedRecovery && command.lane !== "verifier") throw new Error("Recovery commands must use the verifier lane");
  if (trustedRecovery && command.type !== "verification_recovery_required" && command.type !== "verification_recovery_resolved") throw new Error("Recovery authority is restricted to verifier request recovery markers");
  if (command.type === "update_proposal_evaluated" && !trustedEvaluation) throw new Error("Update proposal evaluation is restricted to the trusted evaluation service");
  if (trustedEvaluation && command.type !== "update_proposal_evaluated") throw new Error("Update evaluation authority is restricted to evaluated proposal commands");
  if (trustedEvaluation && command.lane !== "planner") throw new Error("Update evaluation commands must use the planner lane");
  if (command.type === "fixture_reset") {
    if (authority !== "fixture") throw new Error("fixture_reset is restricted to the trusted fixture lifecycle service");
    validateFixtureResetState(snapshot);
    if (!Number.isInteger(command.generation) || command.generation <= snapshot.generation) {
      throw new Error(`Fixture generation must increase monotonically beyond ${snapshot.generation}`);
    }
  }
  if (command.type === "artifact") {
    if (!command.artifact.id.trim()) throw new Error("Artifact id is required");
    if (command.generation !== snapshot.generation) throw new Error(`Artifact generation must equal current generation ${snapshot.generation}`);
    if (snapshot.artifacts[command.artifact.id]) throw new Error(`Artifact already exists: ${command.artifact.id}`);
    if (trustedVerifierArtifact && !command.artifact.sourceEffectId) throw new Error("A verifier result Artifact must bind a verifier Effect");
    if (trustedVerifierInput && command.artifact.sourceEffectId) throw new Error("A verifier recovery input cannot bind an Effect");
    if (command.artifact.sourceEffectId) {
      const effect = snapshot.effects[command.artifact.sourceEffectId];
      if (!effect) throw new Error(`Unknown source effect ${command.artifact.sourceEffectId}`);
      if (effect.generation !== snapshot.generation) throw new Error(`Artifact source effect is from generation ${effect.generation}`);
      if (effect.producerLane === "verifier") {
        if (!trustedVerifierArtifact) throw new Error(`Artifact binding to verifier Effect ${effect.id} requires trusted verifier Artifact authority`);
        if (effect.status !== "STARTED") throw new Error(`Verifier result Artifact requires a STARTED Effect: ${effect.id}`);
        if (Object.values(snapshot.artifacts).some((artifact) => artifact.sourceEffectId === effect.id)) {
          throw new Error(`Verifier Effect ${effect.id} already has a result Artifact`);
        }
      } else {
        if (trustedVerifierArtifact) throw new Error(`Verifier result Artifact cannot bind non-verifier Effect ${effect.id}`);
        if (effect.status !== "STARTED" && effect.status !== "FINISHED") throw new Error(`Artifact source effect is not active or finished: ${effect.id}`);
      }
    }
  }
  if (command.type === "effect_proposed") {
    if (!command.effect.id.trim() || !command.effect.idempotencyKey.trim() || !command.effect.operation.trim()) throw new Error("Effect id, idempotency key, and operation are required");
    if (command.effect.status !== "PROPOSED") throw new Error("A proposed Effect must start in PROPOSED state");
    const injectedResultFields = ["outcome", "artifactId", "externalId", "durationMs", "outputBytes", "exitCode", "errorSignature", "verification"]
      .filter((key) => (command.effect as Record<string, unknown>)[key] !== undefined);
    if (injectedResultFields.length > 0) throw new Error(`A proposed Effect cannot contain result fields: ${injectedResultFields.join(", ")}`);
    const expectedIdempotencyKey = createEffectInput(snapshot.runId, command.effect.operation, command.effect.args, command.effect.replayPolicy, snapshot.generation).idempotencyKey;
    if (command.effect.idempotencyKey !== expectedIdempotencyKey) throw new Error("Effect idempotency key does not match its immutable input");
    if (snapshot.effects[command.effect.id]) throw new Error(`Effect already exists: ${command.effect.id}`);
    if (Object.values(snapshot.effects).some((effect) => effect.idempotencyKey === command.effect.idempotencyKey)) {
      throw new Error(`Effect idempotency key already exists: ${command.effect.idempotencyKey}`);
    }
    if (VERIFIER_EFFECT_OPERATIONS.has(command.effect.operation) && (!trustedVerifier || command.lane !== "verifier")) {
      throw new Error(`Verifier effect operation ${command.effect.operation} requires trusted verifier authority`);
    }
    if (command.lane === "verifier") validateVerifierEffectProposal(snapshot, command.effect, trustedVerifier);
  }
  if (command.type === "effect_started") {
    const effect = snapshot.effects[command.effectId];
    if (!effect) throw new Error(`Unknown effect: ${command.effectId}`);
    if (effect.status !== "PROPOSED") throw new Error(`Cannot start effect in ${effect.status}`);
    if (effect.producerLane === "verifier" && !trustedVerifier) throw new Error("Verifier effects require trusted verifier authority");
    if (command.sessionId !== undefined && !command.sessionId.trim()) throw new Error("Started effect session id cannot be empty");
    if (command.externalId !== undefined && !command.externalId.trim()) throw new Error("Started effect external id cannot be empty");
  }
  if (command.type === "effect_finished") {
    const effect = snapshot.effects[command.effectId];
    if (!effect) throw new Error(`Unknown effect: ${command.effectId}`);
    if (effect.status !== "STARTED") throw new Error(`Cannot finish effect in ${effect.status}`);
    if (effect.producerLane === "verifier" && !trustedVerifier) throw new Error("Verifier effects require trusted verifier authority");
    if (!command.artifactId) throw new Error("A finished effect requires an output artifact");
    const artifact = snapshot.artifacts[command.artifactId];
    if (!artifact) throw new Error(`Unknown effect artifact ${command.artifactId}`);
    if (artifact.sourceEffectId !== effect.id) throw new Error(`Artifact ${artifact.id} is not bound to effect ${effect.id}`);
    if (artifact.generation !== snapshot.generation || effect.generation !== snapshot.generation) throw new Error("Effect result provenance is from a stale generation");
    if (effect.producerLane === "verifier") {
      if (isVerifierReplayOperation(effect.operation)) {
        if (command.verification) throw new Error("A verification replay Effect cannot carry a completion verdict");
      } else if (!command.verification) {
        throw new Error("A verifier Effect requires a structured verification verdict");
      }
      if (!isVerifierReplayOperation(effect.operation)) {
        if (artifact.origin.registeredBy !== "verifier") throw new Error(`Verifier Effect Artifact ${artifact.id} was not registered by verifier authority`);
        const boundArtifacts = Object.values(snapshot.artifacts).filter((value) => value.sourceEffectId === effect.id);
        if (boundArtifacts.length !== 1 || boundArtifacts[0]?.id !== artifact.id) throw new Error(`Verifier Effect ${effect.id} requires exactly one trusted result Artifact`);
        validateVerificationVerdict(snapshot, effect, artifact, command.verification!);
      } else if (artifact.origin.registeredBy !== "verifier") {
        throw new Error(`Verification replay Artifact ${artifact.id} was not registered by verifier authority`);
      }
    } else if (command.verification) {
      throw new Error("Only a verifier Effect may carry a verification verdict");
    }
  }
  if (command.type === "effect_reconciled") {
    const effect = snapshot.effects[command.effectId];
    if (!effect) throw new Error(`Unknown effect: ${command.effectId}`);
    if (effect.status !== "PROPOSED" && effect.status !== "STARTED") throw new Error(`Cannot reconcile effect in ${effect.status}`);
    if (effect.producerLane === "verifier" && !trustedVerifier) throw new Error("Verifier effects require trusted verifier authority");
  }
  if (command.type === "completion_proposed") {
    if (!command.completion.id.trim()) throw new Error("Completion id is required");
    if (snapshot.completions[command.completion.id]) throw new Error(`Completion already exists: ${command.completion.id}`);
    if (!["submission", "claim_reproduction", "harness_verification"].includes(command.completion.purpose)) {
      throw new Error(`Completion ${command.completion.id} requires an immutable purpose`);
    }
    if (command.completion.submissionTarget !== undefined
      && (typeof command.completion.submissionTarget !== "string"
        || command.completion.submissionTarget.trim().length === 0
        || command.completion.submissionTarget.length > 256)) {
      throw new Error(`Completion ${command.completion.id} has an invalid submission target`);
    }
    const artifact = snapshot.artifacts[command.completion.artifactId];
    if (!artifact) throw new Error(`Unknown completion artifact ${command.completion.artifactId}`);
    if (artifact.generation !== snapshot.generation) throw new Error(`Completion artifact is from generation ${artifact.generation}`);
    if (artifact.sha256 !== command.completion.candidateHash) throw new Error(`Candidate hash mismatch for completion ${command.completion.id}`);
    if (command.completion.verificationKey !== undefined) {
      const request = Object.values(snapshot.verificationRequests).find((value) => value.key === command.completion.verificationKey);
      if (!request) throw new Error(`Completion ${command.completion.id} references an unknown verification request`);
      if (request.generation !== snapshot.generation || request.status !== "PENDING" || request.completionId) throw new Error(`Verification request ${request.id} is not available for Completion binding`);
    }
  }
  if (command.type === "session_opened") {
    const session = command.session;
    if (session.runId !== snapshot.runId) throw new Error("Session binding must match the current run");
    if (!session.id.trim()) throw new Error("Session open requires a durable session identity");
    if (session.kind !== "browser" && !session.externalId?.trim()) throw new Error("Session open requires an external runtime identity");
    if (session.requestKey !== undefined && !isSafeSessionBindingText(session.requestKey)) throw new Error("Session request key is invalid");
    if (session.policyHash !== undefined && !/^[a-f0-9]{64}$/i.test(session.policyHash)) throw new Error("Session policy hash must be a sha256 hash");
    if (session.recipeHash !== undefined && !/^[a-f0-9]{64}$/i.test(session.recipeHash)) throw new Error("Session recipe hash must be a sha256 hash");
    if (session.scopeHash !== undefined && !/^[a-f0-9]{64}$/i.test(session.scopeHash)) throw new Error("Session scope hash must be a sha256 hash");
    if (session.bindingTxnId !== undefined && !/^[a-f0-9]{64}$/i.test(session.bindingTxnId)) throw new Error("Session binding transaction id must be a sha256 hash");
    if (session.bindingIdentityHash !== undefined && !/^[a-f0-9]{64}$/i.test(session.bindingIdentityHash)) throw new Error("Session binding identity hash must be a sha256 hash");
    if (session.bindingState !== undefined) {
      if (!bindingAuthority || session.bindingState !== "FINALIZING") throw new Error("Only binding authority may open a FINALIZING session");
      if (session.bindingTxnId === undefined || session.bindingIdentityHash === undefined) throw new Error("A FINALIZING session requires binding markers");
    }
  }
  if (command.type === "session_binding_completed") {
    if (!bindingAuthority) throw new Error("Session binding completion requires binding authority");
    if (!/^[a-f0-9]{64}$/i.test(command.bindingTxnId) || !/^[a-f0-9]{64}$/i.test(command.bindingIdentityHash)) {
      throw new Error("Session binding completion markers must be sha256 hashes");
    }
    const session = snapshot.sessions[command.sessionId];
    if (!session) throw new Error(`Unknown session ${command.sessionId}`);
    if (session.status !== "OPEN") throw new Error(`Session ${command.sessionId} is ${session.status}, not OPEN`);
    if (session.bindingTxnId !== command.bindingTxnId || session.bindingIdentityHash !== command.bindingIdentityHash) {
      throw new Error(`Session ${command.sessionId} binding identity mismatch`);
    }
    if (session.bindingState !== "FINALIZING") throw new Error(`Session ${command.sessionId} is not FINALIZING`);
  }
  if (command.type === "verification_requested") {
    if (!/^VR-[a-f0-9]{24}$/i.test(command.request.id)) throw new Error("Verification request id is invalid");
    if (!/^[a-f0-9]{64}$/i.test(command.request.key)) throw new Error("Verification request key is invalid");
    if (!/^[a-f0-9]{64}$/i.test(command.request.policyHash) || !/^[a-f0-9]{64}$/i.test(command.request.recipeHash)) throw new Error("Verification request hashes are invalid");
    if (!["web", "browser", "pwn", "claim"].includes(command.request.kind)) throw new Error("Verification request kind is invalid");
    if (snapshot.verificationRequests[command.request.id] || Object.values(snapshot.verificationRequests).some((value) => value.key === command.request.key)) throw new Error(`Verification request already exists: ${command.request.id}`);
  }
  if (command.type === "verification_recovery_required" || command.type === "verification_recovery_resolved") {
    const request = snapshot.verificationRequests[command.requestId];
    if (!trustedRecovery) throw new Error(`${command.type} is restricted to the recovery service`);
    if (!request) throw new Error(`Unknown verification request ${command.requestId}`);
    if (request.runId !== snapshot.runId || request.generation !== snapshot.generation) throw new Error(`Verification request ${command.requestId} is stale`);
    if (command.reason.trim().length === 0 || command.reason.length > 512) throw new Error("Verification recovery reason must contain 1..512 characters");
    if (command.type === "verification_recovery_required" && request.recoveryState === "RECOVERED") throw new Error(`Verification request ${request.id} is already recovered`);
    if (command.type === "verification_recovery_resolved") {
      if (request.recoveryState !== "RECOVERY_REQUIRED") throw new Error(`Verification request ${request.id} is not awaiting recovery`);
      const completion = request.completionId ? snapshot.completions[request.completionId] : undefined;
      if (!completion || (completion.status !== "ACCEPTED" && completion.status !== "REJECTED")) throw new Error(`Verification request ${request.id} has no terminal Completion`);
    }
  }
  if (command.type === "evidence") validateEvidence(snapshot, command.evidence, command.lane ?? "main", references, trustedVerifier);
  if (command.type === "domain_record") validateDomainRecord(snapshot, command.record, references, trustedVerifier);
  if (command.type === "fact") {
    const previous = snapshot.facts[command.fact.id];
    if (previous && (previous.runId !== snapshot.runId || previous.generation !== snapshot.generation)) throw new Error(`Fact ${command.fact.id} is from another run or generation`);
    assertUnique(command.fact.evidenceIds, `Fact ${command.fact.id} evidence ids`);
    assertKnownReferences(command.fact.evidenceIds, references.evidence, "evidence");
  }
  if (command.type === "observation") {
    if (snapshot.observations[command.observation.id]) throw new Error(`Observation already exists: ${command.observation.id}`);
    if (command.observation.source.generation !== snapshot.generation) throw new Error(`Observation generation must equal current generation ${snapshot.generation}`);
  }
  if (command.type === "hypothesis") {
    const previous = snapshot.hypotheses[command.hypothesis.id];
    if (previous && (previous.runId !== snapshot.runId || previous.generation !== snapshot.generation)) throw new Error(`Hypothesis ${command.hypothesis.id} is from another run or generation`);
    assertUnique(command.hypothesis.evidenceIds, `Hypothesis ${command.hypothesis.id} evidence ids`);
    assertKnownReferences(command.hypothesis.evidenceIds, references.evidence, "evidence");
  }
  if (command.type === "lease_released" && (command.ownerLane !== undefined || command.generation !== undefined)) {
    const lease = snapshot.leases[command.resourceKey];
    if (!lease) return;
    if (command.ownerLane !== lease.ownerLane || command.generation !== lease.generation) {
      throw new Error(`Lease ownership mismatch: ${command.resourceKey}`);
    }
  }
  if (command.type === "artifact_annotation") {
    const artifact = snapshot.artifacts[command.artifactId];
    if (!artifact) throw new Error(`Unknown artifact ${command.artifactId}`);
    if (artifact.runId !== snapshot.runId || artifact.generation !== snapshot.generation) throw new Error(`Artifact ${command.artifactId} is from another run or generation`);
    validateArtifactSemantic(snapshot, command.semantic);
  }
  if (command.type === "artifact" && command.artifact.semantic) validateArtifactSemantic(snapshot, command.artifact.semantic);
  if (command.type === "reasoning_node") validateReasoningNode(snapshot, command.node);
  if (command.type === "reasoning_edge") validateReasoningEdge(snapshot, command.edge);
  if (command.type === "reasoning_tree") validateReasoningTree(snapshot, command.tree);
  if (command.type.startsWith("work_item_")) validateWorkItemCommand(snapshot, command as WorkItemCommand);
  if (command.type === "request_epoch_started") validateRequestEpochCommand(snapshot, command);
  if ((command.type === "job_queued" || command.type === "job_queued_legacy") && snapshot.status !== "CREATED" && ["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"].includes(snapshot.status)) {
    throw new Error(`Cannot queue a job for terminal run ${snapshot.status}`);
  }
  if (command.type === "job_queued" && (!command.job.backendId || !command.job.backendVersion)) {
    throw new Error("job_queued requires backendId and backendVersion");
  }
  if (command.type === "job_started" || command.type === "job_finished" || command.type === "job_cancelled" || command.type === "job_reconciled") {
    const jobId = command.jobId;
    const job = snapshot.jobs[jobId];
    if (!job) throw new Error(`Unknown job ${jobId}`);
    if (command.type === "job_started" && job.status !== "QUEUED" && job.status !== "RUNNING") throw new Error(`Cannot start job in ${job.status}`);
    if (command.type === "job_started" && job.generation !== snapshot.generation) throw new Error(`Cannot start job ${jobId} from generation ${job.generation}; current generation is ${snapshot.generation}`);
    if (command.type === "job_finished" && job.generation !== snapshot.generation) throw new Error(`Cannot finish job ${jobId} from generation ${job.generation}; current generation is ${snapshot.generation}`);
    if (command.type === "job_cancelled" && job.generation !== snapshot.generation) throw new Error(`Cannot cancel job ${jobId} from generation ${job.generation}; current generation is ${snapshot.generation}`);
    if (command.type === "job_finished" && job.status === "CANCELLED") return;
    if (command.type === "job_cancelled" && ["SUCCEEDED", "FAILED", "TIMED_OUT", "UNKNOWN"].includes(job.status)) throw new Error(`Cannot cancel job in ${job.status}`);
  }
  if ((command.type === "job_queued" || command.type === "job_queued_legacy") && command.job.generation !== snapshot.generation) {
    throw new Error(`Cannot queue job ${command.job.id} for generation ${command.job.generation}; current generation is ${snapshot.generation}`);
  }
  if (command.type === "handoff_proposed") {
    if (isTerminal(snapshot.status)) throw new Error(`Cannot propose a handoff for terminal run ${snapshot.status}`);
    if (command.lane !== "planner") throw new Error("Handoff proposals are restricted to the planner lane");
    if (command.handoff.sourceLane !== "planner" || command.handoff.targetLane !== "executor") throw new Error("Handoff lanes are fixed to planner -> executor");
    if (command.handoff.runId !== snapshot.runId || command.handoff.taskId !== snapshot.task.task_id) throw new Error("Handoff task identity mismatch");
    if (snapshot.handoffs[command.handoff.id]) throw new Error(`Handoff already exists: ${command.handoff.id}`);
  }
  if (command.type === "handoff_accepted" || command.type === "handoff_superseded" || command.type === "handoff_rejected") {
    const handoff = snapshot.handoffs[command.handoffId];
    if (!handoff) throw new Error(`Unknown handoff ${command.handoffId}`);
    if (command.type === "handoff_accepted") {
      if (isTerminal(snapshot.status)) throw new Error(`Cannot accept a handoff for terminal run ${snapshot.status}`);
      if (command.lane !== "executor") throw new Error("Handoff acceptance is restricted to the executor lane");
      if (handoff.status !== "PROPOSED" && handoff.status !== "ACCEPTED") throw new Error(`Cannot accept handoff in ${handoff.status}`);
      if (handoff.knowledgeVersion !== handoffKnowledgeVersion(snapshot)) throw new Error(`Handoff is stale: ${handoff.id}`);
    }
    if (command.type === "handoff_superseded" && handoff.status === "REJECTED") throw new Error("A rejected handoff cannot be superseded");
  }
  if (command.type === "start_phase") assertPhaseTransition(snapshot, command.phase);
  if (command.type === "set_domain_phase") validateDomainPhaseTransition(snapshot, command.domainPhase);
  if (command.type === "record_tool_preparation") validateToolPreparation(snapshot, command.preparation);
  if (command.type === "experiment") validateExperimentCommand(snapshot, command);
  if (command.type === "replan_requested") validateReplanCommand(snapshot, command);
  if (command.type === "update_proposal_created") validateUpdateProposalCommand(snapshot, command);
  if (command.type === "update_proposal_evaluated") {
    const proposal = snapshot.updateProposals[command.proposalId];
    if (!proposal) throw new Error(`Unknown update proposal: ${command.proposalId}`);
    if (proposal.status !== "PROPOSED") throw new Error(`Cannot evaluate update proposal in ${proposal.status}`);
    if (!/^[a-f0-9]{64}$/i.test(command.evaluationHash)) throw new Error("Update proposal evaluation hash must be sha256");
    validateProposalEvaluation(proposal, command);
  }
  if (command.type === "update_proposal_approved" || command.type === "update_proposal_activated" || command.type === "update_proposal_rejected") {
    const proposal = snapshot.updateProposals[command.proposalId];
    if (!proposal) throw new Error(`Unknown update proposal: ${command.proposalId}`);
    if (command.type === "update_proposal_approved") validatePersistedProposalEvaluation(proposal, true);
  }
  if (command.type === "update_proposal_rolled_back") {
    const proposal = snapshot.updateProposals[command.proposalId];
    if (!proposal) throw new Error(`Unknown update proposal: ${command.proposalId}`);
    if (!/^[a-f0-9]{64}$/i.test(command.candidateHash)) throw new Error("Rollback candidate hash must be sha256");
    if (command.candidateHash !== proposal.candidateHash) throw new Error("Rollback candidate hash does not match proposal");
  }
  if (command.type === "completion_verified") validateCompletionVerification(snapshot, command);
  if (command.type === "fact" && command.fact.status === "CONFIRMED" && command.lane !== "verifier") {
    throw new Error("Confirmed facts are restricted to the verifier lane");
  }
  if (command.type !== "finish" || !command.verified) return;
  if (command.lane !== "verifier") throw new Error("A successful run can only be committed by the verifier lane");
  const completion = snapshot.completions[command.completionId];
  if (!completion) throw new Error(`Unknown completion ${command.completionId}`);
  if (completion.status !== "ACCEPTED") throw new Error(`Completion ${completion.id} is not ACCEPTED`);
  if (completion.runId !== snapshot.runId || completion.generation !== snapshot.generation) throw new Error("A successful run requires a current-generation completion");
  assertUnique(command.evidenceIds, "Final evidence ids");
  if (!sameStringSet(command.evidenceIds, completion.evidenceIds)) throw new Error("Final evidence ids must exactly match the accepted completion");
  for (const evidenceId of command.evidenceIds) {
    const evidence = snapshot.evidence[evidenceId];
    if (!evidence) throw new Error(`A successful run references unknown evidence ${evidenceId}`);
    if (evidence.kind !== "reproduction" || evidence.provenance?.recordedBy !== "verifier") throw new Error(`Final evidence ${evidenceId} is not trusted reproduction evidence`);
    if (evidence.provenance.generation !== snapshot.generation || !evidence.supports.includes(completion.id)) throw new Error(`Final evidence ${evidenceId} is not bound to the selected completion`);
    const verdict = evidence.provenance.effect ? snapshot.effects[evidence.provenance.effect.id]?.verification : undefined;
    if (!verdict?.valid || !verdict.accepted || verdict.completionId !== completion.id || verdict.candidateHash !== completion.candidateHash || verdict.candidateArtifactId !== completion.artifactId) {
      throw new Error(`Final evidence ${evidenceId} has no accepted verdict for the selected completion`);
    }
  }
  if (!completedWorkItemForCompletion(snapshot, completion, command.evidenceIds)) {
    throw new Error("A successful run requires a completed executor WorkItem bound to the accepted completion");
  }
  const submitGate = evaluatePhaseGate(snapshot, "SUBMIT");
  if (submitGate.status !== "pass") {
    throw new Error(`Cannot finish accepted completion: SUBMIT gate ${submitGate.status}; missing ${[...submitGate.missing, ...submitGate.stale].join(", ")}`);
  }
}

function validateFixtureResetState(snapshot: RunSnapshot): void {
  if (isTerminal(snapshot.status)) throw new Error(`Cannot reset fixture for terminal run ${snapshot.status}`);
  if (snapshot.phase === "verification" || snapshot.phase === "report") throw new Error(`Cannot reset fixture during ${snapshot.phase}`);
}

interface BatchReferences {
  artifacts: Set<string>;
  effects: Set<string>;
  evidence: Set<string>;
  facts: Set<string>;
  hypotheses: Set<string>;
  completions: Set<string>;
  observations: Set<string>;
  domainRecords: Set<string>;
}

function buildBatchReferences(snapshot: RunSnapshot, commands: DomainCommand[]): BatchReferences {
  const references: BatchReferences = {
    artifacts: new Set(Object.keys(snapshot.artifacts)),
    effects: new Set(Object.keys(snapshot.effects)),
    evidence: new Set(Object.values(snapshot.evidence).filter((value) => value.provenance?.runId === snapshot.runId && value.provenance.generation === snapshot.generation).map((value) => value.id)),
    facts: new Set(Object.values(snapshot.facts).filter((value) => value.runId === snapshot.runId && value.generation === snapshot.generation).map((value) => value.id)),
    hypotheses: new Set(Object.values(snapshot.hypotheses).filter((value) => value.runId === snapshot.runId && value.generation === snapshot.generation).map((value) => value.id)),
    completions: new Set(Object.values(snapshot.completions).filter((value) => value.runId === snapshot.runId && value.generation === snapshot.generation).map((value) => value.id)),
    observations: new Set(Object.values(snapshot.observations).filter((value) => value.runId === snapshot.runId && value.generation === snapshot.generation).map((value) => value.id)),
    domainRecords: new Set(Object.values(snapshot.domainRecords ?? {}).filter((value) => value.runId === snapshot.runId && value.generation === snapshot.generation).map((value) => value.id)),
  };
  const addImmutable = (values: Set<string>, value: string, label: string): void => {
    if (values.has(value)) throw new Error(`${label} already exists: ${value}`);
    values.add(value);
  };
  for (const command of commands) {
    if (command.type === "artifact") addImmutable(references.artifacts, command.artifact.id, "Artifact");
    else if (command.type === "effect_proposed") addImmutable(references.effects, command.effect.id, "Effect");
    else if (command.type === "evidence") addImmutable(references.evidence, command.evidence.id, "Evidence");
    else if (command.type === "completion_proposed") addImmutable(references.completions, command.completion.id, "Completion");
    else if (command.type === "fact") references.facts.add(command.fact.id);
    else if (command.type === "hypothesis") references.hypotheses.add(command.hypothesis.id);
    else if (command.type === "observation") references.observations.add(command.observation.id);
    else if (command.type === "domain_record") addImmutable(references.domainRecords, command.record.id, "Domain record");
  }
  return references;
}

function requiresVerifierAuthority(command: DomainCommand): boolean {
  if (command.type === "completion_verified") return true;
  if (command.type === "finish" && command.verified) return true;
  if (command.type === "fact" && command.fact.status === "CONFIRMED") return true;
  if (command.type === "artifact_annotation" && command.semantic.annotatedBy !== "agent") return true;
  if (command.type === "evidence") return command.evidence.kind === "reproduction" || command.evidence.kind === "negative" || command.evidence.confidence === 1;
  if (command.type === "domain_record") return command.record.kind === "web_exploit_chain" && command.record.status === "reproduced";
  return command.lane === "verifier" && (command.type === "effect_proposed" || command.type === "effect_started" || command.type === "effect_finished" || command.type === "effect_reconciled");
}

function protectedCommandLabel(command: DomainCommand): string {
  if (command.type === "evidence") return `${command.evidence.kind} evidence`;
  if (command.type === "finish" && command.verified) return "Successful finish";
  if (command.type === "domain_record") return `${command.record.kind} domain record`;
  return command.type;
}

function validateEvidence(
  snapshot: RunSnapshot,
  evidence: Omit<Evidence, "createdSeq" | "provenance">,
  lane: Lane,
  references: BatchReferences,
  trustedVerifier: boolean,
): void {
  if (snapshot.evidence[evidence.id]) throw new Error(`Evidence already exists: ${evidence.id}`);
  if (!evidence.id.trim()) throw new Error("Evidence id is required");
  if (!evidence.summary.trim()) throw new Error("Evidence summary is required");
  if (!Number.isFinite(evidence.confidence) || evidence.confidence < 0 || evidence.confidence > 1) {
    throw new Error("Evidence confidence must be a finite number in the range 0..1");
  }
  if (evidence.confidence === 1 && !trustedVerifier) throw new Error("Confidence 1 is restricted to the trusted verifier service");
  if (!Number.isInteger(evidence.source.generation) || evidence.source.generation !== snapshot.generation) {
    throw new Error(`Evidence generation must equal current generation ${snapshot.generation}`);
  }
  const artifactIds = evidenceArtifactIds(evidence);
  assertUnique(evidence.source.artifactIds ?? [], `Evidence ${evidence.id} source artifact ids`);
  if (artifactIds.length === 0) throw new Error("Evidence requires at least one source artifact");
  assertUnique(artifactIds, `Evidence ${evidence.id} artifact ids`);
  for (const artifactId of artifactIds) {
    const artifact = snapshot.artifacts[artifactId];
    if (!artifact) throw new Error(`Unknown evidence artifact ${artifactId}`);
    if (artifact.runId !== snapshot.runId || artifact.generation !== snapshot.generation) throw new Error(`Evidence artifact ${artifactId} is from another run or generation`);
  }
  const dependsOn = evidence.dependsOn ?? [];
  assertUnique(dependsOn, `Evidence ${evidence.id} dependencies`);
  if (dependsOn.includes(evidence.id)) throw new Error("Evidence cannot depend on itself");
  for (const dependencyId of dependsOn) {
    const dependency = snapshot.evidence[dependencyId];
    if (!dependency) throw new Error(`Unknown evidence dependency ${dependencyId}`);
    if (dependency.provenance?.runId !== snapshot.runId || dependency.provenance?.generation !== snapshot.generation) {
      throw new Error(`Evidence dependency ${dependencyId} is from another run or generation`);
    }
  }
  assertUnique(evidence.supports, `Evidence ${evidence.id} supports`);
  assertUnique(evidence.refutes, `Evidence ${evidence.id} refutes`);
  const overlap = evidence.supports.filter((value) => evidence.refutes.includes(value));
  if (overlap.length > 0) throw new Error(`Evidence cannot both support and refute: ${overlap.join(", ")}`);
  assertUnambiguousClaimReferences(evidence.supports, references, "support references");
  assertUnambiguousClaimReferences(evidence.refutes, references, "refute references");

  const protectedKind = evidence.kind === "reproduction" || evidence.kind === "negative";
  const verifierGrade = protectedKind || evidence.confidence === 1;
  if (protectedKind && (!trustedVerifier || lane !== "verifier")) throw new Error(`${evidence.kind} evidence is restricted to the trusted verifier service`);
  const effect = evidence.source.effectId ? snapshot.effects[evidence.source.effectId] : undefined;
  if (verifierGrade && !effect) throw new Error(`${protectedKind ? evidence.kind : "Confidence 1"} evidence requires a completed verifier effect`);
  if (evidence.source.effectId && !effect) throw new Error(`Unknown evidence effect ${evidence.source.effectId}`);
  if (!effect) return;
  if (effect.runId !== snapshot.runId || effect.generation !== snapshot.generation) throw new Error(`Evidence effect ${effect.id} is from another run or generation`);
  if (effect.status !== "FINISHED") throw new Error(`Evidence effect ${effect.id} is not FINISHED`);
  if (!effect.artifactId || !artifactIds.includes(effect.artifactId)) throw new Error(`Evidence does not include effect artifact ${effect.artifactId ?? "missing"}`);
  const effectArtifact = snapshot.artifacts[effect.artifactId];
  if (!effectArtifact || effectArtifact.sourceEffectId !== effect.id) throw new Error(`Effect artifact is not bound to effect ${effect.id}`);
  if (evidence.source.artifactId !== effect.artifactId) throw new Error(`Primary evidence artifact must equal effect artifact ${effect.artifactId}`);
  if (evidence.source.tool !== effect.operation) throw new Error(`Evidence tool must equal effect operation ${effect.operation}`);
  if (verifierGrade) {
    validateTrustedVerificationEffect(snapshot, effect);
    const verdict = effect.verification!;
    const completionRefs = new Set([
      ...evidence.supports.filter((id) => Boolean(snapshot.completions[id])),
      ...evidence.refutes.filter((id) => Boolean(snapshot.completions[id])),
    ]);
    if (completionRefs.size !== 1 || !completionRefs.has(verdict.completionId)) {
      throw new Error(`Verifier Evidence must bind exactly the Effect completion ${verdict.completionId}`);
    }
    if (evidence.kind === "reproduction" && (!verdict.accepted || !evidence.supports.includes(verdict.completionId) || evidence.refutes.includes(verdict.completionId))) {
      throw new Error(`Reproduction Evidence requires an accepted verdict supporting ${verdict.completionId}`);
    }
    if (evidence.kind === "negative" && (verdict.accepted || !evidence.refutes.includes(verdict.completionId) || evidence.supports.includes(verdict.completionId))) {
      throw new Error(`Negative Evidence requires a rejected verdict refuting ${verdict.completionId}`);
    }
  }
}

function validateCompletionVerification(snapshot: RunSnapshot, command: Extract<DomainCommand, { type: "completion_verified" }>): void {
  if (command.lane !== "verifier") throw new Error("Completion verification is restricted to the verifier lane");
  const completion = snapshot.completions[command.completionId];
  if (!completion) throw new Error(`Unknown completion ${command.completionId}`);
  if (completion.status !== "PROPOSED") throw new Error(`Completion ${completion.id} is already ${completion.status}`);
  if (completion.runId !== snapshot.runId || completion.generation !== snapshot.generation) throw new Error(`Completion ${completion.id} is from another run or generation`);
  assertUnique(command.evidenceIds, `Completion ${completion.id} evidence ids`);
  if (command.evidenceIds.length === 0) throw new Error("Completion verification requires evidence");
  const evidence = command.evidenceIds.map((evidenceId) => {
    const value = snapshot.evidence[evidenceId];
    if (!value) throw new Error(`Unknown completion evidence ${evidenceId}`);
    if (value.provenance?.runId !== snapshot.runId || value.provenance?.generation !== snapshot.generation) throw new Error(`Completion evidence ${evidenceId} is from another run or generation`);
    if (value.provenance.recordedBy !== "verifier" || !value.provenance.effect) throw new Error(`Completion evidence ${evidenceId} is not trusted verifier evidence`);
    const effect = snapshot.effects[value.provenance.effect.id];
    const verdict = effect?.verification;
    if (!effect || !verdict || !verdict.valid
      || verdict.completionId !== completion.id
      || verdict.candidateHash !== completion.candidateHash
      || verdict.candidateArtifactId !== completion.artifactId) {
      throw new Error(`Completion evidence ${evidenceId} verdict is not bound to completion ${completion.id}`);
    }
    if (command.accepted !== verdict.accepted) throw new Error(`Completion evidence ${evidenceId} verdict does not match the requested terminal state`);
    const related = value.kind === "reproduction" ? value.supports.includes(completion.id) : value.kind === "negative" ? value.refutes.includes(completion.id) : false;
    if (!related) throw new Error(`Evidence ${evidenceId} is not bound to completion ${completion.id}`);
    return value;
  });
  if (command.accepted) {
    if (evidence.some((value) => value.kind !== "reproduction")) throw new Error("Accepted completion evidence must all be reproduction evidence");
    const effectIds = new Set(evidence.map((value) => value.provenance.effect!.id));
    const sessionIds = new Set(evidence.map((value) => snapshot.effects[value.provenance.effect!.id]?.verification?.sessionId));
    const attemptIds = new Set(evidence.map((value) => snapshot.effects[value.provenance.effect!.id]?.verification?.attemptId));
    const transcriptHashes = new Set(evidence.map((value) => snapshot.effects[value.provenance.effect!.id]?.verification?.transcriptHash));
    const configuredRequired = snapshot.task.verification.required_reproductions;
    if (!Number.isInteger(configuredRequired) || configuredRequired < 0) throw new Error("Task verification required_reproductions must be a non-negative integer");
    const required = Math.max(1, configuredRequired);
    if (effectIds.size < required) throw new Error(`Accepted completion requires ${required} independent reproduction effects`);
    if (sessionIds.has(undefined) || attemptIds.has(undefined) || transcriptHashes.has(undefined)
      || sessionIds.size !== evidence.length || attemptIds.size !== evidence.length || transcriptHashes.size !== evidence.length) {
      throw new Error("Accepted completion requires independent verifier sessions, attempts, and transcripts");
    }
    if (snapshot.task.verification.kind !== "reproduction" && evidence.some((value) => value.provenance.effect?.operation !== "fixture_score")) {
      throw new Error("Only task scorer effects can accept a scorer/platform-judged completion");
    }
  } else if (!evidence.some((value) => value.kind === "negative" && value.refutes.includes(completion.id))) {
    throw new Error("Rejected completion requires negative evidence that refutes it");
  }
}

function isSafeSessionBindingText(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validateVerifierEffectProposal(
  snapshot: RunSnapshot,
  effect: Omit<RunSnapshot["effects"][string], "createdSeq" | "runId" | "generation" | "producerLane">,
  trustedVerifier: boolean,
): void {
  if (!trustedVerifier) throw new Error("Verifier effects require trusted verifier authority");
  if (!VERIFIER_EFFECT_OPERATIONS.has(effect.operation)) throw new Error(`Untrusted verifier effect operation: ${effect.operation}`);
  if (isVerifierReplayOperation(effect.operation)) {
    validateVerifierReplayBinding(snapshot, effect);
    return;
  }
  const completionId = String(effect.args.completionId ?? "");
  const completion = snapshot.completions[completionId];
  if (!completion) throw new Error(`Verifier effect requires a known completion: ${completionId || "missing"}`);
  if (completion.status !== "PROPOSED" || completion.generation !== snapshot.generation) throw new Error(`Verifier effect completion ${completion.id} is not a current PROPOSED completion`);
  const expected = {
    runId: snapshot.runId,
    taskId: snapshot.task.task_id,
    generation: snapshot.generation,
    completionId: completion.id,
    candidateHash: completion.candidateHash,
    candidateArtifactId: completion.artifactId,
    taskHash: sha256(canonicalJson(snapshot.task)),
    targetHash: sha256(snapshot.task.target),
    verificationRuleHash: sha256(canonicalJson(snapshot.task.verification)),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (effect.args[key] !== value) throw new Error(`Verifier effect ${key} does not match the immutable task binding`);
  }
  if (!effect.sessionId?.trim()) throw new Error("Verifier effect requires a session id");
  if (typeof effect.args.attemptId !== "string" || !effect.args.attemptId.trim()) throw new Error("Verifier effect requires an immutable attempt id");
  if (!effect.cwd?.trim()) throw new Error("Verifier effect requires an auditable cwd");
  if (!pathIsWithin(effect.cwd, snapshot.task.scope.allowed_workspace)) throw new Error(`Verifier cwd escapes allowed_workspace: ${effect.cwd}`);
  if (effect.command && effect.args.commandHash !== sha256(effect.command)) throw new Error("Verifier command hash does not match the immutable command");
  if (effect.operation === "result_verification" || effect.operation === "claim_reproduction") {
    if (snapshot.task.verification.kind !== "reproduction" || !snapshot.task.verification.command || effect.command !== snapshot.task.verification.command) {
      throw new Error(`${effect.operation} command must come from the task verifier policy`);
    }
    if (effect.args.resultArtifactMode === "artifact") {
      if (effect.args.resultArtifactId !== completion.artifactId || effect.args.resultHash !== completion.candidateHash) {
        throw new Error("Result Artifact verifier binding does not match the proposed Completion");
      }
    }
  }
  if (effect.operation === "web_reproduce" && !snapshot.task.verification.web?.flag_pattern) {
    throw new Error("web_reproduce is restricted to tasks with an immutable web verification policy");
  }
  if (effect.operation === "web_reproduce" && snapshot.task.verification.web?.transport === "browser") {
    throw new Error("browser transport must use browser_reproduce");
  }
  if (effect.operation === "browser_reproduce" && snapshot.task.verification.web?.transport !== "browser") {
    throw new Error("browser_reproduce is restricted to tasks with an immutable browser Web verification policy");
  }
  if (effect.operation === "fixture_score" && snapshot.task.verification.kind === "platform_submission") {
    const requestId = String(effect.args.verificationRequestId ?? "");
    const request = snapshot.verificationRequests[requestId];
    if (!request || request.status !== "BOUND" || request.completionId !== completion.id || request.key !== completion.verificationKey) {
      throw new Error("fixture_score requires a bound platform verification request");
    }
    if (effect.args.verificationKey !== request.key || effect.args.policyHash !== request.policyHash || effect.args.recipeHash !== request.recipeHash) {
      throw new Error("fixture_score does not match the immutable platform verification request");
    }
  }
  if (effect.operation === "pwn_reproduce") validatePwnVerifierBinding(snapshot, effect);
}

function validateTrustedVerificationEffect(snapshot: RunSnapshot, effect: RunSnapshot["effects"][string]): void {
  if (effect.producerLane !== "verifier") throw new Error(`Evidence effect ${effect.id} was not produced by the verifier service`);
  if (!VERIFIER_ATTESTATION_OPERATIONS.has(effect.operation)) throw new Error(`Evidence effect ${effect.id} uses an untrusted verifier operation`);
  if (effect.outcome !== "success" || effect.exitCode !== 0) throw new Error(`Evidence effect ${effect.id} did not complete successfully`);
  if (!effect.sessionId?.trim()) throw new Error(`Evidence effect ${effect.id} has no auditable session id`);
  const verdict = effect.verification;
  if (!verdict?.valid) throw new Error(`Evidence effect ${effect.id} has no valid structured verifier verdict`);
  const resultArtifact = effect.artifactId ? snapshot.artifacts[effect.artifactId] : undefined;
  if (!resultArtifact || resultArtifact.origin.registeredBy !== "verifier" || resultArtifact.sourceEffectId !== effect.id) {
    throw new Error(`Evidence effect ${effect.id} has no verifier-authority result Artifact`);
  }
  const completion = snapshot.completions[String(effect.args.completionId ?? "")];
  if (!completion || effect.args.candidateHash !== completion.candidateHash || effect.args.candidateArtifactId !== completion.artifactId) {
    throw new Error(`Evidence effect ${effect.id} is not bound to its completion candidate`);
  }
  if (effect.args.taskHash !== sha256(canonicalJson(snapshot.task)) || effect.args.targetHash !== sha256(snapshot.task.target) || effect.args.verificationRuleHash !== sha256(canonicalJson(snapshot.task.verification))) {
    throw new Error(`Evidence effect ${effect.id} task binding is stale or invalid`);
  }
  if (verdict.runId !== snapshot.runId || verdict.generation !== snapshot.generation || verdict.taskHash !== snapshot.taskHash
    || verdict.completionId !== completion.id || verdict.candidateHash !== completion.candidateHash || verdict.candidateArtifactId !== completion.artifactId
    || verdict.operation !== effect.operation || verdict.sessionId !== effect.sessionId || verdict.attemptId !== effect.args.attemptId
    || verdict.resultArtifactId !== effect.artifactId || verdict.resultArtifactSha256 !== snapshot.artifacts[effect.artifactId]?.sha256
    || verdict.transcriptHash !== snapshot.artifacts[effect.artifactId]?.sha256) {
    throw new Error(`Evidence effect ${effect.id} verifier verdict is stale or invalid`);
  }
}

const VERIFIER_REPLAY_OPERATION = "verification_replay";
const VERIFIER_ATTESTATION_OPERATIONS = new Set(["fixture_score", "result_verification", "claim_reproduction", "pwn_reproduce", "web_reproduce", "browser_reproduce"]);
const VERIFIER_EFFECT_OPERATIONS = new Set([...VERIFIER_ATTESTATION_OPERATIONS, VERIFIER_REPLAY_OPERATION]);

function isVerifierReplayOperation(operation: string): boolean {
  return operation === VERIFIER_REPLAY_OPERATION;
}

function validateVerifierReplayBinding(
  snapshot: RunSnapshot,
  effect: Omit<RunSnapshot["effects"][string], "createdSeq" | "runId" | "generation" | "producerLane">,
): void {
  const requestId = String(effect.args.verificationRequestId ?? "");
  const request = snapshot.verificationRequests[requestId];
  if (!request || request.runId !== snapshot.runId || request.generation !== snapshot.generation) {
    throw new Error(`Verification replay Effect requires a current request: ${requestId || "missing"}`);
  }
  if (effect.args.verificationKey !== request.key || effect.args.kind !== request.kind
    || effect.args.policyHash !== request.policyHash || effect.args.recipeHash !== request.recipeHash) {
    throw new Error(`Verification replay Effect ${effect.id} does not match the immutable request policy`);
  }
  const expected = {
    runId: snapshot.runId,
    taskId: snapshot.task.task_id,
    generation: snapshot.generation,
    taskHash: sha256(canonicalJson(snapshot.task)),
    targetHash: sha256(snapshot.task.target),
    verificationRuleHash: sha256(canonicalJson(snapshot.task.verification)),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (effect.args[key] !== value) throw new Error(`Verification replay Effect ${key} does not match the immutable task binding`);
  }
  if (typeof effect.args.attemptId !== "string" || !effect.args.attemptId.trim()) throw new Error("Verification replay Effect requires an immutable attempt id");
  if (typeof effect.args.recoveryArtifactSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(effect.args.recoveryArtifactSha256)) {
    throw new Error("Verification replay Effect requires a hashed recovery input");
  }
  if (!effect.sessionId?.trim()) throw new Error("Verification replay Effect requires a stable attempt session id");
  if (!effect.cwd?.trim()) throw new Error("Verification replay Effect requires an auditable cwd");
  if (!pathIsWithin(effect.cwd, snapshot.task.scope.allowed_workspace)) throw new Error(`Verifier cwd escapes allowed_workspace: ${effect.cwd}`);
  if (request.status !== "PENDING" && request.status !== "BOUND") throw new Error(`Verification request ${request.id} is not replayable in ${request.status} state`);
}

function validatePwnVerifierBinding(
  snapshot: RunSnapshot,
  effect: Omit<RunSnapshot["effects"][string], "createdSeq" | "runId" | "generation" | "producerLane">,
): void {
  if (snapshot.task.target_kind !== "pwn") throw new Error("pwn_reproduce is restricted to pwn tasks");
  if (!snapshot.task.verification.command || effect.command !== snapshot.task.verification.command) throw new Error("pwn_reproduce command must come from the task verifier policy");
  const endpoint = effect.args.endpoint;
  if (snapshot.task.scope.external_network
    && ((snapshot.task.scope.allowed_endpoints?.length ?? 0) > 0 || snapshot.task.scope.allowed_ports.length > 0)
    && endpoint === undefined) {
    throw new Error("Remote pwn reproduction requires a task-bound endpoint tuple");
  }
  if (endpoint !== undefined) {
    if (!snapshot.task.scope.external_network) throw new Error("Remote pwn reproduction is outside task scope");
    if (!endpoint || typeof endpoint !== "object") throw new Error("pwn_reproduce endpoint must be a bound host/port tuple");
    const host = String((endpoint as Record<string, unknown>).host ?? "").toLowerCase();
    const port = Number((endpoint as Record<string, unknown>).port);
    const endpointAllowed = snapshot.task.scope.allowed_endpoints
      ? snapshot.task.scope.allowed_endpoints.some((value) => value.host.toLowerCase() === host && value.port === port)
      : snapshot.task.scope.allowed_hosts.map((value) => value.toLowerCase()).includes(host) && snapshot.task.scope.allowed_ports.includes(port);
    if (!endpointAllowed) {
      throw new Error(`pwn_reproduce endpoint is outside task scope: ${host}:${port}`);
    }
  }
  const modelControlledPwnFields = ["flagRegex", "flagPath", "shellMarker", "target", "targetCommand", "remoteEndpoint", "stages", "exploitStages"]
    .filter((key) => key in effect.args);
  if (modelControlledPwnFields.length > 0) throw new Error(`pwn verifier target, rules, and stages cannot be supplied by the model: ${modelControlledPwnFields.join(", ")}`);
}

function validateVerificationVerdict(
  snapshot: RunSnapshot,
  effect: RunSnapshot["effects"][string],
  artifact: RunSnapshot["artifacts"][string],
  verdict: VerificationVerdict,
): void {
  const completion = snapshot.completions[String(effect.args.completionId ?? "")];
  if (!completion) throw new Error("Verifier verdict references an unknown completion");
  const expected = {
    schemaVersion: 1,
    operation: effect.operation,
    runId: snapshot.runId,
    taskId: snapshot.task.task_id,
    taskHash: snapshot.taskHash,
    generation: snapshot.generation,
    completionId: completion.id,
    candidateHash: completion.candidateHash,
    candidateArtifactId: completion.artifactId,
    attemptId: effect.args.attemptId,
    sessionId: effect.sessionId,
    resultArtifactId: artifact.id,
    resultArtifactSha256: artifact.sha256,
    transcriptHash: artifact.sha256,
  } as const;
  for (const [key, value] of Object.entries(expected)) {
    if ((verdict as unknown as Record<string, unknown>)[key] !== value) throw new Error(`Verifier verdict ${key} does not match the immutable Effect binding`);
  }
  if (typeof verdict.valid !== "boolean" || typeof verdict.accepted !== "boolean") throw new Error("Verifier verdict validity and acceptance must be boolean");
  if (!verdict.valid && verdict.accepted) throw new Error("An invalid verifier verdict cannot be accepted");
}

function validateDomainRecord(
  snapshot: RunSnapshot,
  input: DomainRecordInput,
  references: BatchReferences,
  trustedVerifier: boolean,
): void {
  const record = { ...input, runId: snapshot.runId, generation: snapshot.generation, createdSeq: 0 } as DomainRecord;
  if (snapshot.domainRecords?.[record.id]) throw new Error(`Domain record already exists: ${record.id}`);
  validateDomainRecordShape(record);
  if (record.kind.startsWith("web_") && !isWebDomainRecord(record)) throw new Error(`Invalid Web domain record kind: ${record.kind}`);
  if (record.kind.startsWith("pwn_") && !isPwnDomainRecord(record)) throw new Error(`Invalid Pwn domain record kind: ${record.kind}`);
  const targetKind = snapshot.task.target_kind;
  if (isWebDomainRecord(record) && targetKind !== "web" && targetKind !== "mixed" && targetKind !== "unknown") {
    throw new Error(`Web domain record is not allowed for target kind ${targetKind}`);
  }
  if (isPwnDomainRecord(record) && targetKind !== "pwn" && targetKind !== "mixed" && targetKind !== "unknown") {
    throw new Error(`Pwn domain record is not allowed for target kind ${targetKind}`);
  }
  assertKnownReferences(record.artifactIds, references.artifacts, `domain record ${record.id} artifacts`);
  assertKnownReferences(record.evidenceIds, references.evidence, `domain record ${record.id} evidence`);
  if (record.kind === "pwn_exploit_stage" && record.inputArtifactId !== undefined) {
    assertKnownReferences([record.inputArtifactId], references.artifacts, `domain record ${record.id} input artifact`);
    if (!record.artifactIds.includes(record.inputArtifactId)) throw new Error(`Domain record ${record.id} input artifact must be included in artifacts`);
  }
  const linkedRecordIds = domainRecordLinks(record);
  assertKnownReferences(linkedRecordIds, references.domainRecords, `domain record ${record.id} related records`);
  if (record.effectId !== undefined) {
    const effect = snapshot.effects[record.effectId];
    if (!effect) throw new Error(`Unknown domain record effect ${record.effectId}`);
    if (effect.generation !== snapshot.generation || effect.status !== "FINISHED") throw new Error(`Domain record effect ${record.effectId} is not a finished current-generation Effect`);
    if (!effect.artifactId || !record.artifactIds.includes(effect.artifactId)) throw new Error(`Domain record ${record.id} must include its Effect artifact`);
  }
  if (record.kind === "web_exploit_chain" && record.status === "reproduced" && !trustedVerifier) {
    throw new Error("A reproduced Web exploit chain requires trusted verifier authority");
  }
}

function domainRecordLinks(record: DomainRecord): string[] {
  switch (record.kind) {
    case "web_endpoint": return record.sourceRecordIds;
    case "web_exploit_chain": return record.stepRecordIds;
    case "pwn_primitive": return record.preconditionRecordIds;
    case "pwn_leak": return record.derivation?.sourceRecordIds ?? [];
    default: return [];
  }
}

function evidenceArtifactIds(evidence: Pick<Evidence, "source">): string[] {
  return [...new Set([...(evidence.source.artifactIds ?? []), ...(evidence.source.artifactId ? [evidence.source.artifactId] : [])])];
}

function assertKnownReferences(ids: string[], known: Set<string>, label: string): void {
  const missing = ids.filter((value) => !known.has(value));
  if (missing.length > 0) throw new Error(`Unknown ${label}: ${missing.join(", ")}`);
}

function assertUnambiguousClaimReferences(ids: string[], references: BatchReferences, label: string): void {
  const missing: string[] = [];
  const ambiguous: string[] = [];
  for (const id of ids) {
    const count = Number(references.facts.has(id))
      + Number(references.hypotheses.has(id))
      + Number(references.completions.has(id))
      + Number(references.observations.has(id));
    if (count === 0) missing.push(id);
    else if (count > 1) ambiguous.push(id);
  }
  if (missing.length > 0) throw new Error(`Unknown ${label}: ${missing.join(", ")}`);
  if (ambiguous.length > 0) throw new Error(`Ambiguous ${label}: ${ambiguous.join(", ")}`);
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`);
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function pathIsWithin(candidate: string, allowedRoot: string): boolean {
  const base = resolve(allowedRoot);
  const value = resolve(candidate);
  const rel = relative(base, value);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function validateTaskContract(task: TaskContract): void {
  if (!task.task_id.trim()) throw new Error("Task id is required");
  if (!Number.isInteger(task.verification.required_reproductions) || task.verification.required_reproductions < 0) {
    throw new Error("Task verification required_reproductions must be a non-negative integer");
  }
  if (task.verification.web?.transport !== undefined && !["http", "browser"].includes(task.verification.web.transport)) {
    throw new Error("Task Web verification transport must be http or browser");
  }
  const browserPolicy = task.verification.web?.browser;
  if (browserPolicy) {
    if (task.verification.web?.transport !== "browser") throw new Error("Browser verification limits require browser transport");
    const allowedActions = browserPolicy.allowed_actions ?? ["navigate"];
    if (!Array.isArray(allowedActions) || allowedActions.length === 0 || new Set(allowedActions).size !== allowedActions.length || allowedActions.some((action) => !["navigate", "click", "fill", "submit", "wait"].includes(action))) {
      throw new Error("Browser verification allowed_actions must contain unique supported actions");
    }
    if (browserPolicy.max_steps !== undefined && (!Number.isInteger(browserPolicy.max_steps) || browserPolicy.max_steps < 1 || browserPolicy.max_steps > 64)) {
      throw new Error("Browser verification max_steps must be an integer between 1 and 64");
    }
    if (browserPolicy.max_duration_ms !== undefined && (!Number.isInteger(browserPolicy.max_duration_ms) || browserPolicy.max_duration_ms < 100 || browserPolicy.max_duration_ms > 600_000)) {
      throw new Error("Browser verification max_duration_ms must be an integer between 100 and 600000");
    }
    if (browserPolicy.max_response_bytes !== undefined && (!Number.isInteger(browserPolicy.max_response_bytes) || browserPolicy.max_response_bytes < 1 || browserPolicy.max_response_bytes > 8 * 1_048_576)) {
      throw new Error("Browser verification max_response_bytes must be an integer between 1 and 8388608");
    }
  }
  if (!task.scope.allowed_workspace.trim()) throw new Error("Task allowed_workspace is required");
  if (task.constraints.max_replans !== undefined && (!Number.isInteger(task.constraints.max_replans) || task.constraints.max_replans < 0 || task.constraints.max_replans > 16)) {
    throw new Error("Task constraints max_replans must be an integer between 0 and 16 when provided");
  }
  if (task.external_submission !== undefined) {
    const targets = task.external_submission.targets;
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > 64) {
      throw new Error("Task external_submission targets must contain between 1 and 64 destinations");
    }
    const normalized = targets.map((target) => typeof target === "string" ? target.trim() : "");
    if (normalized.some((target) => target.length === 0 || target.length > 256) || new Set(normalized).size !== normalized.length) {
      throw new Error("Task external_submission targets must be unique non-empty logical destination names up to 256 characters");
    }
  }
  for (const endpoint of task.scope.allowed_endpoints ?? []) {
    if (!endpoint.host.trim() || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535) {
      throw new Error("Task allowed_endpoints must contain valid host/port tuples");
    }
  }
}

function validateDomainPhaseTransition(snapshot: RunSnapshot, next: DomainPhase): void {
  const order: DomainPhase[] = ["INTAKE", "RECON", "TARGET_MODEL", "HYPOTHESIS", "EXPERIMENT", "REPRODUCE", "REPORT", "SUBMIT"];
  const allowedBacktracks: Partial<Record<DomainPhase, DomainPhase[]>> = { HYPOTHESIS: ["RECON"], EXPERIMENT: ["HYPOTHESIS", "RECON"], REPRODUCE: ["EXPERIMENT"] };
  if (next === snapshot.domainPhase) return;
  if (order.indexOf(next) > order.indexOf(snapshot.domainPhase)) return;
  if (!allowedBacktracks[snapshot.domainPhase]?.includes(next)) throw new Error(`Invalid domain phase transition: ${snapshot.domainPhase} -> ${next}`);
}

function validateToolPreparation(snapshot: RunSnapshot, preparation: RunToolPreparation): void {
  if (isTerminal(snapshot.status)) throw new Error(`Cannot record tool preparation for terminal run ${snapshot.status}`);
  if (preparation.schemaVersion !== 1) throw new Error("Unsupported tool preparation schema version");
  if (preparation.generation !== snapshot.generation) throw new Error(`Tool preparation generation must equal current generation ${snapshot.generation}`);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(preparation.profileId)) throw new Error("Tool preparation profileId is invalid");
  if (!["host", "container"].includes(preparation.runtime)) throw new Error("Tool preparation runtime is invalid");
  for (const [label, value] of [["runtimeKey", preparation.runtimeKey], ["cacheKey", preparation.cacheKey], ["toolCatalogHash", preparation.toolCatalogHash], ["mcpCatalogHash", preparation.mcpCatalogHash], ["hash", preparation.hash]] as const) {
    if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new Error(`Tool preparation ${label} is invalid`);
  }
  const { hash, ...unsigned } = preparation;
  if (sha256(canonicalJson(unsigned)) !== hash) throw new Error("Tool preparation hash does not match its contents");
  if (!Number.isFinite(preparation.checkedAt) || preparation.checkedAt <= 0) throw new Error("Tool preparation checkedAt is invalid");
  if (preparation.health !== "ready" && preparation.health !== "degraded") throw new Error("Tool preparation health is invalid");
  if (preparation.health === "ready" && preparation.missingRequiredTools.length > 0) throw new Error("Ready tool preparation cannot have missing required tools");
  validateBoundedStringList(preparation.missingRequiredTools, "missing required tools", 64, 128);
  validateBoundedStringList(preparation.missingOptionalTools, "missing optional tools", 64, 128);
  validateBoundedStringList(preparation.fallbackStrategies, "fallback strategies", 512, 64);
  if (preparation.firstActionPlan !== undefined) {
    const plan = preparation.firstActionPlan;
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(plan.id)) throw new Error("Tool preparation first action id is invalid");
    if (!Number.isInteger(plan.maxCalls) || plan.maxCalls < 1 || plan.maxCalls > 16) throw new Error("Tool preparation first action maxCalls is invalid");
    validateBoundedStringList(plan.allowedToolNames, "first action tools", 128, 32);
  }
  if (preparation.actionBundles !== undefined) validateActionBundles(preparation.actionBundles);
  if (preparation.firstClassMcpTools !== undefined) {
    const exposure = preparation.firstClassMcpTools;
    if (!Number.isInteger(exposure.exposed) || exposure.exposed < 0 || exposure.exposed > 64
      || !Number.isInteger(exposure.omitted) || exposure.omitted < 0 || exposure.omitted > 4_096
      || typeof exposure.truncated !== "boolean") {
      throw new Error("Tool preparation first-class MCP exposure is invalid");
    }
    if (exposure.omitted > 0 && !exposure.truncated) throw new Error("Tool preparation first-class MCP truncation marker is invalid");
  }
  if (!Array.isArray(preparation.tools) || preparation.tools.length > 128) throw new Error("Tool preparation tool list is invalid");
  for (const tool of preparation.tools) {
    if (!tool.id || tool.id.length > 64 || !tool.name || tool.name.length > 128 || !tool.path || tool.path.length > 512) throw new Error("Tool preparation entry is invalid");
    if (tool.status !== "ready" && tool.status !== "missing") throw new Error(`Tool preparation status is invalid: ${tool.id}`);
    if (typeof tool.required !== "boolean") throw new Error(`Tool preparation required marker is invalid: ${tool.id}`);
  }
  if (!Array.isArray(preparation.mcpServers) || preparation.mcpServers.length > 32) throw new Error("Tool preparation MCP list is invalid");
  for (const server of preparation.mcpServers) {
    if (!server.name || server.name.length > 128 || !server.status || server.status.length > 64 || (server.toolchainState !== undefined && server.toolchainState.length > 64)) throw new Error("Tool preparation MCP entry is invalid");
  }
}

function validateActionBundles(bundles: ActionBundle[]): void {
  if (!Array.isArray(bundles) || bundles.length > 16) throw new Error("Tool preparation action bundle list is invalid");
  const ids = new Set<string>();
  const phases = new Set<string>();
  for (const bundle of bundles) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(bundle.id) || ids.has(bundle.id)) throw new Error(`Tool preparation action bundle id is invalid: ${bundle.id}`);
    ids.add(bundle.id);
    if (!(["RECON", "TARGET_MODEL", "HYPOTHESIS", "EXPERIMENT", "REPRODUCE"] as string[]).includes(bundle.domainPhase) || phases.has(bundle.domainPhase)) {
      throw new Error(`Tool preparation action bundle phase is invalid: ${bundle.domainPhase}`);
    }
    phases.add(bundle.domainPhase);
    if (!bundle.objective.trim() || bundle.objective.length > 1_000) throw new Error(`Tool preparation action bundle objective is invalid: ${bundle.id}`);
    if (!Number.isInteger(bundle.maxCalls) || bundle.maxCalls < 1 || bundle.maxCalls > 16) throw new Error(`Tool preparation action bundle maxCalls is invalid: ${bundle.id}`);
    validateBoundedStringList(bundle.toolNames, "action bundle tools", 128, 32);
    validateBoundedStringList(bundle.capabilityIds, "action bundle capabilities", 128, 32);
    validateBoundedStringList(bundle.preconditions, "action bundle preconditions", 512, 16);
    validateBoundedStringList(bundle.successCriteria, "action bundle success criteria", 512, 16);
    validateBoundedStringList(bundle.failureCriteria, "action bundle failure criteria", 512, 16);
  }
}

function validateBoundedStringList(values: unknown, label: string, maxItemLength: number, maxItems: number): void {
  if (!Array.isArray(values) || values.length > maxItems || values.some((value) => typeof value !== "string" || value.length === 0 || value.length > maxItemLength)) throw new Error(`Tool preparation ${label} is invalid`);
}

function validateExperimentCommand(snapshot: RunSnapshot, command: Extract<DomainCommand, { type: "experiment" }>): void {
  const experiment = command.experiment;
  if (snapshot.experiments[experiment.id]) throw new Error(`Experiment already exists: ${experiment.id}`);
  if (experiment.runId !== snapshot.runId) throw new Error(`Experiment run identity mismatch: ${experiment.id}`);
  if (experiment.generation !== snapshot.generation) throw new Error(`Experiment generation mismatch: ${experiment.id}`);
  if (experiment.domainPhase !== snapshot.domainPhase) throw new Error(`Experiment phase ${experiment.domainPhase} does not match current phase ${snapshot.domainPhase}`);
  if (!experiment.repeatKey.trim() || experiment.repeatKey.length > 256) throw new Error("Experiment repeatKey must contain 1-256 characters");
  if (!experiment.action.trim() || experiment.action.length > 1_000) throw new Error("Experiment action must contain 1-1000 characters");
  if (!experiment.inputHash.trim() || experiment.inputHash.length > 256) throw new Error("Experiment inputHash must contain 1-256 characters");
  if (!experiment.summary.trim() || experiment.summary.length > 1_000) throw new Error("Experiment summary must contain 1-1000 characters");
  if (experiment.hypothesisId && !snapshot.hypotheses[experiment.hypothesisId]) throw new Error(`Unknown experiment hypothesis: ${experiment.hypothesisId}`);
  const budget = phaseBudget(snapshot);
  if (budget.phaseActionsRemaining !== undefined && budget.phaseActionsRemaining <= 0) {
    throw new Error(`Phase action budget exhausted: ${snapshot.domainPhase}`);
  }
}

function validateReplanCommand(snapshot: RunSnapshot, command: Extract<DomainCommand, { type: "replan_requested" }>): void {
  if (isTerminal(snapshot.status)) throw new Error(`Cannot replan terminal run ${snapshot.status}`);
  const replan = command.replan;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(replan.id)) throw new Error("Replan id is invalid");
  if (!replan.reason.trim() || replan.reason.length > 1_000) throw new Error("Replan reason must contain 1-1000 characters");
  if (replan.domainPhase !== snapshot.domainPhase) throw new Error(`Replan phase ${replan.domainPhase} does not match current phase ${snapshot.domainPhase}`);
  if (!FAILURE_CATEGORIES.has(replan.category)) throw new Error(`Unknown replan failure category: ${String(replan.category)}`);
  if (snapshot.replanCount >= maxReplansFor(snapshot.task.target_kind, snapshot.task.constraints.max_replans)) {
    throw new Error(`Replan budget exhausted: ${snapshot.replanCount}`);
  }
  if (!replan.sourceWorkItemId || !replan.nextWorkItemId || replan.sourceWorkItemId === replan.nextWorkItemId) {
    throw new Error("Replan must bind distinct source and next WorkItems");
  }
  if (snapshot.workItems[replan.sourceWorkItemId]?.status !== "BLOCKED") throw new Error("Replan source WorkItem must already be BLOCKED");
  if (snapshot.workItems[replan.nextWorkItemId]?.status !== "READY") throw new Error("Replan next WorkItem must already be READY");
  if (!Array.isArray(replan.prohibitedRepeatKeys) || replan.prohibitedRepeatKeys.length > 16 || replan.prohibitedRepeatKeys.some((key) => typeof key !== "string" || key.length === 0 || key.length > 256)) {
    throw new Error("Replan prohibited repeat keys are invalid");
  }
}

function validateUpdateProposalCommand(snapshot: RunSnapshot, command: Extract<DomainCommand, { type: "update_proposal_created" }>): void {
  const proposal = command.proposal;
  if (snapshot.updateProposals[proposal.id]) throw new Error(`Update proposal already exists: ${proposal.id}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(proposal.id)) throw new Error("Update proposal id is invalid");
  if (!["prompt", "tool", "skill", "knowledge", "program", "model"].includes(proposal.kind)) throw new Error(`Unknown update proposal kind: ${proposal.kind}`);
  for (const [label, value] of [["baseVersion", proposal.baseVersion], ["candidateVersion", proposal.candidateVersion], ["retentionDataset", proposal.retentionDataset], ["migrationDataset", proposal.migrationDataset], ["safetyDataset", proposal.safetyDataset]] as const) {
    if (!value.trim() || value.length > 256) throw new Error(`Update proposal ${label} is invalid`);
  }
  if (!/^[a-f0-9]{64}$/i.test(proposal.candidateHash)) throw new Error("Update proposal candidate hash must be sha256");
  validateBoundedStringList(proposal.sourceArtifactIds, "update proposal source artifacts", 256, 128);
  validateBoundedStringList(proposal.triggerFailureIds, "update proposal trigger failures", 256, 128);
  if (!proposal.evaluationSets) throw new Error("Update proposal requires all evaluation sets");
  if (Object.keys(proposal.evaluationSets).length !== 4) throw new Error("Update proposal requires exactly four evaluation sets");
  for (const [name, values] of Object.entries(proposal.evaluationSets)) {
    if (!["trigger", "retention", "migration", "safety"].includes(name)) throw new Error(`Unknown update proposal evaluation set: ${name}`);
    validateBoundedStringList(values, `update proposal ${name} evaluation set`, 16, 256);
  }
}

function validateProposalEvaluation(proposal: UpdateProposal, command: Extract<DomainCommand, { type: "update_proposal_evaluated" }>): void {
  if (!command.gate) throw new Error("Update proposal evaluation requires a canonical gate report");
  if (!proposal.evaluationSets) throw new Error("Update proposal evaluation sets are missing");
  if (!command.metrics) throw new Error("Update proposal evaluation requires gate metrics");
  validateUpdateEvaluationGate(command.gate, {
    candidateHash: proposal.candidateHash,
    evaluationSets: proposal.evaluationSets,
    evaluationHash: command.evaluationHash,
    gatePassed: command.metrics.gatePassed,
  });
  validateGateMetrics(command.gate, command.metrics);
  validateProposalMetrics(command.metrics);
}

function validatePersistedProposalEvaluation(proposal: UpdateProposal, requirePassing: boolean): void {
  if (!proposal.evaluationGate || !proposal.evaluationHash || !proposal.evaluationSets || !proposal.metrics) {
    throw new Error("Update proposal approval requires a valid passing evaluation gate");
  }
  validateUpdateEvaluationGate(proposal.evaluationGate, {
    candidateHash: proposal.candidateHash,
    evaluationSets: proposal.evaluationSets,
    evaluationHash: proposal.evaluationHash,
    gatePassed: proposal.metrics.gatePassed,
  });
  validateGateMetrics(proposal.evaluationGate, proposal.metrics);
  if (requirePassing && (!proposal.evaluationGate.passed || proposal.metrics.gatePassed !== 1)) {
    throw new Error("Update proposal approval requires a valid passing evaluation gate");
  }
}

function validateGateMetrics(gate: UpdateEvaluationGate, metrics: NonNullable<UpdateProposal["metrics"]>): void {
  if (metrics.triggerPassRate !== gate.scores.triggerPassRate
    || metrics.retentionPassRate !== gate.scores.retentionPassRate
    || metrics.migrationPassRate !== gate.scores.migrationPassRate
    || metrics.safetyPassRate !== gate.scores.safetyPassRate
    || metrics.retentionRegressionRate !== gate.scores.retentionRegressionRate
    || metrics.activationRate !== gate.activationRate
    || metrics.followingRate !== gate.followingRate) {
    throw new Error("Update proposal metrics do not match canonical gate report");
  }
}

function validateProposalMetrics(metrics: UpdateProposal["metrics"]): void {
  if (!metrics) return;
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (key !== "p95LatencyMs" && key !== "costUsd" && value > 1)) {
      throw new Error(`Update proposal metric is invalid: ${key}`);
    }
  }
}

function validateArtifactSemantic(snapshot: RunSnapshot, semantic: Omit<ArtifactSemanticMetadata, "updatedSeq"> | ArtifactSemanticMetadata): void {
  if (!semantic.name.trim() || semantic.name.length > 160) throw new Error("Artifact name must contain 1-160 characters");
  if (!semantic.summary.trim() || semantic.summary.length > 1_000) throw new Error("Artifact summary must contain 1-1000 characters");
  if (semantic.tags.length > 16 || semantic.tags.some((tag) => !tag.trim() || tag.length > 40)) throw new Error("Artifact tags must contain at most 16 values of 1-40 characters");
  if (!(["supporting", "intermediate", "debug", "result"] as string[]).includes(semantic.role)) throw new Error(`Unknown artifact role: ${String(semantic.role)}`);
  if (!(["harness", "agent", "user"] as string[]).includes(semantic.annotatedBy)) throw new Error(`Unknown artifact annotator: ${String(semantic.annotatedBy)}`);
  if (semantic.relatedIds.length > 32) throw new Error("Artifact related ids must contain at most 32 values");
  const known = new Set([
    ...Object.keys(snapshot.artifacts),
    ...Object.keys(snapshot.evidence),
    ...Object.keys(snapshot.facts),
    ...Object.keys(snapshot.hypotheses),
    ...Object.keys(snapshot.completions),
    ...Object.keys(snapshot.observations),
    ...Object.keys(snapshot.reasoningNodes),
    ...Object.keys(snapshot.reasoningTrees),
  ]);
  const missing = semantic.relatedIds.filter((id) => !known.has(id));
  if (missing.length > 0) throw new Error(`Unknown related ids: ${missing.join(", ")}`);
}

function validateWorkItemCommand(snapshot: RunSnapshot, command: WorkItemCommand): void {
  if (isTerminal(snapshot.status)) throw new Error(`Cannot mutate work graph for terminal run ${snapshot.status}`);
  if (command.type === "work_item_created") {
    const item = command.workItem;
    if (snapshot.workItems[item.id]) throw new Error(`Work item already exists: ${item.id}`);
    if (item.runId !== snapshot.runId) throw new Error(`Work item run identity mismatch: ${item.id}`);
    if (!item.title.trim() || !item.objective.trim()) throw new Error("Work item title and objective are required");
    if (!(["planner", "researcher", "coder", "executor", "verifier"] as string[]).includes(item.role)) throw new Error(`Unknown work item role: ${String(item.role)}`);
    if (!["PLANNED", "READY"].includes(item.status)) throw new Error(`New work item must be PLANNED or READY, got ${item.status}`);
    if (!Number.isInteger(item.attempt) || item.attempt < 0 || !Number.isInteger(item.maxAttempts) || item.maxAttempts < 1 || item.attempt > item.maxAttempts) throw new Error("Invalid work item attempt budget");
    if (item.parentId !== undefined && !snapshot.workItems[item.parentId]) throw new Error(`Unknown parent work item ${item.parentId}`);
    if (item.dependsOn.includes(item.id)) throw new Error(`Work item cannot depend on itself: ${item.id}`);
    for (const dependency of item.dependsOn) {
      if (!snapshot.workItems[dependency]) throw new Error(`Unknown work item dependency ${dependency}`);
      if (reachesWorkItem(snapshot, dependency, item.id, new Set())) throw new Error(`Work item dependency cycle involving ${item.id}`);
    }
    for (const evidenceId of item.evidenceIds) if (!snapshot.evidence[evidenceId]) throw new Error(`Unknown work item evidence ${evidenceId}`);
    for (const artifactId of item.artifactIds) if (!snapshot.artifacts[artifactId]) throw new Error(`Unknown work item artifact ${artifactId}`);
    if (item.status === "READY" && !dependenciesSucceeded(snapshot, item.dependsOn)) throw new Error(`Work item dependencies are not complete: ${item.id}`);
    return;
  }

  const item = snapshot.workItems[command.workItemId];
  if (!item) throw new Error(`Unknown work item ${command.workItemId}`);
  const lane = command.lane ?? "main";
  if (command.type === "work_item_ready") {
    if (item.status !== "PLANNED" && item.status !== "BLOCKED") throw new Error(`Cannot ready work item in ${item.status}`);
    if (item.attempt >= item.maxAttempts) throw new Error(`Work item attempt budget exhausted: ${item.id}`);
    if (!dependenciesSucceeded(snapshot, item.dependsOn)) throw new Error(`Work item dependencies are not complete: ${item.id}`);
    return;
  }
  if (command.type === "work_item_claimed") {
    if (lane !== command.ownerLane) throw new Error("Work item claim lane must match ownerLane");
    const expired = !item.lease || Date.parse(item.lease.expiresAt) <= Date.now();
    if (item.status === "RUNNING" && !expired) throw new Error(`Work item lease is still active: ${item.id}`);
    if (item.status !== "READY" && !(item.status === "RUNNING" && expired)) throw new Error(`Cannot claim work item in ${item.status}`);
    if (item.attempt >= item.maxAttempts) throw new Error(`Work item attempt budget exhausted: ${item.id}`);
    if (!Number.isFinite(Date.parse(command.leaseExpiresAt))) throw new Error("Work item lease expiry must be an ISO timestamp");
    return;
  }
  if (command.type === "work_item_blocked" || command.type === "work_item_completed" || command.type === "work_item_failed") {
    if (item.status !== "RUNNING") throw new Error(`Cannot transition work item in ${item.status}`);
    if (item.ownerLane !== lane) throw new Error(`Work item ownership mismatch: ${item.id}`);
  }
  if (command.type === "work_item_completed") {
    for (const evidenceId of command.evidenceIds ?? []) if (!snapshot.evidence[evidenceId]) throw new Error(`Unknown work item evidence ${evidenceId}`);
    for (const artifactId of command.artifactIds ?? []) if (!snapshot.artifacts[artifactId]) throw new Error(`Unknown work item artifact ${artifactId}`);
  }
  if (command.type === "work_item_cancelled" || command.type === "work_item_superseded") {
    if (["SUCCEEDED", "FAILED", "CANCELLED", "SUPERSEDED"].includes(item.status)) throw new Error(`Cannot transition work item in ${item.status}`);
    if (item.status === "RUNNING" && item.ownerLane !== lane && lane !== "main") throw new Error(`Work item ownership mismatch: ${item.id}`);
  }
}

function validateRequestEpochCommand(snapshot: RunSnapshot, command: Extract<DomainCommand, { type: "request_epoch_started" }>): void {
  if (isTerminal(snapshot.status)) throw new Error(`Cannot start a request epoch for terminal run ${snapshot.status}`);
  const epoch = command.epoch;
  if (snapshot.requestEpochs[epoch.id]) throw new Error(`Request epoch already exists: ${epoch.id}`);
  if (epoch.runId !== snapshot.runId) throw new Error(`Request epoch run identity mismatch: ${epoch.id}`);
  // Legacy epochs omitted generation. New epochs must bind to the snapshot
  // that produced the actual Provider request.
  if (epoch.generation !== undefined && epoch.generation !== snapshot.generation) {
    throw new Error(`Request epoch generation mismatch: expected ${snapshot.generation}, got ${epoch.generation}`);
  }
  if (!epoch.requestId.trim() || !epoch.provider.trim() || !epoch.model.trim() || !epoch.adapter.trim()) throw new Error("Request epoch identity fields are required");
  if (epoch.status !== "STARTED") throw new Error(`New request epoch must be STARTED, got ${epoch.status}`);
  if (!Number.isFinite(Date.parse(epoch.createdAt))) throw new Error("Request epoch createdAt must be an ISO timestamp");
  if (epoch.parentEpochId !== undefined && !snapshot.requestEpochs[epoch.parentEpochId]) throw new Error(`Unknown parent request epoch ${epoch.parentEpochId}`);
  if (new Set(epoch.toolNames).size !== epoch.toolNames.length) throw new Error("Request epoch toolNames must be unique");
}

function dependenciesSucceeded(snapshot: RunSnapshot, dependencies: string[]): boolean {
  return dependencies.every((dependency) => snapshot.workItems[dependency]?.status === "SUCCEEDED");
}

function reachesWorkItem(snapshot: RunSnapshot, fromId: string, targetId: string, seen: Set<string>): boolean {
  if (fromId === targetId) return true;
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  return (snapshot.workItems[fromId]?.dependsOn ?? []).some((dependency) => reachesWorkItem(snapshot, dependency, targetId, seen));
}

/**
 * Make an exact retry of a trusted verifier result batch a no-op. The
 * comparison is intentionally strict: a reused id may only replay the same
 * Evidence or terminal Completion, never overwrite a different conclusion.
 */
function filterIdempotentVerifierCommands(snapshot: RunSnapshot, commands: VerifierResultCommand[]): VerifierResultCommand[] {
  return commands.filter((command) => {
    if (command.type === "evidence") {
      const existing = snapshot.evidence[command.evidence.id];
      if (!existing) return true;
      if (existing.provenance.recordedBy !== "verifier" || canonicalJson(verifierEvidenceShape(existing)) !== canonicalJson(verifierEvidenceShape(command.evidence))) {
        throw new Error(`Verifier Evidence retry does not match durable Evidence ${command.evidence.id}`);
      }
      return false;
    }
    if (command.type === "completion_verified") {
      const existing = snapshot.completions[command.completionId];
      if (!existing || existing.status === "PROPOSED") return true;
      const missingEvidence = command.evidenceIds.filter((evidenceId) => !snapshot.evidence[evidenceId]);
      if (missingEvidence.length > 0) throw new Error(`Terminal Completion retry references missing Evidence: ${missingEvidence.join(", ")}`);
      const accepted = existing.status === "ACCEPTED";
      if (accepted !== command.accepted || !sameStringArray(existing.evidenceIds, command.evidenceIds)) {
        throw new Error(`Verifier Completion retry does not match durable Completion ${existing.id}`);
      }
      return false;
    }
    return true;
  });
}

function verifierEvidenceShape(value: RunSnapshot["evidence"][string] | VerifierEvidenceCommand["evidence"]): Record<string, unknown> {
  return {
    id: value.id,
    kind: value.kind,
    name: value.name,
    summary: value.summary,
    tags: value.tags ?? [],
    dependsOn: value.dependsOn ?? [],
    source: value.source,
    confidence: value.confidence,
    supports: value.supports,
    refutes: value.refutes,
  };
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function createEffectInput(runId: string, operation: string, args: Record<string, unknown>, replayPolicy: ReplayPolicy, generation: number): { effectId: string; idempotencyKey: string } {
  const normalizedArgs = canonicalJson(args);
  return { effectId: id("EF"), idempotencyKey: sha256(`${runId}:${operation}:${normalizedArgs}:${generation}:${replayPolicy}`) };
}

function normalizeIngressLease(value: number | undefined): number {
  if (value === undefined) return 30_000;
  if (!Number.isInteger(value) || value < 50 || value > 300_000) throw new Error("event ingress lease must be an integer from 50 to 300000ms");
  return value;
}
