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
  /** Earliest model-facing tool in the durable ablation decision stream. */
  firstTool?: string;
  /** Tool calls observed during this attempt, in durable decision order. */
  toolCalls?: string[];
  /** Milliseconds from run start to first immutable Evidence. */
  firstEvidenceMs?: number;
  /** Optional quality score from an independent judge; never drives success. */
  qualityScore?: number;
}

export type AblationEvaluationStage = "smoke" | "exploration" | "confirmation";

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
  stage: AblationEvaluationStage;
  modelSnapshot: { fingerprint: string; provider: string; api: string; model: string; thinkingLevel?: string };
  safetySnapshot: { fingerprint: string; fixed: true };
  variants: AblationVariantReport[];
  metrics: {
    k: number;
    byVariant: Record<string, { passAtK: number; passConsecutiveK: number; bestAtK: number; flakyRate: number }>;
  };
  pairedComparisons: Array<{ baselineId: string; variantId: string; bothCompleted: number; excludedPairs: number; baselineOnlySuccess: number; variantOnlySuccess: number; bothSuccess: number; bothFailure: number; successRateDelta: number }>;
  closure: AblationClosureSummary;
  validityWarnings: string[];
  reportHash: string;
}

export interface AblationClosureSummary {
  completedRecords: number;
  comparableRecords: number;
  excludedRecords: Record<string, number>;
  failureAttribution: Array<{ variantId: string; owner: "provider" | "harness" | "tool" | "environment" | "verifier" | "model" | "unknown"; category: string; count: number }>;
  successfulTrajectories: Array<{ variantId: string; successCount: number; firstTools: Record<string, number>; verifyClaimCalls: number; evidenceCalls: number; averageFirstEvidenceMs?: number }>;
  requiredActions: string[];
}

export function buildAblationReport(experiment: AblationExperimentSnapshot, records: readonly AblationResultRecord[]): AblationReport {
  validateRecords(experiment, records);
  const completedRecords = records.filter(isTerminalRecord);
  const byVariant = new Map(experiment.variants.map((variant) => [variant.id, completedRecords.filter((record) => record.variantId === variant.id)]));
  const variants = experiment.variants.map((variant) => summarizeVariant(variant, byVariant.get(variant.id) ?? []));
  const baseline = experiment.variants.find((variant) => variant.baseline);
  const pairedComparisons = baseline ? experiment.variants.filter((variant) => !variant.baseline).map((variant) => comparePaired(baseline.id, variant.id, records)) : [];
  const validityWarnings: string[] = [];
  if (completedRecords.some((record) => record.candidateLeaked)) validityWarnings.push("存在候选答案泄漏，不能将成功率作为有效结论");
  if (completedRecords.length !== records.length) validityWarnings.push("存在运行中或未知 Attempt，已从成功率与配对分母排除");
  if (experiment.variants.some((variant) => variant.policySnapshot.multiFactor)) validityWarnings.push("存在组合策略 Variant，不能作为单因素因果证据");
  if (variants.some((variant) => variant.total === 0)) validityWarnings.push("存在尚未完成 Attempt 的 Variant");
  if (new Set(experiment.variants.map((variant) => variant.modelSnapshot.profileFingerprint)).size > 1) validityWarnings.push("Variant 的 Provider/模型快照不一致，可能混入模型因素");
  const stage = inferStage(experiment, records);
  const modelSnapshot = { fingerprint: experiment.model.profileFingerprint, provider: experiment.model.provider, api: experiment.model.api, model: experiment.model.model, ...(experiment.model.thinkingLevel === undefined ? {} : { thinkingLevel: experiment.model.thinkingLevel }) };
  const safetySnapshot = { fingerprint: sha256(canonicalJson(experiment.safety)), fixed: true as const };
  const metrics = summarizePassMetrics(experiment, completedRecords);
  const closure = summarizeClosure(records);
  if (stage !== "confirmation") validityWarnings.push(`当前为${stage === "smoke" ? "冒烟" : "探索"}阶段，不能生成部署或发布结论`);
  if (closure.excludedRecords.provider_error) validityWarnings.push("存在 Provider 错误 Attempt，已从可比较策略分母排除，但保留在原始成功率中");
  if (closure.excludedRecords.budget_exhausted) validityWarnings.push("存在预算或 deadline 耗尽 Attempt，需先审计控制平面再解释策略差异");
  const base = { schemaVersion: 1 as const, reportVersion: "ablation-report-v1" as const, experimentId: experiment.experimentId, experimentFingerprint: experiment.experimentFingerprint, stage, modelSnapshot, safetySnapshot, metrics, variants, pairedComparisons, closure, validityWarnings };
  return { ...base, reportHash: sha256(canonicalJson(base)) };
}

function inferStage(experiment: AblationExperimentSnapshot, records: readonly AblationResultRecord[]): AblationEvaluationStage {
  const attemptsPerVariant = Math.max(...experiment.variants.map((variant) => records.filter((record) => record.variantId === variant.id && isTerminalRecord(record)).length), 0);
  const taskCount = new Set(records.map((record) => record.caseId)).size;
  if (taskCount <= 2 && attemptsPerVariant <= 2) return "smoke";
  if (taskCount < 20 || attemptsPerVariant < 3) return "exploration";
  return "confirmation";
}

function summarizePassMetrics(experiment: AblationExperimentSnapshot, records: readonly AblationResultRecord[]): AblationReport["metrics"] {
  const k = Math.max(1, experiment.budget.attempts);
  const passed = (record: AblationResultRecord): boolean => record.success && record.evidenceBacked && !record.candidateLeaked;
  const byVariant = Object.fromEntries(experiment.variants.map((variant) => {
    const byTask = new Map<string, AblationResultRecord[]>();
    for (const record of records.filter((item) => item.variantId === variant.id)) { const list = byTask.get(record.caseId) ?? []; list.push(record); byTask.set(record.caseId, list); }
    const groups = [...byTask.values()].map((items) => items.sort((left, right) => left.attempt - right.attempt));
    const sampled = groups.filter((items) => items.length >= k);
    const passAtK = sampled.length === 0 ? 0 : sampled.filter((items) => items.slice(0, k).some(passed)).length / sampled.length;
    const passConsecutiveK = sampled.length === 0 ? 0 : sampled.filter((items) => items.slice(0, k).every(passed)).length / sampled.length;
    const bestAtK = sampled.length === 0 ? 0 : sampled.filter((items) => items.slice(0, k).some((item) => item.success)).length / sampled.length;
    const flakyRate = groups.length === 0 ? 0 : groups.filter((items) => new Set(items.map(passed)).size > 1).length / groups.length;
    return [variant.id, { passAtK: round(passAtK), passConsecutiveK: round(passConsecutiveK), bestAtK: round(bestAtK), flakyRate: round(flakyRate) }];
  }));
  return { k, byVariant };
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
  const lines = [`# 消融实验报告：${report.experimentId}`, `报告哈希：${report.reportHash}`, `阶段：${report.stage}`, `模型快照：${report.modelSnapshot.provider}/${report.modelSnapshot.model}`, `安全快照：${report.safetySnapshot.fingerprint}`, "", "## Pass 指标", "", "| Variant | Pass@k | Pass^k | Best@k | flaky |", "| --- | ---: | ---: | ---: | ---: |"];
  for (const variant of report.variants) { const metrics = report.metrics.byVariant[variant.id]!; lines.push(`| ${variant.name} (${variant.id}) | ${(metrics.passAtK * 100).toFixed(1)}% | ${(metrics.passConsecutiveK * 100).toFixed(1)}% | ${(metrics.bestAtK * 100).toFixed(1)}% | ${(metrics.flakyRate * 100).toFixed(1)}% |`); }
  lines.push("", "## Variant 结果", "", "| Variant | Attempt | 已完成 | 已验证成功率 | 95% 区间 | 证据支持成功率 | Token | 费用 USD | P95 耗时 ms | 候选泄漏 |", "| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const variant of report.variants) lines.push(`| ${variant.name} (${variant.id}) | ${variant.total} | ${variant.completed} | ${(variant.successRate * 100).toFixed(1)}% | ${(variant.successRateCi95.low * 100).toFixed(1)}%-${(variant.successRateCi95.high * 100).toFixed(1)}% | ${(variant.evidenceBackedSuccessRate * 100).toFixed(1)}% | ${variant.totalTokens} | ${variant.totalCostUsd.toFixed(4)} | ${variant.p95DurationMs} | ${variant.candidateLeakCount} |`);
  lines.push("", "## 配对比较", "", "| 基线 | Variant | 可比较配对 | 排除配对 | 基线独有成功 | Variant 独有成功 | 成功率差 |", "| --- | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const comparison of report.pairedComparisons) lines.push(`| ${comparison.baselineId} | ${comparison.variantId} | ${comparison.bothCompleted} | ${comparison.excludedPairs} | ${comparison.baselineOnlySuccess} | ${comparison.variantOnlySuccess} | ${(comparison.successRateDelta * 100).toFixed(1)}% |`);
  lines.push("", "## 可比较性与首错归因", "", `- 已完成 Attempt：${report.closure.completedRecords}`, `- 可比较策略分母：${report.closure.comparableRecords}`);
  const excluded = Object.entries(report.closure.excludedRecords);
  lines.push(...(excluded.length > 0 ? excluded.map(([reason, count]) => `- 排除 ${reason}：${count}`) : ["- 无污染或不可比较 Attempt"]));
  lines.push("", "| Variant | 首错责任域 | 类别 | 数量 |", "| --- | --- | --- | ---: |");
  lines.push(...(report.closure.failureAttribution.length > 0 ? report.closure.failureAttribution.map((item) => `| ${item.variantId} | ${item.owner} | ${item.category} | ${item.count} |`) : ["| - | - | 无失败首错 | 0 |"]));
  lines.push("", "## 成功轨迹", "", "| Variant | 成功数 | 首工具分布 | verify_claim | evidence | 平均首证据 ms |", "| --- | ---: | --- | ---: | ---: | ---: |");
  lines.push(...report.closure.successfulTrajectories.map((item) => `| ${item.variantId} | ${item.successCount} | ${Object.entries(item.firstTools).map(([tool, count]) => `${tool}:${count}`).join(", ") || "未记录"} | ${item.verifyClaimCalls} | ${item.evidenceCalls} | ${item.averageFirstEvidenceMs ?? 0} |`));
  lines.push("", "## 闭环下一步", "", ...report.closure.requiredActions.map((action) => `- ${action}`));
  lines.push("", "## 有效性警告", "", ...(report.validityWarnings.length > 0 ? report.validityWarnings.map((warning) => `- ${warning}`) : ["- 无"]), "");
  return lines.join("\n");
}

function summarizeClosure(records: readonly AblationResultRecord[]): AblationClosureSummary {
  const excluded = records.flatMap((record) => {
    const reason = exclusionReason(record);
    return reason ? [reason] : [];
  });
  const comparable = records.filter((record) => !exclusionReason(record));
  const failureAttribution = countsBy(records.filter((record) => isTerminalRecord(record) && !record.success && record.failureCategory), (record) => `${record.variantId}\u0000${failureOwner(record.failureCategory!)}\u0000${record.failureCategory!}`)
    .map(([key, count]) => {
      const [variantId, owner, category] = key.split("\u0000");
      return { variantId: variantId!, owner: owner as AblationClosureSummary["failureAttribution"][number]["owner"], category: category!, count };
    });
  const successfulTrajectories = [...new Set(records.map((record) => record.variantId))].sort().map((variantId) => {
    const successful = records.filter((record) => record.variantId === variantId && record.success && record.evidenceBacked && !exclusionReason(record));
    const firstEvidence = successful.flatMap((record) => record.firstEvidenceMs === undefined ? [] : [record.firstEvidenceMs]);
    return {
      variantId,
      successCount: successful.length,
      firstTools: counts(successful.flatMap((record) => record.firstTool ? [record.firstTool] : [])),
      verifyClaimCalls: sum(successful.map((record) => record.toolCalls?.filter((tool) => tool === "verify_claim").length ?? 0)),
      evidenceCalls: sum(successful.map((record) => record.toolCalls?.filter((tool) => tool === "evidence").length ?? 0)),
      ...(firstEvidence.length > 0 ? { averageFirstEvidenceMs: Math.round(sum(firstEvidence) / firstEvidence.length) } : {}),
    };
  });
  const actions = new Set<string>();
  if (excluded.includes("provider_error")) actions.add("Provider 错误已从可比较分母排除；在相同模型快照下复测受污染 pairing，或切换到已预检的稳定窗口。");
  if (excluded.includes("budget_exhausted")) actions.add("先审计 deadline、Provider 预算预留和工具清理；预算耗尽前不得把策略差异写作模型能力差异。");
  if (excluded.includes("candidate_leak")) actions.add("候选泄漏使本批结论失效；修复语料或日志隔离后创建新的不可变实验快照。");
  if (failureAttribution.some((item) => item.owner === "tool")) actions.add("工具/Schema 首错需要先修复并增加回归，再重跑同一 pairing。");
  if (failureAttribution.some((item) => item.owner === "verifier")) actions.add("Verifier 拒绝需要检查候选推导与 Evidence 来源闭包，不应修改安全边界来提高通过率。");
  if (actions.size === 0) actions.add("比较成功轨迹的首工具、verify_claim、Evidence 和首证据时间；样本不足时仅保留机制结论并扩展分层语料。");
  return { completedRecords: records.filter(isTerminalRecord).length, comparableRecords: comparable.length, excludedRecords: counts(excluded), failureAttribution, successfulTrajectories, requiredActions: [...actions] };
}

function exclusionReason(record: AblationResultRecord): string | undefined {
  if (record.candidateLeaked) return "candidate_leak";
  if (!isTerminalRecord(record)) return "incomplete";
  if (record.failureCategory === "provider_error") return "provider_error";
  if (record.failureCategory === "budget_exhausted") return "budget_exhausted";
  if (record.failureCategory === "effect_outcome_unknown") return "environment_unknown";
  return undefined;
}

function failureOwner(category: string): AblationClosureSummary["failureAttribution"][number]["owner"] {
  if (/provider/i.test(category)) return "provider";
  if (/budget|context_overflow/i.test(category)) return "harness";
  if (/tool|schema/i.test(category)) return "tool";
  if (/environment|effect_outcome_unknown/i.test(category)) return "environment";
  if (/verif/i.test(category)) return "verifier";
  if (/model|hypothesis/i.test(category)) return "model";
  return "unknown";
}

function countsBy<T>(values: readonly T[], key: (value: T) => string): Array<[string, number]> {
  const result = new Map<string, number>();
  for (const value of values) result.set(key(value), (result.get(key(value)) ?? 0) + 1);
  return [...result.entries()].sort(([left], [right]) => left.localeCompare(right));
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
  let excludedPairs = 0;
  for (const [key, left] of baseline) {
    const right = candidate.get(key);
    if (!right) continue;
    if (exclusionReason(left) || exclusionReason(right)) { excludedPairs += 1; continue; }
    if (left.success && right.success) bothSuccess += 1;
    else if (!left.success && !right.success) bothFailure += 1;
    else if (left.success) baselineOnlySuccess += 1;
    else variantOnlySuccess += 1;
  }
  const bothCompleted = bothSuccess + bothFailure + baselineOnlySuccess + variantOnlySuccess;
  return { baselineId, variantId, bothCompleted, excludedPairs, baselineOnlySuccess, variantOnlySuccess, bothSuccess, bothFailure, successRateDelta: round(rate(variantOnlySuccess + bothSuccess, bothCompleted) - rate(baselineOnlySuccess + bothSuccess, bothCompleted)) };
}

function wilson(success: number, total: number): { low: number; high: number } { if (total === 0) return { low: 0, high: 0 }; const p = success / total; const z = 1.96; const denominator = 1 + z * z / total; const centre = (p + z * z / (2 * total)) / denominator; const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator; return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) }; }
function percentile(values: readonly number[], p: number): number { if (values.length === 0) return 0; return values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]!; }
function rate(value: number, total: number): number { return total > 0 ? value / total : 0; }
function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }
function round(value: number): number { return Math.round(value * 1e6) / 1e6; }
function counts(values: readonly string[]): Record<string, number> { return Object.fromEntries([...new Set(values)].sort().map((key) => [key, values.filter((value) => value === key).length])); }
