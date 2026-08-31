import assert from "node:assert/strict";
import test from "node:test";
import { AblationPolicyController, DEFAULT_HARNESS_POLICY } from "../src/index.js";

const base = {
  experimentId: "AB-1", variantId: "baseline", caseId: "case-1", attempt: 1, runId: "run-1", turn: 1,
  requestedAction: "probe", requestedTool: "bash", reasonInputs: { commandHash: "x" },
};

test("records hard cognitive gates and soft advice distinctly", () => {
  const controller = new AblationPolicyController(DEFAULT_HARNESS_POLICY, () => "2026-08-31T00:00:00.000Z");
  const blocked = controller.decide({ ...base, firstActionViolation: true });
  assert.equal(blocked.decision, "block");
  assert.equal(blocked.policyName, "first_action");
  assert.equal(blocked.policyMode, "hard_gate");
  const advised = new AblationPolicyController({ ...DEFAULT_HARNESS_POLICY, firstAction: "soft_advice" }).decide({ ...base, firstActionViolation: true });
  assert.equal(advised.decision, "advise");
  assert.notEqual(advised.decision, "block");
});

test("safety boundary blocks even when cognitive policies are disabled", () => {
  const controller = new AblationPolicyController({ ...DEFAULT_HARNESS_POLICY, firstAction: "off", phaseRoute: "off", duplicateFailure: "record", circuitBreaker: "off" });
  const event = controller.decide({ ...base, firstActionViolation: true, circuitBreakerTriggered: true, safetyViolation: "secret_isolation" });
  assert.deepEqual({ decision: event.decision, policyName: event.policyName, policyMode: event.policyMode }, { decision: "block", policyName: "safety_boundary", policyMode: "enforced" });
});

test("hard circuit breaker terminates and event outcomes can be linked", () => {
  const controller = new AblationPolicyController(DEFAULT_HARNESS_POLICY);
  const event = controller.decide({ ...base, circuitBreakerTriggered: true });
  assert.equal(event.decision, "terminate");
  const updated = controller.recordOutcome(event, false, ["E-2", "E-1"], "blocked");
  assert.deepEqual(updated.subsequentEvidenceIds, ["E-1", "E-2"]);
  assert.equal(controller.eventsSnapshot()[0]?.modelAcceptedSuggestion, false);
  assert.equal(controller.eventsSnapshot()[0]?.subsequentOutcome, "blocked");
});

test("hard violations take precedence over soft advice and disabled breakers remain auditable", () => {
  const controller = new AblationPolicyController({ ...DEFAULT_HARNESS_POLICY, firstAction: "soft_advice" });
  const event = controller.decide({ ...base, firstActionViolation: true, duplicateFailure: true });
  assert.equal(event.decision, "block");
  assert.equal(event.policyName, "duplicate_failure");
  const disabled = new AblationPolicyController({ ...DEFAULT_HARNESS_POLICY, circuitBreaker: "off" }).decide({ ...base, circuitBreakerTriggered: true });
  assert.equal(disabled.decision, "allow");
  assert.equal(disabled.policyName, "circuit_breaker");
  assert.equal(disabled.reasonCode, "circuit_breaker_disabled");
});
