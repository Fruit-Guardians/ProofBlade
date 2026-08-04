import { join } from "node:path";
import {
  AgentHarness,
  JsonlSessionRepo,
  NodeExecutionEnv,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessEvent,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { planContextMaintenance } from "@proofblade/molecules";
import type { ProofBladeConfig } from "../config.js";
import type { ControlStore } from "../control/control-store.js";
import { pruneAgentMessages, repairAgentMessages } from "../context/agent-pruner.js";
import { attachPiObservability } from "../observability/pi-events.js";
import { createConfiguredModels, resolveModelProfile } from "./lmstudio-provider.js";
import type { AgentLanePort, AgentOutcome } from "./pi-adapter.js";

const CODING_SYSTEM_PROMPT = `You are ProofBlade (证锋), a coding agent working with the user in their current project workspace.

Respond naturally to ordinary conversation. Use workspace tools only when the user's request benefits from inspecting, running, or editing project files. Explain completed work concisely and preserve the user's existing changes. There is no implicit challenge target, fixture, scorer, candidate, or verification workflow.`;

export class PiCodingLane implements AgentLanePort {
  private busy = false;

  private constructor(
    private readonly runId: string,
    private readonly controlStore: ControlStore,
    private readonly harness: AgentHarness<ExecutionToolContext>,
    private readonly env: NodeExecutionEnv,
  ) {}

  public static async create(options: {
    runId: string;
    projectRoot: string;
    runDir: string;
    controlStore: ControlStore;
    config: ProofBladeConfig;
    onEvent?: (event: AgentHarnessEvent) => void | Promise<void>;
  }): Promise<PiCodingLane> {
    const env = new NodeExecutionEnv({ cwd: options.projectRoot });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(options.runDir, "pi-sessions") });
    const sessionId = `${options.runId}-chat`;
    const known = await repo.list({ cwd: options.projectRoot });
    const metadata = known.find((item) => item.id === sessionId);
    const session = metadata
      ? await repo.open(metadata)
      : await repo.create({
        id: sessionId,
        cwd: options.projectRoot,
        metadata: { runId: options.runId, lane: "main", purpose: "chat" },
      });
    const profile = await resolveModelProfile(options.config.modelProfiles.executor);
    const { models, model } = createConfiguredModels(profile);
    const tools = [
      createReadTool<ExecutionToolContext>(),
      createBashTool<ExecutionToolContext>(),
      createEditTool<ExecutionToolContext>(),
      createWriteTool<ExecutionToolContext>(),
    ];
    const harness = new AgentHarness<ExecutionToolContext>({
      session,
      models,
      model,
      tools,
      activeToolNames: tools.map((tool) => tool.name),
      toolContext: { env },
      thinkingLevel: profile.thinkingLevel ?? "off",
      systemPrompt: CODING_SYSTEM_PROMPT,
      streamOptions: { timeoutMs: profile.requestTimeoutMs, maxRetries: profile.maxRetries },
    });
    const contextBudget = Math.max(256, profile.contextWindow - profile.maxTokens - 2_048);
    harness.on("context", ({ messages }) => {
      const repaired = repairAgentMessages(messages);
      const plan = planContextMaintenance(repaired.estimatedTokens, contextBudget);
      if (!plan.shouldSnip) return { messages: repaired.messages };
      const mode = plan.forceCompact ? "emergency" : plan.shouldPrune ? "prune" : "snip";
      return { messages: pruneAgentMessages(repaired.messages, contextBudget, { mode }).messages };
    });
    attachPiObservability(harness, {
      runId: options.runId,
      lane: "main",
      controlStore: options.controlStore,
    });
    if (options.onEvent) harness.subscribe(options.onEvent);
    return new PiCodingLane(options.runId, options.controlStore, harness, env);
  }

  public async prompt(text: string): Promise<AgentOutcome> {
    this.busy = true;
    const correlationId = `${this.runId}:main:chat-turn`;
    await this.controlStore.append(this.runId, [{
      schemaVersion: 1,
      lane: "main",
      correlationId,
      actor: "orchestrator",
      type: "turn_started",
      payload: { promptLength: text.length },
    }]);
    try {
      const response = await this.harness.prompt(text);
      const output = response.content
        .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      await this.controlStore.append(this.runId, [{
        schemaVersion: 1,
        lane: "main",
        correlationId,
        actor: "model",
        type: "assistant_message",
        payload: { text: output, stopReason: response.stopReason },
      }]);
      return {
        text: output,
        stopReason: response.stopReason,
        usage: response.usage as AssistantMessage["usage"],
        errorMessage: response.errorMessage,
      };
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
    await this.env.cleanup();
  }
}
