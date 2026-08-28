import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProofBladeConfig } from "../config.js";
import type { HarnessEvent, PrimaryFailureCategory, TargetKind, TaskContract } from "../domain/types.js";
import { assertRunId } from "../domain/run-id.js";
import { canonicalJson, isTerminal, sha256 } from "../domain/utils.js";
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
  /** Require every evaluated Variant to produce real Provider telemetry. */
  requireProviderTraffic?: boolean;
  /** Minimum corpus size for a strict live evaluation; defaults to 20 when traffic is required. */
  minimumCorpusCases?: number;
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
  /** Target kinds that must occur in the corpus when a strict live gate is used. */
  requiredTargetKinds?: readonly TargetKind[];
  /** Reject corpora whose target files contain the expected answer literally. */
  requireAnswerLiteralsAbsent?: boolean;
}

export interface RealModelEvaluationGatePolicy {
  minimumSuccessRate: number;
  baselineVariantId: string;
  maxBaselineSuccessRateDrop: number;
  requireProviderTraffic: boolean;
  minimumCorpusCases: number;
  requiredTargetKinds: TargetKind[];
}

export interface RealModelEvaluationPreflightOptions {
  corpusPath: string;
  variants: RealEvaluationVariant[];
  requireProviderTraffic?: boolean;
  minimumCorpusCases?: number;
  requiredTargetKinds?: readonly TargetKind[];
  attempts?: number;
  maxTurns?: number;
  maxCostUsd?: number;
  deadlineMs?: number;
  /** Reject corpora whose target files contain the expected answer literally. */
  requireAnswerLiteralsAbsent?: boolean;
}

export interface RealModelEvaluationPreflightSummary {
  schemaVersion: 1;
  corpus: {
    id: string;
    hash: string;
    total: number;
    targetKinds: Record<string, number>;
  };
  variants: Array<{
    id: string;
    provider: string;
    api: string;
    model: string;
    apiKeyEnv: string;
    credentialPresent: boolean;
    pricingPresent: boolean;
    profileFingerprint: string;
  }>;
  budget: { attempts: number; maxTurns: number; maxCostUsd: number; deadlineMs: number };
  checks: Array<{ id: string; passed: boolean; actual: number | string; expected: number | string }>;
  ready: boolean;
}

/**
 * Validate a live evaluation setup without creating a Run or contacting a
 * Provider.  The report exposes only credential environment variable names and
 * presence, never credential values.
 */
export async function preflightRealModelEvaluation(options: RealModelEvaluationPreflightOptions): Promise<RealModelEvaluationPreflightSummary> {
  const attempts = positive(options.attempts ?? 3, "attempts");
  const maxTurns = positive(options.maxTurns ?? 12, "maxTurns");
  const deadlineMs = positive(options.deadlineMs ?? 900_000, "deadlineMs");
  const maxCostUsd = positiveDecimal(options.maxCostUsd ?? 5, "maxCostUsd");
  const variants = normalizeVariants(options.variants);
  const corpus = await loadRealEvaluationCorpus(options.corpusPath);
  const minimumCorpusCases = nonNegativeInteger(options.minimumCorpusCases ?? (options.requireProviderTraffic === true ? 20 : 0), "minimumCorpusCases");
  const requiredTargetKinds = normalizeRequiredTargetKinds(options.requiredTargetKinds ?? (options.requireProviderTraffic === true ? ["web", "pwn"] : []));
  const requireAnswerLiteralsAbsent = options.requireAnswerLiteralsAbsent ?? options.requireProviderTraffic === true;
  const targetKinds = orderedCounts(corpus.cases.map((item) => item.targetKind)) as Record<string, number>;
  const answerLiteralLeakCount = requireAnswerLiteralsAbsent ? await countAnswerLiteralLeaks(corpus.cases) : 0;
  const distinctProfiles = new Set(variants.map((variant) => fingerprint(variant.config))).size;
  const checks = [
    check("minimum_variants", variants.length >= 2, variants.length, ">=2"),
    check("distinct_profile_variants", distinctProfiles >= 2, distinctProfiles, ">=2"),
    ...(minimumCorpusCases > 0 ? [check("minimum_corpus_cases", corpus.cases.length >= minimumCorpusCases, corpus.cases.length, `>=${minimumCorpusCases}`)] : []),
    ...requiredTargetKinds.map((targetKind) => check(`target_kind_coverage:${targetKind}`, targetKinds[targetKind] !== undefined, targetKinds[targetKind] ?? 0, ">=1")),
    ...(requireAnswerLiteralsAbsent ? [check("answer_literals_absent", answerLiteralLeakCount === 0, answerLiteralLeakCount, 0)] : []),
    ...variants.map((variant) => {
      const profile = variant.config.modelProfiles.executor;
      const envName = profile.apiKeyEnv.trim();
      const credentialPresent = envName.length > 0 && Boolean(process.env[envName]?.trim());
      return check(`credential:${variant.id}`, credentialPresent, credentialPresent ? "present" : "missing", "present");
    }),
    ...variants.map((variant) => check(`pricing:${variant.id}`, hasLiveEvaluationPricing(variant.config), hasLiveEvaluationPricing(variant.config) ? "valid" : "missing_or_invalid", "valid")),
  ];
  return {
    schemaVersion: 1,
    corpus: { id: corpus.snapshot.id, hash: corpus.snapshot.hash, total: corpus.cases.length, targetKinds },
    variants: variants.map((variant) => {
      const profile = variant.config.modelProfiles.executor;
      const envName = profile.apiKeyEnv.trim();
      return {
        id: variant.id,
        provider: profile.provider,
        api: profile.api,
        model: profile.model,
        apiKeyEnv: envName,
        credentialPresent: envName.length > 0 && Boolean(process.env[envName]?.trim()),
        pricingPresent: hasLiveEvaluationPricing(variant.config),
        profileFingerprint: fingerprint(variant.config),
      };
    }),
    budget: { attempts, maxTurns, maxCostUsd, deadlineMs },
    checks,
    ready: checks.every((item) => item.passed),
  };
}

export interface RealModelEvaluationCase {
  variantId: string;
  corpusCaseId: string;
  targetKind: TaskContract["target_kind"];
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
  /** Milliseconds from run start until the first immutable evidence event. */
  firstEvidenceMs?: number;
  /** Number of repeat keys with at least two failed experiments. */
  repeatedExperimentCount: number;
  /** Durable platform-scoring effects spent by this run. */
  submissionCount: number;
  /** Input/context tokens consumed by provider requests. */
  contextTokens: number;
  confirmedFacts: number;
  evidenceLinkedFacts: number;
  factEvidenceCoverage: number;
  /** Replay-derived request and evidence placement for each executor turn. */
  providerDiagnostics: RealModelProviderDiagnostics;
  failureCategory?: RealEvaluationFailureCategory;
  error?: string;
}

export interface RealModelTurnDiagnostics {
  turn: number;
  providerRequests: number;
  completedRequests: number;
  totalTokens: number;
  evidenceAdded: number;
  phases: string[];
}

export interface RealModelProviderDiagnostics {
  turns: RealModelTurnDiagnostics[];
  providerRequestsByPhase: Record<string, number>;
  firstEvidencePhase?: string;
  lastProviderPhase?: string;
  deadlineBeforeCompletion: boolean;
}

export interface RealModelCategorySummary {
  total: number;
  successCount: number;
  successRate: number;
  providerRequests: number;
  totalTokens: number;
  totalCostUsd: number;
  firstEvidenceMs: { total: number; average: number; p95: number };
  repeatedExperimentCount: number;
  submissionCount: number;
  contextTokens: number;
  failureCategories: Partial<Record<RealEvaluationFailureCategory, number>>;
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
    firstEvidenceMs: { total: number; average: number; p95: number };
    repeatedExperimentCount: number;
    submissionCount: number;
    contextTokens: number;
    factEvidenceCoverage: number;
    firstTurnProviderRequests: { total: number; average: number };
    firstTurnTokens: { total: number; average: number };
    deadlineBeforeCompletionCount: number;
    providerRequestsByPhase: Record<string, number>;
  };
  /** Direction-level metrics make Web/Pwn regressions visible without parsing case ids. */
  categoryMetrics: Record<string, RealModelCategorySummary>;
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
    const corpus = await loadRealEvaluationCorpus(options.corpusPath);
    const minimumCorpusCases = nonNegativeInteger(options.minimumCorpusCases ?? (options.requireProviderTraffic === true ? 20 : 0), "minimumCorpusCases");
    const requireAnswerLiteralsAbsent = options.requireAnswerLiteralsAbsent ?? options.requireProviderTraffic === true;
    if (requireAnswerLiteralsAbsent) {
      const answerLiteralLeakCount = await countAnswerLiteralLeaks(corpus.cases);
      if (answerLiteralLeakCount > 0) throw new Error(`Real evaluation corpus contains ${answerLiteralLeakCount} expected answer literal(s) in target files; use a private non-leaking corpus`);
    }
    const gatePolicy = gatePolicyFor(options, variants, minimumCorpusCases);
    const runPrefix = options.runPrefix ?? `REAL-EVAL-${Date.now()}`;
    assertRunId(runPrefix);
    const results: RealModelVariantSummary[] = [];
    for (const variant of variants) {
      const profileFingerprint = fingerprint(variant.config);
      const services = createServices(this.root, variant.config);
      const cases: RealModelEvaluationCase[] = [];
      try {
        for (const corpusCase of corpus.cases) {
          for (let attempt = 1; attempt <= attempts; attempt += 1) {
            const runId = `${runPrefix}-${variant.id}-${corpusCase.id}-a${attempt}`;
            assertRunId(runId);
            await stageRealEvaluationCase(join(this.root, variant.config.storage.fixturesDir), runId, corpus, corpusCase);
            const task = realEvaluationTask(runId, corpusCase, this.root, variant.config, { maxCostUsd, deadlineMs });
            cases.push(await this.runCase(variant.id, corpusCase, attempt, runId, task, variant.config, services, maxTurns, deadlineMs));
          }
        }
      } finally {
        await services.sandbox.close();
      }
      results.push(summarizeVariant(variant.id, profileFingerprint, cases));
    }
    const comparisons = compareVariants(results, gatePolicy.baselineVariantId);
    const baseline = results.find((item) => item.id === gatePolicy.baselineVariantId)!;
    const distinctProfiles = new Set(results.map((variant) => variant.profileFingerprint)).size;
    const checks = [
      check("minimum_variants", results.length >= 2, results.length, ">=2"),
      check("distinct_profile_variants", distinctProfiles >= 2, distinctProfiles, ">=2"),
      check("full_corpus_coverage", results.every((item) => item.total === corpus.cases.length * attempts), results.map((item) => item.total).join(","), corpus.cases.length * attempts),
      ...(minimumCorpusCases > 0 ? [check("minimum_corpus_cases", corpus.cases.length >= minimumCorpusCases, corpus.cases.length, `>=${minimumCorpusCases}`)] : []),
      ...(requireAnswerLiteralsAbsent ? [check("answer_literals_absent", true, 0, 0)] : []),
      ...gatePolicy.requiredTargetKinds.map((targetKind) => check(
        `target_kind_coverage:${targetKind}`,
        corpus.cases.some((item) => item.targetKind === targetKind),
        corpus.cases.filter((item) => item.targetKind === targetKind).length,
        ">=1",
      )),
      check("candidate_leaks", results.every((item) => item.candidateLeakCount === 0), sum(results.map((item) => item.candidateLeakCount)), 0),
      check("case_cost_cap", results.every((item) => item.cases.every((candidate) => candidate.costUsd <= maxCostUsd + 1e-9)), highestCaseCost(results), `<=${maxCostUsd}`),
      ...(options.requireProviderTraffic === true
        ? results.map((item) => check(`provider_traffic:${item.id}`, item.metrics.providerRequests > 0, item.metrics.providerRequests, ">0"))
        : []),
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
    deadlineMs: number,
  ): Promise<RealModelEvaluationCase> {
    const started = Date.now();
    let status = "FAILED";
    let phase = "intake";
    let turns = 0;
    let error: string | undefined;
    let deadlineExceeded = false;
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(() => deadline.abort(new Error("Real evaluation case deadline exhausted")), deadlineMs);
    try {
      const loop = this.createLane
        ? new SingleAgentCtfLoop(this.root, config, services, this.createLane)
        : new SingleAgentCtfLoop(this.root, config, services);
      const outcome = await loop.run({
        runId,
        task,
        mode: "auto",
        maxTurns,
        signal: deadline.signal,
        terminalizeAbort: { reason: "Real evaluation case deadline exhausted.", category: "budget_exhausted" },
      });
      status = outcome.status;
      phase = outcome.phase;
      turns = outcome.turns;
      if (status !== "SUCCEEDED" && (deadline.signal.aborted || Date.now() - started >= deadlineMs)) {
        deadlineExceeded = true;
        error = "Error: Real evaluation case deadline exhausted.";
        const current = await services.control.snapshot(runId);
        if (!isTerminal(current.status) && current.status !== "PAUSED") {
          await services.control.dispatch(runId, {
            type: "fail",
            reason: "Real evaluation case deadline exhausted.",
            category: "budget_exhausted",
            lane: "executor",
          }).catch(() => undefined);
        }
      }
    } catch (caught) {
      error = String(caught);
      if (deadline.signal.aborted) {
        deadlineExceeded = true;
        const current = await services.control.snapshot(runId);
        if (!isTerminal(current.status) && current.status !== "PAUSED") {
          await services.control.dispatch(runId, {
            type: "fail",
            reason: "Real evaluation case deadline exhausted.",
            category: "budget_exhausted",
            lane: "executor",
          }).catch(() => undefined);
        }
      }
    } finally {
      clearTimeout(deadlineTimer);
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
    let firstEvidenceMs: number | undefined;
    let repeatedExperimentCount = 0;
    let submissionCount = 0;
    let contextTokens = 0;
    let confirmedFacts = 0;
    let evidenceLinkedFacts = 0;
    let factEvidenceCoverage = 0;
    let providerDiagnostics: RealModelProviderDiagnostics = emptyProviderDiagnostics(false);
    let failureCategory: RealEvaluationFailureCategory | undefined;
    try {
      const snapshot = await services.control.snapshot(runId);
      const eventLog = await services.control.events(runId);
      const replayed = await services.control.replay(runId);
      const persisted = await new JsonlControlStore(services.runsRoot).loadProjection(runId);
      // A deadline or Provider error may interrupt `lane.prompt` before the
      // loop can return its normal outcome. The WorkItem claim is durable and
      // therefore remains the authoritative count of model turns attempted;
      // do not report an already-started turn as zero.
      turns = Math.max(turns, eventLog.filter((event) => event.type === "work_item_claimed" && event.lane === "executor").length);
      replayParity = Boolean(persisted) && projectionHash(replayed) === projectionHash(persisted!);
      evidenceBacked = snapshot.status === "SUCCEEDED" && Object.values(snapshot.evidence).filter((item) => item.kind === "reproduction").length >= snapshot.task.verification.required_reproductions;
      candidateLeaked = (await readFile(join(services.runsRoot, runId, "events.jsonl"), "utf8")).includes(corpusCase.expected);
      const telemetry = await new RunTelemetry(services.control).report(runId);
      providerRequests = telemetry.provider.requestCount;
      totalTokens = telemetry.provider.tokens.total;
      costUsd = telemetry.provider.cost.totalUsd;
      effectCount = Object.keys(snapshot.effects).length;
      submissionCount = Object.values(snapshot.effects).filter((effect) => effect.operation === "fixture_score").length;
      const evidenceEffectIds = new Set(Object.values(snapshot.evidence).flatMap((item) => item.source.effectId ? [item.source.effectId] : []));
      effectiveActions = Object.values(snapshot.effects).filter((effect) => evidenceEffectIds.has(effect.id)).length;
      effectiveActionRatio = rate(effectiveActions, effectCount);
      const facts = Object.values(snapshot.facts).filter((item) => item.status === "CONFIRMED");
      confirmedFacts = facts.length;
      evidenceLinkedFacts = facts.filter((fact) => fact.evidenceIds.length > 0 && fact.evidenceIds.every((evidenceId) => snapshot.evidence[evidenceId] !== undefined)).length;
      factEvidenceCoverage = rate(evidenceLinkedFacts, confirmedFacts);
      firstEvidenceMs = telemetry.evidence.firstEvidenceMs;
      repeatedExperimentCount = telemetry.convergence.repeatedFailedActionCount;
      contextTokens = telemetry.provider.tokens.input;
      providerDiagnostics = deriveProviderDiagnostics(eventLog, deadlineExceeded, snapshot.status === "SUCCEEDED");
      // Prefer the durable category chosen by the Run coordinator even when
      // the lane also throws.  The exception is retained separately in the
      // case record; dropping the persisted category whenever `error` exists
      // made live reports collapse provider/tool failures into `unclassified`.
      // If no durable category exists, keep the conservative unclassified
      // fallback below rather than guessing from an arbitrary error string.
      failureCategory = deadlineExceeded ? "budget_exhausted" : snapshot.failureCategory ?? telemetry.failure?.primary;
      status = snapshot.status;
      phase = snapshot.phase;
    } catch (caught) {
      error = error ?? String(caught);
    }
    const success = status === "SUCCEEDED" && phase === "report" && evidenceBacked && replayParity && !candidateLeaked && !error;
    if (!success && !failureCategory) failureCategory = "unclassified";
    return {
      variantId,
      corpusCaseId: corpusCase.id,
      targetKind: corpusCase.targetKind,
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
      ...(firstEvidenceMs === undefined ? {} : { firstEvidenceMs }),
      repeatedExperimentCount,
      submissionCount,
      contextTokens,
      confirmedFacts,
      evidenceLinkedFacts,
      factEvidenceCoverage,
      providerDiagnostics,
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
  const firstEvidence = cases.flatMap((item) => item.firstEvidenceMs === undefined ? [] : [item.firstEvidenceMs]).sort((left, right) => left - right);
  const totalFacts = sum(cases.map((item) => item.confirmedFacts));
  const evidenceLinkedFacts = sum(cases.map((item) => item.evidenceLinkedFacts));
  const firstTurnRequests = cases.map((item) => item.providerDiagnostics.turns[0]?.providerRequests ?? 0);
  const firstTurnTokens = cases.map((item) => item.providerDiagnostics.turns[0]?.totalTokens ?? 0);
  const providerRequestsByPhase = aggregateProviderRequestsByPhase(cases);
  const categoryMetrics = summarizeCategories(cases);
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
      firstEvidenceMs: { total: sum(firstEvidence), average: average(firstEvidence), p95: percentile(firstEvidence, 0.95) },
      repeatedExperimentCount: sum(cases.map((item) => item.repeatedExperimentCount)),
      submissionCount: sum(cases.map((item) => item.submissionCount)),
      contextTokens: sum(cases.map((item) => item.contextTokens)),
      factEvidenceCoverage: rate(evidenceLinkedFacts, totalFacts),
      firstTurnProviderRequests: { total: sum(firstTurnRequests), average: average(firstTurnRequests) },
      firstTurnTokens: { total: sum(firstTurnTokens), average: average(firstTurnTokens) },
      deadlineBeforeCompletionCount: cases.filter((item) => item.providerDiagnostics.deadlineBeforeCompletion).length,
      providerRequestsByPhase,
    },
    categoryMetrics,
    failureCategories: orderedCounts(cases.flatMap((item) => item.failureCategory ? [item.failureCategory] : [])),
    cases,
  };
}

function summarizeCategories(cases: RealModelEvaluationCase[]): Record<string, RealModelCategorySummary> {
  const grouped = new Map<string, RealModelEvaluationCase[]>();
  for (const item of cases) {
    const existing = grouped.get(item.targetKind);
    if (existing) existing.push(item);
    else grouped.set(item.targetKind, [item]);
  }
  return Object.fromEntries([...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([targetKind, items]) => [targetKind, summarizeCategory(items)]));
}

function summarizeCategory(cases: RealModelEvaluationCase[]): RealModelCategorySummary {
  const successCount = cases.filter((item) => item.success).length;
  const firstEvidence = cases.flatMap((item) => item.firstEvidenceMs === undefined ? [] : [item.firstEvidenceMs]).sort((left, right) => left - right);
  return {
    total: cases.length,
    successCount,
    successRate: rate(successCount, cases.length),
    providerRequests: sum(cases.map((item) => item.providerRequests)),
    totalTokens: sum(cases.map((item) => item.totalTokens)),
    totalCostUsd: round(sum(cases.map((item) => item.costUsd))),
    firstEvidenceMs: { total: sum(firstEvidence), average: average(firstEvidence), p95: percentile(firstEvidence, 0.95) },
    repeatedExperimentCount: sum(cases.map((item) => item.repeatedExperimentCount)),
    submissionCount: sum(cases.map((item) => item.submissionCount)),
    contextTokens: sum(cases.map((item) => item.contextTokens)),
    failureCategories: orderedCounts(cases.flatMap((item) => item.failureCategory ? [item.failureCategory] : [])),
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
        repeatedExperimentCount: variant.metrics.repeatedExperimentCount,
        submissionCount: variant.metrics.submissionCount,
        contextTokens: variant.metrics.contextTokens,
        factEvidenceCoverage: variant.metrics.factEvidenceCoverage,
        firstTurnProviderRequests: variant.metrics.firstTurnProviderRequests,
        firstTurnTokens: variant.metrics.firstTurnTokens,
        deadlineBeforeCompletionCount: variant.metrics.deadlineBeforeCompletionCount,
        providerRequestsByPhase: variant.metrics.providerRequestsByPhase,
      },
      categoryMetrics: Object.fromEntries(Object.entries(variant.categoryMetrics).map(([targetKind, metrics]) => [targetKind, {
        total: metrics.total,
        successCount: metrics.successCount,
        successRate: metrics.successRate,
        providerRequests: metrics.providerRequests,
        totalTokens: metrics.totalTokens,
        totalCostUsd: metrics.totalCostUsd,
        repeatedExperimentCount: metrics.repeatedExperimentCount,
        submissionCount: metrics.submissionCount,
        contextTokens: metrics.contextTokens,
        failureCategories: metrics.failureCategories,
      }])),
      failureCategories: variant.failureCategories,
      cases: variant.cases.map(({ runId: _runId, durationMs: _durationMs, firstEvidenceMs: _firstEvidenceMs, error: _error, ...item }) => item),
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

function gatePolicyFor(options: RealModelEvaluationOptions, variants: RealEvaluationVariant[], minimumCorpusCases: number): RealModelEvaluationGatePolicy {
  const minimumSuccessRate = rateThreshold(options.minimumSuccessRate ?? 0.5, "minimumSuccessRate");
  const maxBaselineSuccessRateDrop = rateThreshold(options.maxBaselineSuccessRateDrop ?? 0.1, "maxBaselineSuccessRateDrop");
  const baselineVariantId = options.baselineVariantId ?? variants[0]!.id;
  if (!variants.some((variant) => variant.id === baselineVariantId)) {
    throw new Error(`Real evaluation baseline variant is not configured: ${baselineVariantId}`);
  }
  return {
    minimumSuccessRate,
    baselineVariantId,
    maxBaselineSuccessRateDrop,
    requireProviderTraffic: options.requireProviderTraffic === true,
    minimumCorpusCases,
    requiredTargetKinds: normalizeRequiredTargetKinds(options.requiredTargetKinds ?? (options.requireProviderTraffic === true ? ["web", "pwn"] : [])),
  };
}

/**
 * Projects provider traffic onto durable executor turns without relying on
 * wall-clock timing. WorkItem claims are the turn boundary because they are
 * persisted before Pi.prompt and survive Provider/deadline exceptions.
 */
export function deriveProviderDiagnostics(events: readonly HarnessEvent[], deadlineExceeded: boolean, completed: boolean): RealModelProviderDiagnostics {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const claims = ordered.filter((event) => event.type === "work_item_claimed"
    && (event.lane === "executor" || event.payload?.ownerLane === "executor"));
  const requestStarts = ordered.filter((event) => event.type === "provider_request_started");
  const usages = ordered.filter((event) => event.type === "model_usage" && event.payload?.queueCancelled !== true);
  const evidence = ordered.filter((event) => event.type === "evidence_added");
  const boundaries = claims.length > 0 ? claims : requestStarts.slice(0, 1);
  const turns = boundaries.map((claim, index) => {
    const endSeq = boundaries[index + 1]?.seq ?? Number.POSITIVE_INFINITY;
    const requests = requestStarts.filter((event) => event.seq > claim.seq && event.seq < endSeq);
    const turnUsages = usages.filter((event) => event.seq > claim.seq && event.seq < endSeq);
    const turnEvidence = evidence.filter((event) => event.seq > claim.seq && event.seq < endSeq);
    return {
      turn: index + 1,
      providerRequests: requests.length,
      completedRequests: turnUsages.length,
      totalTokens: sum(turnUsages.map((event) => usageTokens(event.payload?.usage))),
      evidenceAdded: turnEvidence.length,
      phases: [...new Set(requests.map((event) => eventPhase(event, ordered)).filter((phase): phase is string => phase !== undefined))].sort(),
    };
  });
  const providerRequestsByPhase: Record<string, number> = {};
  for (const event of requestStarts) {
    const phase = eventPhase(event, ordered) ?? "unknown";
    providerRequestsByPhase[phase] = (providerRequestsByPhase[phase] ?? 0) + 1;
  }
  const firstEvidence = evidence[0];
  const lastProvider = requestStarts.at(-1);
  return {
    turns,
    providerRequestsByPhase: orderedRecord(providerRequestsByPhase),
    ...(firstEvidence ? { firstEvidencePhase: phaseAt(firstEvidence.seq, ordered) } : {}),
    ...(lastProvider ? { lastProviderPhase: eventPhase(lastProvider, ordered) } : {}),
    deadlineBeforeCompletion: deadlineExceeded && !completed,
  };
}

function emptyProviderDiagnostics(deadlineExceeded: boolean): RealModelProviderDiagnostics {
  return { turns: [], providerRequestsByPhase: {}, deadlineBeforeCompletion: deadlineExceeded };
}

function aggregateProviderRequestsByPhase(cases: RealModelEvaluationCase[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of cases) {
    for (const [phase, count] of Object.entries(item.providerDiagnostics.providerRequestsByPhase)) counts[phase] = (counts[phase] ?? 0) + count;
  }
  return orderedRecord(counts);
}

function eventPhase(event: HarnessEvent, ordered: HarnessEvent[]): string | undefined {
  return typeof event.payload?.phase === "string" ? event.payload.phase : phaseAt(event.seq, ordered);
}

/** Count cases whose target input literally contains the hidden answer. */
async function countAnswerLiteralLeaks(cases: readonly LoadedRealEvaluationCase[]): Promise<number> {
  let leakedCases = 0;
  for (const item of cases) {
    let leaked = false;
    for (const file of item.files) {
      if (await fileContainsLiteral(file.sourcePath, item.expected)) {
        leaked = true;
        break;
      }
    }
    if (leaked) leakedCases += 1;
  }
  return leakedCases;
}

/** Stream a corpus file so the quality gate does not load a large input into memory. */
async function fileContainsLiteral(path: string, literal: string): Promise<boolean> {
  if (literal.length === 0) return false;
  let tail = "";
  const stream = createReadStream(path, { encoding: "utf8" });
  for await (const chunk of stream) {
    const text = `${tail}${chunk}`;
    if (text.includes(literal)) return true;
    tail = text.slice(Math.max(0, text.length - literal.length + 1));
  }
  return false;
}

function phaseAt(seq: number, ordered: HarnessEvent[]): string | undefined {
  let phase: string | undefined;
  for (const event of ordered) {
    if (event.seq > seq) break;
    if (event.type === "phase_started" && typeof event.payload?.phase === "string") phase = event.payload.phase;
  }
  return phase;
}

function usageTokens(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const usage = value as { totalTokens?: unknown; input?: unknown; output?: unknown };
  if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) return usage.totalTokens;
  const input = typeof usage.input === "number" && Number.isFinite(usage.input) ? usage.input : 0;
  const output = typeof usage.output === "number" && Number.isFinite(usage.output) ? usage.output : 0;
  return input + output;
}

function fingerprint(config: ProofBladeConfig): string {
  const profile = config.modelProfiles.executor;
  return sha256(canonicalJson({
    provider: profile.provider,
    api: profile.api,
    baseUrl: profile.baseUrl,
    model: profile.model,
    // Keep the credential value out of reports, but include its declared
    // identity so two separately provisioned accounts are not silently
    // collapsed into one comparison profile.
    apiKeyEnv: profile.apiKeyEnv,
    endpointMode: profile.endpointMode,
    proxyUrl: profile.proxyUrl,
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

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function rateThreshold(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be a finite number from 0 to 1`);
  return value;
}

function normalizeRequiredTargetKinds(values: readonly TargetKind[]): TargetKind[] {
  const allowed = new Set<TargetKind>(["unknown", "web", "reverse", "pwn", "crypto", "misc", "mixed"]);
  const unique = [...new Set(values)];
  if (unique.some((value) => !allowed.has(value))) throw new Error("Real evaluation requiredTargetKinds contains an unsupported target kind");
  return unique.sort();
}

function check(id: string, passed: boolean, actual: number | string, expected: number | string): RealModelEvaluationSummary["gate"]["checks"][number] {
  return { id, passed, actual, expected };
}

function orderedCounts<T extends string>(values: readonly T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))) as Partial<Record<T, number>>;
}

function orderedRecord(value: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
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
