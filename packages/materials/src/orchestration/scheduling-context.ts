import type { SchedulingContext } from "../domain/intent.js";
import type { RunSnapshot } from "../domain/types.js";

export function buildSchedulingContext(snapshot: RunSnapshot): SchedulingContext {
  const intents = Object.values(snapshot.schedulerIntents ?? {});
  const currentGeneration = snapshot.generation;
  const currentIntents = intents.filter(intent => intent.fixtureGeneration === currentGeneration);

  return {
    runId: snapshot.runId,
    phase: snapshot.phase,
    knowledgeVersion: Math.max(
      0,
      ...Object.values(snapshot.facts ?? {}).map(item => item.createdSeq),
      ...Object.values(snapshot.hypotheses ?? {}).map(item => item.createdSeq),
      ...Object.values(snapshot.evidence ?? {}).map(item => item.createdSeq),
      ...Object.values(snapshot.observations ?? {}).map(item => item.createdSeq),
    ),
    currentGeneration,
    facts: Object.keys(snapshot.facts ?? {}),
    hypotheses: Object.keys(snapshot.hypotheses ?? {}),
    evidence: Object.keys(snapshot.evidence ?? {}),
    openIntents: currentIntents.filter(intent => intent.status === "PROPOSED" || intent.status === "CLAIMED").length,
    hasIntentHistory: currentIntents.length > 0,
    newHighValueFacts: 0,
    consecutiveFailures: 0,
    phaseBudgetUsed: 0.5,
    newHints: [],
    verifierRejected: Object.values(snapshot.completions ?? {}).some(completion => completion.status === "REJECTED"),
    remainingBudget: {
      tokens: 100_000,
      costUsd: snapshot.task?.constraints?.max_cost_usd || 10,
      timeMs: snapshot.task?.constraints?.deadline_ms ?? 600_000,
    },
    occupiedResources: Object.keys(snapshot.leases ?? {}),
    completedIntentIds: new Set(currentIntents.filter(intent => intent.status === "COMPLETED").map(intent => intent.id)),
    completedHypothesisIds: new Set(currentIntents
      .filter(intent => intent.status === "COMPLETED" && intent.hypothesis)
      .map(intent => intent.hypothesis!)),
    refutedHypotheses: new Set(Object.values(snapshot.evidence ?? {})
      .filter(evidence => evidence.source.generation === currentGeneration)
      .flatMap(evidence => evidence.refutes ?? [])),
  };
}
