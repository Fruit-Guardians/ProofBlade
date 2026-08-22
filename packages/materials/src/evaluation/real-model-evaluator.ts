import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProofBladeConfig } from "../config.js";
import type { PrimaryFailureCategory, TaskContract } from "../domain/types.js";
import { assertRunId } from "../domain/run-id.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import { createServices, type AppServices } from "../app/demo.js";
import { JsonlControlStore } from "../storage/jsonl-store.js";
import { projectionHash } from "../control/reducer.js";
import { SingleAgentCtfLoop, type AgentLaneFactory } from "../orchestration/single-agent-loop.js";
import { RunTelemetry } from "../observability/run-telemetry.js";
import { loadRealEvaluationCorpus, stageRealEvaluationCase, type LoadedRealEvaluationCase, type RealEvaluationCorpusSnapshot } from "./real-corpus.js";

export const REAL_MODEL_EVALUATION_PROTOCOL_VERSION = "real-model-eval-v2";

export type RealEvaluationFailureCategory = PrimaryFailureCategory | "unclassified";

export interface RealEvaluationVariant {
  id: string;
  config: ProofBladeConfig;
}

export interface RealModelEvaluationOptions {
  corpusPath: string;
  variants: RealEvaluationVariant[];
  allowLive: true;
  attempts?: number;
  maxTurns?: number;
  maxCostUsd?: number;
  deadlineMs?: number;
  runPrefix?: string;
  /** Every Variant must meet this rate for an enforced evaluation gate to pass. Defaults to 0.5. */
  minimumSuccessRate?: number;
  /** Variant used as the success-rate comparison reference. Defaults to the first canonical Variant id. */
  baselineVariantId?: string;
  /** Maximum success-rate regression allowed against the selected baseline. Defaults to 0.1. */
  maxBaselineSuccessRateDrop?: number;
}

export interface RealModelEvaluationGatePolicy {
  minimumSuccessRate: number;
  baselineVariantId: string;
  maxBaselineSuccessRateDrop: number;
}

export interface RealModelEvaluationCase {
  variantId: string;
  corpusCaseId: string;
  runId: string;
  attempt: number;
  status: string;
  phase: string;
  turns: number;
  durationMs: number;
  success: boolean;
  evidenceBacked: boolean;
  replayParity: boolean;
  candidateLeaked: boolean;
  providerRequests: number;
  totalTokens: number;
  costUsd: number;
  effectCount: number;
  effectiveActions: number;
  effectiveActionRatio: number;
  confirmedFacts: number;
  evidenceLinkedFacts: number;
  factEvidenceCoverage: number;
  failureCategory?: RealEvaluationFailureCategory;
  error?: string;
}

export interface RealModelVariantSummary {
  id: string;
  profileFingerprint: string;
  total: number;
  successCount: number;
  successRate: number;
  candidateLeakCount: number;
  metrics: {
    durationMs: { total: number; average: number; p95: number };
    providerRequests: number;
    totalTokens: number;
    totalCostUsd: number;
    costPerSolveUsd: number;
    effects: number;
    effectiveActions: number;
    effectiveActionRatio: number;
    factEvidenceCoverage: number;
  };
  failureCategories: Partial<Record<RealEvaluationFailureCategory, number>>;
  cases: RealModelEvaluationCase[];
}

export interface RealModelEvaluationSummary {
  schemaVersion: 1;
  protocolVersion: typeof REAL_MODEL_EVALUATION_PROTOCOL_VERSION;
  runPrefix: string;
  corpus: RealEvaluationCorpusSnapshot;
  budget: { attempts: number; maxTurns: number; maxCostUsd: number; deadlineMs: number };
  variants: RealModelVariantSummary[];
  comparisons: Array<{ baselineId: string; variantId: string; successRateDelta: number; totalCostUsdDelta: number; p95DurationMsDelta: number }>;
  gate: {
    policy: RealModelEvaluationGatePolicy;
    passed: boolean;
    checks: Array<{ id: string; passed: boolean; actual: number | string; expected: number | string }>;
  };
  reportHash: string;
}

/**
 * Runs real provider-backed Coding lanes only after an explicit caller opt-in.
 * CI should exercise this class with an injected deterministic lane instead.
 */
export class RealModelEvaluationRunner {
  public constructor(private readonly root: string, private readonly createLane?: AgentLaneFactory) {}

  public async run(options: RealModelEvaluationOptions): Promise<RealModelEvaluationSummary> {
    if (options.allowLive !== true) throw new Error("Real model evaluation requires allowLive: true");
    const attempts = positive(options.attempts ?? 3, "attempts");
    const maxTurns = positive(options.maxTurns ?? 12, "maxTurns");
    const deadlineMs = positive(options.deadlineMs ?? 900_000, "deadlineMs");
    const maxCostUsd = positiveDecimal(options.maxCostUsd ?? 5, "maxCostUsd");
    const variants = normalizeVariants(options.variants);
    const gatePolicy = gatePolicyFor(options, variants);
    const corpus = await loadRealEvaluationCorpus(options.corpusPath);
    const runPrefix = options.runPrefix ?? `REAL-EVAL-${Date.now()}`;
    assertRunId(runPrefix);
    const results: RealModelVariantSummary[] = [];
    for (const variant of variants) {
      const profileFingerprint = fingerprint(variant.config);
      const services = createServices(this.root, variant.config);
      const cases: RealModelEvaluationCase[] = [];
      for (const corpusCase of corpus.cases) {
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          const runId = `${runPrefix}-${variant.id}-${corpusCase.id}-a${attempt}`;
          assertRunId(runId);
          await stageRealEvaluationCase(join(this.root, variant.config.storage.fixturesDir), runId, corpus, corpusCase);
          const task = realEvaluationTask(runId, corpusCase, this.root, variant.config, { maxCostUsd, deadlineMs });
          cases.push(await this.runCase(variant.id, corpusCase, attempt, runId, task, variant.config, services, maxTurns));
        }
      }
      results.push(summarizeVariant(variant.id, profileFingerprint, cases));
      await services.sandbox.close();
    }
    const comparisons = compareVariants(results, gatePolicy.baselineVariantId);
    const baseline = results.find((item) => item.id === gatePolicy.baselineVariantId)!;
    const checks = [
      check("minimum_variants", results.length >= 2, results.length, ">=2"),
      check("full_corpus_coverage", results.every((item) => item.total === corpus.cases.length * attempts), results.map((item) => item.total).join(","), corpus.cases.length * attempts),
      check("candidate_leaks", results.every((item) => item.candidateLeakCount === 0), sum(results.map((item) => item.candidateLeakCount)), 0),
      check("case_cost_cap", results.every((item) => item.cases.every((candidate) => candidate.costUsd <= maxCostUsd + 1e-9)), highestCaseCost(results), `<=${maxCostUsd}`),
      ...results.map((item) => check(`minimum_success_rate:${item.id}`, item.successRate >= gatePolicy.minimumSuccessRate, item.successRate, `>=${gatePolicy.minimumSuccessRate}`)),
      ...results
        .filter((item) => item.id !== baseline.id)
        .map((item) => check(
          `baseline_success_rate_drop:${item.id}`,
          item.successRate >= baseline.successRate - gatePolicy.maxBaselineSuccessRateDrop,
          item.successRate,
          `>=${round(baseline.successRate - gatePolicy.maxBaselineSuccessRateDrop)}`,
        )),
    ];
    const base: Omit<RealModelEvaluationSummary, "reportHash"> = {
      schemaVersion: 1,
      protocolVersion: REAL_MODEL_EVALUATION_PROTOCOL_VERSION,
      runPrefix,
      corpus: corpus.snapshot,
      budget: { attempts, maxTurns, maxCostUsd, deadlineMs },
      variants: results,
      comparisons,
      gate: { policy: gatePolicy, passed: checks.every((item) => item.passed), checks },
    };
    return { ...base, reportHash: stableReportHash(base) };
  }

  private async runCase(
    variantId: string,
    corpusCase: LoadedRealEvaluationCase,
    attempt: number,
    runId: string,
    task: TaskContract,
    config: ProofBladeConfig,
    services: AppServices,
    maxTurns: number,
  ): Promise<RealModelEvaluationCase> {
    const started = Date.now();
    let status = "FAILED";
    let phase = "intake";
    let turns = 0;
    let error: string | undefined;
    try {
      const loop = this.createLane
        ? new SingleAgentCtfLoop(this.root, config, services, this.createLane)
        : new SingleAgentCtfLoop(this.root, config, services);
      const outcome = await loop.run({ runId, task, mode: "auto", maxTurns });
      status = outcome.status;
      phase = outcome.phase;
      turns = outcome.turns;
    } catch (caught) {
      error = String(caught);
    }
    let replayParity = false;
    let evidenceBacked = false;
    let candidateLeaked = false;
    let providerRequests = 0;
    let totalTokens = 0;
    let costUsd = 0;
    let effectCount = 0;
    let effectiveActions = 0;
    let effectiveActionRatio = 0;
    let confirmedFacts = 0;
    let evidenceLinkedFacts = 0;
    let factEvidenceCoverage = 0;
    let failureCategory: RealEvaluationFailureCategory | undefined;
    try {
      const snapshot = await services.control.snapshot(runId);
      const replayed = await services.control.replay(runId);
      const persisted = await new JsonlControlStore(services.runsRoot).loadProjection(runId);
      replayParity = Boolean(persisted) && projectionHash(replayed) === projectionHash(persisted!);
      evidenceBacked = snapshot.status === "SUCCEEDED" && Object.values(snapshot.evidence).filter((item) => item.kind === "reproduction").length >= snapshot.task.verification.required_reproductions;
      candidateLeaked = (await readFile(join(services.runsRoot, runId, "events.jsonl"), "utf8")).includes(corpusCase.expected);
      const telemetry = await new RunTelemetry(services.control).report(runId);
      providerRequests = telemetry.provider.requestCount;
      totalTokens = telemetry.provider.tokens.total;
      costUsd = telemetry.provider.cost.totalUsd;
      effectCount = Object.keys(snapshot.effects).length;
      const evidenceEffectIds = new Set(Object.values(snapshot.evidence).flatMap((item) => item.source.effectId ? [item.source.effectId] : []));
      effectiveActions = Object.values(snapshot.effects).filter((effect) => evidenceEffectIds.has(effect.id)).length;
      effectiveActionRatio = rate(effectiveActions, effectCount);
      const facts = Object.values(snapshot.facts).filter((item) => item.status === "CONFIRMED");
      confirmedFacts = facts.length;
      evidenceLinkedFacts = facts.filter((fact) => fact.evidenceIds.length > 0 && fact.evidenceIds.every((evidenceId) => snapshot.evidence[evidenceId] !== undefined)).length;
      factEvidenceCoverage = rate(evidenceLinkedFacts, confirmedFacts);
      failureCategory = telemetry.failure?.primary;
      if (!error) {
        status = snapshot.status;
        phase = snapshot.phase;
      }
    } catch (caught) {
      error = error ?? String(caught);
    }
    const success = status === "SUCCEEDED" && phase === "report" && evidenceBacked && replayParity && !candidateLeaked && !error;
    if (!success && !failureCategory) failureCategory = "unclassified";
    return {
      variantId,
      corpusCaseId: corpusCase.id,
      runId,
      attempt,
      status,
      phase,
      turns,
      durationMs: Date.now() - started,
      success,
      evidenceBacked,
      replayParity,
      candidateLeaked,
      providerRequests,
      totalTokens,
      costUsd,
      effectCount,
      effectiveActions,
      effectiveActionRatio,
      confirmedFacts,
      evidenceLinkedFacts,
      factEvidenceCoverage,
      ...(failureCategory ? { failureCategory } : {}),
      ...(error ? { error } : {}),
    };
  }
}

function realEvaluationTask(runId: string, corpusCase: LoadedRealEvaluationCase, root: string, config: ProofBladeConfig, budget: { maxCostUsd: number; deadlineMs: number }): TaskContract {
  return {
    schema_version: 1,
    task_id: runId,
    mode: "ctf_solve",
    target_kind: corpusCase.targetKind,
    target: `REAL_EVALUATION:${corpusCase.id}`,
    objective: corpusCase.objective,
    inputs: corpusCase.files.map((file) => ({ path: file.path, sha256: file.sha256, read_only: true })),
    success_criteria: [
      "The candidate is supported by an immutable target observation.",
      "The isolated scorer accepts two independent reproduction attempts.",
      "The report references accepted completion and evidence ids.",
    ],
    verification: { kind: "hidden_scorer", required_reproductions: 2 },
    scope: { allowed_hosts: ["LOCAL_EVALUATION_CORPUS"], allowed_ports: [], external_network: false, allowed_workspace: join(root, config.storage.fixturesDir, runId) },
    pause_policy: ["scope_change", "credential_required", "irreversible_external_effect"],
    constraints: { deadline_ms: budget.deadlineMs, max_cost_usd: budget.maxCostUsd, max_tool_calls: 80, max_submissions: 3 },
  };
}

function summarizeVariant(id: string, profileFingerprint: string, cases: RealModelEvaluationCase[]): RealModelVariantSummary {
  const successCount = cases.filter((item) => item.success).length;
  const durations = cases.map((item) => item.durationMs).sort((left, right) => left - right);
  const providerRequests = sum(cases.map((item) => item.providerRequests));
  const totalTokens = sum(cases.map((item) => item.totalTokens));
  const totalCostUsd = sum(cases.map((item) => item.costUsd));
  const effects = sum(cases.map((item) => item.effectCount));
  const effectiveActions = sum(cases.map((item) => item.effectiveActions));
  const totalFacts = sum(cases.map((item) => item.confirmedFacts));
  const evidenceLinkedFacts = sum(cases.map((item) => item.evidenceLinkedFacts));
  return {
    id,
    profileFingerprint,
    total: cases.length,
    successCount,
    successRate: rate(successCount, cases.length),
    candidateLeakCount: cases.filter((item) => item.candidateLeaked).length,
    metrics: {
      durationMs: { total: sum(durations), average: average(durations), p95: percentile(durations, 0.95) },
      providerRequests,
      totalTokens,
      totalCostUsd,
      costPerSolveUsd: successCount === 0 ? 0 : round(totalCostUsd / successCount),
      effects,
      effectiveActions,
      effectiveActionRatio: rate(effectiveActions, effects),
      factEvidenceCoverage: rate(evidenceLinkedFacts, totalFacts),
    },
    failureCategories: orderedCounts(cases.flatMap((item) => item.failureCategory ? [item.failureCategory] : [])),
    cases,
  };
}

function compareVariants(variants: RealModelVariantSummary[], baselineVariantId: string): RealModelEvaluationSummary["comparisons"] {
  const baseline = variants.find((variant) => variant.id === baselineVariantId);
  if (!baseline) return [];
  return variants.filter((variant) => variant.id !== baseline.id).map((variant) => ({
    baselineId: baseline.id,
    variantId: variant.id,
    successRateDelta: round(variant.successRate - baseline.successRate),
    totalCostUsdDelta: round(variant.metrics.totalCostUsd - baseline.metrics.totalCostUsd),
    p95DurationMsDelta: variant.metrics.durationMs.p95 - baseline.metrics.durationMs.p95,
  }));
}

function stableReportHash(summary: Omit<RealModelEvaluationSummary, "reportHash">): string {
  return sha256(canonicalJson({
    schemaVersion: summary.schemaVersion,
    protocolVersion: summary.protocolVersion,
    corpusHash: summary.corpus.hash,
    budget: summary.budget,
    variants: summary.variants.map((variant) => ({
      id: variant.id,
      profileFingerprint: variant.profileFingerprint,
      total: variant.total,
      successCount: variant.successCount,
      candidateLeakCount: variant.candidateLeakCount,
      metrics: {
        providerRequests: variant.metrics.providerRequests,
        totalTokens: variant.metrics.totalTokens,
        totalCostUsd: variant.metrics.totalCostUsd,
        effects: variant.metrics.effects,
        effectiveActions: variant.metrics.effectiveActions,
        effectiveActionRatio: variant.metrics.effectiveActionRatio,
        factEvidenceCoverage: variant.metrics.factEvidenceCoverage,
      },
      failureCategories: variant.failureCategories,
      cases: variant.cases.map(({ runId: _runId, durationMs: _durationMs, error: _error, ...item }) => item),
    })),
    comparisons: summary.comparisons.map(({ p95DurationMsDelta: _p95DurationMsDelta, ...comparison }) => comparison),
    gate: summary.gate,
  }));
}

function normalizeVariants(variants: RealEvaluationVariant[]): RealEvaluationVariant[] {
  if (variants.length < 2) throw new Error("Real model evaluation requires at least two variants");
  const sorted = [...variants].sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set<string>();
  for (const variant of sorted) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(variant.id) || ids.has(variant.id)) throw new Error("Real evaluation variant ids must be unique alphanumeric identifiers");
    if (!hasLiveEvaluationPricing(variant.config)) throw new Error(`Real evaluation variant ${variant.id} requires positive executor pricing`);
    ids.add(variant.id);
  }
  return sorted;
}

function gatePolicyFor(options: RealModelEvaluationOptions, variants: RealEvaluationVariant[]): RealModelEvaluationGatePolicy {
  const minimumSuccessRate = rateThreshold(options.minimumSuccessRate ?? 0.5, "minimumSuccessRate");
  const maxBaselineSuccessRateDrop = rateThreshold(options.maxBaselineSuccessRateDrop ?? 0.1, "maxBaselineSuccessRateDrop");
  const baselineVariantId = options.baselineVariantId ?? variants[0]!.id;
  if (!variants.some((variant) => variant.id === baselineVariantId)) {
    throw new Error(`Real evaluation baseline variant is not configured: ${baselineVariantId}`);
  }
  return { minimumSuccessRate, baselineVariantId, maxBaselineSuccessRateDrop };
}

function fingerprint(config: ProofBladeConfig): string {
  const profile = config.modelProfiles.executor;
  return sha256(canonicalJson({
    provider: profile.provider,
    api: profile.api,
    baseUrl: profile.baseUrl,
    model: profile.model,
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxTokens,
    requestTimeoutMs: profile.requestTimeoutMs,
    maxRetries: profile.maxRetries,
    input: profile.input,
    thinkingLevel: profile.thinkingLevel,
    pricing: profile.pricing,
  }));
}

function hasLiveEvaluationPricing(config: ProofBladeConfig): boolean {
  const pricing = config.modelProfiles.executor.pricing;
  return Boolean(pricing
    && Number.isFinite(pricing.inputUsdPerMillion)
    && pricing.inputUsdPerMillion > 0
    && Number.isFinite(pricing.outputUsdPerMillion)
    && pricing.outputUsdPerMillion > 0
    && Number.isFinite(pricing.cacheReadUsdPerMillion)
    && pricing.cacheReadUsdPerMillion >= 0
    && Number.isFinite(pricing.cacheWriteUsdPerMillion)
    && pricing.cacheWriteUsdPerMillion >= 0);
}

function highestCaseCost(variants: RealModelVariantSummary[]): number {
  return round(Math.max(0, ...variants.flatMap((variant) => variant.cases.map((candidate) => candidate.costUsd))));
}

function positive(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function positiveDecimal(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number`);
  return value;
}

function rateThreshold(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be a finite number from 0 to 1`);
  return value;
}

function check(id: string, passed: boolean, actual: number | string, expected: number | string): RealModelEvaluationSummary["gate"]["checks"][number] {
  return { id, passed, actual, expected };
}

function orderedCounts(values: RealEvaluationFailureCategory[]): Partial<Record<RealEvaluationFailureCategory, number>> {
  const counts: Partial<Record<RealEvaluationFailureCategory, number>> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))) as Partial<Record<RealEvaluationFailureCategory, number>>;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function rate(value: number, total: number): number {
  return total === 0 ? 0 : Number((value / total).toFixed(4));
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : round(sum(values) / values.length);
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1))]!;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}
