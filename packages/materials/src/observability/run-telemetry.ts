import type { ControlStore } from "../control/control-store.js";
import type { HarnessEvent, PrimaryFailureCategory, RunSnapshot } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";

interface TokenTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

interface CostTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalUsd: number;
}

export interface RunTelemetryReport {
  schemaVersion: 1;
  runId: string;
  status: RunSnapshot["status"];
  phase: RunSnapshot["phase"];
  durationMs: number;
  versionSnapshot: RunSnapshot["versionSnapshot"];
  provider: {
    requestCount: number;
    responseCount: number;
    httpErrorCount: number;
    latencyMs: { total: number; average: number; p95: number };
    tokens: TokenTotals;
    cost: CostTotals;
    contextEfficiency: number;
    cacheHitRate: number;
    toolCallCount: number;
    finishReasons: Record<string, number>;
    byModel: Array<{ provider: string; model: string; requests: number; tokens: number; costUsd: number }>;
  };
  tools: {
    agentCalls: number;
    agentErrors: number;
    effectiveActions: number;
    effectiveActionRatio: number;
    waitMs: number;
    executionMs: number;
    outputBytes: number;
    effects: number;
    effectErrors: number;
    effectTimeouts: number;
    effectUnknown: number;
    effectExecutionMs: number;
    effectOutputBytes: number;
    byTool: Array<{ name: string; calls: number; errors: number; durationMs: number; outputBytes: number }>;
  };
  context: {
    compactions: number;
    checkpoints: number;
    overflowRecoveries: number;
  };
  evidence: {
    count: number;
    firstEvidenceMs?: number;
  };
  failure?: { primary: PrimaryFailureCategory; reason?: string };
  reportHash: string;
}

export class RunTelemetry {
  public constructor(private readonly controlStore: ControlStore) {}

  public async report(runId: string): Promise<RunTelemetryReport> {
    const [snapshot, events] = await Promise.all([this.controlStore.snapshot(runId), this.controlStore.events(runId)]);
    const provider = providerReport(events);
    const tools = toolReport(events, snapshot);
    const startedMs = snapshot.startedAt ? Date.parse(snapshot.startedAt) : Date.parse(events[0]?.ts ?? new Date(0).toISOString());
    const endedMs = snapshot.finishedAt ? Date.parse(snapshot.finishedAt) : Date.parse(events.at(-1)?.ts ?? snapshot.startedAt ?? new Date(0).toISOString());
    const firstEvidence = events.find((event) => event.type === "evidence_added");
    const failureCategory = snapshot.failureCategory ?? inferFailure(snapshot, tools);
    const base = {
      schemaVersion: 1 as const,
      runId,
      status: snapshot.status,
      phase: snapshot.phase,
      durationMs: Math.max(0, endedMs - startedMs),
      versionSnapshot: snapshot.versionSnapshot,
      provider,
      tools,
      context: {
        compactions: events.filter((event) => event.type === "compaction_recorded").length,
        checkpoints: Object.keys(snapshot.checkpoints).length,
        overflowRecoveries: snapshot.contextOverflowRecoveries,
      },
      evidence: {
        count: Object.keys(snapshot.evidence).length,
        ...(firstEvidence ? { firstEvidenceMs: Math.max(0, Date.parse(firstEvidence.ts) - startedMs) } : {}),
      },
      ...(failureCategory ? { failure: { primary: failureCategory, reason: snapshot.terminalReason } } : {}),
    };
    return { ...base, reportHash: sha256(canonicalJson(base)) };
  }
}

function providerReport(events: HarnessEvent[]): RunTelemetryReport["provider"] {
  const starts = events.filter((event) => event.type === "provider_request_started");
  const responses = events.filter((event) => event.type === "provider_response_received");
  const usages = events.filter((event) => event.type === "model_usage");
  const tokens: TokenTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const cost: CostTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalUsd: 0 };
  const latencies: number[] = [];
  const finishReasons: Record<string, number> = {};
  const models = new Map<string, { provider: string; model: string; requests: number; tokens: number; costUsd: number }>();
  let toolCallCount = 0;
  for (const event of usages) {
    const payload = event.payload ?? {};
    const usage = object(payload.usage);
    const usageCost = object(usage.cost);
    tokens.input += number(usage.input);
    tokens.output += number(usage.output);
    tokens.reasoning += number(usage.reasoning);
    tokens.cacheRead += number(usage.cacheRead);
    tokens.cacheWrite += number(usage.cacheWrite);
    tokens.total += number(usage.totalTokens, number(usage.input) + number(usage.output));
    cost.input += number(usageCost.input);
    cost.output += number(usageCost.output);
    cost.cacheRead += number(usageCost.cacheRead);
    cost.cacheWrite += number(usageCost.cacheWrite);
    cost.totalUsd += number(usageCost.total);
    if (typeof payload.durationMs === "number") latencies.push(payload.durationMs);
    toolCallCount += number(payload.toolCallCount);
    const finishReason = String(payload.finishReason ?? "unknown");
    finishReasons[finishReason] = (finishReasons[finishReason] ?? 0) + 1;
    const provider = String(payload.provider ?? "unknown");
    const model = String(payload.model ?? "unknown");
    const key = `${provider}\u0000${model}`;
    const entry = models.get(key) ?? { provider, model, requests: 0, tokens: 0, costUsd: 0 };
    entry.requests += 1;
    entry.tokens += number(usage.totalTokens, number(usage.input) + number(usage.output));
    entry.costUsd += number(usageCost.total);
    models.set(key, entry);
  }
  latencies.sort((a, b) => a - b);
  const inputBasis = tokens.input + tokens.cacheRead;
  return {
    requestCount: Math.max(starts.length, usages.length),
    responseCount: Math.max(responses.length, usages.length),
    httpErrorCount: responses.filter((event) => number(event.payload?.status) >= 400).length,
    latencyMs: { total: sum(latencies), average: latencies.length ? round(sum(latencies) / latencies.length) : 0, p95: percentile(latencies, 0.95) },
    tokens,
    cost,
    contextEfficiency: tokens.input ? round(tokens.output / tokens.input) : 0,
    cacheHitRate: inputBasis ? round(tokens.cacheRead / inputBasis) : 0,
    toolCallCount,
    finishReasons: orderedRecord(finishReasons),
    byModel: [...models.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)),
  };
}

function toolReport(events: HarnessEvent[], snapshot: RunSnapshot): RunTelemetryReport["tools"] {
  const calls = events.filter((event) => event.type === "tool_call_recorded");
  const results = events.filter((event) => event.type === "tool_result_recorded");
  const byTool = new Map<string, { name: string; calls: number; errors: number; durationMs: number; outputBytes: number }>();
  for (const event of calls) {
    const name = String(event.payload?.toolName ?? "unknown");
    const entry = byTool.get(name) ?? { name, calls: 0, errors: 0, durationMs: 0, outputBytes: 0 };
    entry.calls += 1;
    byTool.set(name, entry);
  }
  for (const event of results) {
    const name = String(event.payload?.toolName ?? "unknown");
    const entry = byTool.get(name) ?? { name, calls: 0, errors: 0, durationMs: 0, outputBytes: 0 };
    if (event.payload?.isError === true) entry.errors += 1;
    entry.durationMs += number(event.payload?.durationMs);
    entry.outputBytes += number(event.payload?.outputBytes);
    byTool.set(name, entry);
  }
  const effects = Object.values(snapshot.effects);
  return {
    agentCalls: calls.length,
    agentErrors: results.filter((event) => event.payload?.isError === true).length,
    effectiveActions: results.filter((event) => event.payload?.evidenceAdded === true).length,
    effectiveActionRatio: calls.length ? round(results.filter((event) => event.payload?.evidenceAdded === true).length / calls.length) : 0,
    waitMs: sum(calls.map((event) => number(event.payload?.waitMs))),
    executionMs: sum(results.map((event) => number(event.payload?.durationMs))),
    outputBytes: sum(results.map((event) => number(event.payload?.outputBytes))),
    effects: effects.length,
    effectErrors: effects.filter((effect) => effect.outcome === "error").length,
    effectTimeouts: effects.filter((effect) => effect.outcome === "timeout").length,
    effectUnknown: effects.filter((effect) => effect.outcome === "unknown" || effect.status === "UNKNOWN").length,
    effectExecutionMs: sum(effects.map((effect) => effect.durationMs ?? 0)),
    effectOutputBytes: sum(effects.map((effect) => effect.outputBytes ?? 0)),
    byTool: [...byTool.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function inferFailure(snapshot: RunSnapshot, tools: RunTelemetryReport["tools"]): PrimaryFailureCategory | undefined {
  if (!snapshot.finishedAt || snapshot.status === "SUCCEEDED") return undefined;
  if (tools.effectUnknown > 0) return "effect_outcome_unknown";
  if (tools.effectTimeouts > 0) return "tool_timeout";
  if (snapshot.contextOverflowRecoveries > 0 || /context[_ -]?overflow/i.test(snapshot.terminalReason ?? "")) return "context_overflow";
  if (/budget|deadline|exhaust/i.test(snapshot.terminalReason ?? "")) return "budget_exhausted";
  if (tools.agentCalls === 0 && tools.effects === 0) return "model_no_tool_call";
  if (Object.keys(snapshot.evidence).length === 0) return "wrong_hypothesis";
  if (Object.values(snapshot.completions).some((completion) => completion.status === "REJECTED")) return "verifier_disagreement";
  return "verification_missing";
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1))]!;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function orderedRecord(value: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
