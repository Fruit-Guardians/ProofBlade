import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import { snipText, type OutputRewritePort, type OutputRewriteTicket } from "@proofblade/molecules";
import { Type } from "typebox";
import { sha256 } from "../domain/utils.js";
import { boundModelText, boundedRequestedChars } from "../domain/text-bounds.js";
import { createModelReceipt, renderModelReceipt } from "../context/model-receipt.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { ControlStore } from "../control/control-store.js";
import type { McpProjectRegistry } from "../mcp/registry.js";
import type { ProofBladeSkillRegistry } from "../skills/registry.js";
import type { CodingEvidenceGraph } from "../knowledge/evidence-graph.js";
import { KNOWLEDGE_READ_MAX_TOKENS } from "../knowledge/projection.js";
import type { EvidenceCurationGate } from "../knowledge/evidence-curation-gate.js";
import type { CodingClaimVerifier } from "../verification/claim-verification.js";
import type { ToolEffectPolicy, ToolEffectPolicyResolver } from "./tool-repeat-breaker.js";
import type { ProofBladeToolRuntime } from "../tools/runtime.js";
import type { Lane, RawEffectResult, TargetKind } from "../domain/types.js";
import type { PwnToolHandler } from "../pwn/pwn-tools.js";
import { createPwnCodingTools } from "./pwn-coding-tools.js";
import type { ExperimentGate } from "../competition/experiment-gate.js";
import type { WebExploitRecipe } from "../verification/web-reproducer.js";
import type { WebToolHandler } from "../web/web-tools.js";
import { createWebSessionTools } from "./web-coding-tools.js";
import { globWorkspace, grepWorkspace, limitWorkspaceSearchResult, workspaceSearchHash, workspaceSearchText, WORKSPACE_SEARCH_MODEL_MAX_CHARS } from "./workspace-search.js";
import { RunEventIngress } from "../orchestration/event-ingress.js";

export const CODING_BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "glob", "grep"] as const;
export const CODING_PROXY_TOOL_NAMES = ["verify_result", "verify_claim", "evidence", "load_skill", "capability", "mcp_call", "shell_background", "shell_job"] as const;
export const CODING_WEB_TOOL_NAMES = ["web_reproduce"] as const;
/** Interactive HTTP session tools (exploration counterpart to web_reproduce). */
export const CODING_WEB_SESSION_TOOL_NAMES = ["web_open", "web_request", "web_replay", "web_close", "web_list"] as const;
export const CODING_PWN_TOOL_NAMES = ["pwn_open", "pwn_send", "pwn_recv", "pwn_signal", "pwn_close", "pwn_list", "pwn_record_primitive", "pwn_reproduce"] as const;
const MODEL_TOOL_RESULT_MAX_TOKENS = 4_096;

const IDALIB_FIRST_CLASS_TOOLS = new Set([
  "idalib_open", "idalib_current", "survey_binary", "list_funcs", "lookup_funcs", "decompile", "disasm",
  "analyze_batch", "analyze_function", "imports", "xrefs_to", "get_string", "search_text",
]);
const JADX_FIRST_CLASS_TOOLS = new Set([
  "get_android_manifest", "get_main_activity_class", "get_main_application_classes_names", "get_main_application_classes_code",
  "get_class_source", "get_methods_of_class", "get_method_by_name", "get_strings", "search_classes_by_keyword",
  "search_method_by_name", "get_xrefs_to_class", "get_xrefs_to_method",
]);

/** Verdict returned by a real platform submission. */
export interface CodingFlagSubmission {
  accepted: boolean;
  completionId: string;
  candidateHash: string;
  /** True when this exact flag was already submitted and the stored verdict was replayed. */
  replayed: boolean;
  /** True in assist mode: recorded for operator approval, platform not contacted. */
  heldForApproval?: boolean;
  message?: string;
  submissionsUsed: number;
  submissionsRemaining: number;
}

export interface CodingResourceContext extends ExecutionToolContext {
  /** Durable owner identity for lane-scoped shell process records. */
  ownerLane?: Lane;
  controlStore: ControlStore;
  artifactStore: ArtifactStore;
  skills: ProofBladeSkillRegistry;
  mcp: McpProjectRegistry;
  enabledSkills: Set<string>;
  enabledMcpServers: Set<string>;
  claimVerifier: CodingClaimVerifier;
  /**
   * Stop the current Pi turn after verify_claim so the outer Run coordinator
   * can perform verifier-owned scoring before the model issues another tool
   * call. Competition lanes leave this unset so submit_flag may follow a
   * preliminary observation in the same turn.
   */
  deferClaimAcceptance?: boolean;
  /** Keep claim verification in the same continuous maintenance loop. */
  continuousRecovery?: boolean;
  evidenceGraph: CodingEvidenceGraph;
  evidenceCurationGate?: EvidenceCurationGate;
  runtime: ProofBladeToolRuntime;
  /** Durable per-run gate for repeated process/network experiments. */
  experimentGate?: ExperimentGate;
  webReproduce?: (recipe: WebExploitRecipe, signal?: AbortSignal) => Promise<unknown>;
  /**
   * Present only when the task has a resolvable web target. Drives interactive
   * HTTP session tools (web_open/request/replay/close/list); absent for non-web
   * runs, in which case those tools fail closed with a clear message.
   */
  webSession?: WebToolHandler;
  /** Present only when the run is judged by a live competition platform. */
  submitFlag?: (flag: string, signal?: AbortSignal) => Promise<CodingFlagSubmission>;
  /** Hard ceiling in seconds on any single `bash` call. Unset means no ceiling. */
  bashTimeoutSecondsMax?: number;
  /**
   * Present only when a Docker-backed pwn/pwn-kernel container or durable
   * session-runtime broker is available.
   * Absent for GUI chat and no-container runs, in which case the pwn_* tools
   * fail closed with a clear message instead of pretending to have a tube.
   */
  pwnTools?: PwnToolHandler;
  outputRewrite?: {
    port: OutputRewritePort;
    artifactStore: ArtifactStore;
    runId: string;
  };
  /**
   * Per-lane bounded index of output content already shown to the model. A
   * repeated hash can be represented by an Artifact reference instead of
   * reinjecting the entire stdout into the next provider request.
   */
  artifactOutputRefs?: Map<string, { artifactId: string; count: number }>;
  /**
   * Per-run count of how many times each distinct image has been read, keyed by
   * the image CONTENT hash (not path). Identical bytes give no new information on
   * re-read, but each re-read re-injects the full image block; enough copies push
   * the reasoning history out of context and the model "forgets" it already
   * looked, then loops. The read wrapper uses this to stop re-injecting after a
   * small budget and nudge toward a different tactic — while a changed file
   * (new bytes → new key) still gets delivered, and path aliases for the same
   * bytes share one counter. See {@link dedupeImageRead}.
   */
  imagesSeen?: Map<string, number>;
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

export function createCodingTools(options: { platformJudged?: boolean; webReproductionEnabled?: boolean; webSessionEnabled?: boolean } = {}): AgentHarnessTool<CodingResourceContext>[] {
  return [
    ...builtinTools(),
    verifyResultTool,
    verifyClaimTool,
    evidenceTool,
    loadSkillTool,
    capabilityTool,
    mcpCallTool,
    shellBackgroundTool,
    shellJobTool,
    ...createPwnCodingTools(),
    ...(options.webSessionEnabled ? createWebSessionTools() : []),
    ...(options.webReproductionEnabled ? [webReproduceTool] : []),
    // Registered only for platform-judged runs: it spends a real submission, and
    // a GUI chat run has no platform to submit to.
    ...(options.platformJudged ? [submitFlagTool] : []),
  ];
}

/** First-class tool name for an MCP server tool: mcp__<server>__<tool>. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/**
 * Enumerate each enabled MCP server's tools and expose them as FIRST-CLASS
 * provider tools (mcp__<server>__<tool>) with their real input schemas, the way
 * Claude Code / the Anthropic API surface MCP — instead of hiding everything
 * behind the generic mcp_call proxy the model is not trained to drive. Requires
 * connecting to each server at lane startup (that is the cost of first-class
 * tools). A server that fails to enumerate is skipped; mcp_call remains as a
 * fallback for anything not expanded.
 */
export async function createMcpFirstClassTools(
  mcp: McpProjectRegistry,
  enabledServers: Iterable<string>,
  signal?: AbortSignal,
): Promise<AgentHarnessTool<CodingResourceContext>[]> {
  const tools: AgentHarnessTool<CodingResourceContext>[] = [];
  const summaries = mcp.summaries();
  for (const server of enabledServers) {
    const summary = summaries.find((item) => item.name === server && !item.disabled);
    if (!summary) continue;
    let described: Awaited<ReturnType<McpProjectRegistry["describeServer"]>>;
    try {
      described = await mcp.describeServer(server, signal);
    } catch {
      continue; // server unreachable at startup; mcp_call stays as fallback
    }
    for (const tool of described.tools) {
      tools.push({
        name: mcpToolName(server, tool.name),
        label: mcpToolName(server, tool.name),
        description: `[MCP ${server}] ${tool.description}`,
        parameters: (tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object" }) as never,
        executionMode: "sequential",
        async execute(_toolCallId, params, sig, _onUpdate, context) {
          assertMcpEnabled(context, server);
          const capabilityId = context.mcp.summaries().find((item) => item.name === server)?.capabilityId;
          if (!capabilityId) throw new Error(`Unknown MCP server: ${server}`);
          // Production lanes route MCP calls through the journaled capability
          // runtime so the raw response is archived and observed. Keep the
          // direct registry fallback for small/fake tool contexts used by
          // contract tests and offline callers.
          if (context.runtime && typeof context.runtime.invokeCapability === "function") {
            const invocation = await context.runtime.invokeCapability({
              capabilityId,
              operation: "call",
              input: { tool: tool.name, arguments: (params && typeof params === "object" ? params : {}) as Record<string, unknown> },
            }, sig);
            return toolResult(invocation);
          }
          const result = await context.mcp.execute(
            capabilityId,
            "call",
            { tool: tool.name, arguments: (params && typeof params === "object" ? params : {}) as Record<string, unknown> },
            sig,
          );
          return mcpToolResult(result);
        },
      });
    }
  }
  return tools;
}

/**
 * Keep decompiler schemas out of unrelated challenge contexts. The generic
 * `mcp_call` proxy remains active as a deferred escape hatch; only the small
 * category-specific set below is sent as native provider tools.
 */
export function selectFirstClassMcpTools<T extends { name: string }>(tools: T[], targetKind: TargetKind, target = "", profileId?: string): T[] {
  if (targetKind !== "reverse") return [];
  const android = profileId === "mobile" || /\.(?:apk|dex|aab)\b|android|jadx/i.test(target);
  const allowed = android ? JADX_FIRST_CLASS_TOOLS : IDALIB_FIRST_CLASS_TOOLS;
  return tools.filter((tool) => allowed.has(tool.name.slice(tool.name.lastIndexOf("__") + 2)));
}

const READ_ONLY_EFFECT: ToolEffectPolicy = { readOnly: true, sideEffect: "none" };
const WORKSPACE_EFFECT: ToolEffectPolicy = { readOnly: false, sideEffect: "workspace" };
const PROCESS_EFFECT: ToolEffectPolicy = { readOnly: false, sideEffect: "process" };

const CODING_TOOL_EFFECT_POLICIES: Readonly<Record<string, ToolEffectPolicy>> = {
  read: READ_ONLY_EFFECT,
  bash: PROCESS_EFFECT,
  edit: WORKSPACE_EFFECT,
  write: WORKSPACE_EFFECT,
  verify_claim: WORKSPACE_EFFECT,
  verify_result: WORKSPACE_EFFECT,
  load_skill: READ_ONLY_EFFECT,
  // Starting and killing processes is a process side effect; polling a log is not,
  // so shell_job's policy is resolved per-operation below.
  shell_background: PROCESS_EFFECT,
};

const EVIDENCE_READ_OPERATIONS = new Set(["curation_status", "inspect_forest", "inspect_tree", "search", "read"]);

/** Resolves the same read-only and side-effect contract used by the runtime capability boundary. */
export function createCodingToolEffectPolicyResolver(
  mcp: Pick<McpProjectRegistry, "summaries" | "resolveInvocation">,
  runtime?: Pick<ProofBladeToolRuntime, "resolveCapabilityPolicy">,
): ToolEffectPolicyResolver {
  return (toolName, input) => {
    const fixed = CODING_TOOL_EFFECT_POLICIES[toolName];
    if (fixed) return fixed;
    // First-class MCP tools: mcp__<server>__<tool>. Resolve the same policy the
    // mcp_call proxy would, by matching the enabled server prefix.
    if (toolName.startsWith("mcp__")) {
      const summary = mcp.summaries().find((server) => !server.disabled && toolName.startsWith(`mcp__${server.name}__`));
      if (!summary) return undefined;
      const tool = toolName.slice(`mcp__${summary.name}__`.length);
      try {
        const policy = mcp.resolveInvocation(summary.capabilityId, "call", { tool, arguments: input });
        return { readOnly: policy.readOnly, sideEffect: policy.sideEffect };
      } catch {
        return undefined;
      }
    }
    if (toolName === "evidence") return EVIDENCE_READ_OPERATIONS.has(String(input.operation)) ? READ_ONLY_EFFECT : WORKSPACE_EFFECT;
    if (CODING_WEB_SESSION_TOOL_NAMES.includes(toolName as (typeof CODING_WEB_SESSION_TOOL_NAMES)[number])) return { readOnly: false, sideEffect: "network" };
    // Polling a job log is a read; stopping one is a process side effect. Without
    // this split, repeated polling would look like a side-effecting call and could
    // reset the no-progress window that is supposed to catch a stalled agent.
    if (toolName === "shell_job") return input.operation === "stop" ? PROCESS_EFFECT : READ_ONLY_EFFECT;
    if (toolName === "capability") {
      if (input.operation !== "invoke") return READ_ONLY_EFFECT;
      if (!runtime || typeof input.capabilityId !== "string" || typeof input.capabilityOperation !== "string" || !isRecord(input.input)) return undefined;
      try {
        const policy = runtime.resolveCapabilityPolicy({ capabilityId: input.capabilityId, operation: input.capabilityOperation, input: input.input });
        return { readOnly: policy.readOnly, sideEffect: policy.sideEffect };
      } catch {
        return undefined;
      }
    }
    if (toolName !== "mcp_call") return undefined;
    if (input.operation === "list") return READ_ONLY_EFFECT;
    if (input.operation === "describe") return { readOnly: true, sideEffect: "process" };
    if (input.operation !== "call" || typeof input.server !== "string") return undefined;
    const capabilityId = mcp.summaries().find((server) => server.name === input.server && !server.disabled)?.capabilityId;
    if (!capabilityId) return undefined;
    try {
      const policy = mcp.resolveInvocation(capabilityId, "call", { tool: input.tool, arguments: input.arguments });
      return { readOnly: policy.readOnly, sideEffect: policy.sideEffect };
    } catch {
      return undefined;
    }
  };
}

const verifyClaimTool: AgentHarnessTool<CodingResourceContext> = {
  name: "verify_claim",
  label: "verify_claim",
  description: "Run the task's deterministic workspace verifier and journal its exact candidate output. A task-bound command creates trusted reproduction Evidence and accepts a Completion; when a task has no verifier policy, the same call is retained as an explicitly unverified observation.",
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
    let output = "";
    const reproduction = await context.claimVerifier.record({
      candidate,
      command,
      cwd: context.env.cwd,
      toolCallId,
      supportingEvidenceIds: input.evidenceIds,
      signal,
      execute: async (innerSignal) => {
        const started = Date.now();
        const result = await executor.execute(toolCallId, { command, timeout: input.timeout }, innerSignal, onUpdate, context);
        output = result.content.map((item) => item.type === "text" ? item.text : "[image]").join("\n");
        return { stdout: output, stderr: "", exitCode: 0, durationMs: Date.now() - started };
      },
    });
    const result = toolResult({
      verified: reproduction.verified,
      candidateHash: reproduction.candidateHash,
      commandHash: reproduction.commandHash,
      artifactId: reproduction.artifactId,
      evidenceId: reproduction.evidenceId,
      completionId: reproduction.completionId,
      supportingEvidenceIds: reproduction.supportingEvidenceIds,
      output,
    });
    return context.deferClaimAcceptance && !context.continuousRecovery ? { ...result, terminate: true } : result;
  },
};

/**
 * Domain-neutral verification entry point. `verify_claim` remains registered
 * as a compatibility alias for existing sessions and competition fixtures;
 * this name makes it clear that the result can be a file, test output, state,
 * or protocol value rather than a CTF flag.
 */
const verifyResultTool: AgentHarnessTool<CodingResourceContext> = {
  name: "verify_result",
  label: "verify_result",
  description: "Run the task's deterministic verifier or audited workspace check and record the result as durable Evidence. A task-bound verifier can accept a Completion; without one, the check remains an explicitly unverified observation.",
  parameters: Type.Object({
    result: Type.String({ minLength: 1, maxLength: 1_024, description: "Exact result value or text that the answer will report." }),
    command: Type.String({ minLength: 1, maxLength: 16_000, description: "Deterministic command that derives the result from workspace inputs and prints it." }),
    evidenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 16, description: "Supporting evidence ids used by the verification." })),
    timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 120 })),
  }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(toolCallId, params, signal, onUpdate, context) {
    const input = params as { result: string; command: string; evidenceIds?: string[]; timeout?: number };
    const result = input.result.trim();
    const command = input.command.trim();
    if (!result || !command) throw new Error("verify_result requires a result and verification command");
    if (command.includes(result)) throw new Error("Verification command embeds the result literal; derive it from workspace inputs instead");
    const executor = createBashTool<CodingResourceContext>();
    let output = "";
    const reproduction = await context.claimVerifier.record({
      candidate: result,
      command,
      cwd: context.env.cwd,
      toolCallId,
      supportingEvidenceIds: input.evidenceIds,
      signal,
      execute: async (innerSignal) => {
        const started = Date.now();
        const executed = await executor.execute(toolCallId, { command, timeout: input.timeout }, innerSignal, onUpdate, context);
        output = executed.content.map((item) => item.type === "text" ? item.text : "[image]").join("\n");
        return { stdout: output, stderr: "", exitCode: 0, durationMs: Date.now() - started };
      },
    });
    const response = toolResult({
      verified: reproduction.verified,
      result: reproduction.candidate,
      candidateHash: reproduction.candidateHash,
      commandHash: reproduction.commandHash,
      artifactId: reproduction.artifactId,
      evidenceId: reproduction.evidenceId,
      completionId: reproduction.completionId,
      supportingEvidenceIds: reproduction.supportingEvidenceIds,
      output,
    });
    return context.deferClaimAcceptance && !context.continuousRecovery ? { ...response, terminate: true } : response;
  },
};

const evidenceTool: AgentHarnessTool<CodingResourceContext> = {
  name: "evidence",
  label: "evidence",
  description: "Evidence and knowledge proxy for durable observations, typed graph edges, reasoning trees, pb:// L0/L1/L2 projections, and curation status. Use curation_status for exact pending Artifact ids and viewed/reviewed/promoted counts. Record accepts artifactIds (plural), name, and summary and promotes artifacts into auditable Evidence. Annotate accepts artifactId (singular), name, summary, and optional role, but only marks model output viewed and never clears the curation gate. Trees are views over shared DAG nodes, so reuse node ids instead of copying evidence.",
  parameters: Type.Object({
    operation: Type.String({
      enum: ["curation_status", "inspect_forest", "inspect_tree", "search", "read", "inspect_uri", "search_uri", "consolidate", "annotate", "record", "link", "create_tree", "update_tree"],
      description: "Evidence operation. curation_status takes no other arguments; inspect_uri reads a pb:// URI at L0/L1/L2; search_uri searches current Run knowledge plus the read-only project Skill/Tool/MCP directory; consolidate creates a resumable source-linked L0/L1 index without deleting raw Artifacts; inspect_tree requires treeId; read requires artifactId; annotate accepts artifactId, name, and summary; record requires artifactIds (plural), name, and summary and never accepts artifactId or role; link requires from, to, and relation; create_tree requires name, summary, purpose, explanation, rootNodeId, and nodeIds; update_tree requires treeId.",
    }),
    treeId: Type.Optional(Type.String({ minLength: 1 })),
    query: Type.Optional(Type.String({ maxLength: 200 })),
    artifactId: Type.Optional(Type.String({ minLength: 1 })),
    artifactIds: Type.Optional(Type.Array(Type.String({ minLength: 1, description: "Stable A-* ids returned by read/bash or evidence search; file paths are not artifact ids." }), { minItems: 1, maxItems: 16 })),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    summary: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
    tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 16 })),
    role: Type.Optional(Type.String({ enum: ["supporting", "intermediate", "debug", "result"] })),
    relatedIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32 })),
    dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 16 })),
    claim: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
    maxChars: Type.Optional(Type.Number({ minimum: 256, maximum: 12_000 })),
    uri: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    level: Type.Optional(Type.String({ enum: ["L0", "L1", "L2"] })),
    maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    includeStale: Type.Optional(Type.Boolean()),
    policy: Type.Optional(Type.String({ enum: ["deduplicate", "summarize", "all"] })),
    maxArtifacts: Type.Optional(Type.Number({ minimum: 1, maximum: 128 })),
    from: Type.Optional(Type.String({ minLength: 1, description: "Upstream premise/source node id; information flows from this node." })),
    to: Type.Optional(Type.String({ minLength: 1, description: "Downstream derived, supported, refuted, or reproduced node id." })),
    relation: Type.Optional(Type.String({
      enum: ["derived_from", "supports", "refutes", "depends_on", "adopts", "reproduces"],
      description: "Relation from upstream to downstream; depends_on means the downstream node depends on the upstream node.",
    })),
    explanation: Type.Optional(Type.String({ maxLength: 2_000 })),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    purpose: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
    rootNodeId: Type.Optional(Type.String({ minLength: 1 })),
    nodeIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 128 })),
    relatedTreeIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32 })),
    status: Type.Optional(Type.String({ enum: ["ACTIVE", "SUPPORTED", "CONTESTED", "ARCHIVED"] })),
  }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_toolCallId, params, _signal, _onUpdate, context) {
    const input = params as {
      operation: "curation_status" | "inspect_forest" | "inspect_tree" | "search" | "read" | "inspect_uri" | "search_uri" | "consolidate" | "annotate" | "record" | "link" | "create_tree" | "update_tree";
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
      uri?: string;
      level?: "L0" | "L1" | "L2";
      maxResults?: number;
      includeStale?: boolean;
      policy?: "deduplicate" | "summarize" | "all";
      maxArtifacts?: number;
      treeId?: string;
      from?: string;
      to?: string;
      relation?: "derived_from" | "supports" | "refutes" | "depends_on" | "adopts" | "reproduces";
      explanation?: string;
      confidence?: number;
      purpose?: string;
      rootNodeId?: string;
      nodeIds?: string[];
      relatedTreeIds?: string[];
      status?: "ACTIVE" | "SUPPORTED" | "CONTESTED" | "ARCHIVED";
    };
    if (!("operation" in input) || !["curation_status", "inspect_forest", "inspect_tree", "search", "read", "inspect_uri", "search_uri", "consolidate", "annotate", "record", "link", "create_tree", "update_tree"].includes(input.operation)) throw new Error(`Unsupported evidence operation: ${String(input.operation)}`);
    if (input.operation === "curation_status") {
      assertOnly(input, ["operation"], "evidence curation_status");
      return toolResult({ curation: await context.evidenceCurationGate?.inspect({ includeReviewEvents: true }) ?? { stage: "clear", pendingCount: 0, pendingArtifacts: [] } });
    }
    if (input.operation === "inspect_forest") {
      assertOnly(input, ["operation", "maxChars"], "evidence inspect_forest");
      return toolResult(await context.evidenceGraph.inspectForest(), false, input.maxChars);
    }
    if (input.operation === "inspect_tree") {
      assertOnly(input, ["operation", "treeId"], "evidence inspect_tree");
      if (!input.treeId) throw new Error("evidence inspect_tree requires treeId");
      return toolResult(await context.evidenceGraph.inspectTree(input.treeId));
    }
    if (input.operation === "search") {
      assertOnly(input, ["operation", "query", "tags"], "evidence search");
      return toolResult(await context.evidenceGraph.searchWithTrace(input.query, input.tags));
    }
    if (input.operation === "read") {
      assertOnly(input, ["operation", "artifactId", "maxChars"], "evidence read");
      if (!input.artifactId) throw new Error("evidence read requires artifactId");
      return toolResult(await context.evidenceGraph.readArtifact(input.artifactId, boundedRequestedChars(input.maxChars, 6_000, KNOWLEDGE_READ_MAX_TOKENS)));
    }
    if (input.operation === "inspect_uri") {
      assertOnly(input, ["operation", "uri", "level", "maxChars"], "evidence inspect_uri");
      if (!input.uri) throw new Error("evidence inspect_uri requires uri");
      return toolResult(await context.runtime.inspectKnowledge(input.uri, input.level ?? "L0", boundedRequestedChars(input.maxChars, 6_000, KNOWLEDGE_READ_MAX_TOKENS)));
    }
    if (input.operation === "search_uri") {
      assertOnly(input, ["operation", "query", "maxResults", "maxChars", "includeStale"], "evidence search_uri");
      const maxChars = boundedRequestedChars(input.maxChars, 12_000, KNOWLEDGE_READ_MAX_TOKENS);
      return toolResult({ results: await context.runtime.searchKnowledge(input.query ?? "", input.maxResults ?? 50, maxChars, input.includeStale ?? false) }, false, maxChars);
    }
    if (input.operation === "consolidate") {
      assertOnly(input, ["operation", "artifactIds", "policy", "maxArtifacts"], "evidence consolidate");
      return toolResult(await context.runtime.consolidateKnowledge({ artifactIds: input.artifactIds, policy: input.policy, maxArtifacts: input.maxArtifacts }));
    }
    if (input.operation === "annotate") {
      assertOnly(input, ["operation", "artifactId", "name", "summary", "tags", "role", "relatedIds"], "evidence annotate");
      if (!input.artifactId || !input.name || !input.summary) throw new Error("evidence annotate requires artifactId, name, and summary");
      const result = await context.evidenceGraph.annotateArtifact({ artifactId: input.artifactId, name: input.name, summary: input.summary, tags: input.tags, role: input.role, relatedIds: input.relatedIds });
      return toolResult({ ...result, curation: await context.evidenceCurationGate?.inspect() });
    }
    if (input.operation === "record") {
      assertOnly(input, ["operation", "artifactIds", "name", "summary", "tags", "dependsOn", "claim"], "evidence record");
      if (!input.artifactIds || !input.name || !input.summary) throw new Error("evidence record requires artifactIds, name, and summary");
      const result = await context.evidenceGraph.recordEvidence({ name: input.name, summary: input.summary, artifactIds: input.artifactIds, tags: input.tags, claim: input.claim, dependsOn: input.dependsOn });
      return toolResult({ ...result, curation: await context.evidenceCurationGate?.inspect() });
    }
    if (input.operation === "link") {
      assertOnly(input, ["operation", "from", "to", "relation", "explanation", "confidence"], "evidence link");
      if (!input.from || !input.to || !input.relation) throw new Error("evidence link requires from, to, and relation");
      return toolResult(await context.evidenceGraph.linkNodes({ from: input.from, to: input.to, relation: input.relation, explanation: input.explanation, confidence: input.confidence }));
    }
    if (input.operation === "create_tree") {
      assertOnly(input, ["operation", "name", "summary", "purpose", "explanation", "rootNodeId", "nodeIds", "tags", "relatedTreeIds", "status"], "evidence create_tree");
      if (!input.name || !input.summary || !input.purpose || !input.explanation || !input.rootNodeId || !input.nodeIds) throw new Error("evidence create_tree requires name, summary, purpose, explanation, rootNodeId, and nodeIds");
      return toolResult(await context.evidenceGraph.createTree({ name: input.name, summary: input.summary, purpose: input.purpose, explanation: input.explanation, rootNodeId: input.rootNodeId, nodeIds: input.nodeIds, tags: input.tags, relatedTreeIds: input.relatedTreeIds, status: input.status }));
    }
    assertOnly(input, ["operation", "treeId", "name", "summary", "purpose", "explanation", "rootNodeId", "nodeIds", "tags", "relatedTreeIds", "status"], "evidence update_tree");
    if (!input.treeId) throw new Error("evidence update_tree requires treeId");
    return toolResult(await context.evidenceGraph.updateTree({ treeId: input.treeId, name: input.name, summary: input.summary, purpose: input.purpose, explanation: input.explanation, rootNodeId: input.rootNodeId, nodeIds: input.nodeIds, tags: input.tags, relatedTreeIds: input.relatedTreeIds, status: input.status }));
  },
};

/**
 * Submit a flag candidate to the live competition platform.
 *
 * Only registered when the run's `verification.kind` is `platform_submission`,
 * because it is the one path that spends a real submission against the
 * platform. Routes through `runtime.submitCandidate` (format check, submission
 * budget, candidate-hash dedup) and then the effect journal's `fixture_score`,
 * whose idempotency key collapses a repeated identical submission into the
 * stored result instead of a second API call. Both tiebreakers the rules score
 * — wrong-submission count and API-call efficiency — are therefore accounted
 * for in the journal rather than tracked separately.
 */
/**
 * Start a long command WITHOUT blocking the turn.
 *
 * `bash` is synchronous, so a long sweep holds the whole turn — a real run spent
 * 12 minutes inside one heredoc, which in a fleet means one worker slot idle for
 * 12 minutes. `run_background` on the solver lane could not have helped: it only
 * starts capability jobs (`capabilityId` + `operation`), not shell commands.
 *
 * So this is a shell-level pair. The command is detached with its output
 * redirected to a log under the workspace, and the model gets a job id back
 * immediately; `shell_job` then tails or kills it.
 */
const shellBackgroundTool: AgentHarnessTool<CodingResourceContext> = {
  name: "shell_background",
  label: "shell_background",
  description: "Start a bash command in the background and return a job id immediately, without blocking this turn. Use it for anything long-running (brute forces, sweeps, fuzzers, servers) so you can keep analysing while it runs, then poll it with shell_job.",
  parameters: Type.Object({
    command: Type.String({ minLength: 1, description: "Bash command to run in the background." }),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Short name for this job, used in the log filename." })),
  }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(toolCallId, params, signal, onUpdate, context) {
    const input = params as { command: string; label?: string };
    await context.experimentGate?.assertAllowed({ runId: context.runtime.runId, action: "shell_background", input: { command: input.command, label: input.label } });
    // Starting a new long-running probe is still investigation. Polling an
    // existing job remains available, but new background work must stop when
    // the durable evidence backlog reaches the hard curation threshold.
    const curationNotice = await context.evidenceCurationGate?.assertInvestigationAllowed();
    const snapshot = await context.controlStore.snapshot(context.runtime.runId);
    const jobId = `sh-${toolCallId.slice(-8)}`;
    const slug = (input.label ?? "job").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40);
    const paths = shellJobPaths(context.runtime.runId, snapshot.generation, jobId);
    const processStartTime = new Date().toISOString();
    const reservation: ShellJobRecord = {
      schemaVersion: 2,
      jobId,
      runId: context.runtime.runId,
      generation: snapshot.generation,
      ownerLane: context.ownerLane ?? "main",
      pid: 0,
      processGroupCreated: false,
      processTreePath: paths.pidPath,
      processStartTime,
      processStartEpochMs: Date.now(),
      logPath: paths.logPath,
      status: "STARTING",
      commandHash: sha256(input.command),
      label: slug,
      createdAt: processStartTime,
    };
    // The wrapper commits its real PID metadata before it starts user code.
    // This removes the old spawn -> second host write failure window.
    const launcher = buildShellJobLauncher(reservation, paths, input.command);
    let started: string;
    try {
      started = await runShell(launcher, signal, onUpdate, context);
    } catch (error) {
      await context.experimentGate?.record({ runId: context.runtime.runId, action: "shell_background", input: { command: input.command, label: input.label }, outcome: /timed out|timeout/i.test(String(error)) ? "timeout" : "failure", summary: String(error).slice(0, 1_000) });
      throw error;
    }
    const pid = /pid=(\d+)/.exec(started)?.[1];
    if (!pid) throw new Error(`Could not start background job: ${started.slice(0, 400)}`);
    const processGroupCreated = /process-group-created=true/.test(started);
    if (!processGroupCreated && !/process-group-created=false/.test(started)) {
      throw new Error(`Could not determine process isolation mode: ${started.slice(0, 400)}`);
    }
    await context.experimentGate?.record({ runId: context.runtime.runId, action: "shell_background", input: { command: input.command, label: input.label }, outcome: "success", summary: "Background shell process started." });
    return toolResult({
      jobId,
      pid: Number(pid),
      processGroupCreated,
      ...(processGroupCreated ? { processGroupId: Number(pid) } : {}),
      logPath: paths.logPath,
      generation: snapshot.generation,
      ownerLane: reservation.ownerLane,
      status: "running",
      note: [`Started in the background. Poll with shell_job {"operation":"read","jobId":"${jobId}"} and stop it with {"operation":"stop","jobId":"${jobId}"}. Keep working while it runs.`, ...(curationNotice ? [curationNotice] : [])].join("\n\n"),
    });
  },
};

/** Poll or stop a background shell job started by `shell_background`. */
const shellJobTool: AgentHarnessTool<CodingResourceContext> = {
  name: "shell_job",
  label: "shell_job",
  description: "Read the output of, or stop, a background job started by shell_background.",
  parameters: Type.Object({
    operation: Type.String({ enum: ["read", "monitor", "stop", "list"], description: "read returns bounded output, monitor waits for a trigger, stop kills it, list shows known jobs." }),
    jobId: Type.Optional(Type.String({ minLength: 1, description: "Job id from shell_background. Required for read and stop." })),
    maxChars: Type.Optional(Type.Number({ minimum: 256, maximum: 20_000, description: "Bound on returned log text (default 4000)." })),
    sinceCursor: Type.Optional(Type.String({ pattern: "^[0-9]+$", description: "Byte cursor returned by an earlier read or monitor call." })),
    triggers: Type.Optional(Type.Array(Type.String({ enum: ["new_output", "keyword", "exit", "error", "heartbeat", "timeout"] }), { minItems: 1, maxItems: 6 })),
    keywords: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 16, description: "Case-insensitive sentinel strings for the keyword trigger." })),
    waitMs: Type.Optional(Type.Number({ minimum: 50, maximum: 120_000, description: "Maximum time to wait in monitor mode." })),
    heartbeatMs: Type.Optional(Type.Number({ minimum: 50, maximum: 120_000, description: "Optional heartbeat interval while the job remains active." })),
  }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_toolCallId, params, signal, onUpdate, context) {
    const input = params as { operation: "read" | "monitor" | "stop" | "list"; jobId?: string; maxChars?: number; sinceCursor?: string; triggers?: Array<"new_output" | "keyword" | "exit" | "error" | "heartbeat" | "timeout">; keywords?: string[]; waitMs?: number; heartbeatMs?: number };
    if (input.operation === "list") {
      assertAbsent(input as unknown as Record<string, unknown>, ["jobId", "maxChars", "sinceCursor", "triggers", "keywords", "waitMs", "heartbeatMs"], "shell_job list");
      const generation = (await context.controlStore.snapshot(context.runtime.runId)).generation;
      const paths = shellJobPaths(context.runtime.runId, generation);
      const listed = await runShell(`ls -1 ${paths.rootPath}/*.json 2>/dev/null || echo "(no jobs)"`, signal, onUpdate, context);
      return toolResult({ jobs: listed.trim().split(/\r?\n/).filter(Boolean) });
    }
    if (!input.jobId) throw new Error(`shell_job ${input.operation} requires jobId`);
    if (!/^[A-Za-z0-9._-]+$/.test(input.jobId)) throw new Error("shell_job jobId contains unsupported characters");
    const generation = (await context.controlStore.snapshot(context.runtime.runId)).generation;
    if (input.operation === "stop") {
      const stopped = await stopShellJob(shellJobPaths(context.runtime.runId, generation, input.jobId), context.runtime.runId, generation, context.ownerLane ?? "main", signal, onUpdate, context);
      if (stopped.includes("__NO_JOB__") || stopped.includes("__UNKNOWN_JOB__")) throw new Error(`Background job ${input.jobId} is unknown or belongs to another Run/lane`);
      const observationId = await recordShellJobObservation(context, input.jobId, { status: "finished", cursor: 0, trigger: "exit" });
      if (observationId) await context.controlStore.acknowledgeObservations(context.runtime.runId, [observationId]);
      return toolResult({ jobId: input.jobId, stopped: stopped.includes("stopped"), detail: stopped.trim() });
    }
    const maxChars = input.maxChars ?? 4_000;
    if (input.operation === "read") {
      const inspection = await inspectShellJob(input.jobId, generation, maxChars, signal, onUpdate, context);
      const sinceCursor = parseShellCursor(input.sinceCursor);
      const projection = shellOutputProjection(inspection, sinceCursor);
      const trigger = inspection.status === "finished" ? "exit" : projection.newOutput ? "new_output" : undefined;
      if (trigger) {
        const observationId = await recordShellJobObservation(context, input.jobId, { ...inspection, trigger });
        if (observationId) await context.controlStore.acknowledgeObservations(context.runtime.runId, [observationId]);
      }
      return toolResult({
        jobId: input.jobId,
        status: inspection.status,
        cursor: String(inspection.cursor),
        sinceCursor: String(sinceCursor),
        totalBytes: inspection.totalBytes,
        truncated: projection.truncated,
        output: snipText(projection.output, maxChars).text,
        ...(inspection.status === "running" ? { note: "Still running. Use shell_job monitor with a trigger instead of repeated empty reads." } : {}),
      });
    }
    const monitored = await monitorShellJob(input.jobId, generation, input, signal, onUpdate, context);
    const observationId = await recordShellJobObservation(context, input.jobId, monitored);
    if (observationId) await context.controlStore.acknowledgeObservations(context.runtime.runId, [observationId]);
    return toolResult({
      jobId: input.jobId,
      status: monitored.status,
      trigger: monitored.trigger,
      cursor: String(monitored.cursor),
      sinceCursor: String(monitored.sinceCursor),
      truncated: monitored.truncated,
      output: snipText(monitored.output, maxChars).text,
      ...(monitored.matchedKeyword ? { matchedKeyword: monitored.matchedKeyword } : {}),
    });
  },
};

interface ShellJobInspection {
  status: "running" | "finished";
  totalBytes: number;
  cursor: number;
  tail: Buffer;
}

interface ShellJobRecord {
  schemaVersion: 1 | 2;
  jobId: string;
  runId: string;
  generation: number;
  ownerLane: Lane;
  pid: number;
  processGroupCreated?: boolean;
  processGroupId?: number;
  processTreePath?: string;
  processStartTime: string;
  processStartEpochMs: number;
  logPath: string;
  status: "STARTING" | "RUNNING" | "FINISHED" | "STOPPED" | "UNKNOWN";
  commandHash: string;
  label: string;
  createdAt: string;
}

interface ShellOutputProjection {
  output: string;
  newOutput: boolean;
  truncated: boolean;
}

interface ShellMonitorResult {
  status: "running" | "finished";
  trigger: "new_output" | "keyword" | "exit" | "error" | "heartbeat" | "timeout";
  cursor: number;
  sinceCursor: number;
  output: string;
  truncated: boolean;
  matchedKeyword?: string;
}

async function inspectShellJob(
  jobId: string,
  generation: number,
  maxChars: number,
  signal: AbortSignal | undefined,
  onUpdate: Parameters<NonNullable<AgentHarnessTool<CodingResourceContext>["execute"]>>[3],
  context: CodingResourceContext,
): Promise<ShellJobInspection> {
  const paths = shellJobPaths(context.runtime.runId, generation, jobId);
  const identity = shellRecordIdentity(context.runtime.runId, generation, context.ownerLane ?? "main");
  const output = await runShell(
    `f=${paths.logPath}; r=${paths.recordPath}; ` +
    `if [ ! -f "$r" ] || ! grep -Fq ${shellQuote(identity)} "$r" || [ ! -f "$f" ]; then echo "__NO_JOB__"; else ` +
    `p=$(sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' "$r"); ` +
    `if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo "__RUNNING__"; else sed -E -i 's/"status":"[^\"]+"/"status":"FINISHED"/' "$r" 2>/dev/null; echo "__FINISHED__"; fi; ` +
    `wc -c < "$f"; tail -c ${Math.max(256, Math.min(20_000, Math.floor(maxChars)))} "$f" | base64 | tr -d '\\r\\n'; fi`,
    signal,
    onUpdate,
    context,
  );
  if (output.includes("__NO_JOB__")) throw new Error(`Unknown background job: ${jobId}`);
  const running = output.startsWith("__RUNNING__");
  const body = output.replace(/^__(RUNNING|FINISHED)__\r?\n/, "");
  const [sizeLine, ...rest] = body.split(/\r?\n/);
  const totalBytes = Number.parseInt((sizeLine ?? "").trim(), 10);
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new Error(`Background job ${jobId} returned an invalid byte cursor`);
  const encodedTail = rest.join("").trim();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedTail)) {
    throw new Error(`Background job ${jobId} returned an invalid base64 log tail`);
  }
  let tail: Buffer;
  try {
    tail = Buffer.from(encodedTail, "base64");
  } catch {
    throw new Error(`Background job ${jobId} returned an invalid base64 log tail`);
  }
  if (tail.length > totalBytes) throw new Error(`Background job ${jobId} returned an oversized log tail`);
  return { status: running ? "running" : "finished", totalBytes, cursor: totalBytes, tail };
}

function shellOutputProjection(inspection: ShellJobInspection, sinceCursor: number): ShellOutputProjection {
  const tailBytes = inspection.tail.length;
  const tailStart = Math.max(0, inspection.totalBytes - tailBytes);
  if (sinceCursor < tailStart) return { output: decodeUtf8Tail(inspection.tail, 0), newOutput: inspection.totalBytes > sinceCursor, truncated: true };
  const offset = Math.max(0, sinceCursor - tailStart);
  const output = decodeUtf8Tail(inspection.tail, offset);
  return { output, newOutput: inspection.totalBytes > sinceCursor, truncated: false };
}

function decodeUtf8Tail(bytes: Buffer, offset: number): string {
  let safeOffset = Math.max(0, Math.min(bytes.length, Math.floor(offset)));
  // A byte cursor is allowed to point at the beginning of a retained tail,
  // which may itself start in the middle of a UTF-8 sequence after truncation.
  // Skip continuation bytes so the model never receives a replacement glyph.
  while (safeOffset < bytes.length && (bytes[safeOffset]! & 0xc0) === 0x80) safeOffset += 1;
  return bytes.subarray(safeOffset).toString("utf8");
}

async function monitorShellJob(
  jobId: string,
  generation: number,
  input: { sinceCursor?: string; triggers?: ShellMonitorResult["trigger"][]; keywords?: string[]; waitMs?: number; heartbeatMs?: number },
  signal: AbortSignal | undefined,
  onUpdate: Parameters<NonNullable<AgentHarnessTool<CodingResourceContext>["execute"]>>[3],
  context: CodingResourceContext,
): Promise<ShellMonitorResult> {
  const sinceCursor = parseShellCursor(input.sinceCursor);
  const triggers = new Set(input.triggers ?? ["new_output", "keyword", "exit", "error", "heartbeat"]);
  if (triggers.has("keyword") && (!input.keywords || input.keywords.length === 0)) throw new Error("shell_job monitor keyword trigger requires keywords");
  const keywords = (input.keywords ?? []).map((keyword) => keyword.trim()).filter(Boolean);
  const waitMs = normalizeShellMonitorWait(input.waitMs ?? 30_000);
  const heartbeatMs = normalizeShellMonitorWait(input.heartbeatMs ?? 5_000);
  const deadline = Date.now() + waitMs;
  let lastHeartbeat = Date.now();
  while (true) {
    throwIfShellAborted(signal);
    const inspection = await inspectShellJob(jobId, generation, 12_000, signal, onUpdate, context);
    const projection = shellOutputProjection(inspection, sinceCursor);
    const matchedKeyword = keywords.find((keyword) => projection.output.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()));
    if (triggers.has("keyword") && matchedKeyword) return { status: inspection.status, trigger: "keyword", cursor: inspection.cursor, sinceCursor, output: projection.output, truncated: projection.truncated, matchedKeyword };
    if (triggers.has("new_output") && projection.newOutput) return { status: inspection.status, trigger: "new_output", cursor: inspection.cursor, sinceCursor, output: projection.output, truncated: projection.truncated };
    if (inspection.status === "finished") {
      if (triggers.has("error")) return { status: inspection.status, trigger: "error", cursor: inspection.cursor, sinceCursor, output: projection.output, truncated: projection.truncated };
      if (triggers.has("exit")) return { status: inspection.status, trigger: "exit", cursor: inspection.cursor, sinceCursor, output: projection.output, truncated: projection.truncated };
    }
    if (triggers.has("heartbeat") && Date.now() - lastHeartbeat >= heartbeatMs) {
      lastHeartbeat = Date.now();
      return { status: inspection.status, trigger: "heartbeat", cursor: inspection.cursor, sinceCursor, output: projection.output, truncated: projection.truncated };
    }
    if (Date.now() >= deadline) return { status: inspection.status, trigger: "timeout", cursor: inspection.cursor, sinceCursor, output: projection.output, truncated: projection.truncated };
    // A single bounded wait lives inside the tool call; it does not create
    // extra Provider turns or consume model tokens for empty reads.
    await delayShellMonitor(Math.min(250, Math.max(1, deadline - Date.now())), signal);
  }
}

interface ShellJobPaths {
  rootPath: string;
  recordPath: string;
  logPath: string;
  pidPath: string;
}

function shellJobPaths(runId: string, generation: number, jobId?: string): ShellJobPaths {
  const rootPath = `${shellJobRunRoot(runId)}/${generation}`;
  const suffix = jobId ? `/${jobId}` : "";
  return { rootPath, recordPath: `${rootPath}${suffix}.json`, logPath: `${rootPath}${suffix}.log`, pidPath: `${rootPath}${suffix}.pids` };
}

function shellJobRunRoot(runId: string): string {
  return `.proofblade/jobs/${sha256(runId).slice(0, 24)}`;
}

function shellRecordIdentity(runId: string, generation: number, ownerLane: Lane): string {
  return `"runId":${JSON.stringify(runId)},"generation":${generation},"ownerLane":${JSON.stringify(ownerLane)}`;
}

function buildShellJobLauncher(reservation: ShellJobRecord, paths: ShellJobPaths, userCommand: string): string {
  const reservationJson = JSON.stringify(reservation);
  const recordPath = shellQuote(paths.recordPath);
  const logPath = shellQuote(paths.logPath);
  const rootPath = shellQuote(paths.rootPath);
  const pidPath = shellQuote(paths.pidPath);
  const groupWrapper = [
    `record=${recordPath}; temporary="$record.tmp.$$";`,
    `printf %s ${shellQuote(reservationJson)} > "$temporary" || exit 70;`,
    `"$sed_bin" -E -i 's/"pid":0/"pid":'$$'/; s/"processGroupCreated":false/"processGroupCreated":true,"processGroupId":'$$'/; s/"status":"STARTING"/"status":"RUNNING"/' "$temporary" || exit 70;`,
    `"$mv_bin" "$temporary" "$record" || { "$rm_bin" -f "$temporary"; exit 70; }`,
    `exec "$bash_bin" -c ${shellQuote(userCommand)}`,
  ].join("\n");
  const fallbackSupervisor = [
    `record=${recordPath}; pid_file=${pidPath}; temporary="$record.tmp.$BASHPID";`,
    `printf %s ${shellQuote(reservationJson)} > "$temporary" || exit 70;`,
    `"$sed_bin" -E -i 's/"pid":0/"pid":'$$'/' "$temporary" || exit 70;`,
    `"$mv_bin" "$temporary" "$record" || { "$rm_bin" -f "$temporary"; exit 70; }`,
    `set -m 2>/dev/null || exit 70;`,
    `"$bash_bin" -c ${shellQuote(userCommand)} > ${logPath} 2>&1 & child_pid=$!; group_id=$child_pid;`,
    `if ! kill -0 -- -"$group_id" 2>/dev/null; then kill "$child_pid" 2>/dev/null || true; exit 70; fi;`,
    `temporary="$record.tmp.$BASHPID"; "$cat_bin" "$record" > "$temporary" || exit 70; "$sed_bin" -E -i 's/"processGroupCreated":false/"processGroupCreated":true,"processGroupId":'"$group_id"'/; s/"status":"STARTING"/"status":"RUNNING"/' "$temporary" || exit 70; "$mv_bin" "$temporary" "$record" || { "$rm_bin" -f "$temporary"; exit 70; }`,
    `collect_descendants() { parent="$1"; for child in $("$ps_bin" -eo pid=,ppid= 2>/dev/null | "$awk_bin" -v parent="$parent" '$2 == parent { print $1 }'); do collect_descendants "$child"; printf '%s\\n' "$child"; done; }`,
    `snapshot_pids() { now=$("$date_bin" +%s 2>/dev/null) || return 1; temporary="$pid_file.tmp.$BASHPID"; if [ -f "$pid_file" ]; then "$cat_bin" "$pid_file" > "$temporary" || return 1; else : > "$temporary" || return 1; fi; if ! "$grep_bin" -Fq "$$:" "$temporary"; then printf '%s:%s\\n' "$$" "$(( now * 1000 ))" >> "$temporary" || return 1; fi; targets=$(collect_descendants "$$"); if [ -n "$child_pid" ]; then targets="$targets $child_pid $(collect_descendants "$child_pid")"; fi; for target in $targets; do etimes=$("$ps_bin" -o etimes= -p "$target" 2>/dev/null | "$tr_bin" -d ' '); if [ -n "$etimes" ] && ! "$grep_bin" -Fq "$target:" "$temporary"; then printf '%s:%s\\n' "$target" "$(( (now - etimes) * 1000 ))" >> "$temporary" || return 1; fi; done; "$mv_bin" "$temporary" "$pid_file" || { "$rm_bin" -f "$temporary"; return 1; }; }`,
    `terminate_child_tree() { if [ -n "$child_pid" ]; then for target in $(collect_descendants "$child_pid"); do kill "$target" 2>/dev/null || true; done; kill "$child_pid" 2>/dev/null || true; fi; }`,
    `stop_supervisor() { terminate_child_tree; exit 143; }; trap terminate_child_tree EXIT; trap stop_supervisor HUP INT TERM`,
    `supervisor_pid=$$; snapshot_loop() { while kill -0 "$supervisor_pid" 2>/dev/null; do snapshot_pids || exit 70; "$sleep_bin" 0.01; done; }; snapshot_loop & snapshot_pid=$!;`,
    `snapshot_pids || { terminate_child_tree; exit 70; };`,
    `warmup=0; while [ "$warmup" -lt 100 ]; do if ! kill -0 "$child_pid" 2>/dev/null; then break; fi; snapshot_pids || { terminate_child_tree; exit 70; }; "$sleep_bin" 0.01; warmup=$(( warmup + 1 )); done;`,
    `while kill -0 "$child_pid" 2>/dev/null; do snapshot_pids || { terminate_child_tree; exit 70; }; "$sleep_bin" 0.1; done;`,
    `snapshot_pids || { terminate_child_tree; exit 70; };`,
    `kill "$snapshot_pid" 2>/dev/null || true; wait "$snapshot_pid" 2>/dev/null || true; wait "$child_pid"; exit $?`,
  ].join("\n");
  return [
    `root=${rootPath}; record=${recordPath}; log=${logPath};`,
    `mkdir -p "$root" || { echo startup-failed; exit 70; };`,
    `bash_bin=$(command -v bash 2>/dev/null) || { echo startup-failed; exit 70; }; nohup_bin=$(command -v nohup 2>/dev/null) || { echo startup-failed; exit 70; }; sed_bin=$(command -v sed 2>/dev/null) || { echo startup-failed; exit 70; }; grep_bin=$(command -v grep 2>/dev/null) || { echo startup-failed; exit 70; }; sleep_bin=$(command -v sleep 2>/dev/null) || { echo startup-failed; exit 70; }; cat_bin=$(command -v cat 2>/dev/null) || true; ps_bin=$(command -v ps 2>/dev/null) || true; awk_bin=$(command -v awk 2>/dev/null) || true; date_bin=$(command -v date 2>/dev/null) || true; tr_bin=$(command -v tr 2>/dev/null) || { echo startup-failed; exit 70; }; mv_bin=$(command -v mv 2>/dev/null) || { echo startup-failed; exit 70; }; rm_bin=$(command -v rm 2>/dev/null) || { echo startup-failed; exit 70; }; setsid_bin=$(command -v setsid 2>/dev/null) || true; export bash_bin sed_bin grep_bin sleep_bin cat_bin ps_bin awk_bin date_bin tr_bin mv_bin rm_bin;`,
    `temporary="$record.tmp.$$"; printf %s ${shellQuote(reservationJson)} > "$temporary" || { "$rm_bin" -f "$temporary"; echo startup-failed; exit 70; }; "$mv_bin" "$temporary" "$record" || { "$rm_bin" -f "$temporary"; echo startup-failed; exit 70; };`,
    `if [ -n "$setsid_bin" ]; then`,
    `  "$setsid_bin" "$nohup_bin" "$bash_bin" -c ${shellQuote(groupWrapper)} > "$log" 2>&1 &`,
    `  mode=true`,
    `else`,
    `  if [ -z "$cat_bin" ] || [ -z "$ps_bin" ] || [ -z "$awk_bin" ] || [ -z "$date_bin" ]; then echo startup-failed; exit 70; fi`,
    `  "$nohup_bin" "$bash_bin" -c ${shellQuote(fallbackSupervisor)} > "$log" 2>&1 &`,
    `  mode=false`,
    `fi`,
    `launcher_pid=$!;`,
    `cleanup_startup() { if kill -0 "$launcher_pid" 2>/dev/null; then group=$("$sed_bin" -n 's/.*"processGroupId":\\([0-9][0-9]*\\).*/\\1/p' "$record" 2>/dev/null); if [ -n "$group" ] && kill -0 -- -"$group" 2>/dev/null; then kill -- -"$group" 2>/dev/null || true; else kill "$launcher_pid" 2>/dev/null || true; fi; fi; };`,
    `i=0; while [ "$i" -lt 100 ]; do if [ -f "$record" ] && "$grep_bin" -Fq '"status":"RUNNING"' "$record"; then committed_pid=$("$sed_bin" -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' "$record"); if [ -n "$committed_pid" ] && [ "$committed_pid" != 0 ]; then echo "pid=$committed_pid"; if "$grep_bin" -Fq '"processGroupCreated":true' "$record"; then echo process-group-created=true; else echo process-group-created=false; fi; exit 0; fi; fi; if ! kill -0 "$launcher_pid" 2>/dev/null; then "$sed_bin" -E -i 's/"status":"STARTING"/"status":"UNKNOWN"/' "$record" 2>/dev/null || true; echo startup-failed; exit 70; fi; "$sleep_bin" 0.05; i=$((i + 1)); done; cleanup_startup; "$sed_bin" -E -i 's/"status":"STARTING"/"status":"UNKNOWN"/' "$record" 2>/dev/null || true; echo startup-timeout; exit 70;`,
  ].join("\n");
}

async function stopShellJob(
  paths: ShellJobPaths,
  runId: string,
  generation: number,
  ownerLane: Lane,
  signal: AbortSignal | undefined,
  onUpdate: Parameters<NonNullable<AgentHarnessTool<CodingResourceContext>["execute"]>>[3],
  context: CodingResourceContext,
): Promise<string> {
  const identity = shellRecordIdentity(runId, generation, ownerLane);
  return await runShell([
    `r=${paths.recordPath}; if [ ! -f "$r" ] || ! grep -Fq ${shellQuote(identity)} "$r"; then echo "__NO_JOB__"; else`,
    `p=$(sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' "$r"); g=$(sed -n 's/.*"processGroupId":\\([0-9][0-9]*\\).*/\\1/p' "$r"); schema=$(sed -n 's/.*"schemaVersion":\\([0-9][0-9]*\\).*/\\1/p' "$r"); group_created=$(sed -n 's/.*"processGroupCreated":\\(true\\|false\\).*/\\1/p' "$r"); if [ -z "$group_created" ] && [ "$schema" = 1 ] && [ -n "$g" ] && [ "$g" != 0 ]; then group_created=true; fi;`,
    `started=$(sed -n 's/.*"processStartEpochMs":\\([0-9][0-9]*\\).*/\\1/p' "$r"); mark_status() { status="$1"; sed -E -i 's/"status":"[^\"]+"/"status":"'"$status"'"/' "$r" 2>/dev/null; };`,
    `if [ -z "$p" ] || [ "$p" = 0 ] || [ -z "$group_created" ] || [ -z "$started" ]; then mark_status UNKNOWN; echo "__UNKNOWN_JOB__"; elif [ "$group_created" = true ]; then if [ -z "$g" ] || [ "$g" = 0 ]; then mark_status UNKNOWN; echo "__UNKNOWN_JOB__"; elif kill -0 -- -"$g" 2>/dev/null; then now=$(date +%s 2>/dev/null); etimes=$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' '); if kill -0 "$p" 2>/dev/null && { [ -z "$now" ] || [ -z "$etimes" ] || [ $(( now - started / 1000 - etimes )) -gt 3 ] || [ $(( etimes - now + started / 1000 )) -gt 3 ]; }; then mark_status UNKNOWN; echo "__UNKNOWN_JOB__"; else kill -- -"$g" 2>/dev/null || true; sleep 0.3; kill -0 -- -"$g" 2>/dev/null && kill -9 -- -"$g" 2>/dev/null || true; if kill -0 -- -"$g" 2>/dev/null; then mark_status RUNNING; echo "still-alive"; else mark_status STOPPED; echo stopped; fi; fi; elif kill -0 "$p" 2>/dev/null; then now=$(date +%s 2>/dev/null); etimes=$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' '); if [ -z "$now" ] || [ -z "$etimes" ] || [ $(( now - started / 1000 - etimes )) -gt 3 ] || [ $(( etimes - now + started / 1000 )) -gt 3 ]; then mark_status UNKNOWN; echo "__UNKNOWN_JOB__"; else kill "$p" 2>/dev/null || true; sleep 0.3; kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true; if kill -0 "$p" 2>/dev/null; then mark_status RUNNING; echo "still-alive"; else mark_status STOPPED; echo stopped; fi; fi; else mark_status FINISHED; echo finished; fi; elif [ "$group_created" != false ]; then mark_status UNKNOWN; echo "__UNKNOWN_JOB__"; elif ! command -v ps >/dev/null 2>&1 || ! command -v awk >/dev/null 2>&1; then mark_status UNKNOWN; echo "__UNKNOWN_JOB__"; else`,
    `pid_file=${shellQuote(paths.pidPath)}; descendants() { parent="$1"; for child in $(ps -eo pid=,ppid= 2>/dev/null | awk -v parent="$parent" '$2 == parent { print $1 }'); do descendants "$child"; printf '%s\\n' "$child"; done; }; matching_process() { target="$1"; expected="$2"; current=$(ps -o etimes= -p "$target" 2>/dev/null | tr -d ' '); current_now=$(date +%s 2>/dev/null); if [ -z "$target" ] || [ -z "$expected" ] || [ -z "$current" ] || [ -z "$current_now" ] || ! kill -0 "$target" 2>/dev/null; then return 1; fi; actual=$(( (current_now - current) * 1000 )); delta=$(( actual - expected )); [ "$delta" -le 3000 ] && [ "$delta" -ge -3000 ]; }; targets_file="$pid_file.stop.$BASHPID"; : > "$targets_file"; root_running=false; if kill -0 "$p" 2>/dev/null; then root_running=true; kill "$p" 2>/dev/null || true; sleep 0.1; fi; if [ -f "$pid_file" ]; then while IFS=: read -r target expected; do [ -n "$target" ] && printf '%s:%s\\n' "$target" "$expected" >> "$targets_file"; done < "$pid_file"; fi; if kill -0 "$p" 2>/dev/null; then now=$(date +%s 2>/dev/null); for target in $(descendants "$p"); do etimes=$(ps -o etimes= -p "$target" 2>/dev/null | tr -d ' '); if [ -n "$etimes" ] && [ -n "$now" ]; then printf '%s:%s\\n' "$target" "$(( (now - etimes) * 1000 ))" >> "$targets_file"; fi; done; fi; printf '%s:%s\\n' "$p" "$started" >> "$targets_file"; was_running=false; unverified=false; while IFS=: read -r target expected; do if kill -0 "$target" 2>/dev/null; then was_running=true; if ! matching_process "$target" "$expected"; then unverified=true; fi; fi; done < "$targets_file"; signal_targets() { signal="$1"; while IFS=: read -r target expected; do if [ "$target" != "$p" ] && matching_process "$target" "$expected"; then kill -s "$signal" "$target" 2>/dev/null || true; fi; done < "$targets_file"; if matching_process "$p" "$started"; then kill -s "$signal" "$p" 2>/dev/null || true; fi; }; if [ "$unverified" = true ]; then rm -f "$targets_file"; mark_status UNKNOWN; echo "__UNKNOWN_JOB__"; else signal_targets TERM; sleep 0.3; signal_targets KILL; alive=false; while IFS=: read -r target expected; do if matching_process "$target" "$expected"; then alive=true; fi; done < "$targets_file"; rm -f "$targets_file"; if [ "$alive" = true ]; then mark_status RUNNING; echo "still-alive"; elif [ "$was_running" = true ] || [ "$root_running" = true ]; then mark_status STOPPED; echo stopped; else mark_status FINISHED; echo finished; fi; fi; fi; fi`,
  ].join("\n"), signal, onUpdate, context);
}

/** Stop every current-generation shell job owned by this lane during teardown. */
export async function stopAllShellJobs(context: CodingResourceContext): Promise<void> {
  const listed = await runShell(`ls -1 ${shellJobRunRoot(context.runtime.runId)}/*/*.json 2>/dev/null || true`, undefined, undefined, context);
  for (const entry of listed.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const match = /\/([^/]+)\/([^/]+)\.json$/.exec(entry);
    const generation = Number(match?.[1]);
    const jobId = match?.[2];
    if (!Number.isInteger(generation) || generation < 0) continue;
    if (!jobId) continue;
    await stopShellJob(shellJobPaths(context.runtime.runId, generation, jobId), context.runtime.runId, generation, context.ownerLane ?? "main", undefined, undefined, context).catch(() => undefined);
  }
}

async function recordShellJobObservation(context: CodingResourceContext, jobId: string, result: { status: string; cursor: number; trigger: string }): Promise<string | undefined> {
  const ingress = new RunEventIngress(context.controlStore);
  const envelope = await ingress.enqueue(context.runtime.runId, {
    source: "job",
    kind: result.trigger === "timeout" ? "job.wait_timeout" : result.status === "finished" ? "job.exit" : "job.output",
    priority: result.trigger === "error" || result.trigger === "exit" ? "normal" : "background",
    correlationId: `${context.runtime.runId}:${jobId}:shell-job`,
    idempotencyKey: `${context.runtime.runId}:${jobId}:${result.trigger}:${result.cursor}`,
    coalescingKey: `shell-job:${jobId}`,
    replayPolicy: "unknown",
    payload: { jobId, status: result.status, cursor: result.cursor, trigger: result.trigger },
  });
  const event = (await context.controlStore.events(context.runtime.runId)).find((candidate) => candidate.type === "event_ingress_received" && candidate.envelope?.id === envelope.id);
  return event?.id;
}

function parseShellCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) throw new Error("shell_job sinceCursor must be a non-negative byte cursor");
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new Error("shell_job sinceCursor is too large");
  return cursor;
}

function normalizeShellMonitorWait(value: number): number {
  if (!Number.isInteger(value) || value < 50 || value > 120_000) throw new Error("shell_job monitor wait must be an integer from 50 to 120000");
  return value;
}

function throwIfShellAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "shell_job monitor aborted"));
}

function delayShellMonitor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(signal?.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Run one shell command through the lane's execution env and return its text. */
async function runShell(
  command: string,
  signal: AbortSignal | undefined,
  onUpdate: Parameters<NonNullable<AgentHarnessTool<CodingResourceContext>["execute"]>>[3],
  context: CodingResourceContext,
): Promise<string> {
  const bash = createBashTool<CodingResourceContext>();
  const result = await bash.execute("shell-helper", { command }, signal ?? new AbortController().signal, onUpdate, context);
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** Single-quote a string for bash. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const submitFlagTool: AgentHarnessTool<CodingResourceContext> = {
  name: "submit_flag",
  label: "submit_flag",
  description: "Submit one complete flag to the competition platform and return its verdict. Each distinct flag costs one real submission from a limited budget, so submit only a flag you have derived; resubmitting the same value returns the stored verdict without a second API call.",
  parameters: Type.Object({
    flag: Type.String({ minLength: 1, description: "One complete flag value, e.g. prefix{...}." }),
  }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_toolCallId, params, signal, _onUpdate, context) {
    const input = params as { flag: string };
    if (!context.submitFlag) throw new Error("submit_flag is unavailable: this run is not judged by a competition platform");
    return toolResult(await context.submitFlag(input.flag, signal));
  },
};

const webReproduceTool: AgentHarnessTool<CodingResourceContext> = {
  name: "web_reproduce",
  label: "web_reproduce",
  description: "Replay bounded HTTP or browser exploit steps in a verifier-owned clean context. The immutable task verifier supplies the transport and flag format; callers cannot provide either policy.",
  parameters: Type.Object({
    transport: Type.Optional(Type.Union([Type.Literal("http"), Type.Literal("browser")], { description: "Transport selected by the immutable Web verification policy; omit for the default HTTP transport." })),
    steps: Type.Array(Type.Object({
      action: Type.Optional(Type.Union([Type.Literal("navigate"), Type.Literal("click"), Type.Literal("fill"), Type.Literal("submit"), Type.Literal("wait")], { description: "Browser-only action; omitted means navigate for backwards compatibility." })),
      path: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048, description: "HTTP path or browser navigation path; the verifier resolves it against the immutable target origin." })),
      method: Type.Optional(Type.String({ maxLength: 12 })),
      headers: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 4_096 }))),
      body: Type.Optional(Type.String({ maxLength: 1_048_576 })),
      selector: Type.Optional(Type.Object({
        kind: Type.Union([Type.Literal("role"), Type.Literal("label"), Type.Literal("test_id"), Type.Literal("css")]),
        value: Type.String({ minLength: 1, maxLength: 256 }),
        name: Type.Optional(Type.String({ maxLength: 256 })),
      }, { additionalProperties: false })),
      value: Type.Optional(Type.String({ maxLength: 4_096 })),
      wait_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
      expectStatus: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
      expectPattern: Type.Optional(Type.String({ maxLength: 256 })),
    }, { additionalProperties: false }), { minItems: 1, maxItems: 64 }),
  }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_toolCallId, params, signal, _onUpdate, context) {
    if (!context.webReproduce) throw new Error("web_reproduce is unavailable because this task has no immutable web verifier");
    const input = params as WebExploitRecipe;
    return toolResult(await context.webReproduce(input, signal));
  },
};

export function codingActiveToolNames(input: { tools: string[]; skills: string[]; mcpServers: string[]; platformJudged?: boolean; pwnEnabled?: boolean; pwnReproductionEnabled?: boolean; webReproductionEnabled?: boolean; webSessionEnabled?: boolean }): string[] {
  const selected = new Set(input.tools);
  const active: string[] = CODING_BUILTIN_TOOL_NAMES.filter((name) => selected.has(name));
  active.push(...CODING_PROXY_TOOL_NAMES);
  // Only expose the tube tools when a Docker-backed pwn container or durable
  // session-runtime broker is attached, so a GUI chat run does not advertise
  // seven tools that would fail closed.
  if (input.pwnEnabled) {
    active.push(...CODING_PWN_TOOL_NAMES.filter((name) => name !== "pwn_reproduce" || input.pwnReproductionEnabled));
  }
  // Interactive web session tools: only when the task has a resolvable web target.
  if (input.webSessionEnabled) active.push(...CODING_WEB_SESSION_TOOL_NAMES);
  if (input.webReproductionEnabled) active.push(...CODING_WEB_TOOL_NAMES);
  if (input.platformJudged) active.push(submitFlagTool.name);
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
    createGlobTool(),
    createGrepTool(),
  ];
}

function createGlobTool(): AgentHarnessTool<CodingResourceContext> {
  return {
    name: "glob",
    label: "glob",
    description: "Find workspace files with a deterministic glob pattern. Results are sorted, bounded, and exclude control/runtime directories.",
    parameters: Type.Object({ pattern: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })) }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const result = await globWorkspace({ cwd: context.env.cwd, ...(params as { pattern?: string; maxResults?: number }) });
      return searchToolResult(context, result);
    },
  };
}

function createGrepTool(): AgentHarnessTool<CodingResourceContext> {
  return {
    name: "grep",
    label: "grep",
    description: "Search text in workspace files with deterministic path/line matches, bounded file reads, binary skipping, and a result Artifact.",
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 1_000 }), pattern: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), caseSensitive: Type.Optional(Type.Boolean()), maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })), maxFileBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 * 1024 * 1024 })) }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const result = await grepWorkspace({ cwd: context.env.cwd, ...(params as { query: string; pattern?: string; caseSensitive?: boolean; maxResults?: number; maxFileBytes?: number }) });
      return searchToolResult(context, result);
    },
  };
}

async function searchToolResult(context: CodingResourceContext, result: Awaited<ReturnType<typeof globWorkspace>> | Awaited<ReturnType<typeof grepWorkspace>>): Promise<ReturnType<AgentHarnessTool<CodingResourceContext>["execute"]> extends Promise<infer TResult> ? TResult : never> {
  const modelResult = limitWorkspaceSearchResult(result);
  const hash = workspaceSearchHash(result);
  const artifact = await context.artifactStore.putText(context.runtime.runId, JSON.stringify(result), { filename: `${result.kind}-${hash.slice(0, 12)}.json`, mime: "application/json", sensitivity: "public" });
  const presentation = workspaceSearchText(result);
  const details = { ...modelResult, artifactId: artifact.id, artifactHash: artifact.sha256, resultHash: hash, presentation };
  return toolResult(details, false, WORKSPACE_SEARCH_MODEL_MAX_CHARS);
}

/**
 * How many times identical image CONTENT is re-injected into context before the
 * read wrapper stops sending the pixels and nudges instead. The first two reads
 * give the model a genuine look (and a second glance is fair); beyond that the
 * SAME bytes yield nothing new, and each ~MB re-inject dilutes the reasoning
 * history until the model forgets it already looked and loops. Observed live:
 * one run re-read the same flag.jpg 65 times and never progressed.
 */
export const IMAGE_REINJECT_BUDGET = 2;

/**
 * Deduplicate repeated image reads within one run, keyed by the image's CONTENT
 * hash (not its path). Content keying is what makes this correct:
 *   - If a file is overwritten in place (screenshot refresh, in-place crop,
 *     re-render), the bytes change → new key → budget resets → the new image is
 *     delivered. Path-only keying would wrongly keep saying "unchanged".
 *   - Path aliases for the same bytes (`a.png`, `./a.png`, `../d/a.png`, absolute)
 *     hash identically → one shared counter, so the budget cannot be bypassed by
 *     spelling the path differently.
 * Under budget, pass the real image through; over budget, drop the image block
 * and return a short nudge toward a tactic that can actually make progress.
 */
export function dedupeImageRead(
  path: string,
  result: Awaited<ReturnType<ReturnType<typeof createReadTool<CodingResourceContext>>["execute"]>>,
  imagesSeen: Map<string, number> | undefined,
): typeof result {
  if (!imagesSeen) return result;
  // Hash the concatenated image-block payloads: this is the identity that matters
  // (same pixels = nothing new to see), independent of how the path was written.
  const imageData = result.content.filter((item) => item.type === "image").map((item) => (item as { data?: string }).data ?? "").join("\u0000");
  const key = sha256(imageData);
  const seen = imagesSeen.get(key) ?? 0;
  imagesSeen.set(key, seen + 1);
  if (seen < IMAGE_REINJECT_BUDGET) return result;
  const text = `You have already loaded this exact image ${seen} time(s) in this run (last path: ${path}) — the bytes are unchanged, so re-reading adds no new information and only crowds out your earlier reasoning. Do NOT read it again as-is. If a detail is unclear, isolate it, e.g. with Python PIL:\n\`\`\`python\nfrom PIL import Image\nImage.open("in.jpg").crop((x1, y1, x2, y2)).resize((w*4, h*4)).save("out.png")\n\`\`\`\n(or ImageMagick v7 \`magick in.jpg -crop WxH+X+Y -resize 400% out.png\`), then read that smaller piece. If you are matching symbols against a reference table, map by POSITION/INDEX in the table rather than re-recognizing each glyph from the full image.`;
  return { ...result, content: [{ type: "text" as const, text }] };
}

function createCodingReadTool(): AgentHarnessTool<CodingResourceContext> {
  const contract = createReadTool<CodingResourceContext>();
  return {
    ...contract,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const input = params as { path: string; offset?: number; limit?: number };
      const result = await contract.execute(toolCallId, input, signal, onUpdate, context);
      if (result.content.some((item) => item.type === "image")) {
        return dedupeImageRead(input.path, result, context.imagesSeen);
      }
      const pipeline = context.outputRewrite;
      const visible = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      if (!pipeline || !visible) return result;
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
      const observation = await observeCodingArtifact(context, artifact.id, artifact.sha256, "read", 0, `文件读取 · ${pathTitle(input.path)}`, `自动归档的读取结果：${input.path}${readRange(input)}。`, "intermediate", ["read", "file-content"]);
      // The archived text IS the visible text, so there is nothing to point the
      // model at; the id stays in details for the GUI/evidence graph only.
      const receipt = await artifactReceipt(context, toolCallId, `文件读取 · ${pathTitle(input.path)}`, visible, artifact.id, isBoundedReadResult(result));
      return {
        ...result,
        content: [...(observation.repeatedArtifactId ? [{ type: "text" as const, text: repeatedArtifactNotice(observation.repeatedArtifactId, Number(observation.repetitionCount)) }] : result.content), ...(receipt ? [{ type: "text" as const, text: receipt }] : [])],
        details: { ...(result.details ?? {}), artifactId: artifact.id, artifactHash: artifact.sha256, ...observation },
      };
    },
  };
}

/**
 * When a bash command TIMED OUT and the command looks like it was holding a
 * live interactive connection (pwntools tube, recv loop, nc/socat), return a
 * targeted remediation instead of letting the model read a bare "timed out" and
 * rewrite the whole script. The blocking foreground connection is the cause, so
 * point at the persistent tube (if wired) or shell_background (otherwise).
 */
export function interactiveTimeoutHint(errorMessage: string, command: string, pwnToolsAvailable: boolean): string | undefined {
  if (!/timed out|timeout/i.test(errorMessage)) return undefined;
  const interactive = /(recvuntil|recvline|recvall|interactive\(|\.recv\(|sendlineafter|sendafter|remote\(|process\(|pwn import|\bnc\s|\bncat\s|\bsocat\b)/i.test(command);
  if (!interactive) return undefined;
  return pwnToolsAvailable
    ? "[hint] This command blocked on an interactive connection and was killed at the timeout. Do NOT rewrite the whole script. Open the target once with `pwn_open` and drive it with `pwn_send`/`pwn_recv` turn-by-turn (each call is bounded), then confirm with `pwn_reproduce`. Use bash only to compute payload bytes."
    : "[hint] This command blocked on an interactive connection and was killed at the timeout. Do NOT rewrite the whole script. Run the interactive exploit under `shell_background` and poll with `shell_job` so a stall costs one bounded poll, not the whole command budget; keep foreground bash for short computation and single bounded probes only.";
}

/** Preflight guard that catches a foreground interactive exploit before it can consume the timeout budget. */
export function interactiveCommandHint(command: string, pwnToolsAvailable: boolean): string | undefined {
  const interactive = /(recvuntil|recvline|recvall|interactive\(|\.recv\(|sendlineafter|sendafter|remote\(|process\(|pwn import|\bnc\s|\bncat\s|\bsocat\b)/i.test(command);
  if (!interactive) return undefined;
  return pwnToolsAvailable
    ? "[guard] Foreground bash contains an interactive connection. Use pwn_open/pwn_send/pwn_recv/pwn_reproduce for bounded tube steps; reserve bash for payload computation."
    : "[guard] Foreground bash contains an interactive connection. Use shell_background and shell_job, or split the probe into bounded commands.";
}

/**
 * Bash is intentionally an analysis escape hatch, not a second control-plane
 * writer.  The real authority boundary is ControlStore validation, but a
 * cheap preflight catches the common `node -e`/Python/redirect attempts to
 * append trusted domain records or bypass the journal.  Read-only inspection
 * commands remain allowed; this is a loop-prevention guard, not a shell
 * sandbox, and must never be treated as verifier authority.
 */
export function bashEscapeHatchViolation(command: string): string | undefined {
  const executable = /(?:^|[;&|()\s])(?:node|nodejs|tsx|ts-node|bun|deno|python(?:3)?|py|ruby|perl|php|npm|pnpm|yarn)(?:\s|$)/i.test(command);
  const trustedWriter = /(?:dispatch(?:Transaction|Batch)?\s*\(|domain_record_added|type\s*[:=]\s*["']domain_record["']|JsonlControlStore|control-store\.js|(?:events|projection|control)\.jsonl)/i.test(command);
  const writeOperation = /(?:>>?|tee\s|Set-Content|Out-File|writeFile|appendFile|fs\.(?:write|append)File|open\s*\([^)]*,\s*["']a)/i.test(command);
  if ((executable && trustedWriter) || (writeOperation && /(?:events|projection|control)\.jsonl/i.test(command))) {
    return "Bash is an analysis escape hatch and cannot write ProofBlade control records. Use the structured Web/Pwn tools or ControlStore-owned verifier path; bash output remains untrusted Artifact/Observation data.";
  }
  return undefined;
}

function createCodingBashTool(): AgentHarnessTool<CodingResourceContext> {
  const contract = createBashTool<CodingResourceContext>();
  return {
    ...contract,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const pipeline = context.outputRewrite;
      // bash has NO default timeout, and a real run hung one call for over 30
      // minutes with nothing to break it. Anything legitimately longer belongs in
      // shell_background, so a ceiling costs nothing and bounds the damage.
      const raw = params as { command: string; timeout?: number };
      const ceiling = context.bashTimeoutSecondsMax;
      const input = ceiling === undefined
        ? raw
        : { ...raw, timeout: Math.min(raw.timeout ?? ceiling, ceiling) };
      const escapeHatchViolation = bashEscapeHatchViolation(input.command);
      if (escapeHatchViolation) throw new Error(escapeHatchViolation);
      const preflightHint = interactiveCommandHint(input.command, Boolean(context.pwnTools));
      if (preflightHint) throw new Error(preflightHint);
      await context.experimentGate?.assertAllowed({ runId: context.runtime.runId, action: "bash", input: { command: input.command, timeout: input.timeout } });
      // Enforce curation even when a test/custom lane omits output rewriting.
      // Production lanes also pass this check before starting another probe.
      const preflightCuration = await context.evidenceCurationGate?.assertInvestigationAllowed();
      if (!pipeline) {
        const result = await contract.execute(toolCallId, input, signal, onUpdate, context);
        await context.experimentGate?.record({ runId: context.runtime.runId, action: "bash", input: { command: input.command, timeout: input.timeout }, outcome: "success", summary: "Foreground bash completed." });
        return preflightCuration ? { ...result, content: [...result.content, { type: "text" as const, text: preflightCuration }] } : result;
      }
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
        const observation = await observeCodingArtifact(context, String(outputRewrite.artifactId), String(outputRewrite.artifactHash ?? ""), "bash:error", 1, `失败命令 · ${commandTitle(input.command)}`, "命令失败输出已自动归档；如它支持或反驳当前假设，再用 evidence record 提升为正式证据。", "debug", ["bash", "command-output", "debug"]);
        const anchor = artifactAnchor(String(outputRewrite.artifactId), Number(outputRewrite.savedBytes ?? 0)).map((part) => part.text);
        const receipt = await artifactReceipt(context, toolCallId, `失败命令 · ${commandTitle(input.command)}`, visible, String(outputRewrite.artifactId), true, String(outputRewrite.artifactHash ?? ""), Number(outputRewrite.rawBytes ?? 0), Number(outputRewrite.savedBytes ?? 0));
        // A timeout on an interactive exploit is the #1 pwn stall: the command
        // blocked on recv and was killed at the ceiling. Instead of a bare
        // "timed out" that invites a full script rewrite, name the fix directly.
        const hint = interactiveTimeoutHint(visible, input.command, Boolean(context.pwnTools));
        throw new Error([observation.repeatedArtifactId ? repeatedArtifactNotice(observation.repeatedArtifactId, Number(observation.repetitionCount)) : visible, ...(hint ? [hint] : []), ...anchor, ...(receipt ? [receipt] : []), observationNotice(observation)].filter(Boolean).join("\n\n"), { cause: error });
      }
      const visible = result.content.map((item) => item.type === "text" ? item.text : "[image]").join("\n");
      const outputRewrite = await finalizeAndArchive(pipeline, ticket, visible, toolCallId, input.command, "intermediate");
      const observation = await observeCodingArtifact(context, String(outputRewrite.artifactId), String(outputRewrite.artifactHash ?? ""), "bash", 0, `命令输出 · ${commandTitle(input.command)}`, "命令输出已自动归档为 routine observation；只有推进假设的结论才需要 evidence record。", "intermediate", ["bash", "command-output"]);
      const receipt = await artifactReceipt(context, toolCallId, `命令输出 · ${commandTitle(input.command)}`, visible, String(outputRewrite.artifactId), Number(outputRewrite.savedBytes ?? 0) > 0, String(outputRewrite.artifactHash ?? ""), Number(outputRewrite.rawBytes ?? 0), Number(outputRewrite.savedBytes ?? 0));
      await context.experimentGate?.record({ runId: context.runtime.runId, action: "bash", input: { command: input.command, timeout: input.timeout }, outcome: "success", summary: "Foreground bash completed." });
      return {
        ...result,
        content: [...(observation.repeatedArtifactId ? [{ type: "text" as const, text: repeatedArtifactNotice(observation.repeatedArtifactId, Number(observation.repetitionCount)) }] : result.content), ...artifactAnchor(String(outputRewrite.artifactId), Number(outputRewrite.savedBytes ?? 0)), ...(receipt ? [{ type: "text" as const, text: receipt }] : [])],
        details: {
          ...(isRecord(result.details) ? result.details : result.details === undefined ? {} : { toolDetails: result.details }),
          outputRewrite,
          ...observation,
        },
      };
    },
  };
}

function isBoundedReadResult(result: { details?: unknown }): boolean {
  return Boolean(result.details && typeof result.details === "object" && (result.details as { truncated?: unknown }).truncated === true);
}

async function artifactReceipt(context: CodingResourceContext, operationId: string, title: string, content: string, artifactId: string, bounded: boolean, artifactHash = "", artifactBytes = 0, omittedChars = 0): Promise<string | undefined> {
  try {
    const runId = context.runtime?.runId ?? context.outputRewrite?.runId;
    if (!runId) return undefined;
    const snapshot = context.controlStore
      ? await context.controlStore.snapshot(runId).catch(() => undefined)
      : undefined;
    const artifact = snapshot?.artifacts[artifactId] ?? ({
      id: artifactId,
      runId,
      generation: context.runtime?.fixture?.generation ?? snapshot?.generation ?? 0,
      path: `artifacts/${artifactId}`,
      sha256: artifactHash || "0".repeat(64),
      bytes: artifactBytes,
      mime: "text/plain",
      sensitivity: "public",
      origin: { schemaVersion: 1, registeredBy: "agent", tags: [] },
    } as never);
    return renderModelReceipt(createModelReceipt({
      runId,
      generation: context.runtime?.fixture?.generation ?? snapshot?.generation ?? 0,
      operationId,
      title,
      content,
      artifact,
      summary: `${title} 已归档；完整内容请沿 Artifact URI 使用 evidence.read/Recall。`,
      mode: bounded ? "receipt" : "full",
      ...(bounded ? { omittedChars: Math.max(omittedChars, artifactBytes - content.length) } : {}),
      maxInlineChars: 2_048,
      maxPreviewChars: 512,
      nextActions: bounded ? ["recall"] : ["none"],
    }));
  } catch {
    return undefined;
  }
}

interface AutomaticArtifactDetails {
  durableProgress?: boolean;
  progressKey?: string;
  observationId?: string;
  evidenceId?: string;
  candidateKinds?: string[];
  repeatedArtifactId?: string;
  repetitionCount?: number;
}

async function observeCodingArtifact(
  context: CodingResourceContext,
  artifactId: string,
  artifactHash: string,
  operation: string,
  exitCode: number | null,
  name: string,
  summary: string,
  role: "intermediate" | "debug",
  tags: string[],
): Promise<AutomaticArtifactDetails> {
  const details: AutomaticArtifactDetails = {};
  const previous = artifactHash ? context.artifactOutputRefs?.get(artifactHash) : undefined;
  if (artifactHash && context.artifactOutputRefs) {
    const next = { artifactId: previous?.artifactId ?? artifactId, count: (previous?.count ?? 0) + 1 };
    context.artifactOutputRefs.set(artifactHash, next);
    if (context.artifactOutputRefs.size > MAX_ARTIFACT_REPLAY_KEYS) {
      const oldest = context.artifactOutputRefs.keys().next().value;
      if (typeof oldest === "string") context.artifactOutputRefs.delete(oldest);
    }
    if (previous) {
      details.repeatedArtifactId = previous.artifactId;
      details.repetitionCount = next.count;
    }
  }
  try {
    const review = await context.evidenceGraph.annotateArtifact({ artifactId, name, summary, role, tags: [...tags, "auto-reviewed"] });
    // Automatic artifact annotation is bookkeeping, not a solver milestone.
    // `annotateArtifact` reports a newly seen artifact as progress for explicit
    // evidence workflows, but read/bash output is produced on every probe.
    // Propagating that flag here reset the no-progress and experiment breakers
    // after every successful command, allowing an unbounded investigation loop.
    details.durableProgress = false;
    details.progressKey = review.progressKey;
  } catch {
    // Artifact annotation is an observer side effect. A transient control-store
    // failure must not turn a completed bash/read call into a failed solve.
  }
  if (context.runtime && typeof context.runtime.observeArtifact === "function") {
    try {
      const observed = await context.runtime.observeArtifact({ operation, artifactId, exitCode });
      details.observationId = observed.observationId;
      details.evidenceId = observed.evidenceId;
      details.candidateKinds = observed.candidateKinds;
      details.progressKey ??= observed.progressKey;
    } catch {
      // Automatic observation is best-effort; the raw Artifact remains the
      // durable source if the control store is temporarily unavailable.
    }
  }
  return details;
}

function observationNotice(details: AutomaticArtifactDetails): string | undefined {
  const observationId = details.observationId;
  const evidenceId = details.evidenceId;
  const progressKey = details.progressKey;
  if (!observationId && !evidenceId && !progressKey) return undefined;
  return `[ProofBlade observation${observationId ? ` ${observationId}` : ""}${evidenceId ? ` evidence ${evidenceId}` : ""}${progressKey ? ` progressKey ${progressKey}` : ""}]`;
}

function repeatedArtifactNotice(artifactId: string, count: number): string {
  return `[ProofBlade repeated observation: same artifact content as ${artifactId} (seen ${Math.max(2, count)} times); no new bytes were injected. Change the input or use the existing evidence/artifact reference.]`;
}

const MAX_ARTIFACT_REPLAY_KEYS = 512;

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

/**
 * Anchor the archived artifact ONLY when the visible output really is short of
 * the raw output. Announcing an artifact on complete output taught the model
 * that content had been withheld, so it spent turns calling `evidence read` /
 * `evidence search` for text it already had — and when those came back empty
 * (archived artifacts are not in the search index), it re-ran the tool instead.
 */
function artifactAnchor(artifactId: string, withheldBytes = 0): { type: "text"; text: string }[] {
  if (withheldBytes <= 0) return [];
  return [{ type: "text", text: `[ProofBlade artifact ${artifactId}: ${withheldBytes} bytes withheld from the text above; read it with the evidence tool (operation="read", artifactId="${artifactId}") — do not re-run the command]` }];
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

const capabilityTool: AgentHarnessTool<CodingResourceContext> = {
  name: "capability",
  label: "capability",
  description: "Search, describe, or invoke ProofBlade logical capabilities through one stable proxy. Search first, describe one operation when its schema is needed, then invoke it.",
  parameters: Type.Object({
    operation: Type.String({ enum: ["search", "describe", "invoke"] }),
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Search terms for capability ids, operation names, and descriptions." })),
    capabilityId: Type.Optional(Type.String({ minLength: 1, description: "Exact logical capability id for describe or invoke." })),
    capabilityOperation: Type.Optional(Type.String({ minLength: 1, description: "Exact capability operation name for describe or invoke." })),
    input: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Capability operation arguments for invoke." })),
    maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_toolCallId, params, signal, _onUpdate, context) {
    const input = params as {
      operation: "search" | "describe" | "invoke";
      query?: string;
      capabilityId?: string;
      capabilityOperation?: string;
      input?: Record<string, unknown>;
      maxResults?: number;
    };
    if (!(["search", "describe", "invoke"] as const).includes(input.operation)) throw new Error("Unsupported capability proxy operation: " + String(input.operation));
    if (input.operation === "search") {
      assertAbsent(input, ["capabilityId", "capabilityOperation", "input"], "capability search");
      return toolResult(context.runtime.discoverCapabilities({ query: input.query, maxResults: input.maxResults }));
    }
    if (!input.capabilityId || !input.capabilityOperation) throw new Error("Capability " + input.operation + " requires capabilityId and capabilityOperation");
    if (input.operation === "describe") {
      assertAbsent(input, ["query", "input", "maxResults"], "capability describe");
      return toolResult(context.runtime.discoverCapabilities({
        capabilityId: input.capabilityId,
        operation: input.capabilityOperation,
        includeSchemas: true,
        maxResults: 1,
      }));
    }
    assertAbsent(input, ["query", "maxResults"], "capability invoke");
    if (!isRecord(input.input)) throw new Error("Capability invoke requires an input object");
    await context.experimentGate?.assertAllowed({ runId: context.runtime.runId, action: `capability:${input.capabilityId}.${input.capabilityOperation}`, input: input.input });
    let result: Awaited<ReturnType<ProofBladeToolRuntime["invokeCapability"]>>;
    try {
      result = await context.runtime.invokeCapability({ capabilityId: input.capabilityId, operation: input.capabilityOperation, input: input.input }, signal);
    } catch (error) {
      await context.experimentGate?.record({ runId: context.runtime.runId, action: `capability:${input.capabilityId}.${input.capabilityOperation}`, input: input.input, outcome: /timed out|timeout/i.test(String(error)) ? "timeout" : "failure", summary: String(error).slice(0, 1_000) });
      throw error;
    }
    await context.experimentGate?.record({ runId: context.runtime.runId, action: `capability:${input.capabilityId}.${input.capabilityOperation}`, input: input.input, outcome: result ? "success" : "unknown", summary: "Capability invocation completed." });
    return toolResult(result);
  },
};

const mcpCallTool: AgentHarnessTool<CodingResourceContext> = {
  name: "mcp_call",
  label: "mcp_call",
  description: "List, inspect, or call enabled MCP capabilities through one cache-stable proxy. Use describe before call.",
  parameters: Type.Object({
    operation: Type.String({ enum: ["list", "describe", "call"] }),
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
      return toolResult(await context.mcp.describeServer(input.server, signal));
    }
    if (!input.tool || !input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)) throw new Error("MCP call requires tool and object arguments");
    const capabilityId = context.mcp.summaries().find((server) => server.name === input.server)?.capabilityId;
    if (!capabilityId) throw new Error(`Unknown MCP server: ${input.server}`);
    if (context.runtime && typeof context.runtime.invokeCapability === "function") {
      const invocation = await context.runtime.invokeCapability({
        capabilityId,
        operation: "call",
        input: { tool: input.tool, arguments: input.arguments },
      }, signal);
      return toolResult(invocation);
    }
    const result = await context.mcp.execute(capabilityId, "call", { tool: input.tool, arguments: input.arguments }, signal);
    return mcpToolResult(result);
  },
};

function assertMcpEnabled(context: CodingResourceContext, server: string): void {
  if (!context.enabledMcpServers.has(server)) throw new Error(`MCP server is not enabled for this conversation: ${server}`);
  if (!enabledMcpSummaries(context).some((item) => item.name === server)) throw new Error(`Unknown or disabled MCP server: ${server}`);
}

function enabledMcpSummaries(context: CodingResourceContext): ReturnType<McpProjectRegistry["summaries"]> {
  return context.mcp.summaries().filter((server) => context.enabledMcpServers.has(server.name) && !server.disabled);
}

function assertOnly(input: Record<string, unknown>, allowed: string[], operation: string): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(input).filter((key) => input[key] !== undefined && !allowedKeys.has(key));
  if (unexpected.length > 0) throw new Error(`${operation} does not accept: ${unexpected.join(", ")}`);
}

function assertAbsent(input: Record<string, unknown>, keys: string[], operation: string): void {
  const unexpected = keys.filter((key) => input[key] !== undefined);
  if (unexpected.length > 0) throw new Error(`${operation} does not accept: ${unexpected.join(", ")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Render an MCP call result as text the model can actually read.
 *
 * The wire shape arrives quadruple-encoded: the tool result JSON is a string
 * inside `result.content[].text`, that sits inside the `{server, tool, result}`
 * envelope, which is itself a JSON string in `RawEffectResult.stdout`, which we
 * would then JSON.stringify again. The model receives `\\\"instruction\\\"`
 * soup with no real newlines and concludes — reasonably — that its output is
 * being truncated, then re-issues the same call. Measured on an idalib disasm:
 * 835 chars of plain text became 10778 chars of escaping (12.9x).
 *
 * So: unwrap every layer once, and flatten the shapes that dominate RE work
 * (instruction listings, decompiled source) into plain lines.
 */
function renderMcpPayload(result: RawEffectResult): string {
  const stdout = result.stdout.trim();
  if (!stdout) return result.stderr.trim() || "(no output)";
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return stdout; // not our envelope; pass through untouched
  }
  const parts = isRecord(envelope) && isRecord(envelope.result) && Array.isArray(envelope.result.content)
    ? envelope.result.content
    : undefined;
  if (!parts) return typeof envelope === "string" ? envelope : JSON.stringify(envelope, null, 2);
  const rendered = parts.map((part) => {
    if (!isRecord(part)) return String(part);
    if (part.type !== "text" || typeof part.text !== "string") return `[${String(part.type ?? "unknown")}]`;
    let inner: unknown;
    try {
      inner = JSON.parse(part.text);
    } catch {
      return part.text; // already plain text
    }
    return formatMcpValue(inner);
  });
  const body = rendered.join("\n").trim();
  const stderr = result.stderr.trim();
  return stderr ? `${body}\n\n[stderr] ${stderr}` : body;
}

/** Flatten the payload shapes that would otherwise cost ~13x in escaped JSON. */
function formatMcpValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return JSON.stringify(value, null, 2);
  const sections: string[] = [];
  const rest: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === undefined) continue; // drop "error": null noise
    if (Array.isArray(entry) && entry.length === 0) continue; // drop "callers": []
    if (isRecord(entry) && Object.keys(entry).length === 0) continue; // drop "comments": {}
    if (key === "asm" && isRecord(entry) && Array.isArray(entry.lines)) {
      sections.push(formatAsm(entry));
      continue;
    }
    if (Array.isArray(entry) && entry.length > 0 && entry.every((item) => isRecord(item) && typeof item.instruction === "string")) {
      sections.push(formatAsm({ lines: entry }));
      continue;
    }
    if ((key === "decompiled" || key === "pseudocode" || key === "code" || key === "source") && typeof entry === "string") {
      sections.push(entry.trim());
      continue;
    }
    rest[key] = entry;
  }
  if (sections.length === 0) return JSON.stringify(value, null, 2);
  const restKeys = Object.keys(rest);
  const header = restKeys.length > 0 ? `${restKeys.map((key) => `${key}=${scalarOrJson(rest[key])}`).join(" ")}\n` : "";
  return `${header}${sections.join("\n\n")}`;
}

function formatAsm(asm: Record<string, unknown>): string {
  const lines = Array.isArray(asm.lines) ? asm.lines : [];
  const head = [asm.name, asm.segment, asm.start_ea, asm.prototype].filter((item) => typeof item === "string").join(" · ");
  const body = lines.map((line) => {
    if (!isRecord(line)) return String(line);
    const addr = typeof line.addr === "string" ? line.addr.padStart(8) : "        ";
    const label = typeof line.label === "string" ? `\n${line.label}:` : "";
    const refs = Array.isArray(line.refs)
      ? line.refs.map((ref) => (isRecord(ref) ? String(ref.name ?? ref.addr ?? "") : String(ref))).filter(Boolean)
      : [];
    const comment = refs.length > 0 ? `   ; -> ${refs.join(", ")}` : "";
    return `${label}${label ? "\n" : ""}${addr}  ${String(line.instruction ?? "")}${comment}`;
  }).join("\n");
  return head ? `${head}\n${body}` : body;
}

function scalarOrJson(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
}

function mcpToolResult(result: RawEffectResult): ReturnType<AgentHarnessTool<CodingResourceContext>["execute"]> extends Promise<infer TResult> ? TResult : never {
  const visible = boundModelText(renderMcpPayload(result), Number.MAX_SAFE_INTEGER, MODEL_TOOL_RESULT_MAX_TOKENS);
  return {
    content: [{ type: "text", text: visible.text }],
    details: { exitCode: result.exitCode, durationMs: result.durationMs, ...(result.externalId ? { externalId: result.externalId } : {}), ...(visible.truncated ? { truncated: true, maxTokens: MODEL_TOOL_RESULT_MAX_TOKENS } : {}) },
    isError: result.exitCode !== 0,
  } as ReturnType<AgentHarnessTool<CodingResourceContext>["execute"]> extends Promise<infer TResult> ? TResult : never;
}

function toolResult(details: unknown, isError = false, maxChars?: number): ReturnType<AgentHarnessTool<CodingResourceContext>["execute"]> extends Promise<infer TResult> ? TResult : never {
  const serialized = JSON.stringify(details);
  const requestedChars = maxChars === undefined ? Math.max(64, serialized.length) : Math.max(64, maxChars);
  const visible = boundModelText(serialized, requestedChars, MODEL_TOOL_RESULT_MAX_TOKENS).text;
  return {
    content: [{ type: "text", text: visible }],
    details,
    isError,
  } as ReturnType<AgentHarnessTool<CodingResourceContext>["execute"]> extends Promise<infer TResult> ? TResult : never;
}
