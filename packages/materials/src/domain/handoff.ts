import type { HandoffAction, HandoffRecord, RunSnapshot } from "./types.js";
import { canonicalJson, sha256 } from "./utils.js";

export interface HandoffDraft extends Omit<HandoffRecord, "createdSeq" | "hash" | "status"> {
  status: "PROPOSED";
  hash: string;
}

/**
 * Hash only the shared knowledge projection. Handoff lifecycle events do not
 * invalidate their own input, while new observations or facts do.
 */
export function handoffKnowledgeVersion(snapshot: RunSnapshot): string {
  return sha256(canonicalJson({
    taskId: snapshot.task.task_id,
    phase: snapshot.phase,
    generation: snapshot.generation,
    facts: Object.values(snapshot.facts).sort(byId).map(({ id, statement, status, evidenceIds }) => ({ id, statement, status, evidenceIds })),
    hypotheses: Object.values(snapshot.hypotheses).sort(byId).map(({ id, statement, status, evidenceIds }) => ({ id, statement, status, evidenceIds })),
    observations: Object.values(snapshot.observations).sort(byId).map(({ id, summary, source }) => ({ id, summary, source })),
    evidence: Object.values(snapshot.evidence).sort(byId).map(({ id, summary, kind, source, supports, refutes }) => ({ id, summary, kind, source, supports, refutes })),
    intents: Object.values(snapshot.intents).sort(byId).map(({ id, title, description, phase, status, priority, ownerLane }) => ({ id, title, description, phase, status, priority, ownerLane })),
    completions: Object.values(snapshot.completions).sort(byId).map(({ id, candidateHash, status, evidenceIds }) => ({ id, candidateHash, status, evidenceIds })),
    jobs: Object.values(snapshot.jobs).sort(byId).map(({ id, capabilityId, operation, status, generation, artifactId, outputTier }) => ({ id, capabilityId, operation, status, generation, artifactId, outputTier })),
    artifacts: Object.values(snapshot.artifacts).sort(byId).map(({ id, path, sha256, bytes, sensitivity, sourceEffectId }) => ({ id, path, sha256, bytes, sensitivity, sourceEffectId })),
    workItems: Object.values(snapshot.workItems).sort(byId).map(({ id, parentId, title, objective, role, status, dependsOn, evidenceIds, artifactIds, attempt, maxAttempts, ownerLane, blockReason, failureReason }) => ({ id, parentId, title, objective, role, status, dependsOn, evidenceIds, artifactIds, attempt, maxAttempts, ownerLane, blockReason, failureReason })),
  }));
}

export function hashHandoff(draft: Omit<HandoffDraft, "hash"> | HandoffDraft): string {
  const { hash: _ignored, ...withoutHash } = draft as HandoffDraft & { hash?: string };
  return sha256(canonicalJson(withoutHash));
}

export function buildHandoffDraft(snapshot: RunSnapshot, handoffId: string): HandoffDraft {
  const openIntents = Object.values(snapshot.intents)
    .filter((intent) => intent.status === "OPEN" || intent.status === "CLAIMED")
    .sort((a, b) => b.priority - a.priority || a.createdSeq - b.createdSeq)
    .slice(0, 3);
  const observations = Object.values(snapshot.observations).sort(bySeq);
  const workItems = Object.values(snapshot.workItems)
    .filter((item) => item.status === "PLANNED" || item.status === "READY" || item.status === "BLOCKED")
    .sort((a, b) => a.createdSeq - b.createdSeq)
    .slice(0, 4);
  const actions: HandoffAction[] = workItems.map((item) => ({
    id: `ACTION-${item.id}`,
    workItemId: item.id,
    title: item.title,
    description: item.objective,
    expectedEvidence: ["observation", "artifact"],
    resourceKeys: ["target:" + snapshot.task.task_id],
    estimatedToolCalls: 1,
  }));
  actions.push(...openIntents.slice(0, Math.max(0, 3 - actions.length)).map((intent) => ({
    id: `ACTION-${intent.id}`,
    title: intent.title,
    description: intent.description,
    expectedEvidence: ["observation", "artifact"],
    resourceKeys: ["target:" + snapshot.task.task_id],
    estimatedToolCalls: 1,
  })));
  if (actions.length === 0) {
    actions.push({
      id: "ACTION-INSPECT",
      title: "Inspect the visible target",
      description: observations.length === 0 ? "Acquire the first bounded target observation." : "Acquire a fresh bounded observation that distinguishes the remaining routes.",
      expectedEvidence: ["observation", "artifact"],
      resourceKeys: ["target:" + snapshot.task.task_id],
      estimatedToolCalls: 1,
    });
  }
  const elapsedMs = snapshot.startedAt ? Math.max(0, Date.now() - Date.parse(snapshot.startedAt)) : 0;
  const remainingMs = Math.max(0, snapshot.task.constraints.deadline_ms - elapsedMs);
  const remainingToolCalls = Math.max(0, snapshot.task.constraints.max_tool_calls - Object.keys(snapshot.effects).length);
  const draft: Omit<HandoffDraft, "hash"> = {
    id: handoffId,
    schemaVersion: 1,
    runId: snapshot.runId,
    taskId: snapshot.task.task_id,
    sourceLane: "planner",
    targetLane: "executor",
    knowledgeVersion: handoffKnowledgeVersion(snapshot),
    phase: snapshot.phase,
    objective: snapshot.task.objective,
    confirmedFacts: Object.values(snapshot.facts).filter((fact) => fact.status === "CONFIRMED").sort(bySeq).slice(-8).map((fact) => ({ id: fact.id, summary: fact.statement, evidenceIds: fact.evidenceIds })),
    hypotheses: Object.values(snapshot.hypotheses).filter((hypothesis) => hypothesis.status === "OPEN" || hypothesis.status === "CONFIRMED").sort(bySeq).slice(-8).map((hypothesis) => ({ id: hypothesis.id, statement: hypothesis.statement, evidenceIds: hypothesis.evidenceIds })),
    rejectedHypotheses: Object.values(snapshot.hypotheses).filter((hypothesis) => hypothesis.status === "REJECTED").sort(bySeq).slice(-8).map((hypothesis) => ({ id: hypothesis.id, statement: hypothesis.statement, evidenceIds: hypothesis.evidenceIds })),
    nextActions: actions,
    budget: { remainingMs, remainingToolCalls },
    requiredArtifacts: Object.values(snapshot.evidence).sort(bySeq).slice(-8).flatMap((evidence) => [evidence.source.artifactId]).filter((value): value is string => Boolean(value)),
    prohibitedRepeats: Object.values(snapshot.hypotheses).filter((hypothesis) => hypothesis.status === "REJECTED").map((hypothesis) => hypothesis.statement).slice(-8),
    expectedOutputSchema: "executor-progress-v1",
    status: "PROPOSED",
  };
  return { ...draft, hash: hashHandoff(draft) };
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id.localeCompare(b.id);
}

function bySeq(a: { createdSeq: number }, b: { createdSeq: number }): number {
  return a.createdSeq - b.createdSeq;
}
