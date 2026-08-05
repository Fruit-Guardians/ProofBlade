import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { planContextMaintenance, type ContextMaintenancePlan } from "@proofblade/molecules";
import { pruneAgentMessages, repairAgentMessages, type AgentContextPruneMode } from "./agent-pruner.js";

export interface ContextMaintenanceInput {
  messages: AgentMessage[];
  availableTokens: number;
  /** Tokens occupied by the compiled L0-L5 context outside the Pi transcript. */
  baseTokens?: number;
  /** Maximum size for the returned transcript after deterministic pruning. */
  messageBudget?: number;
}

export interface ContextMaintenancePreparation {
  messages: AgentMessage[];
  estimatedTokens: number;
  repaired: boolean;
  dropped: ReturnType<typeof pruneAgentMessages>["dropped"];
  plan: ContextMaintenancePlan;
  postPlan: ContextMaintenancePlan;
  nextAction: "none" | "compact";
  checkpointRecommended: boolean;
}

/**
 * Shared, hook-safe context preparation for every Pi lane.
 *
 * The function only repairs and returns a provider view. It never invokes
 * compaction; callers perform the returned action after the current turn is
 * idle, which keeps Pi hook subscribers re-entrant-safe.
 */
export function prepareContextMaintenance(input: ContextMaintenanceInput): ContextMaintenancePreparation {
  const repaired = repairAgentMessages(input.messages);
  const baseTokens = Math.max(0, Math.floor(input.baseTokens ?? 0));
  const plan = planContextMaintenance(baseTokens + repaired.estimatedTokens, input.availableTokens);
  if (!plan.shouldSnip) {
    return {
      messages: repaired.messages,
      estimatedTokens: repaired.estimatedTokens,
      repaired: repaired.dropped.length > 0,
      dropped: repaired.dropped,
      plan,
      postPlan: plan,
      nextAction: "none",
      checkpointRecommended: repaired.dropped.length > 0,
    };
  }
  const mode: AgentContextPruneMode = plan.forceCompact ? "emergency" : plan.shouldPrune ? "prune" : "snip";
  const messageBudget = Math.max(256, Math.floor(input.messageBudget ?? Math.max(256, input.availableTokens - baseTokens)));
  const pruned = pruneAgentMessages(repaired.messages, messageBudget, { mode });
  const postPlan = planContextMaintenance(baseTokens + pruned.estimatedTokens, input.availableTokens);
  return {
    messages: pruned.messages,
    estimatedTokens: pruned.estimatedTokens,
    repaired: repaired.dropped.length > 0,
    dropped: [...repaired.dropped, ...pruned.dropped],
    plan,
    postPlan,
    nextAction: plan.forceCompact || postPlan.shouldCompact ? "compact" : "none",
    checkpointRecommended: repaired.dropped.length > 0 || pruned.dropped.length > 0,
  };
}
