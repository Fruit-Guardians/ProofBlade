import type { HarnessEvent, RunSnapshot, TaskContract } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import { createInitialSnapshot, projectionHash, reduce } from "../control/reducer.js";

export interface ProtocolReplayTape {
  schemaVersion: 1;
  kind: "protocol";
  runId: string;
  taskHash: string;
  events: HarnessEvent[];
  projectionHash: string;
  hash: string;
}

export interface ToolReplayRecord {
  toolCallId: string;
  toolName: string;
  callSeq: number;
  resultSeq?: number;
  isError?: boolean;
  artifactIds: string[];
  evidenceIds: string[];
}

export interface ToolReplayTape {
  schemaVersion: 1;
  kind: "tool";
  runId: string;
  records: ToolReplayRecord[];
  hash: string;
}

export interface ReplayStats {
  runCount: number;
  successRate: number;
  providerRequestCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  evidenceCount: number;
  costUsd: number;
  cacheReadTokens: number;
  candidateLeakCount: number;
  projectionHash: string;
}

export interface ReplayComparison {
  schemaVersion: 1;
  mode: "shadow" | "ab" | "ablation";
  sampleSize: number;
  baseline: ReplayStats;
  candidate: ReplayStats;
  delta: {
    successRate: number;
    costUsd: number;
    cacheReadTokens: number;
    toolErrorCount: number;
    candidateLeakCount: number;
  };
  sideEffectFree: true;
  hash: string;
}

/** Capture the exact event sequence required for provider-free protocol replay. */
export function createProtocolReplay(events: readonly HarnessEvent[], snapshot: RunSnapshot): ProtocolReplayTape {
  validateEventStream(events, snapshot.runId);
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "protocol" as const,
    runId: snapshot.runId,
    taskHash: snapshot.taskHash,
    events: events.map((event) => structuredClone(event)),
    projectionHash: projectionHash(snapshot),
  };
  return { ...unsigned, hash: sha256(canonicalJson(unsigned)) };
}

/** Replay a protocol tape without a ControlStore, filesystem, Provider, or Tool. */
export function replayProtocol(tape: ProtocolReplayTape, task: TaskContract): RunSnapshot {
  if (tape.schemaVersion !== 1 || tape.kind !== "protocol") throw new Error("Unsupported protocol replay tape");
  const { hash, ...unsigned } = tape;
  if (sha256(canonicalJson(unsigned)) !== hash) throw new Error("Protocol replay tape hash mismatch");
  validateEventStream(tape.events, tape.runId);
  if (sha256(canonicalJson(task)) !== tape.taskHash) throw new Error("Protocol replay task hash does not match the tape");
  let snapshot = createInitialSnapshot(tape.runId, task);
  for (const event of tape.events) snapshot = reduce(snapshot, event);
  if (projectionHash(snapshot) !== tape.projectionHash) throw new Error("Protocol replay projection hash mismatch");
  return snapshot;
}

/** Capture only Tool call/result pairs for fast Tool Replay and pair validation. */
export function createToolReplay(events: readonly HarnessEvent[]): ToolReplayTape {
  const calls = new Map<string, ToolReplayRecord>();
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const toolCallId = stringValue(event.payload?.toolCallId);
    if (!toolCallId) continue;
    if (event.type === "tool_call_recorded") {
      if (calls.has(toolCallId)) throw new Error(`Tool Replay contains duplicate call: ${toolCallId}`);
      calls.set(toolCallId, {
        toolCallId,
        toolName: stringValue(event.payload?.toolName) ?? "unknown",
        callSeq: event.seq,
        artifactIds: collectIds(event.payload, "artifactId"),
        evidenceIds: collectIds(event.payload, "evidenceId"),
      });
    } else if (event.type === "tool_result_recorded") {
      const record = calls.get(toolCallId);
      if (!record) throw new Error(`Tool Replay result has no call: ${toolCallId}`);
      if (record.resultSeq !== undefined) throw new Error(`Tool Replay contains duplicate result: ${toolCallId}`);
      record.resultSeq = event.seq;
      record.isError = event.payload?.isError === true;
      record.artifactIds = mergeIds(record.artifactIds, collectIds(event.payload, "artifactId"));
      record.evidenceIds = mergeIds(record.evidenceIds, collectIds(event.payload, "evidenceId"));
    }
  }
  const unsigned = { schemaVersion: 1 as const, kind: "tool" as const, runId: events[0]?.runId ?? "", records: [...calls.values()].sort((left, right) => left.callSeq - right.callSeq) };
  return { ...unsigned, hash: sha256(canonicalJson(unsigned)) };
}

export function replayTool(tape: ToolReplayTape): { completed: number; pending: string[]; errors: number; artifactIds: string[]; evidenceIds: string[]; hash: string } {
  if (tape.schemaVersion !== 1 || tape.kind !== "tool") throw new Error("Unsupported Tool Replay tape");
  const { hash: tapeHash, ...unsigned } = tape;
  if (sha256(canonicalJson(unsigned)) !== tapeHash) throw new Error("Tool Replay tape hash mismatch");
  const pending = tape.records.filter((record) => record.resultSeq === undefined).map((record) => record.toolCallId);
  const artifactIds = mergeIds([], tape.records.flatMap((record) => record.artifactIds));
  const evidenceIds = mergeIds([], tape.records.flatMap((record) => record.evidenceIds));
  const result = { completed: tape.records.length - pending.length, pending, errors: tape.records.filter((record) => record.isError === true).length, artifactIds, evidenceIds };
  return { ...result, hash: sha256(canonicalJson(result)) };
}

/** Project an event stream for a side-effect-free shadow or ablation comparison. */
export function replayStats(events: readonly HarnessEvent[], runCount = 1): ReplayStats {
  if (!Number.isInteger(runCount) || runCount < 1 || runCount > 1_000_000) throw new Error("Replay runCount must be an integer from 1 to 1000000");
  const usage = events.filter((event) => event.type === "model_usage");
  const successful = events.filter((event) => event.type === "run_finished" && event.payload?.status === "SUCCEEDED").length;
  const errors = events.filter((event) => event.type === "tool_result_recorded" && event.payload?.isError === true).length;
  const costUsd = usage.reduce((sum, event) => sum + costFromUsage(event.payload?.usage), 0);
  const cacheReadTokens = usage.reduce((sum, event) => sum + number(object(event.payload?.usage).cacheRead), 0);
  const evidenceCount = events.filter((event) => event.type === "evidence_added").length;
  return {
    runCount,
    successRate: rate(successful, Math.max(1, runCount)),
    providerRequestCount: events.filter((event) => event.type === "provider_request_started").length,
    toolCallCount: events.filter((event) => event.type === "tool_call_recorded").length,
    toolErrorCount: errors,
    evidenceCount,
    costUsd: round(costUsd),
    cacheReadTokens,
    candidateLeakCount: countCandidateLeaks(events),
    projectionHash: sha256(canonicalJson(events.map((event) => ({ seq: event.seq, type: event.type, payload: event.payload ?? {} })))),
  };
}

/** Compare two already-recorded projections. No callbacks are executed. */
export function compareReplayStats(baseline: ReplayStats, candidate: ReplayStats, mode: ReplayComparison["mode"] = "shadow"): ReplayComparison {
  const unsigned = {
    schemaVersion: 1 as const,
    mode,
    sampleSize: Math.max(baseline.runCount, candidate.runCount),
    baseline: structuredClone(baseline),
    candidate: structuredClone(candidate),
    delta: {
      successRate: round(candidate.successRate - baseline.successRate),
      costUsd: round(candidate.costUsd - baseline.costUsd),
      cacheReadTokens: candidate.cacheReadTokens - baseline.cacheReadTokens,
      toolErrorCount: candidate.toolErrorCount - baseline.toolErrorCount,
      candidateLeakCount: candidate.candidateLeakCount - baseline.candidateLeakCount,
    },
    sideEffectFree: true as const,
  };
  return { ...unsigned, hash: sha256(canonicalJson(unsigned)) };
}

export function shadowReplay(events: readonly HarnessEvent[], ignoredEventTypes: readonly HarnessEvent["type"][] = []): ReplayStats {
  const ignored = new Set(ignoredEventTypes);
  return replayStats(events.filter((event) => !ignored.has(event.type)));
}

function validateEventStream(events: readonly HarnessEvent[], runId: string): void {
  let expectedSeq = 1;
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.runId !== runId || event.streamId !== runId || event.seq !== expectedSeq) throw new Error("Replay event stream is not contiguous and Run-bound");
    expectedSeq += 1;
  }
}

function collectIds(value: unknown, expectedKey: "artifactId" | "evidenceId"): string[] {
  const found: string[] = [];
  const visit = (current: unknown, key = ""): void => {
    const normalized = key.toLowerCase().replace(/[_-]/g, "");
    const expected = expectedKey.toLowerCase();
    if (typeof current === "string" && (normalized === expected || normalized === `${expected}s`)) found.push(current);
    else if (Array.isArray(current)) current.forEach((item) => visit(item, key));
    else if (current && typeof current === "object") Object.entries(current as Record<string, unknown>).forEach(([childKey, child]) => visit(child, childKey));
  };
  visit(value);
  return mergeIds([], found);
}

function mergeIds(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])].sort();
}

function countCandidateLeaks(events: readonly HarnessEvent[]): number {
  const leakingEvents = new Set<string>();
  const visit = (value: unknown, key = ""): boolean => {
    if (typeof value === "string") {
      if (isReferenceKey(key)) return false;
      return isCandidateField(key) || /\b[A-Za-z][A-Za-z0-9_-]{0,63}\{[^\r\n{}]{1,512}\}/.test(value);
    }
    if (Array.isArray(value)) return value.some((item) => visit(item, key));
    if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).some(([childKey, child]) => visit(child, childKey));
    return false;
  };
  events.forEach((event) => { if (visit(event.payload)) leakingEvents.add(event.id); });
  return leakingEvents.size;
}

function isCandidateField(key: string): boolean {
  return /candidate|flag|answer|secret/i.test(key) && !isReferenceKey(key);
}

function isReferenceKey(key: string): boolean {
  return /(?:hash|id|ids|path|uri|ref|refs|key|token)$/i.test(key);
}

function costFromUsage(value: unknown): number {
  return number(object(value).cost && object(object(value).cost).total);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? round(numerator / denominator) : 0;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}
