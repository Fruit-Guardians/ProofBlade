import { canonicalJson, sha256 } from "../domain/utils.js";

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
  trigger: { baseline?: EvaluationSetScore; candidate: EvaluationSetScore };
  retention: { baseline?: EvaluationSetScore; candidate: EvaluationSetScore };
  migration: EvaluationSetScore;
  safety: EvaluationSetScore;
  activation?: UpdateActivationSample;
}

export interface UpdateEvaluationGateReport {
  schemaVersion: 1;
  passed: boolean;
  checks: Record<UpdateEvaluationSet, boolean>;
  reasons: string[];
  scores: {
    triggerPassRate: number;
    retentionPassRate: number;
    migrationPassRate: number;
    safetyPassRate: number;
    retentionRegressionRate: number;
  };
  activationRate: number;
  followingRate: number;
  hash: string;
}

/**
 * Evaluate a change candidate before it can be approved. The trigger set must
 * improve, retention cannot regress, and migration/safety must be complete.
 * The function is pure so a failed proposal can be inspected without mutating
 * the Run or loading a second evaluation database.
 */
export function evaluateUpdateGate(input: UpdateEvaluationInput): UpdateEvaluationGateReport {
  validateInput(input);
  const triggerPassRate = rate(input.trigger.candidate);
  const retentionPassRate = rate(input.retention.candidate);
  const migrationPassRate = rate(input.migration);
  const safetyPassRate = rate(input.safety);
  const retentionRegressionRate = input.retention.candidate.total === 0
    ? 0
    : (input.retention.candidate.regressions ?? compareRegressions(input.retention.baseline, input.retention.candidate)) / input.retention.candidate.total;
  const triggerBaselineRate = input.trigger.baseline ? rate(input.trigger.baseline) : 0;
  const checks = {
    trigger: triggerPassRate > triggerBaselineRate,
    retention: retentionPassRate >= (input.retention.baseline ? rate(input.retention.baseline) : 0) && retentionRegressionRate === 0,
    migration: input.migration.passed === input.migration.total,
    safety: input.safety.passed === input.safety.total,
  } satisfies Record<UpdateEvaluationSet, boolean>;
  const reasons: string[] = [];
  if (!checks.trigger) reasons.push("trigger set did not improve over baseline");
  if (!checks.retention) reasons.push("retention set regressed or did not preserve baseline");
  if (!checks.migration) reasons.push("migration set is incomplete");
  if (!checks.safety) reasons.push("safety set is incomplete");
  const activation = input.activation;
  const activationRate = activation ? boundedRate(activation.activated, activation.eligible) : 0;
  const followingRate = activation ? boundedRate(activation.followed, activation.activated) : 0;
  const unsigned = {
    schemaVersion: 1 as const,
    passed: Object.values(checks).every(Boolean),
    checks,
    reasons,
    scores: { triggerPassRate, retentionPassRate, migrationPassRate, safetyPassRate, retentionRegressionRate },
    activationRate,
    followingRate,
  };
  return { ...unsigned, hash: sha256(canonicalJson(unsigned)) };
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
  validateScore(input.trigger.candidate, "trigger candidate");
  if (input.trigger.baseline) validateScore(input.trigger.baseline, "trigger baseline");
  validateScore(input.retention.candidate, "retention candidate");
  if (input.retention.baseline) validateScore(input.retention.baseline, "retention baseline");
  validateScore(input.migration, "migration");
  validateScore(input.safety, "safety");
  if (input.activation) {
    const { eligible, activated, followed } = input.activation;
    if (![eligible, activated, followed].every((value) => Number.isInteger(value) && value >= 0) || activated > eligible || followed > activated) {
      throw new Error("Update activation sample is invalid");
    }
  }
}

function validateScore(score: EvaluationSetScore, label: string): void {
  if (!score.datasetId.trim() || score.datasetId.length > 256) throw new Error(`${label} datasetId is invalid`);
  if (!Number.isInteger(score.total) || score.total < 1 || score.total > 1_000_000) throw new Error(`${label} total is invalid`);
  if (!Number.isInteger(score.passed) || score.passed < 0 || score.passed > score.total) throw new Error(`${label} passed is invalid`);
  if (score.regressions !== undefined && (!Number.isInteger(score.regressions) || score.regressions < 0 || score.regressions > score.total)) throw new Error(`${label} regressions is invalid`);
}

function compareRegressions(baseline: EvaluationSetScore | undefined, candidate: EvaluationSetScore): number {
  if (!baseline) return 0;
  return Math.max(0, baseline.passed - candidate.passed);
}

function rate(score: EvaluationSetScore): number {
  return boundedRate(score.passed, score.total);
}

function boundedRate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : 0;
}
