import type { ActionBundle, DomainPhase, RunSnapshot, TargetKind } from "./types.js";

export interface PhaseBudgetView {
  domainPhase: DomainPhase;
  actionBundle?: ActionBundle;
  phaseActionsUsed: number;
  phaseActionsRemaining?: number;
  runToolCallsUsed: number;
  runToolCallsRemaining: number;
  submissionsUsed: number;
  submissionsRemaining: number;
  replansUsed: number;
  replanLimit: number;
  replansRemaining: number;
  deadlineRemainingMs?: number;
  exhausted: boolean;
}

/**
 * Derive the bounded recovery budget from durable Run state. Callers may pass
 * `now` when they need a wall-clock deadline; all counters remain replayable
 * without it.
 */
export function phaseBudget(snapshot: RunSnapshot, now?: number): PhaseBudgetView {
  const actionBundle = snapshot.toolPreparation?.actionBundles?.find((bundle) => bundle.domainPhase === snapshot.domainPhase);
  const phaseActionsUsed = Object.values(snapshot.experiments).filter((experiment) => experiment.generation === snapshot.generation && experiment.domainPhase === snapshot.domainPhase).length;
  const runToolCallsUsed = Object.keys(snapshot.effects).length;
  const runToolCallsRemaining = Math.max(0, snapshot.task.constraints.max_tool_calls - runToolCallsUsed);
  const submissionsUsed = Object.values(snapshot.effects).filter((effect) => effect.operation === "fixture_score").length;
  const submissionsRemaining = Math.max(0, snapshot.task.constraints.max_submissions - submissionsUsed);
  const replansUsed = snapshot.replanCount ?? Object.keys(snapshot.replans ?? {}).length;
  const replanLimit = maxReplansFor(snapshot.task.target_kind, snapshot.task.constraints.max_replans);
  const replansRemaining = Math.max(0, replanLimit - replansUsed);
  const startedAtMs = snapshot.startedAt ? Date.parse(snapshot.startedAt) : Number.NaN;
  const deadlineRemainingMs = now !== undefined && Number.isFinite(startedAtMs)
    ? Math.max(0, snapshot.task.constraints.deadline_ms - Math.max(0, now - startedAtMs))
    : undefined;
  const phaseActionsRemaining = actionBundle === undefined ? undefined : Math.max(0, actionBundle.maxCalls - phaseActionsUsed);
  return {
    domainPhase: snapshot.domainPhase,
    ...(actionBundle ? { actionBundle: structuredClone(actionBundle) } : {}),
    phaseActionsUsed,
    ...(phaseActionsRemaining === undefined ? {} : { phaseActionsRemaining }),
    runToolCallsUsed,
    runToolCallsRemaining,
    submissionsUsed,
    submissionsRemaining,
    replansUsed,
    replanLimit,
    replansRemaining,
    ...(deadlineRemainingMs === undefined ? {} : { deadlineRemainingMs }),
    // A phase bundle is a recommendation, unlike the run-level resource caps.
    exhausted: runToolCallsRemaining === 0 || submissionsRemaining === 0 || replansRemaining === 0 || deadlineRemainingMs === 0,
  };
}

export function maxReplansFor(targetKind: TargetKind, configured?: number): number {
  if (configured !== undefined) return configured;
  return targetKind === "web" || targetKind === "pwn" ? 2 : 1;
}
