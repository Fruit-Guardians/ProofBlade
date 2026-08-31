import type { PrimaryFailureCategory } from "./types.js";

/** The action the orchestrator should take after a classified failure. */
export type FailureDisposition = "retry" | "replan" | "stop" | "escalate";

/**
 * A deterministic policy for a durable failure category.  Callers should use
 * this table for control-flow decisions; human-readable reasons stay on the
 * Run snapshot and are never parsed as policy.
 */
export interface FailurePolicy {
  readonly category: PrimaryFailureCategory;
  readonly disposition: FailureDisposition;
  readonly retryable: boolean;
}

const POLICIES: Readonly<Record<PrimaryFailureCategory, FailurePolicy>> = {
  model_no_tool_call: { category: "model_no_tool_call", disposition: "replan", retryable: true },
  bad_tool_args: { category: "bad_tool_args", disposition: "replan", retryable: true },
  tool_timeout: { category: "tool_timeout", disposition: "retry", retryable: true },
  tool_schema_mismatch: { category: "tool_schema_mismatch", disposition: "escalate", retryable: false },
  context_overflow: { category: "context_overflow", disposition: "retry", retryable: true },
  context_amnesia: { category: "context_amnesia", disposition: "replan", retryable: true },
  wrong_hypothesis: { category: "wrong_hypothesis", disposition: "replan", retryable: true },
  verification_missing: { category: "verification_missing", disposition: "replan", retryable: true },
  permission_or_environment: { category: "permission_or_environment", disposition: "escalate", retryable: false },
  provider_error: { category: "provider_error", disposition: "retry", retryable: true },
  budget_exhausted: { category: "budget_exhausted", disposition: "stop", retryable: false },
  effect_outcome_unknown: { category: "effect_outcome_unknown", disposition: "escalate", retryable: false },
  environment_drift: { category: "environment_drift", disposition: "replan", retryable: true },
  prompt_injection_followed: { category: "prompt_injection_followed", disposition: "escalate", retryable: false },
  duplicate_submission: { category: "duplicate_submission", disposition: "stop", retryable: false },
  verifier_disagreement: { category: "verifier_disagreement", disposition: "replan", retryable: true },
};

/** Return the immutable policy for a durable failure category. */
export function failurePolicy(category: PrimaryFailureCategory): FailurePolicy {
  return POLICIES[category];
}

/** Provider-turn guards are recoverable only when their policy requests a replan. */
export function shouldReplanAfterTurnGuard(reason: string): boolean {
  const category = turnGuardFailureCategory(reason);
  return category !== undefined && failurePolicy(category).disposition === "replan";
}

/** Map an in-turn guard to the durable taxonomy used when a Run terminalizes. */
export function turnGuardFailureCategory(reason: string): PrimaryFailureCategory | undefined {
  switch (reason) {
    case "repeated_tool_failure":
      return "bad_tool_args";
    case "no_progress":
    case "tool_failure_storm":
    case "experiment_budget":
      return "wrong_hypothesis";
    case "tool_budget_exhausted":
    case "budget_exhausted":
    case "deadline_exhausted":
      return "budget_exhausted";
    default:
      return undefined;
  }
}
