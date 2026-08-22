import { cacheHitRate as calculateCacheHitRate, compareProviderPrefixShapes, type ProviderPrefixShape } from "@proofblade/molecules";
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
  domainPhase: RunSnapshot["domainPhase"];
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
    cachePrefix: {
      observedRequests: number;
      comparableRequests: number;
      stableRequests: number;
      changedRequests: number;
      stabilityRate: number;
      changeReasons: Record<string, number>;
      last: Pick<ProviderPrefixShape, "prefixHash" | "systemHash" | "toolsHash" | "systemTokens" | "toolSchemaTokens" | "toolCount"> | null;
    };
    toolCallCount: number;
    finishReasons: Record<string, number>;
    byModel: Array<{ provider: string; model: string; requests: number; tokens: number; costUsd: number }>;
    scheduling: { queued: number; cancelled: number; maxQueueDepth: number; waitMs: number; averageWaitMs: number };
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
    automaticObservationCount: number;
    automaticObservationUniqueContentCount: number;
    firstEvidenceMs?: number;
  };
  convergence: {
    experimentCount: number;
    failedExperimentCount: number;
    distinctRepeatKeys: number;
    repeatedFailedActionCount: number;
    foregroundBashTimeouts: number;
    firstCandidateMs?: number;
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
    const firstCandidate = events.find((event) => event.type === "completion_proposed");
    const failureCategory = snapshot.failureCategory ?? inferFailure(snapshot, tools);
    const base = {
      schemaVersion: 1 as const,
      runId,
      status: snapshot.status,
      phase: snapshot.phase,
      domainPhase: snapshot.domainPhase,
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
        ...automaticObservationReport(snapshot),
        ...(firstEvidence ? { firstEvidenceMs: Math.max(0, Date.parse(firstEvidence.ts) - startedMs) } : {}),
      },
      convergence: convergenceReport(snapshot, events, startedMs, firstCandidate),
      ...(failureCategory ? { failure: { primary: failureCategory, reason: snapshot.terminalReason } } : {}),
    };
    return { ...base, reportHash: sha256(canonicalJson(base)) };
  }
}

function automaticObservationReport(snapshot: RunSnapshot): Pick<RunTelemetryReport["evidence"], "automaticObservationCount" | "automaticObservationUniqueContentCount"> {
  const automatic = Object.values(snapshot.observations).filter((item) => item.source.effectId?.startsWith("coding-artifact:")
    || item.source.operation === "read"
    || item.source.operation.startsWith("bash"));
  const contentKeys = new Set(automatic.map((item) => snapshot.artifacts[item.source.artifactId]?.sha256).filter((value): value is string => value !== undefined));
  return {
    automaticObservationCount: automatic.length,
    automaticObservationUniqueContentCount: contentKeys.size,
  };
}

function convergenceReport(snapshot: RunSnapshot, events: HarnessEvent[], startedMs: number, firstCandidate: HarnessEvent | undefined): RunTelemetryReport["convergence"] {
  const experiments = Object.values(snapshot.experiments);
  const failureCounts = new Map<string, number>();
  for (const experiment of experiments) if (experiment.outcome !== "success") failureCounts.set(experiment.repeatKey, (failureCounts.get(experiment.repeatKey) ?? 0) + 1);
  const foregroundBashTimeouts = events.filter((event) => event.type === "tool_result_recorded"
    && event.payload?.toolName === "bash"
    && event.payload?.isError === true
    && /timed out|timeout/i.test(String(event.payload?.errorMessage ?? event.payload?.output ?? ""))).length;
  return {
    experimentCount: experiments.length,
    failedExperimentCount: experiments.filter((item) => item.outcome !== "success").length,
    distinctRepeatKeys: new Set(experiments.map((item) => item.repeatKey)).size,
    repeatedFailedActionCount: [...failureCounts.values()].filter((count) => count >= 2).length,
    foregroundBashTimeouts,
    ...(firstCandidate ? { firstCandidateMs: Math.max(0, Date.parse(firstCandidate.ts) - startedMs) } : {}),
  };
}

function providerReport(events: HarnessEvent[]): RunTelemetryReport["provider"] {
  const starts = events.filter((event) => event.type === "provider_request_started");
  const queued = events.filter((event) => event.type === "provider_request_queued");
  const acquired = events.filter((event) => event.type === "provider_request_slot_acquired");
  const cancelled = events.filter((event) => event.type === "provider_request_queue_cancelled");
  const responses = events.filter((event) => event.type === "provider_response_received");
  const usages = events.filter((event) => event.type === "model_usage" && event.payload?.queueCancelled !== true);
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
  const cacheUsage = { input: tokens.input, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite };
  return {
    requestCount: Math.max(starts.length, usages.length),
    responseCount: Math.max(responses.length, usages.length),
    httpErrorCount: responses.filter((event) => number(event.payload?.status) >= 400).length,
    latencyMs: { total: sum(latencies), average: latencies.length ? round(sum(latencies) / latencies.length) : 0, p95: percentile(latencies, 0.95) },
    tokens,
    cost,
    contextEfficiency: tokens.input ? round(tokens.output / tokens.input) : 0,
    cacheHitRate: round(calculateCacheHitRate(cacheUsage)),
    cachePrefix: providerPrefixReport(usages),
    toolCallCount,
    finishReasons: orderedRecord(finishReasons),
    byModel: [...models.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)),
    scheduling: {
      queued: queued.length,
      cancelled: cancelled.length,
      maxQueueDepth: Math.max(0, ...queued.map((event) => number(event.payload?.queueDepth))),
      waitMs: sum(acquired.map((event) => number(event.payload?.waitMs))),
      averageWaitMs: acquired.length ? round(sum(acquired.map((event) => number(event.payload?.waitMs))) / acquired.length) : 0,
    },
  };
}

function providerPrefixReport(usages: HarnessEvent[]): RunTelemetryReport["provider"]["cachePrefix"] {
  const previousByModel = new Map<string, ProviderPrefixShape>();
  const reasons: Record<string, number> = {};
  let observedRequests = 0;
  let comparableRequests = 0;
  let stableRequests = 0;
  let changedRequests = 0;
  let last: RunTelemetryReport["provider"]["cachePrefix"]["last"] = null;
  for (const event of usages) {
    const payload = event.payload ?? {};
    const shape = providerPrefixShape(payload.cachePrefix);
    if (!shape) continue;
    observedRequests += 1;
    const key = `${String(payload.provider ?? "unknown")}\u0000${String(payload.model ?? "unknown")}`;
    const previous = previousByModel.get(key);
    if (previous) {
      comparableRequests += 1;
      const comparison = compareProviderPrefixShapes(previous, shape);
      if (comparison.changed) {
        changedRequests += 1;
        for (const reason of comparison.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
      } else {
        stableRequests += 1;
      }
    }
    previousByModel.set(key, shape);
    last = {
      prefixHash: shape.prefixHash,
      systemHash: shape.systemHash,
      toolsHash: shape.toolsHash,
      systemTokens: shape.systemTokens,
      toolSchemaTokens: shape.toolSchemaTokens,
      toolCount: shape.toolCount,
    };
  }
  return {
    observedRequests,
    comparableRequests,
    stableRequests,
    changedRequests,
    stabilityRate: comparableRequests > 0 ? round(stableRequests / comparableRequests) : 0,
    changeReasons: orderedRecord(reasons),
    last,
  };
}

function providerPrefixShape(value: unknown): ProviderPrefixShape | undefined {
  const shape = object(value);
  if (shape.version !== 1 || typeof shape.prefixHash !== "string" || typeof shape.systemHash !== "string" || typeof shape.toolsHash !== "string") return undefined;
  return {
    version: 1,
    rewriteVersion: number(shape.rewriteVersion, 1),
    prefixHash: shape.prefixHash,
    systemHash: shape.systemHash,
    toolsHash: shape.toolsHash,
    instructionMessageCount: number(shape.instructionMessageCount),
    toolCount: number(shape.toolCount),
    systemTokens: number(shape.systemTokens),
    toolSchemaTokens: number(shape.toolSchemaTokens),
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
