import { evaluatePhaseGate, phaseBudget, type RunSnapshot } from "@proofblade/materials";
import type { RunControlView } from "./shared.js";

/** Build the bounded, read-only control projection shown by the GUI. */
export function buildRunControlView(snapshot: RunSnapshot): RunControlView {
  const gate = evaluatePhaseGate(snapshot, snapshot.domainPhase);
  const budget = phaseBudget(snapshot);
  const actionBundle = budget.actionBundle;
  const recoveryItems = Object.values(snapshot.verificationRequests)
    .filter((request) => (request.recoveryState ?? "READY") !== "READY")
    .sort((left, right) => left.createdSeq - right.createdSeq || left.id.localeCompare(right.id))
    .slice(0, 16)
    .map((request) => ({
      requestId: request.id,
      kind: request.kind,
      state: request.recoveryState ?? "READY",
      ...(request.recoveryReason ? { reason: request.recoveryReason } : {}),
    }));
  return {
    domainPhase: snapshot.domainPhase,
    gate: { status: gate.status, missing: gate.missing, stale: gate.stale },
    budget: {
      phaseActionsUsed: budget.phaseActionsUsed,
      phaseActionsRemaining: budget.phaseActionsRemaining,
      runToolCallsUsed: budget.runToolCallsUsed,
      runToolCallsRemaining: budget.runToolCallsRemaining,
      submissionsUsed: budget.submissionsUsed,
      submissionsRemaining: budget.submissionsRemaining,
      replansUsed: budget.replansUsed,
      replanLimit: budget.replanLimit,
      replansRemaining: budget.replansRemaining,
    },
    recovery: {
      required: recoveryItems.filter((item) => item.state === "RECOVERY_REQUIRED").length,
      items: recoveryItems,
    },
    ...(actionBundle === undefined ? {} : {
      nextAction: {
        id: actionBundle.id,
        objective: actionBundle.objective,
        toolNames: actionBundle.toolNames,
        maxCalls: actionBundle.maxCalls,
      },
    }),
  };
}
