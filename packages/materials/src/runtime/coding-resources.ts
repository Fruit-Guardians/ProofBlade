import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import { Type } from "typebox";
import type { McpProjectRegistry } from "../mcp/registry.js";
import type { ProofBladeSkillRegistry } from "../skills/registry.js";

export const CODING_BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;

export interface CodingResourceContext extends ExecutionToolContext {
  skills: ProofBladeSkillRegistry;
  enabledSkills: Set<string>;
  mcp: McpProjectRegistry;
  enabledMcpServers: Set<string>;
}

export interface CodingToolCatalogEntry {
  name: string;
  description: string;
  schemaChars: number;
}

export function codingToolCatalog(): CodingToolCatalogEntry[] {
  return builtinTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    schemaChars: JSON.stringify(tool.parameters).length,
  }));
}

export function createCodingTools(): AgentHarnessTool<CodingResourceContext>[] {
  return [
    ...builtinTools(),
    loadSkillTool,
    listMcpServersTool,
    describeMcpServerTool,
    callMcpTool,
  ];
}

export function codingActiveToolNames(input: { tools: string[]; skills: string[]; mcpServers: string[] }): string[] {
  const selected = new Set(input.tools);
  const active: string[] = CODING_BUILTIN_TOOL_NAMES.filter((name) => selected.has(name));
  if (input.skills.length > 0) active.push("load_skill");
  if (input.mcpServers.length > 0) active.push("list_mcp_servers", "describe_mcp_server", "call_mcp_tool");
  return active;
}

function builtinTools(): AgentHarnessTool<CodingResourceContext>[] {
  return [
    createReadTool<CodingResourceContext>(),
    createBashTool<CodingResourceContext>(),
    createEditTool<CodingResourceContext>(),
    createWriteTool<CodingResourceContext>(),
  ];
}

const loadSkillTool: AgentHarnessTool<CodingResourceContext> = {
  name: "load_skill",
  label: "load_skill",
  description: "Load one enabled project Skill on demand. Skill metadata stays small until this tool is used.",
  parameters: Type.Object({
    name: Type.String({ minLength: 1, description: "Enabled Skill name." }),
    maxChars: Type.Optional(Type.Number({ minimum: 256, maximum: 12_000 })),
  }),
  executionMode: "sequential",
  async execute(_toolCallId, params, _signal, _onUpdate, context) {
    const input = params as { name: string; maxChars?: number };
    if (!context.enabledSkills.has(input.name)) throw new Error(`Skill is not enabled for this conversation: ${input.name}`);
    return toolResult(context.skills.loadForModel(input.name, input.maxChars));
  },
};

const listMcpServersTool: AgentHarnessTool<CodingResourceContext> = {
  name: "list_mcp_servers",
  label: "list_mcp_servers",
  description: "List MCP servers enabled for this conversation without connecting to them.",
  parameters: Type.Object({}),
  executionMode: "sequential",
  async execute(_toolCallId, _params, _signal, _onUpdate, context) {
    return toolResult(context.mcp.summaries().filter((server) => context.enabledMcpServers.has(server.name) && !server.disabled));
  },
};

const describeMcpServerTool: AgentHarnessTool<CodingResourceContext> = {
  name: "describe_mcp_server",
  label: "describe_mcp_server",
  description: "Connect lazily to one enabled MCP server and list its allowed tool schemas.",
  parameters: Type.Object({ server: Type.String({ minLength: 1 }) }),
  executionMode: "sequential",
  async execute(_toolCallId, params, signal, _onUpdate, context) {
    const input = params as { server: string };
    assertMcpEnabled(context, input.server);
    return toolResult(await context.mcp.describe(input.server, signal));
  },
};

const callMcpTool: AgentHarnessTool<CodingResourceContext> = {
  name: "call_mcp_tool",
  label: "call_mcp_tool",
  description: "Call one allowed tool on an enabled MCP server after inspecting its schema.",
  parameters: Type.Object({
    server: Type.String({ minLength: 1 }),
    tool: Type.String({ minLength: 1 }),
    arguments: Type.Record(Type.String(), Type.Unknown()),
  }),
  executionMode: "sequential",
  async execute(_toolCallId, params, signal, _onUpdate, context) {
    const input = params as { server: string; tool: string; arguments: Record<string, unknown> };
    assertMcpEnabled(context, input.server);
    const capabilityId = context.mcp.summaries().find((server) => server.name === input.server)?.capabilityId;
    if (!capabilityId) throw new Error(`Unknown MCP server: ${input.server}`);
    const result = await context.mcp.execute(capabilityId, "call", { tool: input.tool, arguments: input.arguments }, signal);
    return toolResult(result, result.exitCode !== 0);
  },
};

function assertMcpEnabled(context: CodingResourceContext, server: string): void {
  if (!context.enabledMcpServers.has(server)) throw new Error(`MCP server is not enabled for this conversation: ${server}`);
}

function toolResult(details: unknown, isError = false): ReturnType<AgentHarnessTool<CodingResourceContext>["execute"]> extends Promise<infer TResult> ? TResult : never {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    isError,
  } as ReturnType<AgentHarnessTool<CodingResourceContext>["execute"]> extends Promise<infer TResult> ? TResult : never;
}
