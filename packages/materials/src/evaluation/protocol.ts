import type { HarnessEvent } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";

export const EVALUATION_PROTOCOL_VERSION = "proofblade-evaluation-v1";

export interface EvaluationDataset {
  id: string;
  version: string;
  taskIds: string[];
  source: "public" | "business" | "production-failure" | "regression";
  difficulty?: "easy" | "medium" | "hard" | "adversarial";
  contentHash: string;
}

export interface EvaluationEnvironmentState {
  id: string;
  version: string;
  reset: "fixture" | "snapshot" | "container" | "manual";
  stateHash: string;
  permissionsHash?: string;
  clock?: string;
  randomSeed?: string;
}

export interface EvaluationTools {
  catalogHash: string;
  toolIds: string[];
  allowedSideEffects: string[];
  capabilityIds?: string[];
}

export type MechanicalRubricCheck =
  | { type: "run_status"; expected: string }
  | { type: "artifact_exists"; artifactId: string }
  | { type: "artifact_hash"; artifactId: string; sha256: string }
  | { type: "event_exists"; eventType: string }
  | { type: "evidence_backed"; minimum: number };

export interface EvaluationRubric {
  checks: MechanicalRubricCheck[];
  prohibited: string[];
  qualityDimensions?: string[];
  review: "mechanical-only" | "mechanical-plus-human" | "mechanical-plus-llm";
}

export interface EvaluationInteractionProtocol {
  maxSteps: number;
  maxDurationMs: number;
  maxCostUsd: number;
  maxToolCalls?: number;
  termination: "verified" | "terminal" | "budget";
  userSimulator?: { id: string; version: string; behaviorHash: string };
}

/** A provider-independent, replayable description of one evaluation. */
export interface EvaluationProtocol {
  schemaVersion: 1;
  id: string;
  version: string;
  dataset: EvaluationDataset;
  environment: EvaluationEnvironmentState;
  tools: EvaluationTools;
  rubric: EvaluationRubric;
  interaction: EvaluationInteractionProtocol;
  hash: string;
}

export type EvaluationOutcome = "PASS" | "FAIL" | "ERROR";

export interface EvaluationAttempt {
  id: string;
  protocolId: string;
  taskId: string;
  attempt: number;
  outcome: EvaluationOutcome;
  verified: boolean;
  startedAt: string;
  durationMs: number;
  costUsd: number;
  totalTokens?: number;
  evidenceIds: string[];
  traceId?: string;
  failureCategory?: string;
}

export interface EvaluationMetrics {
  k: number;
  taskCount: number;
  sampledTaskCount: number;
  passAtK: number;
  passConsecutiveK: number;
  passAt1: number;
  verifiedSuccessRate: number;
  evidenceBackedSuccessRate: number;
  flakyRate: number;
  averageCostUsd: number;
  p95LatencyMs: number;
}

export interface EvaluationComparison {
  failToPass: number;
  passToPass: number;
  failToPassCount: number;
  passToPassCount: number;
  comparableTaskCount: number;
}

export function createEvaluationProtocol(input: Omit<EvaluationProtocol, "schemaVersion" | "hash">): EvaluationProtocol {
  const unsigned = { ...input, schemaVersion: 1 as const };
  validateEvaluationProtocol({ ...unsigned, hash: sha256(canonicalJson(unsigned)) });
  return { ...unsigned, hash: sha256(canonicalJson(unsigned)) };
}

export function validateEvaluationProtocol(protocol: EvaluationProtocol): void {
  if (protocol.schemaVersion !== 1 || protocol.version !== EVALUATION_PROTOCOL_VERSION) throw new Error("Unsupported evaluation protocol version");
  boundedId(protocol.id, "evaluation protocol id", 128);
  boundedId(protocol.dataset.id, "dataset id", 128);
  boundedId(protocol.dataset.version, "dataset version", 64);
  if (!Number.isInteger(protocol.dataset.taskIds.length) || protocol.dataset.taskIds.length === 0 || protocol.dataset.taskIds.length > 100_000) throw new Error("Evaluation dataset taskIds are invalid");
  protocol.dataset.taskIds.forEach((id) => boundedId(id, "dataset task id", 256));
  if (!/^[a-f0-9]{64}$/i.test(protocol.dataset.contentHash)) throw new Error("Evaluation dataset contentHash must be sha256");
  boundedId(protocol.environment.id, "environment id", 128);
  boundedId(protocol.environment.version, "environment version", 64);
  boundedHash(protocol.environment.stateHash, "environment stateHash");
  if (protocol.environment.permissionsHash !== undefined) boundedHash(protocol.environment.permissionsHash, "environment permissionsHash");
  if (protocol.environment.clock !== undefined) boundedString(protocol.environment.clock, "environment clock", 128);
  if (protocol.environment.randomSeed !== undefined) boundedString(protocol.environment.randomSeed, "environment randomSeed", 256);
  boundedHash(protocol.tools.catalogHash, "tool catalogHash");
  boundedList(protocol.tools.toolIds, "tool ids", 256, 1_000);
  boundedList(protocol.tools.allowedSideEffects, "allowed side effects", 256, 256);
  if (protocol.tools.capabilityIds !== undefined) boundedList(protocol.tools.capabilityIds, "capability ids", 256, 1_000);
  if (protocol.rubric.checks.length > 256) throw new Error("Evaluation rubric has too many checks");
  for (const check of protocol.rubric.checks) validateRubricCheck(check);
  boundedList(protocol.rubric.prohibited, "prohibited rubric items", 1_000, 256);
  if (protocol.rubric.qualityDimensions !== undefined) boundedList(protocol.rubric.qualityDimensions, "quality dimensions", 256, 64);
  if (protocol.interaction.maxSteps < 1 || protocol.interaction.maxSteps > 1_000_000) throw new Error("Evaluation maxSteps is invalid");
  if (protocol.interaction.maxDurationMs < 1 || protocol.interaction.maxDurationMs > 86_400_000) throw new Error("Evaluation maxDurationMs is invalid");
  if (!Number.isFinite(protocol.interaction.maxCostUsd) || protocol.interaction.maxCostUsd < 0 || protocol.interaction.maxCostUsd > 1_000_000) throw new Error("Evaluation maxCostUsd is invalid");
  if (protocol.interaction.maxToolCalls !== undefined && (!Number.isInteger(protocol.interaction.maxToolCalls) || protocol.interaction.maxToolCalls < 0 || protocol.interaction.maxToolCalls > 1_000_000)) throw new Error("Evaluation maxToolCalls is invalid");
  if (protocol.interaction.userSimulator) {
    boundedId(protocol.interaction.userSimulator.id, "user simulator id", 128);
    boundedId(protocol.interaction.userSimulator.version, "user simulator version", 64);
    boundedHash(protocol.interaction.userSimulator.behaviorHash, "user simulator behaviorHash");
  }
  const { hash, ...unsigned } = protocol;
  boundedHash(hash, "evaluation protocol hash");
  if (sha256(canonicalJson(unsigned)) !== hash) throw new Error("Evaluation protocol hash does not match contents");
}

export function summarizeEvaluationAttempts(attempts: readonly EvaluationAttempt[], k = 1): EvaluationMetrics {
  if (!Number.isInteger(k) || k < 1 || k > 100) throw new Error("Evaluation k must be a positive integer up to 100");
  for (const attempt of attempts) validateAttempt(attempt);
  const byTask = groupAttempts(attempts);
  const sampled = [...byTask.values()].filter((items) => items.length >= k);
  const passed = (attempt: EvaluationAttempt): boolean => attempt.outcome === "PASS" && attempt.verified;
  const taskPassAtK = sampled.filter((items) => items.slice(0, k).some(passed)).length;
  const taskPassConsecutiveK = sampled.filter((items) => items.slice(0, k).length === k && items.slice(0, k).every(passed)).length;
  const all = [...byTask.values()].flat();
  const success = all.filter(passed);
  const evidenceBacked = success.filter((attempt) => attempt.evidenceIds.length > 0);
  const flakyTasks = [...byTask.values()].filter((items) => {
    const outcomes = new Set(items.map((item) => passed(item)));
    return outcomes.size > 1;
  }).length;
  const latencies = all.map((attempt) => attempt.durationMs).sort((a, b) => a - b);
  return {
    k,
    taskCount: byTask.size,
    sampledTaskCount: sampled.length,
    passAtK: rate(taskPassAtK, sampled.length),
    passConsecutiveK: rate(taskPassConsecutiveK, sampled.length),
    passAt1: rate([...byTask.values()].filter((items) => passed(items[0]!)).length, byTask.size),
    verifiedSuccessRate: rate(success.length, all.length),
    evidenceBackedSuccessRate: rate(evidenceBacked.length, all.length),
    flakyRate: rate(flakyTasks, byTask.size),
    averageCostUsd: all.length ? round(all.reduce((sum, item) => sum + item.costUsd, 0) / all.length) : 0,
    p95LatencyMs: percentile(latencies, 0.95),
  };
}

export function compareEvaluationAttempts(baseline: readonly EvaluationAttempt[], candidate: readonly EvaluationAttempt[]): EvaluationComparison {
  const baselineByTask = bestOutcomeByTask(baseline);
  const candidateByTask = bestOutcomeByTask(candidate);
  const taskIds = [...baselineByTask.keys()].filter((taskId) => candidateByTask.has(taskId));
  const failToPassCount = taskIds.filter((taskId) => !baselineByTask.get(taskId) && candidateByTask.get(taskId)).length;
  const passToPassCount = taskIds.filter((taskId) => baselineByTask.get(taskId) && candidateByTask.get(taskId)).length;
  return {
    failToPass: rate(failToPassCount, taskIds.filter((taskId) => !baselineByTask.get(taskId)).length),
    passToPass: rate(passToPassCount, taskIds.filter((taskId) => baselineByTask.get(taskId)).length),
    failToPassCount,
    passToPassCount,
    comparableTaskCount: taskIds.length,
  };
}

function validateAttempt(attempt: EvaluationAttempt): void {
  boundedId(attempt.id, "evaluation attempt id", 128);
  boundedId(attempt.protocolId, "attempt protocol id", 128);
  boundedId(attempt.taskId, "attempt task id", 256);
  if (!Number.isInteger(attempt.attempt) || attempt.attempt < 1 || attempt.attempt > 100_000) throw new Error("Evaluation attempt number is invalid");
  if (!Number.isFinite(Date.parse(attempt.startedAt))) throw new Error("Evaluation attempt startedAt is invalid");
  if (!Number.isFinite(attempt.durationMs) || attempt.durationMs < 0 || attempt.durationMs > 86_400_000) throw new Error("Evaluation attempt durationMs is invalid");
  if (!Number.isFinite(attempt.costUsd) || attempt.costUsd < 0) throw new Error("Evaluation attempt costUsd is invalid");
  boundedList(attempt.evidenceIds, "attempt evidence ids", 256, 1_000);
  if (attempt.totalTokens !== undefined && (!Number.isInteger(attempt.totalTokens) || attempt.totalTokens < 0)) throw new Error("Evaluation attempt totalTokens is invalid");
}

function validateRubricCheck(check: MechanicalRubricCheck): void {
  if (check.type === "run_status") boundedString(check.expected, "rubric run status", 128);
  else if (check.type === "artifact_exists" || check.type === "evidence_backed") {
    if (check.type === "artifact_exists") boundedId(check.artifactId, "rubric artifact id", 256);
    else if (!Number.isInteger(check.minimum) || check.minimum < 0 || check.minimum > 100_000) throw new Error("Rubric evidence minimum is invalid");
  } else if (check.type === "artifact_hash") {
    boundedId(check.artifactId, "rubric artifact id", 256);
    boundedHash(check.sha256, "rubric artifact hash");
  } else if (check.type === "event_exists") boundedString(check.eventType, "rubric event type", 128);
  else throw new Error("Unsupported rubric check");
}

function groupAttempts(attempts: readonly EvaluationAttempt[]): Map<string, EvaluationAttempt[]> {
  const groups = new Map<string, EvaluationAttempt[]>();
  for (const attempt of attempts) {
    const group = groups.get(attempt.taskId) ?? [];
    group.push(attempt);
    groups.set(attempt.taskId, group);
  }
  for (const group of groups.values()) group.sort((left, right) => left.attempt - right.attempt || left.id.localeCompare(right.id));
  return groups;
}

function bestOutcomeByTask(attempts: readonly EvaluationAttempt[]): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const attempt of attempts) {
    const passed = attempt.outcome === "PASS" && attempt.verified;
    result.set(attempt.taskId, (result.get(attempt.taskId) ?? false) || passed);
  }
  return result;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? round(numerator / denominator) : 0;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1))]!;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function boundedId(value: string, label: string, max: number): void {
  boundedString(value, label, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new Error(`${label} contains invalid characters`);
}

function boundedString(value: string, label: string, max: number): void {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000\r\n]/.test(value)) throw new Error(`${label} is invalid`);
}

function boundedList(values: readonly string[], label: string, maxItemLength: number, maxItems: number): void {
  if (!Array.isArray(values) || values.length > maxItems || values.some((value) => typeof value !== "string" || value.length === 0 || value.length > maxItemLength || /[\u0000\r\n]/.test(value))) throw new Error(`${label} are invalid`);
}

function boundedHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} must be sha256`);
}
