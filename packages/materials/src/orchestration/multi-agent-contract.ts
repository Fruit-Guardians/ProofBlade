import { canonicalJson, sha256 } from "../domain/utils.js";

export type AgentStrategy = "single-agent" | "planner-executor" | "parallel-race";

/** Structured handoff data. It deliberately contains references, not thought history. */
export interface AgentHandoff {
  taskId: string;
  workItemId: string;
  goal: string;
  constraints: string[];
  acceptedFacts: string[];
  artifactRefs: string[];
  evidenceRefs: string[];
  remainingBudget: { tokens?: number; timeMs?: number; cost?: number };
  visitedAgents: string[];
  expectedOutput: string;
  generation: number;
}

export interface AgentBudget {
  tokens?: number;
  timeMs?: number;
  cost?: number;
  maxChildren?: number;
}

export interface WinnerSettlement {
  workItemId: string;
  winnerId: string;
  evidenceRefs: string[];
  status: "SETTLED" | "REJECTED";
  settledAt?: string;
  idempotencyKey: string;
}

export interface CancellationAck {
  agentId: string;
  workItemId: string;
  status: "ACKED" | "TIMED_OUT" | "FORCED";
  stoppedAt?: string;
  releasedScope: boolean;
}

export interface AgentCapabilityFailure {
  code: "MULTI_AGENT_DISABLED" | "UNSUPPORTED_STRATEGY" | "BUDGET_EXHAUSTED" | "HANDOFF_INVALID";
  strategy: AgentStrategy;
  message: string;
  recoverability: "recoverable" | "needs_human" | "terminal";
}

export type AgentStrategyDecision =
  | { status: "ready"; strategy: "single-agent"; enabled: true }
  | { status: "unsupported"; strategy: AgentStrategy; enabled: false; failure: AgentCapabilityFailure };

export const DEFAULT_AGENT_STRATEGY = "single-agent" as const;

/**
 * Capability gate for the future orchestration layer. No parallel executor is
 * hidden behind this API; unsupported requests remain explicit failures.
 */
export function selectAgentStrategy(requested: AgentStrategy = DEFAULT_AGENT_STRATEGY): AgentStrategyDecision {
  if (requested === DEFAULT_AGENT_STRATEGY) return { status: "ready", strategy: DEFAULT_AGENT_STRATEGY, enabled: true };
  return {
    status: "unsupported",
    strategy: requested,
    enabled: false,
    failure: {
      code: "MULTI_AGENT_DISABLED",
      strategy: requested,
      message: "Only the single-agent execution path is enabled; multi-agent orchestration is reserved for a later release.",
      recoverability: "needs_human",
    },
  };
}

export function validateAgentHandoff(handoff: AgentHandoff, expectedGeneration?: number): void {
  bounded(handoff.taskId, "handoff taskId");
  bounded(handoff.workItemId, "handoff workItemId");
  bounded(handoff.goal, "handoff goal", 2_000);
  bounded(handoff.expectedOutput, "handoff expectedOutput", 2_000);
  if (!Number.isInteger(handoff.generation) || handoff.generation < 0) throw new Error("Handoff generation is invalid");
  if (expectedGeneration !== undefined && handoff.generation !== expectedGeneration) throw new Error("Handoff generation does not match the current Run");
  boundedList(handoff.constraints, "handoff constraints", 32, 512);
  boundedList(handoff.acceptedFacts, "handoff facts", 128, 256);
  boundedList(handoff.artifactRefs, "handoff artifacts", 256, 256);
  boundedList(handoff.evidenceRefs, "handoff evidence", 256, 256);
  boundedList(handoff.visitedAgents, "handoff visited agents", 128, 16);
  if (new Set(handoff.visitedAgents).size !== handoff.visitedAgents.length) throw new Error("Handoff agent chain contains a cycle");
  for (const [name, value] of Object.entries(handoff.remainingBudget)) {
    if (!["tokens", "timeMs", "cost"].includes(name) || value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error("Handoff budget is invalid");
  }
}

/** Create the deterministic idempotency key expected by a future settlement writer. */
export function winnerSettlementKey(workItemId: string, winnerId: string, evidenceRefs: readonly string[]): string {
  return sha256(canonicalJson({ workItemId, winnerId, evidenceRefs: [...evidenceRefs].sort() }));
}

function bounded(value: string, label: string, max = 256): void {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000\r\n]/.test(value)) throw new Error(`${label} is invalid`);
}

function boundedList(values: readonly string[], label: string, maxItems: number, maxItemLength: number): void {
  if (!Array.isArray(values) || values.length > maxItems || values.some((value) => typeof value !== "string" || value.length === 0 || value.length > maxItemLength || /[\u0000\r\n]/.test(value))) throw new Error(`${label} is invalid`);
}
