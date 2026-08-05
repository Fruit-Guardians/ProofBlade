import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProofBladeConfig } from "../config.js";
import { createServices } from "../app/demo.js";
import { fixtureTask } from "../app/fixture-task.js";
import { JsonlControlStore } from "../storage/jsonl-store.js";
import { projectionHash } from "../control/reducer.js";
import { getFixtureProfile, listFixtureProfiles } from "../sandbox/fixture-catalog.js";
import { SingleAgentCtfLoop, type SolverLaneFactory } from "../orchestration/single-agent-loop.js";
import { sha256, canonicalJson } from "../domain/utils.js";

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
  error?: string;
}

export interface FixtureEvaluationSummary {
  schemaVersion: 1;
  runPrefix: string;
  attempts: number;
  total: number;
  successCount: number;
  successRate: number;
  evidenceBackedCount: number;
  evidenceBackedRate: number;
  replayParityCount: number;
  replayParityRate: number;
  cases: FixtureEvaluationCase[];
  reportHash: string;
}

export class FixtureEvaluationRunner {
  public constructor(private readonly root: string, private readonly config: ProofBladeConfig) {}

  public async run(options: FixtureEvaluationOptions = {}): Promise<FixtureEvaluationSummary> {
    const attempts = normalizePositive(options.attempts ?? 1, "attempts");
    const maxTurns = normalizePositive(options.maxTurns ?? 1, "maxTurns");
    const runPrefix = options.runPrefix ?? `EVAL-${Date.now()}`;
    const requested = options.fixtureIds ?? listFixtureProfiles().map((profile) => profile.id);
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
    const summaryBase = {
      schemaVersion: 1 as const,
      runPrefix,
      attempts,
      total,
      successCount,
      successRate: rate(successCount, total),
      evidenceBackedCount,
      evidenceBackedRate: rate(evidenceBackedCount, total),
      replayParityCount,
      replayParityRate: rate(replayParityCount, total),
      cases,
    };
    return { ...summaryBase, reportHash: sha256(canonicalJson(summaryBase)) };
  }

  private async runCase(services: ReturnType<typeof createServices>, fixtureId: string, attempt: number, runId: string, maxTurns: number): Promise<FixtureEvaluationCase> {
    const task = fixtureTask(runId, fixtureId, this.root, this.config);
    const started = Date.now();
    let status = "FAILED";
    let phase = "intake";
    let turns = 0;
    let error: string | undefined;
    try {
      const outcome = await new SingleAgentCtfLoop(this.root, this.config, services, deterministicLane).run({ runId, task, mode: "auto", maxTurns });
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
    try {
      const snapshot = await services.control.snapshot(runId);
      const replayed = await services.control.replay(runId);
      const persisted = await new JsonlControlStore(services.runsRoot).loadProjection(runId);
      replayParity = Boolean(persisted) && projectionHash(replayed) === projectionHash(persisted!);
      eventCount = replayed.lastSeq;
      evidenceBacked = snapshot.status === "SUCCEEDED" && Object.values(snapshot.evidence).filter((item) => item.kind === "reproduction").length >= snapshot.task.verification.required_reproductions;
      candidateLeaked = (await readFile(join(services.runsRoot, runId, "events.jsonl"), "utf8")).includes((listFixtureProfiles().find((profile) => profile.id === fixtureId)!).expected);
      if (!error) {
        status = snapshot.status;
        phase = snapshot.phase;
      }
    } catch (caught) {
      error = error ?? String(caught);
    }
    const success = status === "SUCCEEDED" && phase === "report" && evidenceBacked && replayParity && !candidateLeaked && !error;
    return { fixtureId, runId, attempt, status, phase, turns, durationMs: Date.now() - started, success, evidenceBacked, replayParity, candidateLeaked, eventCount, error };
  }
}

const deterministicLane: SolverLaneFactory = async ({ runtime }) => ({
  async prompt() {
    const inspected = runtime.fixture.endpoint
      ? await runtime.invokeCapability({ capabilityId: "proofblade.web", operation: "request", input: { path: webFixturePath(runtime.fixture.profileId) } })
      : await runtime.inspectTarget();
    const candidate = inspected.output.match(/PB\{[^}\r\n]+\}/)?.[0];
    if (!candidate) throw new Error("Fixture contains no candidate");
    if (!inspected.evidenceId) throw new Error("Fixture inspection produced no evidence");
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

function webFixturePath(profileId: string | undefined): string {
  const path = profileId ? getFixtureProfile(profileId).http?.evaluationPath : undefined;
  if (!path) throw new Error(`Fixture has no evaluation HTTP path: ${profileId ?? "unknown"}`);
  return path;
}

function normalizePositive(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function rate(value: number, total: number): number {
  return total === 0 ? 0 : Number((value / total).toFixed(4));
}
