import { canonicalJson, sha256 } from "../domain/utils.js";
import type { AblationChangedFactor, HarnessPolicy } from "./ablation.js";

export type AblationDecision = "allow" | "advise" | "block" | "terminate";

export interface AblationPolicyDecisionInput {
  experimentId: string;
  variantId: string;
  caseId: string;
  attempt: number;
  runId: string;
  turn: number;
  requestedAction: string;
  requestedTool?: string;
  firstActionViolation?: boolean;
  phaseRouteViolation?: boolean;
  actionBundleViolation?: boolean;
  duplicateFailure?: boolean;
  circuitBreakerTriggered?: boolean;
  stopSuggested?: boolean;
  /** A safety violation always blocks regardless of the cognitive policy. */
  safetyViolation?: string;
  reasonInputs?: unknown;
  suggestedAlternative?: string;
  subsequentEvidenceIds?: string[];
  subsequentOutcome?: string;
}

export interface AblationDecisionEvent extends Omit<AblationPolicyDecisionInput, "reasonInputs"> {
  schemaVersion: 1;
  decision: AblationDecision;
  policyName: AblationChangedFactor | "safety_boundary" | "none";
  policyMode: string;
  reasonCode: string;
  reasonInputsHash: string;
  modelAcceptedSuggestion?: boolean;
  createdAt: string;
}

/**
 * Applies only experiment-controlled cognitive policies. Resource, scope,
 * effect, lease, generation, cancellation and verifier checks stay outside
 * this class and must continue to run even when every cognitive policy is off.
 */
export class AblationPolicyController {
  private readonly events: AblationDecisionEvent[] = [];

  public constructor(private readonly policy: HarnessPolicy, private readonly clock: () => string = () => new Date().toISOString()) {}

  /** Returns a defensive copy for adapters that project policy into context. */
  public policySnapshot(): HarnessPolicy { return { ...this.policy }; }

  public decide(input: AblationPolicyDecisionInput): AblationDecisionEvent {
    const result = this.evaluate(input);
    const event: AblationDecisionEvent = {
      ...input,
      schemaVersion: 1,
      decision: result.decision,
      policyName: result.policyName,
      policyMode: result.policyMode,
      reasonCode: result.reasonCode,
      reasonInputsHash: sha256(canonicalJson(input.reasonInputs ?? { requestedAction: input.requestedAction, requestedTool: input.requestedTool ?? "" })),
      createdAt: this.clock(),
    };
    delete (event as Partial<AblationPolicyDecisionInput>).reasonInputs;
    this.events.push(event);
    return event;
  }

  public recordOutcome(event: AblationDecisionEvent, accepted: boolean, evidenceIds: string[] = [], outcome?: string): AblationDecisionEvent {
    const index = this.events.indexOf(event);
    const updated: AblationDecisionEvent = { ...event, modelAcceptedSuggestion: accepted, ...(evidenceIds.length === 0 ? {} : { subsequentEvidenceIds: [...evidenceIds].sort() }), ...(outcome === undefined ? {} : { subsequentOutcome: outcome }) };
    if (index >= 0) this.events[index] = updated;
    return updated;
  }

  public eventsSnapshot(): AblationDecisionEvent[] { return this.events.map((event) => ({ ...event, ...(event.subsequentEvidenceIds ? { subsequentEvidenceIds: [...event.subsequentEvidenceIds] } : {}) })); }

  private evaluate(input: AblationPolicyDecisionInput): { decision: AblationDecision; policyName: AblationDecisionEvent["policyName"]; policyMode: string; reasonCode: string } {
    if (input.safetyViolation) return { decision: "block", policyName: "safety_boundary", policyMode: "enforced", reasonCode: input.safetyViolation };
    if (input.circuitBreakerTriggered) {
      if (this.policy.circuitBreaker === "hard_stop") return { decision: "terminate", policyName: "circuit_breaker", policyMode: this.policy.circuitBreaker, reasonCode: "circuit_breaker_triggered" };
      if (this.policy.circuitBreaker === "adaptive" || this.policy.circuitBreaker === "advice") return { decision: "advise", policyName: "circuit_breaker", policyMode: this.policy.circuitBreaker, reasonCode: "circuit_breaker_advice" };
    }
    const checks: Array<{ active: boolean | undefined; mode: string; factor: AblationChangedFactor; hard: string; advice: string; off: string }> = [
      { active: input.firstActionViolation, mode: this.policy.firstAction, factor: "first_action", hard: "first_action_gate", advice: "first_action_advice", off: "first_action_disabled" },
      { active: input.phaseRouteViolation, mode: this.policy.phaseRoute, factor: "phase_route", hard: "phase_route_gate", advice: "phase_route_advice", off: "phase_route_disabled" },
      { active: input.actionBundleViolation, mode: this.policy.actionBundle, factor: "action_bundle", hard: "action_bundle_gate", advice: "action_bundle_advice", off: "action_bundle_disabled" },
      { active: input.duplicateFailure, mode: this.policy.duplicateFailure, factor: "duplicate_failure", hard: "duplicate_failure_stop", advice: "duplicate_failure_advice", off: "duplicate_failure_recorded" },
    ];
    for (const check of checks) if (check.active) {
      if (check.mode === "hard_gate" || check.mode === "hard_stop") return { decision: "block", policyName: check.factor, policyMode: check.mode, reasonCode: check.hard };
      if (check.mode === "soft_advice" || check.mode === "advice") return { decision: "advise", policyName: check.factor, policyMode: check.mode, reasonCode: check.advice };
      return { decision: "allow", policyName: check.factor, policyMode: check.mode, reasonCode: check.off };
    }
    if (input.stopSuggested && this.policy.stopSuggestion !== "off") return { decision: "advise", policyName: "stop_suggestion", policyMode: this.policy.stopSuggestion, reasonCode: "stop_suggestion" };
    return { decision: "allow", policyName: "none", policyMode: "off", reasonCode: "no_policy_intervention" };
  }
}
