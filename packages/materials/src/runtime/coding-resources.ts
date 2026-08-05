import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import type { OutputRewritePort, OutputRewriteTicket } from "@proofblade/molecules";
import { Type } from "typebox";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { McpProjectRegistry } from "../mcp/registry.js";
import type { ProofBladeSkillRegistry } from "../skills/registry.js";
import type { CodingEvidenceGraph } from "../knowledge/evidence-graph.js";
import type { CodingClaimVerifier } from "../verification/claim-verification.js";

export const CODING_BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;
export const CODING_PROXY_TOOL_NAMES = ["verify_claim", "evidence", "load_skill", "mcp_call"] as const;

export interface CodingResourceContext extends ExecutionToolContext {
  skills: ProofBladeSkillRegistry;
  mcp: McpProjectRegistry;
  enabledSkills: Set<string>;
  enabledMcpServers: Set<string>;
  claimVerifier: CodingClaimVerifier;
  evidenceGraph: CodingEvidenceGraph;
  outputRewrite?: {
    port: OutputRewritePort;
    artifactStore: ArtifactStore;
    runId: string;
  };
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
    verifyClaimTool,
    evidenceTool,
    loadSkillTool,
    mcpCallTool,
  ];
}

const verifyClaimTool: AgentHarnessTool<CodingResourceContext> = {
  name: "verify_claim",
  label: "verify_claim",
  description: "Reproduce a final challenge answer with a deterministic workspace command. The command must derive and print the candidate without embedding the candidate literal. A match creates durable Artifact, Evidence, and accepted Completion records.",
  parameters: Type.Object({
    candidate: Type.String({ minLength: 1, maxLength: 1_024, description: "Exact final candidate that the answer will report." }),
    command: Type.String({ minLength: 1, maxLength: 16_000, description: "Deterministic command that derives the candidate from workspace inputs and prints it." }),
    evidenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 16, description: "Supporting evidence ids used by the reproduction." })),
    timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 120 })),
  }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(toolCallId, params, signal, onUpdate, context) {
    const input = params as { candidate: string; command: string; evidenceIds?: string[]; timeout?: number };
    const candidate = input.candidate.trim();
    const command = input.command.trim();
    if (!candidate || !command) throw new Error("verify_claim requires a candidate and reproduction command");
    if (command.includes(candidate)) throw new Error("Reproduction command embeds the candidate literal; derive it from workspace inputs instead");
    const executor = createBashTool<CodingResourceContext>();
    const result = await executor.execute(toolCallId, { command, timeout: input.timeout }, signal, onUpdate, context);
    const output = result.content.map((item) => item.type === "text" ? item.text : "[image]").join("\n");
    if (!output.includes(candidate)) throw new Error("Reproduction output does not contain the exact candidate");
    const reproduction = await context.claimVerifier.record({ candidate, command, cwd: context.env.cwd, output, toolCallId, supportingEvidenceIds: input.evidenceIds });
    return toolResult({
      verified: true,
      candidateHash: reproduction.candidateHash,
      commandHash: reproduction.commandHash,
      artifactId: reproduction.artifactId,
      evidenceId: reproduction.evidenceId,
      completionId: reproduction.completionId,
      supportingEvidenceIds: reproduction.supportingEvidenceIds,
      output,
    });
  },
};

const evidenceTool: AgentHarnessTool<CodingResourceContext> = {
  name: "evidence",
  label: "evidence",
  description: "Search, read, annotate, or record the durable evidence graph through one cache-stable proxy. Record promotes and labels its artifacts while creating Evidence and an optional Fact, so do not annotate first. Use annotate only for metadata that should not become Evidence. Record only material findings.",
  parameters: Type.Union([
    Type.Object({
      operation: Type.Literal("search"),
      query: Type.Optional(Type.String({ maxLength: 200 })),
      tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 16 })),
    }, { additionalProperties: false }),
    Type.Object({
      operation: Type.Literal("read"),
      artifactId: Type.String({ minLength: 1 }),
      maxChars: Type.Optional(Type.Number({ minimum: 256, maximum: 12_000 })),
    }, { additionalProperties: false }),
    Type.Object({
      operation: Type.Literal("annotate"),
      artifactId: Type.String({ minLength: 1 }),
      name: Type.String({ minLength: 1, maxLength: 160 }),
      summary: Type.String({ minLength: 1, maxLength: 1_000 }),
      tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 16 })),
      role: Type.Optional(Type.Union([Type.Literal("supporting"), Type.Literal("intermediate"), Type.Literal("debug"), Type.Literal("result")])),
      relatedIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32 })),
    }, { additionalProperties: false }),
    Type.Object({
      operation: Type.Literal("record"),
      artifactIds: Type.Array(Type.String({ minLength: 1, description: "Stable A-* ids returned by read/bash or evidence search; file paths are not artifact ids." }), { minItems: 1, maxItems: 16 }),
      name: Type.String({ minLength: 1, maxLength: 160 }),
      summary: Type.String({ minLength: 1, maxLength: 1_000 }),
      tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 16 })),
      dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 16 })),
      claim: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
    }, { additionalProperties: false }),
  ]),
  executionMode: "sequential",
  async execute(_toolCallId, params, _signal, _onUpdate, context) {
    const input = params as {
      operation: "search" | "read" | "annotate" | "record";
      query?: string;
      artifactId?: string;
      artifactIds?: string[];
      name?: string;
      summary?: string;
      tags?: string[];
      role?: "supporting" | "intermediate" | "debug" | "result";
      relatedIds?: string[];
      dependsOn?: string[];
      claim?: string;
      maxChars?: number;
    };
    if (!("operation" in input) || !["search", "read", "annotate", "record"].includes(input.operation)) throw new Error(`Unsupported evidence operation: ${String(input.operation)}`);
    if (input.operation === "search") {
      assertAbsent(input, ["artifactId", "artifactIds", "name", "summary", "role", "relatedIds", "dependsOn", "claim", "maxChars"], "evidence search");
      return toolResult({ results: await context.evidenceGraph.search(input.query, input.tags) });
    }
    if (input.operation === "read") {
      assertAbsent(input, ["query", "artifactIds", "name", "summary", "tags", "role", "relatedIds", "dependsOn", "claim"], "evidence read");
      if (!input.artifactId) throw new Error("evidence read requires artifactId");
      return toolResult(await context.evidenceGraph.readArtifact(input.artifactId, input.maxChars));
    }
    if (input.operation === "annotate") {
      assertAbsent(input, ["query", "artifactIds", "dependsOn", "claim", "maxChars"], "evidence annotate");
      if (!input.artifactId || !input.name || !input.summary) throw new Error("evidence annotate requires artifactId, name, and summary");
      return toolResult(await context.evidenceGraph.annotateArtifact({ artifactId: input.artifactId, name: input.name, summary: input.summary, tags: input.tags, role: input.role, relatedIds: input.relatedIds }));
    }
    assertAbsent(input, ["query", "artifactId", "role", "relatedIds", "maxChars"], "evidence record");
    if (!input.artifactIds || !input.name || !input.summary) throw new Error("evidence record requires artifactIds, name, and summary");
    return toolResult(await context.evidenceGraph.recordEvidence({ name: input.name, summary: input.summary, artifactIds: input.artifactIds, tags: input.tags, claim: input.claim, dependsOn: input.dependsOn }));
  },
};

export function codingActiveToolNames(input: { tools: string[]; skills: string[]; mcpServers: string[] }): string[] {
  const selected = new Set(input.tools);
  const active: string[] = CODING_BUILTIN_TOOL_NAMES.filter((name) => selected.has(name));
  active.push(...CODING_PROXY_TOOL_NAMES);
  return active;
}

export function codingProviderToolContractSnapshot(): Array<{ name: string; description: string; parameters: unknown }> {
  return createCodingTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.parameters),
  }));
}

function builtinTools(): AgentHarnessTool<CodingResourceContext>[] {
  return [
    createCodingReadTool(),
    createCodingBashTool(),
    createEditTool<CodingResourceContext>(),
    createWriteTool<CodingResourceContext>(),
  ];
}

function createCodingReadTool(): AgentHarnessTool<CodingResourceContext> {
  const contract = createReadTool<CodingResourceContext>();
  return {
    ...contract,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const input = params as { path: string; offset?: number; limit?: number };
      const result = await contract.execute(toolCallId, input, signal, onUpdate, context);
      const pipeline = context.outputRewrite;
      const visible = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      if (!pipeline || !visible || result.content.some((item) => item.type === "image")) return result;
      const artifact = await pipeline.artifactStore.putText(pipeline.runId, visible, {
        filename: `read-${toolCallId}.txt`,
        mime: "text/plain",
        sensitivity: "public",
        semantic: {
          name: `文件读取 · ${pathTitle(input.path)}`,
          summary: `读取 ${input.path}${readRange(input)} 的文本结果，${Buffer.byteLength(visible)} bytes。`,
          tags: ["read", "file-content", pathTitle(input.path)],
          role: "intermediate",
          relatedIds: [],
          annotatedBy: "harness",
        },
      });
      return {
        ...result,
        content: [...result.content, artifactAnchor(artifact.id)],
        details: { ...(result.details ?? {}), artifactId: artifact.id, artifactHash: artifact.sha256 },
      };
    },
  };
}

function createCodingBashTool(): AgentHarnessTool<CodingResourceContext> {
  const contract = createBashTool<CodingResourceContext>();
  return {
    ...contract,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const pipeline = context.outputRewrite;
      if (!pipeline) return await contract.execute(toolCallId, params as { command: string; timeout?: number }, signal, onUpdate, context);
      const input = params as { command: string; timeout?: number };
      const ticket = await pipeline.port.prepare({ toolCallId, command: input.command, cwd: context.env.cwd }, signal);
      const executor = createBashTool<CodingResourceContext>({
        async prepare(execution) {
          Object.assign(execution.env, ticket.executionEnv);
        },
      });
      let result: Awaited<ReturnType<typeof executor.execute>>;
      try {
        result = await executor.execute(toolCallId, { ...input, command: ticket.command }, signal, onUpdate, context);
      } catch (error) {
        const visible = error instanceof Error ? error.message : String(error);
        const outputRewrite = await finalizeAndArchive(pipeline, ticket, visible, toolCallId, input.command, "debug");
        throw new Error(`${visible}\n\n[ProofBlade output artifact ${outputRewrite.artifactId}; rewrite=${outputRewrite.provider}]`, { cause: error });
      }
      const visible = result.content.map((item) => item.type === "text" ? item.text : "[image]").join("\n");
      const outputRewrite = await finalizeAndArchive(pipeline, ticket, visible, toolCallId, input.command, "intermediate");
      return {
        ...result,
        content: [...result.content, artifactAnchor(String(outputRewrite.artifactId))],
        details: {
          ...(isRecord(result.details) ? result.details : result.details === undefined ? {} : { toolDetails: result.details }),
          outputRewrite,
        },
      };
    },
  };
}

async function finalizeAndArchive(
  pipeline: NonNullable<CodingResourceContext["outputRewrite"]>,
  ticket: OutputRewriteTicket,
  visibleOutput: string,
  toolCallId: string,
  command: string,
  role: "intermediate" | "debug",
): Promise<Record<string, unknown>> {
  const finalized = await pipeline.port.finalize(ticket, visibleOutput);
  const artifact = await pipeline.artifactStore.putText(pipeline.runId, finalized.rawOutput, {
    filename: `bash-${toolCallId}-raw.txt`,
    mime: "text/plain",
    sensitivity: "public",
    truncated: finalized.rawTruncated,
    semantic: {
      name: `命令输出 · ${commandTitle(command)}`,
      summary: `${role === "debug" ? "失败命令" : "命令"}的原始输出，${finalized.rawBytes} bytes${finalized.rawTruncated ? "，已截断" : ""}。`,
      tags: ["bash", "command-output", ticket.provider],
      role,
      relatedIds: [],
      annotatedBy: "harness",
    },
  });
  const savedBytes = Math.max(0, finalized.rawBytes - finalized.visibleBytes);
  return {
    requestedProvider: ticket.requestedProvider,
    provider: ticket.provider,
    providerVersion: ticket.providerVersion,
    applied: ticket.applied,
    fallbackReason: ticket.fallbackReason,
    originalCommandHash: ticket.originalCommandHash,
    rewrittenCommandHash: ticket.rewrittenCommandHash,
    rawCapture: finalized.rawCapture,
    rawBytes: finalized.rawBytes,
    visibleBytes: finalized.visibleBytes,
    savedBytes,
    savingsRate: finalized.rawBytes > 0 ? Number((savedBytes / finalized.rawBytes).toFixed(4)) : 0,
    rawTruncated: finalized.rawTruncated,
    artifactId: artifact.id,
    artifactHash: artifact.sha256,
  };
}

function commandTitle(command: string): string {
  const first = command.split(/\r?\n/, 1)[0]?.trim().replace(/\s+/g, " ") ?? "bash";
  return first.length > 100 ? `${first.slice(0, 97)}...` : first;
}

function pathTitle(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/");
  const title = normalized.split("/").filter(Boolean).at(-1) ?? normalized;
  return title.length > 100 ? `${title.slice(0, 97)}...` : title;
}

function readRange(input: { offset?: number; limit?: number }): string {
  const parts = [input.offset !== undefined ? `offset=${input.offset}` : "", input.limit !== undefined ? `limit=${input.limit}` : ""].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function artifactAnchor(artifactId: string): { type: "text"; text: string } {
  return { type: "text", text: `[ProofBlade artifact ${artifactId}; use this id with the evidence tool]` };
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

const mcpCallTool: AgentHarnessTool<CodingResourceContext> = {
  name: "mcp_call",
  label: "mcp_call",
  description: "List, inspect, or call enabled MCP capabilities through one cache-stable proxy. Use describe before call.",
  parameters: Type.Object({
    operation: Type.Union([Type.Literal("list"), Type.Literal("describe"), Type.Literal("call")]),
    server: Type.Optional(Type.String({ minLength: 1, description: "Enabled MCP server name for describe or call." })),
    tool: Type.Optional(Type.String({ minLength: 1, description: "Allowed MCP tool name for call." })),
    arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "MCP tool arguments for call." })),
  }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_toolCallId, params, signal, _onUpdate, context) {
    const input = params as { operation: "list" | "describe" | "call"; server?: string; tool?: string; arguments?: Record<string, unknown> };
    if (!(["list", "describe", "call"] as const).includes(input.operation)) throw new Error(`Unsupported MCP operation: ${String(input.operation)}`);
    if (input.operation === "list") {
      assertAbsent(input, ["server", "tool", "arguments"], "MCP list");
      return toolResult({ servers: enabledMcpSummaries(context) });
    }
    if (!input.server) throw new Error(`MCP ${input.operation} requires server`);
    assertMcpEnabled(context, input.server);
    if (input.operation === "describe") {
      assertAbsent(input, ["tool", "arguments"], "MCP describe");
      return toolResult({ server: input.server, tools: await context.mcp.describe(input.server, signal) });
    }
    if (!input.tool || !input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)) throw new Error("MCP call requires tool and object arguments");
    const capabilityId = context.mcp.summaries().find((server) => server.name === input.server)?.capabilityId;
    if (!capabilityId) throw new Error(`Unknown MCP server: ${input.server}`);
    const result = await context.mcp.execute(capabilityId, "call", { tool: input.tool, arguments: input.arguments }, signal);
    return toolResult(result, result.exitCode !== 0);
  },
};

function assertMcpEnabled(context: CodingResourceContext, server: string): void {
  if (!context.enabledMcpServers.has(server)) throw new Error(`MCP server is not enabled for this conversation: ${server}`);
  if (!enabledMcpSummaries(context).some((item) => item.name === server)) throw new Error(`Unknown or disabled MCP server: ${server}`);
}

function enabledMcpSummaries(context: CodingResourceContext): ReturnType<McpProjectRegistry["summaries"]> {
  return context.mcp.summaries().filter((server) => context.enabledMcpServers.has(server.name) && !server.disabled);
}

function assertAbsent(input: Record<string, unknown>, keys: string[], operation: string): void {
  const unexpected = keys.filter((key) => input[key] !== undefined);
  if (unexpected.length > 0) throw new Error(`${operation} does not accept: ${unexpected.join(", ")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolResult(details: unknown, isError = false): ReturnType<AgentHarnessTool<CodingResourceContext>["execute"]> extends Promise<infer TResult> ? TResult : never {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    isError,
  } as ReturnType<AgentHarnessTool<CodingResourceContext>["execute"]> extends Promise<infer TResult> ? TResult : never;
}
