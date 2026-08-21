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
  ReasoningEdge,
  ReasoningNode,
  ReasoningTree,
  WorkItem,
  RequestEpoch,
  SessionRecord,
  DomainPhase,
  ExperimentRecord,
} from "../domain/types.js";
import { validateReasoningEdge, validateReasoningNode, validateReasoningTree } from "../domain/reasoning.js";
import { canonicalJson, id, isTerminal, sha256 } from "../domain/utils.js";
import { handoffKnowledgeVersion } from "../domain/handoff.js";
import { JsonlControlStore, makeEvent } from "../storage/jsonl-store.js";
import { reduce } from "./reducer.js";
import { KeyedOperationQueue } from "@proofblade/atoms";
import { assertPhaseTransition } from "./phase-machine.js";

export type DomainCommand =
  | { type: "start_phase"; phase: Phase; lane?: Lane }
  | { type: "finish_phase"; phase: Phase; lane?: Lane }
  | { type: "set_domain_phase"; domainPhase: DomainPhase; lane?: Lane }
  | { type: "fixture_reset"; generation: number; lane?: Lane }
  | { type: "pause"; reason: string; lane?: Lane }
  | { type: "resume"; lane?: Lane }
  | { type: "finish"; verified: boolean; evidenceIds: string[]; reason: string; failureCategory?: PrimaryFailureCategory; lane?: Lane }
  | { type: "fail"; reason: string; category: PrimaryFailureCategory; lane?: Lane }
  | { type: "exhaust"; reason: string; lane?: Lane }
  | { type: "fact"; fact: Omit<Fact, "createdSeq">; lane?: Lane }
  | { type: "observation"; observation: Omit<Observation, "createdSeq">; lane?: Lane }
  | { type: "evidence"; evidence: Omit<Evidence, "createdSeq">; lane?: Lane }
  | { type: "experiment"; experiment: Omit<ExperimentRecord, "createdSeq">; lane?: Lane }
  | { type: "reasoning_node"; node: Omit<ReasoningNode, "createdSeq" | "updatedSeq">; lane?: Lane }
  | { type: "reasoning_edge"; edge: Omit<ReasoningEdge, "createdSeq">; lane?: Lane }
  | { type: "reasoning_tree"; tree: Omit<ReasoningTree, "createdSeq" | "updatedSeq">; lane?: Lane }
  | { type: "hypothesis"; hypothesis: Omit<Hypothesis, "createdSeq">; lane?: Lane }
  | { type: "intent"; intent: Omit<Intent, "createdSeq">; lane?: Lane }
  | { type: "completion_proposed"; completion: Omit<CompletionProposal, "createdSeq" | "status" | "evidenceIds">; lane?: Lane }
  | { type: "completion_verified"; completionId: string; accepted: boolean; evidenceIds: string[]; lane?: Lane }
  | { type: "artifact"; artifact: RunSnapshot["artifacts"][string]; lane?: Lane }
  | { type: "artifact_annotation"; artifactId: string; semantic: Omit<ArtifactSemanticMetadata, "updatedSeq">; lane?: Lane }
  | { type: "effect_proposed"; effect: Omit<RunSnapshot["effects"][string], "createdSeq">; lane?: Lane }
  | { type: "effect_started"; effectId: string; lane?: Lane }
  | { type: "effect_finished"; effectId: string; outcome: "success" | "error" | "timeout" | "unknown"; artifactId?: string; externalId?: string; durationMs?: number; outputBytes?: number; exitCode?: number | null; errorSignature?: string; lane?: Lane }
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
  | { type: "session_interacted"; sessionId: string; waitReason?: SessionRecord["lastWaitReason"]; transcriptArtifactId?: string; stateHash?: string; exited?: boolean; exitCode?: number | null; lane?: Lane }
  | { type: "session_signaled"; sessionId: string; signal: string; delivered?: boolean; lane?: Lane }
  | { type: "session_closed"; sessionId: string; reason?: string; exitCode?: number | null; lane?: Lane }
  | { type: "session_superseded"; sessionId: string; reason: string; lane?: Lane }
  | { type: "context_recovery"; checkpointId: string; lane?: Lane };

type WorkItemCommand = Extract<DomainCommand, { type: `work_item_${string}` }>;

export class ControlStore {
  private readonly operations = new KeyedOperationQueue();

  public constructor(
    private readonly eventStore: JsonlControlStore,
    private readonly versionProvider?: () => Promise<RunVersionSnapshot>,
  ) {}

  public async createRun(runId: string, task: TaskContract): Promise<RunSnapshot> {
    return await this.operations.run(runId, async () => {
      await this.eventStore.persistTask(runId, task);
      const snapshot = await this.eventStore.create(runId, task, await this.versionProvider?.());
      await this.eventStore.saveProjection(snapshot);
      return snapshot;
    });
  }

  public async snapshot(runId: string): Promise<RunSnapshot> {
    return await this.eventStore.replay(runId);
  }

  public async replay(runId: string): Promise<RunSnapshot> {
    return await this.eventStore.replay(runId);
  }

  public async events(runId: string): Promise<HarnessEvent[]> {
    return await this.eventStore.events(runId);
  }

  public async dispatch(runId: string, command: DomainCommand): Promise<HarnessEvent[]> {
    return await this.dispatchBatch(runId, [command]);
  }

  public async dispatchBatch(runId: string, commands: DomainCommand[]): Promise<HarnessEvent[]> {
    if (commands.length === 0) return [];
    return await this.operations.run(runId, async () => {
      const { events } = await this.commitCommands(runId, await this.snapshot(runId), commands);
      return events;
    });
  }

  public async dispatchTransaction<TResult>(
    runId: string,
    prepare: (snapshot: RunSnapshot) => { commands: DomainCommand[]; project: (after: RunSnapshot) => TResult },
  ): Promise<TResult> {
    return await this.operations.run(runId, async () => {
      const before = await this.snapshot(runId);
      const transaction = prepare(before);
      if (transaction.commands.length === 0) return transaction.project(before);
      const { after } = await this.commitCommands(runId, before, transaction.commands);
      return transaction.project(after);
    });
  }

  public async append(runId: string, events: Array<Omit<HarnessEvent, "seq" | "id" | "streamId" | "runId" | "ts">>): Promise<void> {
    await this.operations.run(runId, async () => {
      const snapshot = await this.snapshot(runId);
      const materialized = events.map((event, index) => makeEvent(
        runId,
        snapshot.lastSeq + index + 1,
        event.type,
        event.actor,
        event.lane,
        event.payload,
        event.correlationId,
      ));
      let validated = snapshot;
      for (const event of materialized) validated = reduce(validated, event);
      await this.eventStore.append(materialized);
      await this.eventStore.saveProjection(validated);
    });
  }

  public async runHash(runId: string): Promise<string> {
    const snapshot = await this.replay(runId);
    return sha256(canonicalJson(snapshot));
  }

  private async commitCommands(
    runId: string,
    before: RunSnapshot,
    commands: DomainCommand[],
  ): Promise<{ after: RunSnapshot; events: HarnessEvent[] }> {
    let after = before;
    const events: HarnessEvent[] = [];
    for (const command of commands) {
      validateCommand(after, command);
      const lane = command.lane ?? "main";
      const seq = after.lastSeq + 1;
      const event = makeEvent(runId, seq, eventType(command), commandActor(command), lane, payloadFor(command, seq));
      after = reduce(after, event);
      events.push(event);
    }
    await this.eventStore.append(events);
    await this.eventStore.saveProjection(after);
    return { after, events };
  }
}

function eventType(command: DomainCommand): HarnessEvent["type"] {
  switch (command.type) {
    case "start_phase": return "phase_started";
    case "finish_phase": return "phase_finished";
    case "set_domain_phase": return "domain_phase_changed";
    case "fixture_reset": return "fixture_reset";
    case "pause": return "run_paused";
    case "resume": return "run_resumed";
    case "finish": return "run_finished";
    case "fail": return "run_failed";
    case "exhaust": return "run_finished";
    case "fact": return "fact_added";
    case "observation": return "observation_added";
    case "evidence": return "evidence_added";
    case "experiment": return "experiment_recorded";
    case "reasoning_node": return "reasoning_node_upserted";
    case "reasoning_edge": return "reasoning_edge_added";
    case "reasoning_tree": return "reasoning_tree_upserted";
    case "hypothesis": return "hypothesis_added";
    case "intent": return "intent_changed";
    case "completion_proposed": return "completion_proposed";
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

function payloadFor(command: DomainCommand, seq: number): Record<string, unknown> {
  switch (command.type) {
    case "start_phase": return { phase: command.phase };
    case "finish_phase": return { phase: command.phase };
    case "set_domain_phase": return { domainPhase: command.domainPhase };
    case "fixture_reset": return { generation: command.generation };
    case "pause": return { reason: command.reason };
    case "resume": return {};
    case "finish": return { status: command.verified ? "SUCCEEDED" : "FAILED", verified: command.verified, evidenceIds: command.evidenceIds, reason: command.reason, failureCategory: command.verified ? undefined : command.failureCategory ?? "verification_missing" };
    case "fail": return { reason: command.reason, failureCategory: command.category };
    case "exhaust": return { status: "EXHAUSTED", verified: false, evidenceIds: [], reason: command.reason, failureCategory: "budget_exhausted" };
    case "fact": return { fact: { ...command.fact, createdSeq: seq } };
    case "observation": return { observation: { ...command.observation, createdSeq: seq } };
    case "evidence": return { evidence: { ...command.evidence, createdSeq: seq } };
    case "experiment": return { experiment: { ...command.experiment, createdSeq: seq } };
    case "reasoning_node": return { node: command.node };
    case "reasoning_edge": return { edge: command.edge };
    case "reasoning_tree": return { tree: command.tree };
    case "hypothesis": return { hypothesis: { ...command.hypothesis, createdSeq: seq } };
    case "intent": return { intent: { ...command.intent, createdSeq: seq } };
    case "completion_proposed": return { completion: { ...command.completion, status: "PROPOSED", evidenceIds: [], createdSeq: seq } };
    case "completion_verified": return { completionId: command.completionId, accepted: command.accepted, evidenceIds: command.evidenceIds };
    case "artifact": return {
      artifact: command.artifact.semantic
        ? { ...command.artifact, semantic: { ...command.artifact.semantic, updatedSeq: seq } }
        : command.artifact,
    };
    case "artifact_annotation": return { artifactId: command.artifactId, semantic: { ...command.semantic, updatedSeq: seq } };
    case "effect_proposed": return { effect: { ...command.effect, createdSeq: seq } };
    case "effect_started": return { effectId: command.effectId };
    case "effect_finished": return { effectId: command.effectId, outcome: command.outcome, artifactId: command.artifactId, externalId: command.externalId, durationMs: command.durationMs, outputBytes: command.outputBytes, exitCode: command.exitCode, errorSignature: command.errorSignature };
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
    case "session_interacted": return { sessionId: command.sessionId, waitReason: command.waitReason, transcriptArtifactId: command.transcriptArtifactId, stateHash: command.stateHash, exited: command.exited, exitCode: command.exitCode };
    case "session_signaled": return { sessionId: command.sessionId, signal: command.signal, delivered: command.delivered ?? false };
    case "session_closed": return { sessionId: command.sessionId, reason: command.reason, exitCode: command.exitCode };
    case "session_superseded": return { sessionId: command.sessionId, reason: command.reason };
    case "context_recovery": return { checkpointId: command.checkpointId };
  }
}

function validateCommand(snapshot: RunSnapshot, command: DomainCommand): void {
  if (snapshot.status === "PAUSED" && (command.type === "finish" || command.type === "fail" || command.type === "exhaust")) {
    throw new Error(`Cannot ${command.type} a paused run; resume it first`);
  }
  if (command.type === "lease_released" && (command.ownerLane !== undefined || command.generation !== undefined)) {
    const lease = snapshot.leases[command.resourceKey];
    if (!lease) return;
    if (command.ownerLane !== lease.ownerLane || command.generation !== lease.generation) {
      throw new Error(`Lease ownership mismatch: ${command.resourceKey}`);
    }
  }
  if (command.type === "artifact_annotation") {
    if (!snapshot.artifacts[command.artifactId]) throw new Error(`Unknown artifact ${command.artifactId}`);
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
    if (command.type === "job_finished" && job.status === "CANCELLED") return;
    if (command.type === "job_cancelled" && ["SUCCEEDED", "FAILED", "TIMED_OUT", "UNKNOWN"].includes(job.status)) throw new Error(`Cannot cancel job in ${job.status}`);
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
  if (command.type === "experiment") validateExperimentCommand(snapshot, command);
  if (command.type === "completion_verified" && command.lane !== "verifier") {
    throw new Error("Completion verification is restricted to the verifier lane");
  }
  if (command.type === "fact" && command.fact.status === "CONFIRMED" && command.lane !== "verifier") {
    throw new Error("Confirmed facts are restricted to the verifier lane");
  }
  if (command.type !== "finish" || !command.verified) return;
  if (command.lane !== "verifier") throw new Error("A successful run can only be committed by the verifier lane");
  const completion = Object.values(snapshot.completions).find((item) => item.status === "ACCEPTED");
  if (!completion) throw new Error("A successful run requires an accepted completion proposal");
  const evidence = command.evidenceIds.map((id) => snapshot.evidence[id]);
  if (evidence.some((item) => !item)) throw new Error("A successful run references unknown evidence");
  if (!evidence.some((item) => item?.kind === "reproduction")) throw new Error("A successful run requires reproduction evidence");
  if (command.evidenceIds.length < snapshot.task.verification.required_reproductions) {
    throw new Error(`A successful run requires ${snapshot.task.verification.required_reproductions} evidence records`);
  }
  if (!command.evidenceIds.every((id) => completion.evidenceIds.includes(id))) {
    throw new Error("Completion verification does not cover every final evidence id");
  }
}

function validateDomainPhaseTransition(snapshot: RunSnapshot, next: DomainPhase): void {
  const order: DomainPhase[] = ["INTAKE", "RECON", "TARGET_MODEL", "HYPOTHESIS", "EXPERIMENT", "REPRODUCE", "SUBMIT"];
  const allowedBacktracks: Partial<Record<DomainPhase, DomainPhase[]>> = { HYPOTHESIS: ["RECON"], EXPERIMENT: ["HYPOTHESIS", "RECON"], REPRODUCE: ["EXPERIMENT"] };
  if (next === snapshot.domainPhase) return;
  if (order.indexOf(next) > order.indexOf(snapshot.domainPhase)) return;
  if (!allowedBacktracks[snapshot.domainPhase]?.includes(next)) throw new Error(`Invalid domain phase transition: ${snapshot.domainPhase} -> ${next}`);
}

function validateExperimentCommand(snapshot: RunSnapshot, command: Extract<DomainCommand, { type: "experiment" }>): void {
  const experiment = command.experiment;
  if (snapshot.experiments[experiment.id]) throw new Error(`Experiment already exists: ${experiment.id}`);
  if (experiment.runId !== snapshot.runId) throw new Error(`Experiment run identity mismatch: ${experiment.id}`);
  if (experiment.generation !== snapshot.generation) throw new Error(`Experiment generation mismatch: ${experiment.id}`);
  if (!experiment.repeatKey.trim() || experiment.repeatKey.length > 256) throw new Error("Experiment repeatKey must contain 1-256 characters");
  if (!experiment.action.trim() || experiment.action.length > 1_000) throw new Error("Experiment action must contain 1-1000 characters");
  if (!experiment.inputHash.trim() || experiment.inputHash.length > 256) throw new Error("Experiment inputHash must contain 1-256 characters");
  if (!experiment.summary.trim() || experiment.summary.length > 1_000) throw new Error("Experiment summary must contain 1-1000 characters");
  if (experiment.hypothesisId && !snapshot.hypotheses[experiment.hypothesisId]) throw new Error(`Unknown experiment hypothesis: ${experiment.hypothesisId}`);
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

export function createEffectInput(runId: string, operation: string, args: Record<string, unknown>, replayPolicy: ReplayPolicy, generation: number): { effectId: string; idempotencyKey: string } {
  const normalizedArgs = canonicalJson(args);
  return { effectId: id("EF"), idempotencyKey: sha256(`${runId}:${operation}:${normalizedArgs}:${generation}:${replayPolicy}`) };
}
