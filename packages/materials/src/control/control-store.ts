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
} from "../domain/types.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import { JsonlControlStore, makeEvent } from "../storage/jsonl-store.js";
import { reduce } from "./reducer.js";
import { KeyedOperationQueue } from "@proofblade/atoms";
import { assertPhaseTransition } from "./phase-machine.js";

export type DomainCommand =
  | { type: "start_phase"; phase: Phase; lane?: Lane }
  | { type: "finish_phase"; phase: Phase; lane?: Lane }
  | { type: "fixture_reset"; generation: number; lane?: Lane }
  | { type: "pause"; reason: string; lane?: Lane }
  | { type: "resume"; lane?: Lane }
  | { type: "finish"; verified: boolean; evidenceIds: string[]; reason: string; lane?: Lane }
  | { type: "fail"; reason: string; lane?: Lane }
  | { type: "exhaust"; reason: string; lane?: Lane }
  | { type: "fact"; fact: Omit<Fact, "createdSeq">; lane?: Lane }
  | { type: "observation"; observation: Omit<Observation, "createdSeq">; lane?: Lane }
  | { type: "evidence"; evidence: Omit<Evidence, "createdSeq">; lane?: Lane }
  | { type: "hypothesis"; hypothesis: Omit<Hypothesis, "createdSeq">; lane?: Lane }
  | { type: "intent"; intent: Omit<Intent, "createdSeq">; lane?: Lane }
  | { type: "completion_proposed"; completion: Omit<CompletionProposal, "createdSeq" | "status" | "evidenceIds">; lane?: Lane }
  | { type: "completion_verified"; completionId: string; accepted: boolean; evidenceIds: string[]; lane?: Lane }
  | { type: "artifact"; artifact: RunSnapshot["artifacts"][string]; lane?: Lane }
  | { type: "effect_proposed"; effect: Omit<RunSnapshot["effects"][string], "createdSeq">; lane?: Lane }
  | { type: "effect_started"; effectId: string; lane?: Lane }
  | { type: "effect_finished"; effectId: string; outcome: "success" | "error" | "timeout" | "unknown"; artifactId?: string; externalId?: string; lane?: Lane }
  | { type: "effect_reconciled"; effectId: string; outcome: "success" | "error" | "timeout" | "unknown"; lane?: Lane }
  | { type: "lease_acquired"; lease: RunSnapshot["leases"][string]; lane?: Lane }
  | { type: "lease_heartbeat"; resourceKey: string; ownerLane: Lane; generation: number; heartbeatAt: string; expiresAt: string; lane?: Lane }
  | { type: "lease_released"; resourceKey: string; lane?: Lane }
  | { type: "checkpoint"; checkpointId: string; lane?: Lane };

export class ControlStore {
  private readonly operations = new KeyedOperationQueue();

  public constructor(private readonly eventStore: JsonlControlStore) {}

  public async createRun(runId: string, task: TaskContract): Promise<RunSnapshot> {
    return await this.operations.run(runId, async () => {
      await this.eventStore.persistTask(runId, task);
      const snapshot = await this.eventStore.create(runId, task);
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
    return await this.operations.run(runId, async () => {
      const before = await this.snapshot(runId);
      validateCommand(before, command);
      const lane = command.lane ?? "main";
      const seq = before.lastSeq + 1;
      const event = makeEvent(runId, seq, eventType(command), commandActor(command), lane, payloadFor(command, seq));
      const events = [event];
      const after = reduce(before, event);
      await this.eventStore.append(events);
      await this.eventStore.saveProjection(after);
      return events;
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
}

function eventType(command: DomainCommand): HarnessEvent["type"] {
  switch (command.type) {
    case "start_phase": return "phase_started";
    case "finish_phase": return "phase_finished";
    case "fixture_reset": return "fixture_reset";
    case "pause": return "run_paused";
    case "resume": return "run_resumed";
    case "finish": return "run_finished";
    case "fail": return "run_failed";
    case "exhaust": return "run_finished";
    case "fact": return "fact_added";
    case "observation": return "observation_added";
    case "evidence": return "evidence_added";
    case "hypothesis": return "hypothesis_added";
    case "intent": return "intent_changed";
    case "completion_proposed": return "completion_proposed";
    case "completion_verified": return "completion_verified";
    case "artifact": return "artifact_registered";
    case "effect_proposed": return "effect_proposed";
    case "effect_started": return "effect_started";
    case "effect_finished": return "effect_finished";
    case "effect_reconciled": return "effect_reconciled";
    case "lease_acquired": return "lease_acquired";
    case "lease_heartbeat": return "lease_heartbeat";
    case "lease_released": return "lease_released";
    case "checkpoint": return "checkpoint_created";
  }
}

function commandActor(command: DomainCommand): HarnessEvent["actor"] {
  return command.type === "effect_finished" || command.type === "effect_started" ? "tool" : "orchestrator";
}

function payloadFor(command: DomainCommand, seq: number): Record<string, unknown> {
  switch (command.type) {
    case "start_phase": return { phase: command.phase };
    case "finish_phase": return { phase: command.phase };
    case "fixture_reset": return { generation: command.generation };
    case "pause": return { reason: command.reason };
    case "resume": return {};
    case "finish": return { status: command.verified ? "SUCCEEDED" : "FAILED", verified: command.verified, evidenceIds: command.evidenceIds, reason: command.reason };
    case "fail": return { reason: command.reason };
    case "exhaust": return { status: "EXHAUSTED", verified: false, evidenceIds: [], reason: command.reason };
    case "fact": return { fact: { ...command.fact, createdSeq: seq } };
    case "observation": return { observation: { ...command.observation, createdSeq: seq } };
    case "evidence": return { evidence: { ...command.evidence, createdSeq: seq } };
    case "hypothesis": return { hypothesis: { ...command.hypothesis, createdSeq: seq } };
    case "intent": return { intent: { ...command.intent, createdSeq: seq } };
    case "completion_proposed": return { completion: { ...command.completion, status: "PROPOSED", evidenceIds: [], createdSeq: seq } };
    case "completion_verified": return { completionId: command.completionId, accepted: command.accepted, evidenceIds: command.evidenceIds };
    case "artifact": return { artifact: command.artifact };
    case "effect_proposed": return { effect: { ...command.effect, createdSeq: seq } };
    case "effect_started": return { effectId: command.effectId };
    case "effect_finished": return { effectId: command.effectId, outcome: command.outcome, artifactId: command.artifactId, externalId: command.externalId };
    case "effect_reconciled": return { effectId: command.effectId, outcome: command.outcome };
    case "lease_acquired": return { lease: command.lease };
    case "lease_heartbeat": return { resourceKey: command.resourceKey, ownerLane: command.ownerLane, generation: command.generation, heartbeatAt: command.heartbeatAt, expiresAt: command.expiresAt };
    case "lease_released": return { resourceKey: command.resourceKey };
    case "checkpoint": return { checkpointId: command.checkpointId };
  }
}

function validateCommand(snapshot: RunSnapshot, command: DomainCommand): void {
  if (command.type === "start_phase") assertPhaseTransition(snapshot, command.phase);
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

export function createEffectInput(runId: string, operation: string, args: Record<string, unknown>, replayPolicy: ReplayPolicy, generation: number): { effectId: string; idempotencyKey: string } {
  const normalizedArgs = canonicalJson(args);
  return { effectId: id("EF"), idempotencyKey: sha256(`${runId}:${operation}:${normalizedArgs}:${generation}:${replayPolicy}`) };
}
