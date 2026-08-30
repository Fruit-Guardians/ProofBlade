import { canonicalJson, sha256 } from "../domain/utils.js";
import type { UpdateEvaluationGate, UpdateEvaluationMeasurementSample } from "../domain/types.js";

export type UpdateEvaluationSet = "trigger" | "retention" | "migration" | "safety";

export interface EvaluationSetScore {
  datasetId: string;
  total: number;
  passed: number;
  /** Number of cases that regressed compared with the baseline. */
  regressions?: number;
}

export interface UpdateActivationSample {
  eligible: number;
  activated: number;
  followed: number;
}

export interface UpdateEvaluationInput {
  trigger: { baseline: EvaluationSetScore; candidate: EvaluationSetScore };
  retention: { baseline: EvaluationSetScore; candidate: EvaluationSetScore };
  migration: EvaluationSetScore;
  safety: EvaluationSetScore;
  activation?: UpdateActivationSample;
  canonical: {
    candidateHash: string;
    evaluationSets: UpdateEvaluationGate["evaluationSets"];
    protocolHash: string;
    environmentHash: string;
    toolCatalogHash: string;
    corpusHash: string;
    configHash: string;
  };
}

export type UpdateEvaluationGateReport = UpdateEvaluationGate;

export interface UpdateEvaluationGateBinding {
  candidateHash: string;
  evaluationSets: UpdateEvaluationGate["evaluationSets"];
  evaluationHash: string;
  gatePassed?: number;
}

/**
 * Evaluate a change candidate before it can be approved. The trigger set must
 * improve, retention cannot regress, and migration/safety must be complete.
 * The function is pure so a failed proposal can be inspected without mutating
 * the Run or loading a second evaluation database.
 */
export function evaluateUpdateGate(input: UpdateEvaluationInput): UpdateEvaluationGateReport {
  validateInput(input);
  const retentionRegressions = input.retention.candidate.regressions ?? compareRegressions(input.retention.baseline, input.retention.candidate);
  const measurement: UpdateEvaluationGate["measurement"] = {
    trigger: {
      baseline: normalizeScore(input.trigger.baseline),
      candidate: normalizeScore(input.trigger.candidate),
    },
    retention: {
      baseline: normalizeScore(input.retention.baseline),
      candidate: normalizeScore(input.retention.candidate, retentionRegressions),
    },
    migration: normalizeScore(input.migration),
    safety: normalizeScore(input.safety),
    activation: input.activation ? { ...input.activation } : { eligible: 0, activated: 0, followed: 0 },
  };
  const triggerPassRate = rate(measurement.trigger.candidate);
  const retentionPassRate = rate(measurement.retention.candidate);
  const migrationPassRate = rate(measurement.migration);
  const safetyPassRate = rate(measurement.safety);
  const retentionRegressionRate = measurement.retention.candidate.regressions / measurement.retention.candidate.total;
  const checks = {
    trigger: triggerPassRate > rate(measurement.trigger.baseline),
    retention: retentionPassRate >= rate(measurement.retention.baseline) && retentionRegressionRate === 0,
    migration: measurement.migration.passed === measurement.migration.total,
    safety: measurement.safety.passed === measurement.safety.total,
  } satisfies Record<UpdateEvaluationSet, boolean>;
  const reasons: string[] = [];
  if (!checks.trigger) reasons.push("trigger set did not improve over baseline");
  if (!checks.retention) reasons.push("retention set regressed or did not preserve baseline");
  if (!checks.migration) reasons.push("migration set is incomplete");
  if (!checks.safety) reasons.push("safety set is incomplete");
  const activationRate = boundedRate(measurement.activation.activated, measurement.activation.eligible);
  const followingRate = boundedRate(measurement.activation.followed, measurement.activation.activated);
  const unsigned = {
    schemaVersion: 1 as const,
    candidateHash: input.canonical.candidateHash,
    evaluationSets: copyEvaluationSets(input.canonical.evaluationSets),
    canonical: {
      protocolHash: input.canonical.protocolHash,
      environmentHash: input.canonical.environmentHash,
      toolCatalogHash: input.canonical.toolCatalogHash,
      corpusHash: input.canonical.corpusHash,
      configHash: input.canonical.configHash,
    },
    measurement,
    passed: Object.values(checks).every(Boolean),
    checks,
    reasons,
    scores: { triggerPassRate, retentionPassRate, migrationPassRate, safetyPassRate, retentionRegressionRate },
    activationRate,
    followingRate,
  };
  return { ...unsigned, hash: sha256(canonicalJson(unsigned)) };
}

/** Validate a persisted gate independently of the command path that produced it. */
export function validateUpdateEvaluationGate(value: unknown, binding?: UpdateEvaluationGateBinding): asserts value is UpdateEvaluationGate {
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "candidateHash", "evaluationSets", "canonical", "measurement", "passed", "checks", "reasons", "scores", "activationRate", "followingRate", "hash"])) {
    throw new Error("Update evaluation gate shape is invalid");
  }
  const gate = value as unknown as UpdateEvaluationGate;
  if (gate.schemaVersion !== 1 || typeof gate.passed !== "boolean") throw new Error("Update evaluation gate metadata is invalid");
  validateHash(gate.candidateHash, "candidate hash");
  validateHash(gate.hash, "gate hash");
  validateEvaluationSets(gate.evaluationSets);
  validateCanonical(gate.canonical, false);
  validateMeasurement(gate.measurement);
  validateChecks(gate.checks);
  validateReasons(gate.reasons);
  validateScores(gate.scores, gate.activationRate, gate.followingRate);
  if (binding) {
    validateHash(binding.candidateHash, "bound candidate hash");
    validateHash(binding.evaluationHash, "bound evaluation hash");
    validateEvaluationSets(binding.evaluationSets);
    if (gate.hash !== binding.evaluationHash) throw new Error("Update evaluation gate hash does not match evaluationHash");
    if (gate.candidateHash !== binding.candidateHash) throw new Error("Update evaluation gate candidate hash does not match proposal");
    if (canonicalJson(gate.evaluationSets) !== canonicalJson(binding.evaluationSets)) throw new Error("Update evaluation gate evaluation sets do not match proposal");
    if (binding.gatePassed !== undefined && binding.gatePassed !== (gate.passed ? 1 : 0)) throw new Error("Update evaluation gate passed flag does not match gatePassed");
  }

  const unsigned = { ...gate, hash: undefined } as Record<string, unknown>;
  delete unsigned.hash;
  if (sha256(canonicalJson(unsigned)) !== gate.hash) throw new Error("Update evaluation gate hash does not match contents");

  const expected = evaluateUpdateGate({
    trigger: gate.measurement.trigger,
    retention: gate.measurement.retention,
    migration: gate.measurement.migration,
    safety: gate.measurement.safety,
    activation: gate.measurement.activation,
    canonical: {
      candidateHash: gate.candidateHash,
      evaluationSets: gate.evaluationSets,
      ...gate.canonical,
    },
  });
  if (canonicalJson(expected) !== canonicalJson(gate)) throw new Error("Update evaluation gate does not match its measurement");
}

export function metricsForUpdateGate(report: UpdateEvaluationGateReport): NonNullable<{
  triggerPassRate?: number;
  retentionPassRate?: number;
  migrationPassRate?: number;
  safetyPassRate?: number;
  retentionRegressionRate?: number;
  gatePassed?: number;
  activationRate?: number;
  followingRate?: number;
}> {
  return {
    triggerPassRate: report.scores.triggerPassRate,
    retentionPassRate: report.scores.retentionPassRate,
    migrationPassRate: report.scores.migrationPassRate,
    safetyPassRate: report.scores.safetyPassRate,
    retentionRegressionRate: report.scores.retentionRegressionRate,
    gatePassed: report.passed ? 1 : 0,
    activationRate: report.activationRate,
    followingRate: report.followingRate,
  };
}

function validateInput(input: UpdateEvaluationInput): void {
  if (!isRecord(input) || !isRecord(input.trigger) || !isRecord(input.retention)) throw new Error("Update evaluation input is invalid");
  if (!isRecord(input.trigger.baseline)) throw new Error("trigger baseline is required");
  if (!isRecord(input.retention.baseline)) throw new Error("retention baseline is required");
  if (!isRecord(input.canonical)) throw new Error("Update evaluation canonical data is required");
  validateHash(input.canonical.candidateHash, "candidate hash");
  validateEvaluationSets(input.canonical.evaluationSets);
  validateCanonical(input.canonical, true);
  validateScore(input.trigger.candidate, "trigger candidate");
  validateScore(input.trigger.baseline, "trigger baseline");
  validateScore(input.retention.candidate, "retention candidate");
  validateScore(input.retention.baseline, "retention baseline");
  validateScore(input.migration, "migration");
  validateScore(input.safety, "safety");
  for (const [name, score] of [["trigger", input.trigger.candidate], ["retention", input.retention.candidate], ["migration", input.migration], ["safety", input.safety]] as const) {
    if (!input.canonical.evaluationSets[name].includes(score.datasetId)) throw new Error(`${name} candidate datasetId must belong to the canonical evaluation set`);
  }
  if (input.activation) {
    const { eligible, activated, followed } = input.activation;
    if (![eligible, activated, followed].every((value) => Number.isInteger(value) && value >= 0 && value <= 1_000_000) || activated > eligible || followed > activated) {
      throw new Error("Update activation sample is invalid");
    }
  }
}

function validateHash(value: string, label: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) throw new Error(`Evaluation ${label} must be sha256`);
}

function validateScore(score: EvaluationSetScore, label: string): void {
  if (!isRecord(score) || typeof score.datasetId !== "string" || !score.datasetId.trim() || score.datasetId.length > 256) throw new Error(`${label} datasetId is invalid`);
  if (!Number.isInteger(score.total) || score.total < 1 || score.total > 1_000_000) throw new Error(`${label} total is invalid`);
  if (!Number.isInteger(score.passed) || score.passed < 0 || score.passed > score.total) throw new Error(`${label} passed is invalid`);
  if (score.regressions !== undefined && (!Number.isInteger(score.regressions) || score.regressions < 0 || score.regressions > score.total)) throw new Error(`${label} regressions is invalid`);
}

function compareRegressions(baseline: EvaluationSetScore, candidate: EvaluationSetScore): number {
  return Math.max(0, baseline.passed - candidate.passed);
}

function rate(score: Pick<EvaluationSetScore, "passed" | "total">): number {
  return boundedRate(score.passed, score.total);
}

function boundedRate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : 0;
}

function normalizeScore(score: EvaluationSetScore, regressions = score.regressions ?? 0): UpdateEvaluationMeasurementSample {
  return { datasetId: score.datasetId, total: score.total, passed: score.passed, regressions };
}

function copyEvaluationSets(sets: UpdateEvaluationGate["evaluationSets"]): UpdateEvaluationGate["evaluationSets"] {
  return { trigger: [...sets.trigger], retention: [...sets.retention], migration: [...sets.migration], safety: [...sets.safety] };
}

function validateEvaluationSets(value: unknown): asserts value is UpdateEvaluationGate["evaluationSets"] {
  if (!isRecord(value) || !hasOnlyKeys(value, ["trigger", "retention", "migration", "safety"])) throw new Error("Evaluation sets are invalid");
  for (const name of ["trigger", "retention", "migration", "safety"] as const) {
    const values = value[name];
    if (!Array.isArray(values) || values.length === 0 || values.length > 16 || values.some((item) => typeof item !== "string" || !item.trim() || item.length > 256)) throw new Error(`Evaluation set ${name} is invalid`);
  }
}

function validateCanonical(value: unknown, includesBinding: boolean): void {
  if (!isRecord(value)) throw new Error("Update evaluation canonical data is invalid");
  const keys = includesBinding
    ? ["candidateHash", "evaluationSets", "protocolHash", "environmentHash", "toolCatalogHash", "corpusHash", "configHash"]
    : ["protocolHash", "environmentHash", "toolCatalogHash", "corpusHash", "configHash"];
  if (!hasOnlyKeys(value, keys)) throw new Error("Update evaluation canonical data is invalid");
  const canonical = value as Record<string, unknown>;
  for (const name of ["protocolHash", "environmentHash", "toolCatalogHash", "corpusHash", "configHash"] as const) validateHash(canonical[name] as string, name);
}

function validateMeasurement(value: unknown): asserts value is UpdateEvaluationGate["measurement"] {
  if (!isRecord(value) || !hasOnlyKeys(value, ["trigger", "retention", "migration", "safety", "activation"])) throw new Error("Update evaluation gate measurement is invalid");
  for (const name of ["trigger", "retention"] as const) {
    const comparison = value[name];
    if (!isRecord(comparison) || !hasOnlyKeys(comparison, ["baseline", "candidate"])) throw new Error(`Update evaluation gate ${name} measurement is invalid`);
    validatePersistedScore(comparison.baseline, `${name} baseline`);
    validatePersistedScore(comparison.candidate, `${name} candidate`);
  }
  validatePersistedScore(value.migration, "migration");
  validatePersistedScore(value.safety, "safety");
  validateActivation(value.activation);
}

function validatePersistedScore(value: unknown, label: string): asserts value is UpdateEvaluationMeasurementSample {
  if (!isRecord(value) || !hasOnlyKeys(value, ["datasetId", "total", "passed", "regressions"])) throw new Error(`${label} measurement is invalid`);
  validateScore(value as unknown as EvaluationSetScore, label);
  if (!Number.isInteger(value.regressions) || (value.regressions as number) < 0 || (value.regressions as number) > (value.total as number)) throw new Error(`${label} regressions is invalid`);
}

function validateActivation(value: unknown): void {
  if (!isRecord(value) || !hasOnlyKeys(value, ["eligible", "activated", "followed"])) throw new Error("Update activation measurement is invalid");
  const { eligible, activated, followed } = value;
  if (![eligible, activated, followed].every((item) => Number.isInteger(item) && (item as number) >= 0 && (item as number) <= 1_000_000)
    || (activated as number) > (eligible as number) || (followed as number) > (activated as number)) throw new Error("Update activation sample is invalid");
}

function validateChecks(value: unknown): void {
  if (!isRecord(value) || !hasOnlyKeys(value, ["trigger", "retention", "migration", "safety"])
    || Object.values(value).some((item) => typeof item !== "boolean")) throw new Error("Update evaluation gate checks are invalid");
}

function validateReasons(value: unknown): void {
  if (!Array.isArray(value) || value.length > 4 || value.some((reason) => typeof reason !== "string" || !reason || reason.length > 256)) throw new Error("Update evaluation gate reasons are invalid");
}

function validateScores(value: unknown, activationRate: unknown, followingRate: unknown): void {
  if (!isRecord(value) || !hasOnlyKeys(value, ["triggerPassRate", "retentionPassRate", "migrationPassRate", "safetyPassRate", "retentionRegressionRate"])) throw new Error("Update evaluation gate scores are invalid");
  for (const score of [...Object.values(value), activationRate, followingRate]) {
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) throw new Error("Update evaluation gate score is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
