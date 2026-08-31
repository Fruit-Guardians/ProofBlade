import { canonicalJson, sha256 } from "../domain/utils.js";
import type { AblationExperimentSnapshot } from "./ablation.js";

export interface AblationResultRecord {
  pairingId: string;
  variantId: string;
  caseId: string;
  attempt: number;
  success: boolean;
  evidenceBacked: boolean;
  candidateLeaked: boolean;
  providerRequests: number;
  totalTokens: number;
  contextTokens: number;
  costUsd: number;
  durationMs: number;
  /** Non-terminal records are excluded from success and paired denominators. */
  status?: string;
  failureCategory?: string;
}

export interface AblationVariantReport {
  id: string;
  name: string;
  baseline: boolean;
  policyFingerprint: string;
  total: number;
  completed: number;
  successCount: number;
  successRate: number;
  successRateCi95: { low: number; high: number };
  evidenceBackedSuccessRate: number;
  candidateLeakCount: number;
  providerRequests: number;
  totalTokens: number;
  contextTokens: number;
  totalCostUsd: number;
  averageDurationMs: number;
  p95DurationMs: number;
  failureCategories: Record<string, number>;
}

export interface AblationReport {
  schemaVersion: 1;
  reportVersion: "ablation-report-v1";
  experimentId: string;
  experimentFingerprint: string;
  variants: AblationVariantReport[];
  pairedComparisons: Array<{ baselineId: string; variantId: string; bothCompleted: number; baselineOnlySuccess: number; variantOnlySuccess: number; bothSuccess: number; bothFailure: number; successRateDelta: number }>;
  validityWarnings: string[];
  reportHash: string;
}

export function buildAblationReport(experiment: AblationExperimentSnapshot, records: readonly AblationResultRecord[]): AblationReport {
  validateRecords(experiment, records);
  const completedRecords = records.filter(isTerminalRecord);
  const byVariant = new Map(experiment.variants.map((variant) => [variant.id, completedRecords.filter((record) => record.variantId === variant.id)]));
  const variants = experiment.variants.map((variant) => summarizeVariant(variant, byVariant.get(variant.id) ?? []));
  const baseline = experiment.variants.find((variant) => variant.baseline);
  const pairedComparisons = baseline ? experiment.variants.filter((variant) => !variant.baseline).map((variant) => comparePaired(baseline.id, variant.id, completedRecords)) : [];
  const validityWarnings: string[] = [];
  if (completedRecords.some((record) => record.candidateLeaked)) validityWarnings.push("存在候选答案泄漏，不能将成功率作为有效结论");
  if (completedRecords.length !== records.length) validityWarnings.push("存在运行中或未知 Attempt，已从成功率与配对分母排除");
  if (experiment.variants.some((variant) => variant.policySnapshot.multiFactor)) validityWarnings.push("存在组合策略 Variant，不能作为单因素因果证据");
  if (variants.some((variant) => variant.total === 0)) validityWarnings.push("存在尚未完成 Attempt 的 Variant");
  if (new Set(experiment.variants.map((variant) => variant.modelSnapshot.profileFingerprint)).size > 1) validityWarnings.push("Variant 的 Provider/模型快照不一致，可能混入模型因素");
  const base = { schemaVersion: 1 as const, reportVersion: "ablation-report-v1" as const, experimentId: experiment.experimentId, experimentFingerprint: experiment.experimentFingerprint, variants, pairedComparisons, validityWarnings };
  return { ...base, reportHash: sha256(canonicalJson(base)) };
}

function validateRecords(experiment: AblationExperimentSnapshot, records: readonly AblationResultRecord[]): void {
  const variants = new Set(experiment.variants.map((variant) => variant.id));
  const seen = new Set<string>();
  for (const record of records) {
    if (!variants.has(record.variantId)) throw new Error(`Ablation report record has unknown variant: ${record.variantId}`);
    const expected = `${experiment.experimentId}:${record.caseId}:${record.attempt}:${record.variantId}`;
    if (record.pairingId !== expected) throw new Error(`Ablation report record pairing id mismatch: ${record.pairingId}`);
    if (seen.has(record.pairingId)) throw new Error(`Ablation report has duplicate pairing record: ${record.pairingId}`);
    seen.add(record.pairingId);
  }
}

function isTerminalRecord(record: AblationResultRecord): boolean {
  return record.status === undefined || ["SUCCEEDED", "FAILED", "CANCELLED", "succeeded", "failed", "cancelled"].includes(record.status);
}

export function renderAblationReportZh(report: AblationReport): string {
  const lines = [`# 消融实验报告：${report.experimentId}`, `报告哈希：${report.reportHash}`, "", "## Variant 结果", "", "| Variant | Attempt | 已完成 | 已验证成功率 | 95% 区间 | 证据支持成功率 | Token | 费用 USD | P95 耗时 ms | 候选泄漏 |", "| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |"];
  for (const variant of report.variants) lines.push(`| ${variant.name} (${variant.id}) | ${variant.total} | ${variant.completed} | ${(variant.successRate * 100).toFixed(1)}% | ${(variant.successRateCi95.low * 100).toFixed(1)}%-${(variant.successRateCi95.high * 100).toFixed(1)}% | ${(variant.evidenceBackedSuccessRate * 100).toFixed(1)}% | ${variant.totalTokens} | ${variant.totalCostUsd.toFixed(4)} | ${variant.p95DurationMs} | ${variant.candidateLeakCount} |`);
  lines.push("", "## 配对比较", "", "| 基线 | Variant | 配对数 | 基线独有成功 | Variant 独有成功 | 成功率差 |", "| --- | --- | ---: | ---: | ---: | ---: |");
  for (const comparison of report.pairedComparisons) lines.push(`| ${comparison.baselineId} | ${comparison.variantId} | ${comparison.bothCompleted} | ${comparison.baselineOnlySuccess} | ${comparison.variantOnlySuccess} | ${(comparison.successRateDelta * 100).toFixed(1)}% |`);
  lines.push("", "## 有效性警告", "", ...(report.validityWarnings.length > 0 ? report.validityWarnings.map((warning) => `- ${warning}`) : ["- 无"]), "");
  return lines.join("\n");
}

function summarizeVariant(variant: AblationExperimentSnapshot["variants"][number], records: readonly AblationResultRecord[]): AblationVariantReport {
  const completed = records.filter((record) => record.success || record.failureCategory !== "running").length;
  const successCount = records.filter((record) => record.success).length;
  const durations = records.map((record) => record.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
  return { id: variant.id, name: variant.name, baseline: variant.baseline, policyFingerprint: variant.policySnapshot.policyFingerprint, total: records.length, completed, successCount, successRate: rate(successCount, records.length), successRateCi95: wilson(successCount, records.length), evidenceBackedSuccessRate: rate(records.filter((record) => record.success && record.evidenceBacked).length, records.length), candidateLeakCount: records.filter((record) => record.candidateLeaked).length, providerRequests: sum(records.map((record) => record.providerRequests)), totalTokens: sum(records.map((record) => record.totalTokens)), contextTokens: sum(records.map((record) => record.contextTokens)), totalCostUsd: round(sum(records.map((record) => record.costUsd))), averageDurationMs: Math.round(sum(durations) / Math.max(durations.length, 1)), p95DurationMs: Math.round(percentile(durations, .95)), failureCategories: counts(records.flatMap((record) => record.failureCategory && !record.success ? [record.failureCategory] : [])) };
}

function comparePaired(baselineId: string, variantId: string, records: readonly AblationResultRecord[]): AblationReport["pairedComparisons"][number] {
  const baseline = new Map(records.filter((record) => record.variantId === baselineId).map((record) => [`${record.caseId}:${record.attempt}`, record]));
  const candidate = new Map(records.filter((record) => record.variantId === variantId).map((record) => [`${record.caseId}:${record.attempt}`, record]));
  let baselineOnlySuccess = 0; let variantOnlySuccess = 0; let bothSuccess = 0; let bothFailure = 0;
  for (const [key, left] of baseline) { const right = candidate.get(key); if (!right) continue; if (left.success && right.success) bothSuccess += 1; else if (!left.success && !right.success) bothFailure += 1; else if (left.success) baselineOnlySuccess += 1; else variantOnlySuccess += 1; }
  const bothCompleted = bothSuccess + bothFailure + baselineOnlySuccess + variantOnlySuccess;
  return { baselineId, variantId, bothCompleted, baselineOnlySuccess, variantOnlySuccess, bothSuccess, bothFailure, successRateDelta: round(rate(variantOnlySuccess + bothSuccess, bothCompleted) - rate(baselineOnlySuccess + bothSuccess, bothCompleted)) };
}

function wilson(success: number, total: number): { low: number; high: number } { if (total === 0) return { low: 0, high: 0 }; const p = success / total; const z = 1.96; const denominator = 1 + z * z / total; const centre = (p + z * z / (2 * total)) / denominator; const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator; return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) }; }
function percentile(values: readonly number[], p: number): number { if (values.length === 0) return 0; return values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]!; }
function rate(value: number, total: number): number { return total > 0 ? value / total : 0; }
function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }
function round(value: number): number { return Math.round(value * 1e6) / 1e6; }
function counts(values: readonly string[]): Record<string, number> { return Object.fromEntries([...new Set(values)].sort().map((key) => [key, values.filter((value) => value === key).length])); }
