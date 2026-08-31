import assert from "node:assert/strict";
import test from "node:test";
import { failurePolicy, shouldReplanAfterTurnGuard, turnGuardFailureCategory } from "../src/domain/failure-policy.js";

test("turn guard policy keeps bounded replans separate from terminal budgets", () => {
  for (const reason of ["repeated_tool_failure", "no_progress", "tool_failure_storm", "experiment_budget"]) {
    assert.equal(shouldReplanAfterTurnGuard(reason), true);
  }
  for (const reason of ["tool_budget_exhausted", "budget_exhausted", "deadline_exhausted", "unknown"]) {
    assert.equal(shouldReplanAfterTurnGuard(reason), false);
  }
});

test("turn guards map to the durable taxonomy used at Run termination", () => {
  assert.equal(turnGuardFailureCategory("repeated_tool_failure"), "bad_tool_args");
  assert.equal(turnGuardFailureCategory("tool_failure_storm"), "wrong_hypothesis");
  assert.equal(turnGuardFailureCategory("deadline_exhausted"), "budget_exhausted");
  assert.equal(turnGuardFailureCategory("unknown"), undefined);
  assert.deepEqual(failurePolicy("effect_outcome_unknown"), {
    category: "effect_outcome_unknown",
    disposition: "escalate",
    retryable: false,
  });
  assert.deepEqual(failurePolicy("provider_error"), {
    category: "provider_error",
    disposition: "retry",
    retryable: true,
  });
});
