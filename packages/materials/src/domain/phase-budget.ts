import type { ActionBundle, DomainPhase, RunSnapshot, TargetKind } from "./types.js";

export interface PhaseBudgetView {
  domainPhase: DomainPhase;
  actionBundle?: ActionBundle;
  phaseActionsUsed: number;
  phaseActionsRemaining?: number;
  /**
   * What `max_tool_calls` actually caps, and it is NOT the number of tool calls.
   *
   * `max_tool_calls` bounds entries in the Effect Journal
   * (`effects/effect-journal.ts`: "Tool budget exhausted" when
   * `Object.keys(snapshot.effects).length >= max_tool_calls`), and the coding
   * lane's `bash`/`read`/`edit`/`write` plus first-class MCP tools never enter
   * that journal -- see `competition/COMPONENT.md`. So a Run can make dozens of
   * tool calls while this counter says two.
   *
   * These fields used to be named `runToolCallsUsed`/`runToolCallsRemaining`, which
   * is what the prompt and the GUI showed the model. CHAT-1790096643438 read
   * "2 used, 998 remaining" after ten tool calls and correctly reported the budget
   * as untrustworthy; the count was right and the name was wrong. A true tool-call
   * counter needs event-level plumbing (`tool_result_recorded`), which this view
   * does not have -- tracked in
   * `docs/PROOFBLADE_HARNESS_FEEDBACK_UPDATE_PLAN_ZH.md` §P0-1.
   */
  journaledEffectsUsed: number;
  journaledEffectsRemaining: number;
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
  const journaledEffectsUsed = Object.keys(snapshot.effects).length;
  const journaledEffectsRemaining = Math.max(0, snapshot.task.constraints.max_tool_calls - journaledEffectsUsed);
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
    journaledEffectsUsed,
    journaledEffectsRemaining,
    submissionsUsed,
    submissionsRemaining,
    replansUsed,
    replanLimit,
    replansRemaining,
    ...(deadlineRemainingMs === undefined ? {} : { deadlineRemainingMs }),
    exhausted: journaledEffectsRemaining === 0 || submissionsRemaining === 0 || replansRemaining === 0 || phaseActionsRemaining === 0 || deadlineRemainingMs === 0,
  };
}

export function maxReplansFor(targetKind: TargetKind, configured?: number): number {
  if (configured !== undefined) return configured;
  return targetKind === "web" || targetKind === "pwn" ? 2 : 1;
}
