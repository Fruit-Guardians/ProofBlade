import { canonicalJson, sha256 } from "../domain/utils.js";
import type { RunEventEnvelope, WorkItem } from "../domain/types.js";

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

export type AgentControlOperation = "spawn" | "list" | "send_message" | "cancel" | "wait";

export interface AgentControlRequest {
  operation: AgentControlOperation;
  runId: string;
  generation: number;
  workItemId: string;
  correlationId: string;
  sequence: number;
  createdAt: string;
  idempotencyKey?: string;
  payloadHash: string;
}

export interface AgentControlProjection {
  workItemId: string;
  event: RunEventEnvelope;
}

export type AgentControlResult =
  | { status: "unsupported"; enabled: false; operation: AgentControlOperation; failure: AgentCapabilityFailure }
  | { status: "projected"; enabled: true; projection: AgentControlProjection };

/** Future implementations must use the caller's existing Run and WorkItem. */
export interface MultiAgentControlPort {
  spawn(request: AgentControlRequest, workItem: WorkItem): Promise<AgentControlResult>;
  list(request: AgentControlRequest, workItem: WorkItem): Promise<AgentControlResult>;
  sendMessage(request: AgentControlRequest, workItem: WorkItem): Promise<AgentControlResult>;
  cancel(request: AgentControlRequest, workItem: WorkItem): Promise<AgentControlResult>;
  wait(request: AgentControlRequest, workItem: WorkItem): Promise<AgentControlResult>;
}

/** Default port reserves the API without owning a Loop, store, Scope, or agent list. */
export class DisabledMultiAgentControlPort implements MultiAgentControlPort {
  public async spawn(request: AgentControlRequest, workItem: WorkItem): Promise<AgentControlResult> { return disabledControl(request, workItem); }
  public async list(request: AgentControlRequest, workItem: WorkItem): Promise<AgentControlResult> { return disabledControl(request, workItem); }
  public async sendMessage(request: AgentControlRequest, workItem: WorkItem): Promise<AgentControlResult> { return disabledControl(request, workItem); }
  public async cancel(request: AgentControlRequest, workItem: WorkItem): Promise<AgentControlResult> { return disabledControl(request, workItem); }
  public async wait(request: AgentControlRequest, workItem: WorkItem): Promise<AgentControlResult> { return disabledControl(request, workItem); }
}

/** Deterministic mapping required of any later enabled implementation. */
export function projectAgentControlOperation(request: AgentControlRequest, workItem: WorkItem): AgentControlProjection {
  validateAgentControlRequest(request, workItem);
  return {
    workItemId: workItem.id,
    event: {
      id: `agent-event-${sha256(canonicalJson(request)).slice(0, 32)}`,
      runId: request.runId,
      generation: request.generation,
      source: "agent",
      kind: `agent.${request.operation}`,
      priority: request.operation === "cancel" ? "urgent" : "normal",
      status: "queued",
      sequence: request.sequence,
      correlationId: request.correlationId,
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      coalescingKey: request.operation === "send_message" ? `agent-message:${workItem.id}` : `agent-control:${request.operation}:${workItem.id}`,
      operationId: `agent:${request.operation}:${workItem.id}`,
      replayPolicy: request.operation === "spawn" ? "unknown" : "idempotent",
      payloadRef: { eventType: `agent.${request.operation}`, hash: request.payloadHash },
      createdAt: request.createdAt,
    },
  };
}

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

function disabledControl(request: AgentControlRequest, workItem: WorkItem): AgentControlResult {
  validateAgentControlRequest(request, workItem);
  return {
    status: "unsupported",
    enabled: false,
    operation: request.operation,
    failure: {
      code: "MULTI_AGENT_DISABLED",
      strategy: "planner-executor",
      message: `Agent control operation ${request.operation} is reserved but not enabled.`,
      recoverability: "needs_human",
    },
  };
}

function validateAgentControlRequest(request: AgentControlRequest, workItem: WorkItem): void {
  bounded(request.runId, "agent control runId");
  bounded(request.workItemId, "agent control workItemId");
  bounded(request.correlationId, "agent control correlationId");
  if (!(["spawn", "list", "send_message", "cancel", "wait"] as string[]).includes(request.operation)) throw new Error("Agent control operation is invalid");
  if (request.workItemId !== workItem.id || request.runId !== workItem.runId) throw new Error("Agent control request does not match its Run WorkItem");
  if (!Number.isInteger(request.generation) || request.generation < 0 || !Number.isInteger(request.sequence) || request.sequence < 1) throw new Error("Agent control sequence or generation is invalid");
  if (!Number.isFinite(Date.parse(request.createdAt))) throw new Error("Agent control createdAt is invalid");
  if (!/^[a-f0-9]{64}$/i.test(request.payloadHash)) throw new Error("Agent control payloadHash must be sha256");
  if (request.idempotencyKey !== undefined) bounded(request.idempotencyKey, "agent control idempotencyKey");
}

function bounded(value: string, label: string, max = 256): void {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000\r\n]/.test(value)) throw new Error(`${label} is invalid`);
}

function boundedList(values: readonly string[], label: string, maxItems: number, maxItemLength: number): void {
  if (!Array.isArray(values) || values.length > maxItems || values.some((value) => typeof value !== "string" || value.length === 0 || value.length > maxItemLength || /[\u0000\r\n]/.test(value))) throw new Error(`${label} is invalid`);
}
