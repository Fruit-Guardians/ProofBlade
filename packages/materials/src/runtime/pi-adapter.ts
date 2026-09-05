import { join } from "node:path";
import {
  AgentHarness,
  createReadTool,
  JsonlSessionRepo,
  NodeExecutionEnv,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ControlStore } from "../control/control-store.js";
import type { Lane } from "../domain/types.js";
import { ContextCompiler, contextText } from "../context/compiler.js";
import type { ProofBladeConfig } from "../config.js";
import { createConfiguredModels, effectiveCacheRetention, resolveModelProfile } from "./lmstudio-provider.js";
import { attachPiObservability, createProviderSchedulingTelemetry, type ContextManifestSummary } from "../observability/pi-events.js";
import type { ResultVerificationProjection } from "../verification/claim-verification.js";
import { persistedAssistantText } from "./assistant-message.js";

export interface AgentOutcome {
  text: string;
  stopReason: string;
  usage: AssistantMessage["usage"];
  errorMessage?: string;
  resultVerification?: ResultVerificationProjection;
  /** @deprecated Use resultVerification for new consumers. */
  claimVerification?: ResultVerificationProjection;
  termination?: "repeated_tool_failure" | "no_progress" | "tool_failure_storm" | "experiment_budget" | "tool_budget_exhausted" | "budget_exhausted" | "deadline_exhausted";
}

export interface AgentLanePort {
  prompt(text: string): Promise<AgentOutcome>;
  compact(reason: string): Promise<void>;
  abort(reason: string): Promise<void>;
  isIdle(): Promise<boolean>;
  close(): Promise<void>;
}

export class PiAgentLane implements AgentLanePort {
  private busy = false;

  private constructor(
    private readonly runId: string,
    private readonly lane: Lane,
    private readonly controlStore: ControlStore,
    private readonly harness: AgentHarness<ExecutionToolContext>,
  ) {}

  public static async create(options: {
    runId: string;
    lane?: Lane;
    runDir: string;
    controlStore: ControlStore;
    config: ProofBladeConfig;
  }): Promise<PiAgentLane> {
    const lane = options.lane ?? "executor";
    const env = new NodeExecutionEnv({ cwd: options.runDir });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(options.runDir, "pi-sessions") });
    const sessionId = `${options.runId}-${lane}`;
    const known = await repo.list({ cwd: options.runDir });
    const metadata = known.find((item) => item.id === sessionId);
    const session = metadata
      ? await repo.open(metadata)
      : await repo.create({ id: sessionId, cwd: options.runDir, metadata: { runId: options.runId, lane } });
    const profile = await resolveModelProfile(options.config.modelProfiles.executor);
    const scheduling = createProviderSchedulingTelemetry({ runId: options.runId, lane, controlStore: options.controlStore });
    const { models, model } = createConfiguredModels(profile, undefined, { observer: scheduling.observer });
    const snapshot = await options.controlStore.snapshot(options.runId);
    const compiled = new ContextCompiler().build({
      runId: options.runId,
      lane,
      phase: snapshot.phase,
      task: snapshot.task,
      snapshot,
      contextWindow: profile.contextWindow,
    });
    const readTool = createReadTool<ExecutionToolContext>();
    const harness = new AgentHarness<ExecutionToolContext>({
      session,
      models,
      model,
      tools: [readTool],
      activeToolNames: ["read"],
      toolContext: { env },
      thinkingLevel: profile.thinkingLevel ?? "off",
      systemPrompt: contextText(compiled),
      streamOptions: { timeoutMs: profile.requestTimeoutMs, maxRetries: profile.maxRetries, maxRetryDelayMs: profile.maxRetryDelayMs, cacheRetention: effectiveCacheRetention(profile) },
    });
    attachPiObservability(harness, {
      runId: options.runId,
      lane,
      controlStore: options.controlStore,
      estimateContextTokens: async () => {
        const current = await options.controlStore.snapshot(options.runId);
        return new ContextCompiler().build({ runId: options.runId, lane, phase: current.phase, task: current.task, snapshot: current, contextWindow: profile.contextWindow }).estimatedTokens;
      },
      getContextSnapshot: async () => {
        const current = await options.controlStore.snapshot(options.runId);
        const currentContext = new ContextCompiler().build({ runId: options.runId, lane, phase: current.phase, task: current.task, snapshot: current, contextWindow: profile.contextWindow });
        return contextSnapshot(currentContext.manifest);
      },
      scheduling,
    });
    return new PiAgentLane(options.runId, lane, options.controlStore, harness);
  }

  public async prompt(text: string): Promise<AgentOutcome> {
    this.busy = true;
    await this.controlStore.append(this.runId, [{
      schemaVersion: 1,
      lane: this.lane,
      correlationId: `${this.runId}:${this.lane}:turn`,
      actor: "orchestrator",
      type: "turn_started",
      payload: { promptHash: text.length },
    }]);
    try {
      const response = await this.harness.prompt(text);
      const output = response.content
        .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const task = await this.controlStore.snapshot(this.runId);
      await this.controlStore.append(this.runId, [
        {
          schemaVersion: 1,
          lane: this.lane,
          correlationId: `${this.runId}:${this.lane}:turn`,
          actor: "model",
          type: "assistant_message",
          payload: { ...persistedAssistantText(task.task.mode, output), stopReason: response.stopReason },
        },
      ]);
      return { text: output, stopReason: response.stopReason, usage: response.usage, errorMessage: response.errorMessage };
    } finally {
      this.busy = false;
    }
  }

  public async abort(_reason: string): Promise<void> {
    await this.harness.abort();
  }

  public async compact(reason: string): Promise<void> {
    await this.harness.compact(reason);
  }

  public async isIdle(): Promise<boolean> {
    return !this.busy;
  }

  public async close(): Promise<void> {
    await this.harness.waitForIdle();
  }
}

export function contextSnapshot(manifest: import("../domain/types.js").ContextManifest): {
  estimatedTokens: number;
  manifestHash: string;
  cache: import("../domain/types.js").ContextManifest["cache"];
  contextWindow: number;
  manifestSummary: ContextManifestSummary;
} {
  return {
    estimatedTokens: manifest.budget.estimatedInput,
    manifestHash: manifest.hash,
    cache: manifest.cache,
    contextWindow: manifest.budget.contextWindow,
    manifestSummary: {
      hash: manifest.hash,
      layerTokens: { ...manifest.layerTokens },
      blockHashes: Object.fromEntries((manifest.blocks ?? []).map((block) => [block.id, block.contentHash])),
      ...(manifest.observationQueue ? { observationQueue: manifest.observationQueue } : {}),
      ...(manifest.firstChangedBlock ? { firstChangedBlock: manifest.firstChangedBlock } : {}),
      ...(manifest.compressionTarget ? { compressionTarget: manifest.compressionTarget } : {}),
      droppedCount: manifest.dropped.length,
      maintenance: { stage: manifest.maintenance.stage, ...(manifest.maintenance.targetRatio === undefined ? {} : { targetRatio: manifest.maintenance.targetRatio }), ...(manifest.maintenance.hardRatio === undefined ? {} : { hardRatio: manifest.maintenance.hardRatio }), shouldCompact: manifest.maintenance.shouldCompact, forceCompact: manifest.maintenance.forceCompact, ...(manifest.maintenance.target ? { target: manifest.maintenance.target } : {}), ...(manifest.maintenance.nextAction ? { nextAction: manifest.maintenance.nextAction } : {}) },
      budget: { contextWindow: manifest.budget.contextWindow, availableInput: manifest.budget.availableInput, estimatedInput: manifest.budget.estimatedInput, ratio: manifest.budget.ratio, overBudget: manifest.budget.overBudget },
    },
  };
}
