import { join } from "node:path";
import {
  AgentHarness,
  JsonlSessionRepo,
  NodeExecutionEnv,
  type AgentHarnessEvent,
} from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ProofBladeConfig } from "../config.js";
import type { ControlStore } from "../control/control-store.js";
import { prepareContextMaintenance } from "../context/maintenance-coordinator.js";
import { attachPiObservability } from "../observability/pi-events.js";
import { McpProjectRegistry } from "../mcp/registry.js";
import { ProofBladeSkillRegistry } from "../skills/registry.js";
import { codingActiveToolNames, createCodingTools, type CodingResourceContext } from "./coding-resources.js";
import { createConfiguredModels, resolveModelProfile } from "./lmstudio-provider.js";
import type { AgentLanePort, AgentOutcome } from "./pi-adapter.js";

const CODING_SYSTEM_PROMPT = `You are ProofBlade (证锋), a coding agent working with the user in their current project workspace.

Respond naturally to ordinary conversation. Use workspace tools only when the user's request benefits from inspecting, running, or editing project files. Explain completed work concisely and preserve the user's existing changes. There is no implicit challenge target, fixture, scorer, candidate, or verification workflow.`;

export class PiCodingLane implements AgentLanePort {
  private busy = false;

  private constructor(
    private readonly runId: string,
    private readonly controlStore: ControlStore,
    private readonly harness: AgentHarness<CodingResourceContext>,
    private readonly env: NodeExecutionEnv,
    private readonly closeTransport: () => Promise<void>,
    private readonly mcp: McpProjectRegistry,
  ) {}

  public static async create(options: {
    runId: string;
    projectRoot: string;
    runDir: string;
    controlStore: ControlStore;
    config: ProofBladeConfig;
    capabilities?: { enabledTools?: string[]; enabledSkills?: string[]; enabledMcpServers?: string[] };
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
    const { models, model, closeTransport } = createConfiguredModels(profile);
    const skills = await ProofBladeSkillRegistry.load(options.projectRoot);
    const mcp = McpProjectRegistry.load(options.projectRoot);
    const enabledTools = options.capabilities?.enabledTools ?? ["read", "bash", "edit", "write"];
    const enabledSkills = new Set(options.capabilities?.enabledSkills ?? skills.list().map((skill) => skill.name));
    const enabledMcpServers = new Set(options.capabilities?.enabledMcpServers ?? mcp.summaries().filter((server) => !server.disabled).map((server) => server.name));
    const resources = skills.piSkills().filter((skill) => enabledSkills.has(skill.name));
    const tools = createCodingTools();
    const activeToolNames = codingActiveToolNames({ tools: enabledTools, skills: [...enabledSkills], mcpServers: [...enabledMcpServers] });
    const toolContext: CodingResourceContext = { env, skills, mcp, enabledSkills, enabledMcpServers };
    const harness = new AgentHarness<CodingResourceContext>({
      session,
      models,
      model,
      tools,
      activeToolNames,
      resources: { skills: resources },
      toolContext,
      thinkingLevel: profile.thinkingLevel ?? "off",
      systemPrompt: () => codingSystemPrompt(resources, mcp.summaries().filter((server) => enabledMcpServers.has(server.name) && !server.disabled)),
      streamOptions: { timeoutMs: profile.requestTimeoutMs, maxRetries: profile.maxRetries, cacheRetention: profile.cacheRetention },
    });
    const contextBudget = Math.max(256, profile.contextWindow - profile.maxTokens - 2_048);
    harness.on("context", ({ messages }) => {
      const prepared = prepareContextMaintenance({ messages, availableTokens: contextBudget, messageBudget: contextBudget });
      return { messages: prepared.messages };
    });
    attachPiObservability(harness, {
      runId: options.runId,
      lane: "main",
      controlStore: options.controlStore,
    });
    if (options.onEvent) harness.subscribe(options.onEvent);
    return new PiCodingLane(options.runId, options.controlStore, harness, env, closeTransport, mcp);
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
    try {
      await this.harness.waitForIdle();
    } finally {
      try {
        await this.env.cleanup();
      } finally {
        try {
          await this.closeTransport();
        } finally {
          await this.mcp.close();
        }
      }
    }
  }
}

function codingSystemPrompt(skills: Array<{ name: string; description: string }>, mcpServers: Array<{ name: string; description: string }>): string {
  const resources = [
    skills.length > 0 ? `\nEnabled Skills:\n${skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}\nUse load_skill to load a Skill only when it is relevant.` : "",
    mcpServers.length > 0 ? `\nEnabled MCP servers:\n${mcpServers.map((server) => `- ${server.name}: ${server.description}`).join("\n")}\nUse mcp_call with operation=describe before operation=call.` : "",
  ].join("");
  return `${CODING_SYSTEM_PROMPT}${resources}`;
}
