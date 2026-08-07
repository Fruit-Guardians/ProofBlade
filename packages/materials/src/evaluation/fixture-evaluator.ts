import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProofBladeConfig } from "../config.js";
import { createServices } from "../app/demo.js";
import { fixtureTask } from "../app/fixture-task.js";
import { JsonlControlStore } from "../storage/jsonl-store.js";
import { projectionHash } from "../control/reducer.js";
import { listFixtureProfiles } from "../sandbox/fixture-catalog.js";
import { SingleAgentCtfLoop, type SolverLaneFactory } from "../orchestration/single-agent-loop.js";
import { sha256, canonicalJson } from "../domain/utils.js";
import { RunTelemetry } from "../observability/run-telemetry.js";
import type { PrimaryFailureCategory } from "../domain/types.js";

export const BASELINE_PROTOCOL_VERSION = "baseline-v1";
export const BASELINE_REQUIRED_ATTEMPTS = 3;

export type EvaluationFailureCategory = PrimaryFailureCategory | "unclassified";

export interface FixtureEvaluationOptions {
  attempts?: number;
  maxTurns?: number;
  runPrefix?: string;
  fixtureIds?: string[];
}

export interface FixtureEvaluationCase {
  fixtureId: string;
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
  eventCount: number;
  providerRequests: number;
  totalTokens: number;
  costUsd: number;
  effectCount: number;
  effectiveActions: number;
  effectiveActionRatio: number;
  firstEvidenceMs?: number;
  confirmedFacts: number;
  evidenceLinkedFacts: number;
  factEvidenceCoverage: number;
  failureCategory?: EvaluationFailureCategory;
  error?: string;
}

export interface FixtureEvaluationSummary {
  schemaVersion: 2;
  protocolVersion: typeof BASELINE_PROTOCOL_VERSION;
  runPrefix: string;
  fixtureIds: string[];
  budget: { maxTurns: number };
  attempts: number;
  total: number;
  successCount: number;
  successRate: number;
  evidenceBackedCount: number;
  evidenceBackedRate: number;
  replayParityCount: number;
  replayParityRate: number;
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
    firstEvidenceMs: { observed: number; average: number; p95: number };
    confirmedFacts: number;
    evidenceLinkedFacts: number;
    factEvidenceCoverage: number;
  };
  failureCategories: Partial<Record<EvaluationFailureCategory, number>>;
  gate: {
    passed: boolean;
    checks: Array<{ id: string; passed: boolean; actual: number | string; expected: number | string }>;
  };
  cases: FixtureEvaluationCase[];
  reportHash: string;
}

export class FixtureEvaluationRunner {
  public constructor(
    private readonly root: string,
    private readonly config: ProofBladeConfig,
    private readonly createLane: SolverLaneFactory = deterministicLane,
  ) {}

  public async run(options: FixtureEvaluationOptions = {}): Promise<FixtureEvaluationSummary> {
    const attempts = normalizePositive(options.attempts ?? BASELINE_REQUIRED_ATTEMPTS, "attempts");
    const maxTurns = normalizePositive(options.maxTurns ?? 1, "maxTurns");
    const runPrefix = options.runPrefix ?? `EVAL-${Date.now()}`;
    const requiredFixtureIds = listFixtureProfiles().map((profile) => profile.id).sort();
    const requested = [...new Set(options.fixtureIds ?? requiredFixtureIds)].sort();
    const profiles = requested.map((fixtureId) => listFixtureProfiles().find((profile) => profile.id === fixtureId) ?? (() => { throw new Error(`Unknown fixture profile: ${fixtureId}`); })());
    const services = createServices(this.root, this.config);
    const cases: FixtureEvaluationCase[] = [];
    for (const profile of profiles) {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        cases.push(await this.runCase(services, profile.id, attempt, `${runPrefix}-${profile.id}-a${attempt}`, maxTurns));
      }
    }
    const total = cases.length;
    const successCount = cases.filter((item) => item.success).length;
    const evidenceBackedCount = cases.filter((item) => item.evidenceBacked).length;
    const replayParityCount = cases.filter((item) => item.replayParity).length;
    const candidateLeakCount = cases.filter((item) => item.candidateLeaked).length;
    const metrics = aggregateMetrics(cases, successCount);
    const failureCategories = orderedCounts(cases.flatMap((item) => item.failureCategory ? [item.failureCategory] : []));
    const checks = [
      check("minimum_attempts", attempts >= BASELINE_REQUIRED_ATTEMPTS, attempts, `>=${BASELINE_REQUIRED_ATTEMPTS}`),
      check("fixture_coverage", sameValues(requested, requiredFixtureIds), requested.join(","), requiredFixtureIds.join(",")),
      check("success_rate", successCount === total, rate(successCount, total), 1),
      check("evidence_backed_rate", evidenceBackedCount === total, rate(evidenceBackedCount, total), 1),
      check("replay_parity_rate", replayParityCount === total, rate(replayParityCount, total), 1),
      check("candidate_leaks", candidateLeakCount === 0, candidateLeakCount, 0),
      check("fact_evidence_coverage", metrics.factEvidenceCoverage === 1, metrics.factEvidenceCoverage, 1),
    ];
    const summaryBase: Omit<FixtureEvaluationSummary, "reportHash"> = {
      schemaVersion: 2 as const,
      protocolVersion: BASELINE_PROTOCOL_VERSION,
      runPrefix,
      fixtureIds: requested,
      budget: { maxTurns },
      attempts,
      total,
      successCount,
      successRate: rate(successCount, total),
      evidenceBackedCount,
      evidenceBackedRate: rate(evidenceBackedCount, total),
      replayParityCount,
      replayParityRate: rate(replayParityCount, total),
      candidateLeakCount,
      metrics,
      failureCategories,
      gate: { passed: checks.every((item) => item.passed), checks },
      cases,
    };
    return { ...summaryBase, reportHash: stableReportHash(summaryBase) };
  }

  private async runCase(services: ReturnType<typeof createServices>, fixtureId: string, attempt: number, runId: string, maxTurns: number): Promise<FixtureEvaluationCase> {
    const task = fixtureTask(runId, fixtureId, this.root, this.config);
    const started = Date.now();
    let status = "FAILED";
    let phase = "intake";
    let turns = 0;
    let error: string | undefined;
    try {
      const outcome = await new SingleAgentCtfLoop(this.root, this.config, services, this.createLane).run({ runId, task, mode: "auto", maxTurns });
      status = outcome.status;
      phase = outcome.phase;
      turns = outcome.turns;
    } catch (caught) {
      error = String(caught);
    }

    let replayParity = false;
    let eventCount = 0;
    let evidenceBacked = false;
    let candidateLeaked = false;
    let providerRequests = 0;
    let totalTokens = 0;
    let costUsd = 0;
    let effectCount = 0;
    let effectiveActions = 0;
    let effectiveActionRatio = 0;
    let firstEvidenceMs: number | undefined;
    let confirmedFacts = 0;
    let evidenceLinkedFacts = 0;
    let factEvidenceCoverage = 0;
    let failureCategory: EvaluationFailureCategory | undefined;
    try {
      const snapshot = await services.control.snapshot(runId);
      const replayed = await services.control.replay(runId);
      const persisted = await new JsonlControlStore(services.runsRoot).loadProjection(runId);
      replayParity = Boolean(persisted) && projectionHash(replayed) === projectionHash(persisted!);
      eventCount = replayed.lastSeq;
      evidenceBacked = snapshot.status === "SUCCEEDED" && Object.values(snapshot.evidence).filter((item) => item.kind === "reproduction").length >= snapshot.task.verification.required_reproductions;
      candidateLeaked = (await readFile(join(services.runsRoot, runId, "events.jsonl"), "utf8")).includes((listFixtureProfiles().find((profile) => profile.id === fixtureId)!).expected);
      const telemetry = await new RunTelemetry(services.control).report(runId);
      providerRequests = telemetry.provider.requestCount;
      totalTokens = telemetry.provider.tokens.total;
      costUsd = telemetry.provider.cost.totalUsd;
      effectCount = Object.keys(snapshot.effects).length;
      const evidenceEffectIds = new Set(Object.values(snapshot.evidence).flatMap((item) => item.source.effectId ? [item.source.effectId] : []));
      effectiveActions = Object.values(snapshot.effects).filter((effect) => evidenceEffectIds.has(effect.id)).length;
      effectiveActionRatio = rate(effectiveActions, effectCount);
      firstEvidenceMs = telemetry.evidence.firstEvidenceMs;
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
      fixtureId,
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
      eventCount,
      providerRequests,
      totalTokens,
      costUsd,
      effectCount,
      effectiveActions,
      effectiveActionRatio,
      ...(firstEvidenceMs === undefined ? {} : { firstEvidenceMs }),
      confirmedFacts,
      evidenceLinkedFacts,
      factEvidenceCoverage,
      ...(failureCategory ? { failureCategory } : {}),
      ...(error ? { error } : {}),
    };
  }
}

const deterministicLane: SolverLaneFactory = async ({ runtime }) => ({
  async prompt() {
    const inspected = await runtime.inspectTarget();
    const candidate = inspected.output.match(/PB\{[^}\r\n]+\}/)?.[0];
    if (!candidate) throw new Error("Fixture contains no candidate");
    await runtime.proposeHypothesis({ statement: "The observed candidate satisfies the fixture.", evidenceIds: [inspected.evidenceId] });
    await runtime.submitCandidate(candidate);
    return {
      text: "candidate proposed",
      stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
  },
  async compact() {},
  async abort() {},
  async isIdle() { return true; },
  async close() {},
});

function normalizePositive(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function rate(value: number, total: number): number {
  return total === 0 ? 0 : Number((value / total).toFixed(4));
}

function aggregateMetrics(cases: FixtureEvaluationCase[], successCount: number): FixtureEvaluationSummary["metrics"] {
  const durations = cases.map((item) => item.durationMs).sort((a, b) => a - b);
  const evidenceTimes = cases.flatMap((item) => item.firstEvidenceMs === undefined ? [] : [item.firstEvidenceMs]).sort((a, b) => a - b);
  const providerRequests = sum(cases.map((item) => item.providerRequests));
  const totalTokens = sum(cases.map((item) => item.totalTokens));
  const totalCostUsd = sum(cases.map((item) => item.costUsd));
  const effects = sum(cases.map((item) => item.effectCount));
  const effectiveActions = sum(cases.map((item) => item.effectiveActions));
  const confirmedFacts = sum(cases.map((item) => item.confirmedFacts));
  const evidenceLinkedFacts = sum(cases.map((item) => item.evidenceLinkedFacts));
  return {
    durationMs: { total: sum(durations), average: average(durations), p95: percentile(durations, 0.95) },
    providerRequests,
    totalTokens,
    totalCostUsd,
    costPerSolveUsd: successCount === 0 ? 0 : round(totalCostUsd / successCount),
    effects,
    effectiveActions,
    effectiveActionRatio: rate(effectiveActions, effects),
    firstEvidenceMs: { observed: evidenceTimes.length, average: average(evidenceTimes), p95: percentile(evidenceTimes, 0.95) },
    confirmedFacts,
    evidenceLinkedFacts,
    factEvidenceCoverage: rate(evidenceLinkedFacts, confirmedFacts),
  };
}

function check(id: string, passed: boolean, actual: number | string, expected: number | string): FixtureEvaluationSummary["gate"]["checks"][number] {
  return { id, passed, actual, expected };
}

function sameValues(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  return sortedActual.every((value, index) => value === sortedExpected[index]);
}

function stableReportHash(summary: Omit<FixtureEvaluationSummary, "reportHash">): string {
  const stableCases = summary.cases.map(({ runId: _runId, durationMs: _durationMs, firstEvidenceMs: _firstEvidenceMs, error: _error, ...item }) => item);
  return sha256(canonicalJson({
    schemaVersion: summary.schemaVersion,
    protocolVersion: summary.protocolVersion,
    fixtureIds: summary.fixtureIds,
    budget: summary.budget,
    attempts: summary.attempts,
    total: summary.total,
    successCount: summary.successCount,
    evidenceBackedCount: summary.evidenceBackedCount,
    replayParityCount: summary.replayParityCount,
    candidateLeakCount: summary.candidateLeakCount,
    metrics: {
      providerRequests: summary.metrics.providerRequests,
      totalTokens: summary.metrics.totalTokens,
      totalCostUsd: summary.metrics.totalCostUsd,
      effects: summary.metrics.effects,
      effectiveActions: summary.metrics.effectiveActions,
      effectiveActionRatio: summary.metrics.effectiveActionRatio,
      confirmedFacts: summary.metrics.confirmedFacts,
      evidenceLinkedFacts: summary.metrics.evidenceLinkedFacts,
      factEvidenceCoverage: summary.metrics.factEvidenceCoverage,
    },
    failureCategories: summary.failureCategories,
    gate: summary.gate,
    cases: stableCases,
  }));
}

function orderedCounts(values: EvaluationFailureCategory[]): Partial<Record<EvaluationFailureCategory, number>> {
  const counts: Partial<Record<EvaluationFailureCategory, number>> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) as Partial<Record<EvaluationFailureCategory, number>>;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
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
