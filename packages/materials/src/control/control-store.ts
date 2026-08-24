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
  VerificationVerdict,
  RunToolPreparation,
} from "../domain/types.js";
import type { Intent as SchedulerIntent } from "../domain/intent.js";
import { validateReasoningEdge, validateReasoningNode, validateReasoningTree } from "../domain/reasoning.js";
import { canonicalJson, id, isTerminal, sha256 } from "../domain/utils.js";
import { redactCtfCandidates } from "../domain/candidate.js";
import { handoffKnowledgeVersion } from "../domain/handoff.js";
import { JsonlControlStore, makeEvent } from "../storage/jsonl-store.js";
import { resolveControlAuthority } from "../storage/control-authority.js";
import { reduce } from "./reducer.js";
import { KeyedOperationQueue } from "@proofblade/atoms";
import { assertPhaseTransition } from "./phase-machine.js";
import { isAbsolute, relative, resolve } from "node:path";

type WithoutLane<T> = T extends unknown ? Omit<T, "lane"> : never;
type ControlAuthority = "public" | "verifier" | "verifier_artifact" | "fixture";
type VerifierResultCommand = Extract<WithoutLane<DomainCommand>, { type: "evidence" | "completion_verified" | "fact" | "artifact_annotation" }>;
type VerifierEffectCommand = Extract<WithoutLane<DomainCommand>, { type: "effect_proposed" | "effect_started" | "effect_finished" | "effect_reconciled" }>;
type VerifierResultArtifactCommand = Extract<WithoutLane<DomainCommand>, { type: "artifact" }>;

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
}

export interface FixtureControlPort {
  /** Check authority and lifecycle before mutating the external fixture. */
  assertResetAllowed(runId: string): Promise<void>;
  /** Harness/recovery-only lifecycle transition after the Sandbox attests reset. */
  reset(runId: string, generation: number): Promise<HarnessEvent[]>;
}

export interface ControlPlane {
  control: ControlStore;
  verifier: VerifierControlPort;
  verifierEffects: VerifierEffectControlPort;
  fixtureControl: FixtureControlPort;
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
  "provider_response_received",
  "request_epoch_context",
  "tool_call_recorded",
  "tool_result_recorded",
  "compaction_recorded",
  "model_usage",
]);
const VERIFIER_RESULT_COMMAND_TYPES = new Set(["evidence", "completion_verified", "fact", "artifact_annotation"]);
const VERIFIER_EFFECT_COMMAND_TYPES = new Set(["effect_proposed", "effect_started", "effect_finished", "effect_reconciled"]);

export type DomainCommand =
  | { type: "start_phase"; phase: Phase; lane?: Lane }
  | { type: "finish_phase"; phase: Phase; lane?: Lane }
  | { type: "set_domain_phase"; domainPhase: DomainPhase; lane?: Lane }
  | { type: "record_tool_preparation"; preparation: RunToolPreparation; lane?: Lane }
  | { type: "fixture_reset"; generation: number; lane?: Lane }
  | { type: "pause"; reason: string; lane?: Lane }
  | { type: "resume"; lane?: Lane }
  | { type: "finish"; verified: true; completionId: string; evidenceIds: string[]; reason: string; lane?: Lane }
  | { type: "finish"; verified: false; evidenceIds?: string[]; reason: string; failureCategory?: PrimaryFailureCategory; lane?: Lane }
  | { type: "fail"; reason: string; category: PrimaryFailureCategory; lane?: Lane }
  | { type: "exhaust"; reason: string; lane?: Lane }
  | { type: "fact"; fact: Omit<Fact, "createdSeq" | "runId" | "generation">; lane?: Lane }
  | { type: "observation"; observation: Omit<Observation, "createdSeq" | "runId" | "generation">; lane?: Lane }
  | { type: "evidence"; evidence: Omit<Evidence, "createdSeq" | "provenance">; lane?: Lane }
  | { type: "experiment"; experiment: Omit<ExperimentRecord, "createdSeq">; lane?: Lane }
  | { type: "reasoning_node"; node: Omit<ReasoningNode, "createdSeq" | "updatedSeq">; lane?: Lane }
  | { type: "reasoning_edge"; edge: Omit<ReasoningEdge, "createdSeq">; lane?: Lane }
  | { type: "reasoning_tree"; tree: Omit<ReasoningTree, "createdSeq" | "updatedSeq">; lane?: Lane }
  | { type: "hypothesis"; hypothesis: Omit<Hypothesis, "createdSeq" | "runId" | "generation">; lane?: Lane }
  | { type: "intent"; intent: Omit<Intent, "createdSeq">; lane?: Lane }
  | { type: "scheduler_intent"; intent: SchedulerIntent; lane?: Lane }
  | { type: "completion_proposed"; completion: Omit<CompletionProposal, "createdSeq" | "status" | "evidenceIds" | "runId" | "generation">; lane?: Lane }
  | { type: "completion_verified"; completionId: string; accepted: boolean; evidenceIds: string[]; lane?: Lane }
  | { type: "artifact"; generation: number; artifact: Omit<RunSnapshot["artifacts"][string], "runId" | "generation" | "origin">; lane?: Lane }
  | { type: "artifact_annotation"; artifactId: string; semantic: Omit<ArtifactSemanticMetadata, "updatedSeq">; lane?: Lane }
  | { type: "effect_proposed"; effect: Omit<RunSnapshot["effects"][string], "createdSeq" | "runId" | "generation" | "producerLane">; lane?: Lane }
  | { type: "effect_started"; effectId: string; lane?: Lane }
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
  | { type: "session_interacted"; sessionId: string; waitReason?: SessionRecord["lastWaitReason"]; transcriptArtifactId?: string; stateHash?: string; exited?: boolean; exitCode?: number | null; lane?: Lane }
  | { type: "session_signaled"; sessionId: string; signal: string; delivered?: boolean; lane?: Lane }
  | { type: "session_closed"; sessionId: string; reason?: string; exitCode?: number | null; lane?: Lane }
  | { type: "session_superseded"; sessionId: string; reason: string; lane?: Lane }
  | { type: "context_recovery"; checkpointId: string; lane?: Lane };

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
      const snapshot = await this.eventStore.create(runId, task, await this.versionProvider?.(), this.#authorityHash);
      await this.eventStore.saveProjection(snapshot, this.#authoritySecret);
      return snapshot;
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

  public async dispatch(runId: string, command: DomainCommand): Promise<HarnessEvent[]> {
    return await this.dispatchBatch(runId, [command]);
  }

  public async dispatchBatch(runId: string, commands: DomainCommand[]): Promise<HarnessEvent[]> {
    if (commands.length === 0) return [];
    return await this.operations.run(runId, async () => {
      const { events } = await this.#commitCommands(runId, await this.snapshot(runId), commands, "public");
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
      const { after } = await this.#commitCommands(runId, before, transaction.commands, "public");
      return transaction.project(after);
    });
  }

  public async append(runId: string, events: Array<Omit<HarnessEvent, "seq" | "id" | "streamId" | "runId" | "ts">>): Promise<void> {
    await this.operations.run(runId, async () => {
      const snapshot = await this.snapshot(runId);
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
      ));
      let validated = snapshot;
      for (const event of materialized) validated = reduce(validated, event);
      await this.eventStore.append(materialized, this.#authoritySecret);
      await this.eventStore.saveProjection(validated, this.#authoritySecret);
    });
  }

  public async runHash(runId: string): Promise<string> {
    const snapshot = await this.replay(runId);
    return sha256(canonicalJson(snapshot));
  }

  async #commitCommands(
    runId: string,
    before: RunSnapshot,
    commands: DomainCommand[],
    authority: ControlAuthority,
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
      const payload = after.task.mode === "coding_assistant" ? rawPayload : redactCtfEventPayload(rawPayload);
      const event = makeEvent(runId, seq, eventType(command), commandActor(command), lane, payload);
      after = reduce(after, event);
      events.push(event);
    }
    await this.eventStore.append(events, this.#authoritySecret);
    await this.eventStore.saveProjection(after, this.#authoritySecret);
    return { after, events };
  }

  #createVerifierPort(): VerifierControlPort {
    const dispatchBatch = async (runId: string, commands: VerifierResultCommand[]): Promise<HarnessEvent[]> => {
      if (commands.length === 0) return [];
      if (commands.some((command) => !VERIFIER_RESULT_COMMAND_TYPES.has(command.type))) throw new Error("Verifier result capability only accepts Evidence, Completion, Fact, and trusted annotation commands");
      return await this.operations.run(runId, async () => {
        const trusted = commands.map((command) => ({ ...command, lane: "verifier" }) as DomainCommand);
        const { events } = await this.#commitCommands(runId, await this.snapshot(runId), trusted, "verifier");
        return events;
      });
    };
    return Object.freeze({
      dispatch: async (runId: string, command: VerifierResultCommand) => await dispatchBatch(runId, [command]),
      dispatchBatch,
      finish: async (runId: string, input: { completionId: string; reason: string }) => await this.operations.run(runId, async () => {
        const snapshot = await this.snapshot(runId);
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
        const { events } = await this.#commitCommands(runId, snapshot, [command], "verifier");
        return events;
      }),
    });
  }

  #createVerifierEffectPort(): VerifierEffectControlPort {
    return Object.freeze({
      dispatch: async (runId: string, command: VerifierEffectCommand): Promise<HarnessEvent[]> => await this.operations.run(runId, async () => {
        if (!VERIFIER_EFFECT_COMMAND_TYPES.has(command.type)) throw new Error("Verifier Effect capability only accepts Effect lifecycle commands");
        const trusted = { ...command, lane: "verifier" } as DomainCommand;
        const { events } = await this.#commitCommands(runId, await this.snapshot(runId), [trusted], "verifier");
        return events;
      }),
      registerResultArtifact: async (runId: string, command: VerifierResultArtifactCommand): Promise<HarnessEvent[]> => await this.operations.run(runId, async () => {
        if (command.type !== "artifact") throw new Error("Verifier Artifact capability only accepts Artifact registration commands");
        const trusted = { ...command, lane: "verifier" } as DomainCommand;
        const { events } = await this.#commitCommands(runId, await this.snapshot(runId), [trusted], "verifier_artifact");
        return events;
      }),
    });
  }

  #createFixtureControlPort(): FixtureControlPort {
    return Object.freeze({
      assertResetAllowed: async (runId: string): Promise<void> => await this.operations.run(runId, async () => {
        const snapshot = await this.snapshot(runId);
        if (snapshot.authorityHash !== this.#authorityHash) throw new Error("Trusted control authority does not match the immutable Run anchor");
        validateFixtureResetState(snapshot);
      }),
      reset: async (runId: string, generation: number) => await this.operations.run(runId, async () => {
        const snapshot = await this.snapshot(runId);
        const command: DomainCommand = { type: "fixture_reset", generation, lane: "main" };
        const { events } = await this.#commitCommands(runId, snapshot, [command], "fixture");
        return events;
      }),
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
    case "scheduler_intent": return "scheduler_intent_changed";
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
    case "experiment": return { experiment: { ...command.experiment, createdSeq: seq } };
    case "reasoning_node": return { node: command.node };
    case "reasoning_edge": return { edge: command.edge };
    case "reasoning_tree": return { tree: command.tree };
    case "hypothesis": return { hypothesis: { ...command.hypothesis, runId: snapshot.runId, generation: snapshot.generation, createdSeq: seq } };
    case "intent": return { intent: { ...command.intent, createdSeq: seq } };
    case "scheduler_intent": return { intent: command.intent };
    case "completion_proposed": return { completion: { ...command.completion, runId: snapshot.runId, generation: snapshot.generation, status: "PROPOSED", evidenceIds: [], createdSeq: seq } };
    case "completion_verified": return { completionId: command.completionId, accepted: command.accepted, evidenceIds: command.evidenceIds };
    case "artifact": return {
      artifact: {
        ...command.artifact,
        runId: snapshot.runId,
        generation: command.generation,
        origin: {
          schemaVersion: 1,
          registeredBy: authority === "verifier_artifact" ? "verifier" : "agent",
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
    case "effect_started": return { effectId: command.effectId };
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
  if (snapshot.status === "PAUSED" && (command.type === "finish" || command.type === "fail" || command.type === "exhaust")) {
    throw new Error(`Cannot ${command.type} a paused run; resume it first`);
  }
  if (requiresVerifierAuthority(command) && !trustedVerifier) {
    throw new Error(`${protectedCommandLabel(command)} is restricted to the trusted verifier service`);
  }
  if ((trustedVerifier || trustedVerifierArtifact) && command.lane !== "verifier") throw new Error("Trusted verifier commands must use the verifier lane");
  if (trustedVerifierArtifact && command.type !== "artifact") throw new Error("Verifier Artifact authority is restricted to Artifact registration");
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
      if (!command.verification) throw new Error("A verifier Effect requires a structured verification verdict");
      if (artifact.origin.registeredBy !== "verifier") throw new Error(`Verifier Effect Artifact ${artifact.id} was not registered by verifier authority`);
      const boundArtifacts = Object.values(snapshot.artifacts).filter((value) => value.sourceEffectId === effect.id);
      if (boundArtifacts.length !== 1 || boundArtifacts[0]?.id !== artifact.id) throw new Error(`Verifier Effect ${effect.id} requires exactly one trusted result Artifact`);
      validateVerificationVerdict(snapshot, effect, artifact, command.verification);
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
    const artifact = snapshot.artifacts[command.completion.artifactId];
    if (!artifact) throw new Error(`Unknown completion artifact ${command.completion.artifactId}`);
    if (artifact.generation !== snapshot.generation) throw new Error(`Completion artifact is from generation ${artifact.generation}`);
    if (artifact.sha256 !== command.completion.candidateHash) throw new Error(`Candidate hash mismatch for completion ${command.completion.id}`);
  }
  if (command.type === "evidence") validateEvidence(snapshot, command.evidence, command.lane ?? "main", references, trustedVerifier);
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
  if (command.type === "record_tool_preparation") validateToolPreparation(snapshot, command.preparation);
  if (command.type === "experiment") validateExperimentCommand(snapshot, command);
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
  }
  return references;
}

function requiresVerifierAuthority(command: DomainCommand): boolean {
  if (command.type === "completion_verified") return true;
  if (command.type === "finish" && command.verified) return true;
  if (command.type === "fact" && command.fact.status === "CONFIRMED") return true;
  if (command.type === "artifact_annotation" && command.semantic.annotatedBy !== "agent") return true;
  if (command.type === "evidence") return command.evidence.kind === "reproduction" || command.evidence.kind === "negative" || command.evidence.confidence === 1;
  return command.lane === "verifier" && (command.type === "effect_proposed" || command.type === "effect_started" || command.type === "effect_finished" || command.type === "effect_reconciled");
}

function protectedCommandLabel(command: DomainCommand): string {
  if (command.type === "evidence") return `${command.evidence.kind} evidence`;
  if (command.type === "finish" && command.verified) return "Successful finish";
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

function validateVerifierEffectProposal(
  snapshot: RunSnapshot,
  effect: Omit<RunSnapshot["effects"][string], "createdSeq" | "runId" | "generation" | "producerLane">,
  trustedVerifier: boolean,
): void {
  if (!trustedVerifier) throw new Error("Verifier effects require trusted verifier authority");
  if (!VERIFIER_EFFECT_OPERATIONS.has(effect.operation)) throw new Error(`Untrusted verifier effect operation: ${effect.operation}`);
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
  if (effect.operation === "claim_reproduction") {
    if (snapshot.task.verification.kind !== "reproduction" || !snapshot.task.verification.command || effect.command !== snapshot.task.verification.command) {
      throw new Error("claim_reproduction command must come from the task verifier policy");
    }
  }
  if (effect.operation === "web_reproduce" && !snapshot.task.verification.web?.flag_pattern) {
    throw new Error("web_reproduce is restricted to tasks with an immutable web verification policy");
  }
  if (effect.operation === "pwn_reproduce") validatePwnVerifierBinding(snapshot, effect);
}

function validateTrustedVerificationEffect(snapshot: RunSnapshot, effect: RunSnapshot["effects"][string]): void {
  if (effect.producerLane !== "verifier") throw new Error(`Evidence effect ${effect.id} was not produced by the verifier service`);
  if (!VERIFIER_EFFECT_OPERATIONS.has(effect.operation)) throw new Error(`Evidence effect ${effect.id} uses an untrusted verifier operation`);
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

const VERIFIER_EFFECT_OPERATIONS = new Set(["fixture_score", "claim_reproduction", "pwn_reproduce", "web_reproduce"]);

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
  if (!task.scope.allowed_workspace.trim()) throw new Error("Task allowed_workspace is required");
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

function validateBoundedStringList(values: unknown, label: string, maxItemLength: number, maxItems: number): void {
  if (!Array.isArray(values) || values.length > maxItems || values.some((value) => typeof value !== "string" || value.length === 0 || value.length > maxItemLength)) throw new Error(`Tool preparation ${label} is invalid`);
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
