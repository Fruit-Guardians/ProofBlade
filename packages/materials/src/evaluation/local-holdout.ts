import type { ProofBladeConfig } from "../config.js";
import type { AgentOutcome } from "../runtime/pi-adapter.js";
import { loadRealEvaluationCorpus } from "./real-corpus.js";
import { RealModelEvaluationRunner, type RealEvaluationVariant, type RealModelEvaluationOptions, type RealModelEvaluationSummary } from "./real-model-evaluator.js";
import type { AgentLaneFactory } from "../orchestration/single-agent-loop.js";

export interface LocalHoldoutEvaluationOptions {
  corpusPath: string;
  attempts?: number;
  maxTurns?: number;
  runPrefix?: string;
  variants?: RealEvaluationVariant[];
  minimumSuccessRate?: number;
}

/**
 * Local-only Web/Pwn holdout runner. It reuses the hash-bound corpus and
 * replay/evidence metrics from the real-model evaluator, but injects a
 * deterministic lane and never creates a Provider request. Two local variants
 * are retained by default so baseline-vs-candidate metrics exercise the same
 * comparison protocol used before any real-model experiment is authorized.
 */
export class LocalHoldoutEvaluationRunner {
  public constructor(
    private readonly root: string,
    private readonly config: ProofBladeConfig,
    private readonly createLane: AgentLaneFactory = localDeterministicLane,
  ) {}

  public async run(options: LocalHoldoutEvaluationOptions): Promise<RealModelEvaluationSummary> {
    const corpus = await loadRealEvaluationCorpus(options.corpusPath);
    if (corpus.cases.length === 0 || corpus.cases.some((item) => item.targetKind !== "web" && item.targetKind !== "pwn")) {
      throw new Error("Local Web/Pwn holdout corpus must contain only web and pwn cases");
    }
    const localConfig = withLocalPricing(this.config);
    const variants = options.variants ?? [
      { id: "local-baseline", config: localConfig },
      { id: "local-candidate", config: localConfig },
    ];
    const runner = new RealModelEvaluationRunner(this.root, this.createLane);
    const runnerOptions: RealModelEvaluationOptions = {
      corpusPath: options.corpusPath,
      variants,
      allowLive: true,
      attempts: options.attempts ?? 1,
      maxTurns: options.maxTurns ?? 1,
      maxCostUsd: 0.01,
      deadlineMs: 30_000,
      runPrefix: options.runPrefix ?? `LOCAL-HOLDOUT-${Date.now()}`,
      minimumSuccessRate: options.minimumSuccessRate ?? 1,
      baselineVariantId: variants[0]!.id,
      maxBaselineSuccessRateDrop: 0,
    };
    return await runner.run(runnerOptions);
  }
}

const localDeterministicLane: AgentLaneFactory = async ({ runtime }) => ({
  async prompt(): Promise<AgentOutcome> {
    const inspected = await runtime.inspectTarget();
    const candidate = inspected.output.match(/[A-Za-z][A-Za-z0-9_-]{0,31}\{[^{}\r\n]{1,512}\}/)?.[0];
    if (!candidate) throw new Error("Local Web/Pwn holdout contains no candidate-shaped value");
    await runtime.proposeHypothesis({ statement: "The bounded local observation contains the accepted candidate.", evidenceIds: [inspected.evidenceId] });
    await runtime.submitCandidate(candidate);
    return { text: "local holdout candidate proposed", stopReason: "stop", usage: zeroUsage() };
  },
  async compact() {},
  async abort() {},
  async isIdle() { return true; },
  async close() {},
});

function withLocalPricing(config: ProofBladeConfig): ProofBladeConfig {
  const profile = config.modelProfiles.executor;
  if (profile.pricing) return config;
  return {
    ...config,
    modelProfiles: {
      ...config.modelProfiles,
      executor: {
        ...profile,
        pricing: { inputUsdPerMillion: 0.000001, outputUsdPerMillion: 0.000001, cacheReadUsdPerMillion: 0, cacheWriteUsdPerMillion: 0 },
      },
    },
  };
}

function zeroUsage(): AgentOutcome["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
