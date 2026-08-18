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
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { McpProjectRegistry } from "../mcp/registry.js";
import type { ProofBladeSkillRegistry } from "../skills/registry.js";
import type { CodingEvidenceGraph } from "../knowledge/evidence-graph.js";
import type { EvidenceCurationGate } from "../knowledge/evidence-curation-gate.js";
import type { CodingClaimVerifier } from "../verification/claim-verification.js";
import type { ToolEffectPolicy, ToolEffectPolicyResolver } from "./tool-repeat-breaker.js";
import type { ProofBladeToolRuntime } from "../tools/runtime.js";
import type { RawEffectResult } from "../domain/types.js";

export const CODING_BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;
export const CODING_PROXY_TOOL_NAMES = ["verify_claim", "evidence", "load_skill", "capability", "mcp_call", "shell_background", "shell_job"] as const;

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
  skills: ProofBladeSkillRegistry;
  mcp: McpProjectRegistry;
  enabledSkills: Set<string>;
  enabledMcpServers: Set<string>;
  claimVerifier: CodingClaimVerifier;
  evidenceGraph: CodingEvidenceGraph;
  evidenceCurationGate?: EvidenceCurationGate;
  runtime: ProofBladeToolRuntime;
  /** Present only when the run is judged by a live competition platform. */
  submitFlag?: (flag: string, signal?: AbortSignal) => Promise<CodingFlagSubmission>;
  /** Hard ceiling in seconds on any single `bash` call. Unset means no ceiling. */
  bashTimeoutSecondsMax?: number;
  outputRewrite?: {
    port: OutputRewritePort;
    artifactStore: ArtifactStore;
    runId: string;
  };
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

export function createCodingTools(options: { platformJudged?: boolean } = {}): AgentHarnessTool<CodingResourceContext>[] {
  return [
    ...builtinTools(),
    verifyClaimTool,
    evidenceTool,
    loadSkillTool,
    capabilityTool,
    mcpCallTool,
    shellBackgroundTool,
    shellJobTool,
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

const READ_ONLY_EFFECT: ToolEffectPolicy = { readOnly: true, sideEffect: "none" };
const WORKSPACE_EFFECT: ToolEffectPolicy = { readOnly: false, sideEffect: "workspace" };
const PROCESS_EFFECT: ToolEffectPolicy = { readOnly: false, sideEffect: "process" };

const CODING_TOOL_EFFECT_POLICIES: Readonly<Record<string, ToolEffectPolicy>> = {
  read: READ_ONLY_EFFECT,
  bash: PROCESS_EFFECT,
  edit: WORKSPACE_EFFECT,
  write: WORKSPACE_EFFECT,
  verify_claim: WORKSPACE_EFFECT,
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
  description: "Evidence Curator proxy for durable observations, typed graph edges, reasoning trees, and the compact forest index. Use curation_status for the exact pending Artifact ids. Record accepts artifactIds (plural), name, and summary; it does not accept artifactId or role. Annotate accepts artifactId (singular), name, summary, and optional role. Record promotes artifacts into Evidence and an optional claim/tree. Trees are views over shared DAG nodes, so reuse node ids instead of copying evidence.",
  parameters: Type.Object({
    operation: Type.String({
      enum: ["curation_status", "inspect_forest", "inspect_tree", "search", "read", "annotate", "record", "link", "create_tree", "update_tree"],
      description: "Evidence operation. curation_status takes no other arguments; inspect_tree requires treeId; read requires artifactId; annotate requires artifactId, name, and summary; record requires artifactIds (plural), name, and summary and never accepts artifactId or role; link requires from, to, and relation; create_tree requires name, summary, purpose, explanation, rootNodeId, and nodeIds; update_tree requires treeId.",
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
      operation: "curation_status" | "inspect_forest" | "inspect_tree" | "search" | "read" | "annotate" | "record" | "link" | "create_tree" | "update_tree";
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
    if (!("operation" in input) || !["curation_status", "inspect_forest", "inspect_tree", "search", "read", "annotate", "record", "link", "create_tree", "update_tree"].includes(input.operation)) throw new Error(`Unsupported evidence operation: ${String(input.operation)}`);
    if (input.operation === "curation_status") {
      assertOnly(input, ["operation"], "evidence curation_status");
      return toolResult({ curation: await context.evidenceCurationGate?.inspect() ?? { stage: "clear", pendingCount: 0, pendingArtifacts: [] } });
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
      return toolResult({ results: await context.evidenceGraph.search(input.query, input.tags) });
    }
    if (input.operation === "read") {
      assertOnly(input, ["operation", "artifactId", "maxChars"], "evidence read");
      if (!input.artifactId) throw new Error("evidence read requires artifactId");
      return toolResult(await context.evidenceGraph.readArtifact(input.artifactId, input.maxChars));
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
    const jobId = `sh-${toolCallId.slice(-8)}`;
    const slug = (input.label ?? "job").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40);
    const logPath = `.proofblade/jobs/${jobId}-${slug}.log`;
    // setsid/nohup keeps the child alive past this tool call; $! is captured
    // before any other command can overwrite it.
    // The pid goes to a file rather than being matched later with `pgrep -f`:
    // the log path is a redirection performed by THIS shell, so it never appears
    // in the child's argv and pattern-matching for it always misses.
    const launcher = [
      `mkdir -p .proofblade/jobs`,
      `nohup bash -c ${shellQuote(input.command)} > ${logPath} 2>&1 &`,
      `echo $! > ${pidPath(jobId)}`,
      `echo "pid=$!"`,
    ].join("\n");
    const started = await runShell(launcher, signal, onUpdate, context);
    const pid = /pid=(\d+)/.exec(started)?.[1];
    if (!pid) throw new Error(`Could not start background job: ${started.slice(0, 400)}`);
    return toolResult({
      jobId,
      pid: Number(pid),
      logPath,
      status: "running",
      note: `Started in the background. Poll with shell_job {"operation":"read","jobId":"${jobId}"} and stop it with {"operation":"stop","jobId":"${jobId}"}. Keep working while it runs.`,
    });
  },
};

/** Poll or stop a background shell job started by `shell_background`. */
const shellJobTool: AgentHarnessTool<CodingResourceContext> = {
  name: "shell_job",
  label: "shell_job",
  description: "Read the output of, or stop, a background job started by shell_background.",
  parameters: Type.Object({
    operation: Type.String({ enum: ["read", "stop", "list"], description: "read tails the job log, stop kills it, list shows known jobs." }),
    jobId: Type.Optional(Type.String({ minLength: 1, description: "Job id from shell_background. Required for read and stop." })),
    maxChars: Type.Optional(Type.Number({ minimum: 256, maximum: 20_000, description: "Bound on returned log text (default 4000)." })),
  }, { additionalProperties: false }),
  executionMode: "sequential",
  async execute(_toolCallId, params, signal, onUpdate, context) {
    const input = params as { operation: "read" | "stop" | "list"; jobId?: string; maxChars?: number };
    if (input.operation === "list") {
      assertAbsent(input as unknown as Record<string, unknown>, ["jobId"], "shell_job list");
      const listed = await runShell(`ls -1 .proofblade/jobs/*.log 2>/dev/null || echo "(no jobs)"`, signal, onUpdate, context);
      return toolResult({ jobs: listed.trim().split(/\r?\n/).filter(Boolean) });
    }
    if (!input.jobId) throw new Error(`shell_job ${input.operation} requires jobId`);
    if (!/^[A-Za-z0-9._-]+$/.test(input.jobId)) throw new Error("shell_job jobId contains unsupported characters");
    if (input.operation === "stop") {
      // Kill the recorded pid AND its children: the pid is a `bash -c` wrapper, and
      // the work (a sweep, a fuzzer) usually lives in a child of it.
      const stopped = await runShell(
        [
          `p=$(cat ${pidPath(input.jobId)} 2>/dev/null)`,
          `if [ -z "$p" ]; then echo "__NO_JOB__"; else`,
          `pkill -P "$p" 2>/dev/null; kill "$p" 2>/dev/null`,
          `sleep 0.3`,
          `if kill -0 "$p" 2>/dev/null; then pkill -9 -P "$p" 2>/dev/null; kill -9 "$p" 2>/dev/null; sleep 0.2; fi`,
          `if kill -0 "$p" 2>/dev/null; then echo "still-alive"; else echo stopped; fi; fi`,
        ].join("\n"),
        signal,
        onUpdate,
        context,
      );
      if (stopped.includes("__NO_JOB__")) throw new Error(`Unknown background job: ${input.jobId}`);
      return toolResult({ jobId: input.jobId, stopped: stopped.includes("stopped"), detail: stopped.trim() });
    }
    const maxChars = input.maxChars ?? 4_000;
    const output = await runShell(
      `f=$(ls -1 .proofblade/jobs/${input.jobId}-*.log 2>/dev/null | head -1); ` +
      `if [ -z "$f" ]; then echo "__NO_JOB__"; else ` +
      `p=$(cat ${pidPath(input.jobId)} 2>/dev/null); ` +
      `if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo "__RUNNING__"; else echo "__FINISHED__"; fi; ` +
      `wc -c < "$f"; tail -c ${Math.max(256, maxChars)} "$f"; fi`,
      signal,
      onUpdate,
      context,
    );
    if (output.includes("__NO_JOB__")) throw new Error(`Unknown background job: ${input.jobId}`);
    const running = output.includes("__RUNNING__");
    const body = output.replace(/__(RUNNING|FINISHED)__\r?\n/, "");
    const [sizeLine, ...rest] = body.split(/\r?\n/);
    const totalBytes = Number.parseInt((sizeLine ?? "").trim(), 10);
    const text = rest.join("\n");
    return toolResult({
      jobId: input.jobId,
      status: running ? "running" : "finished",
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : undefined,
      truncated: Number.isFinite(totalBytes) && totalBytes > text.length,
      output: text,
      ...(running ? { note: "Still running — do not wait in a loop; go do other analysis and poll again later." } : {}),
    });
  },
};

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

/** Where a background job records its pid, used for liveness and for stopping. */
function pidPath(jobId: string): string {
  return `.proofblade/jobs/${jobId}.pid`;
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

export function codingActiveToolNames(input: { tools: string[]; skills: string[]; mcpServers: string[]; platformJudged?: boolean }): string[] {
  const selected = new Set(input.tools);
  const active: string[] = CODING_BUILTIN_TOOL_NAMES.filter((name) => selected.has(name));
  active.push(...CODING_PROXY_TOOL_NAMES);
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
  ];
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
  const imageData = result.content.filter((item) => item.type === "image").map((item) => (item as { data?: string }).data ?? "").join(" ");
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
      await context.evidenceCurationGate?.assertInvestigationAllowed();
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
      const notice = await context.evidenceCurationGate?.checkpointNotice();
      // The archived text IS the visible text, so there is nothing to point the
      // model at; the id stays in details for the GUI/evidence graph only.
      return {
        ...result,
        content: [...result.content, ...(notice ? [{ type: "text" as const, text: notice }] : [])],
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
      // bash has NO default timeout, and a real run hung one call for over 30
      // minutes with nothing to break it. Anything legitimately longer belongs in
      // shell_background, so a ceiling costs nothing and bounds the damage.
      const raw = params as { command: string; timeout?: number };
      const ceiling = context.bashTimeoutSecondsMax;
      const input = ceiling === undefined
        ? raw
        : { ...raw, timeout: Math.min(raw.timeout ?? ceiling, ceiling) };
      if (!pipeline) return await contract.execute(toolCallId, input, signal, onUpdate, context);
      await context.evidenceCurationGate?.assertInvestigationAllowed();
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
        const notice = await context.evidenceCurationGate?.checkpointNotice();
        const anchor = artifactAnchor(String(outputRewrite.artifactId), Number(outputRewrite.savedBytes ?? 0)).map((part) => part.text);
        throw new Error([visible, ...anchor, ...(notice ? [notice] : [])].join("\n\n"), { cause: error });
      }
      const visible = result.content.map((item) => item.type === "text" ? item.text : "[image]").join("\n");
      const outputRewrite = await finalizeAndArchive(pipeline, ticket, visible, toolCallId, input.command, "intermediate");
      const notice = await context.evidenceCurationGate?.checkpointNotice();
      return {
        ...result,
        content: [...result.content, ...artifactAnchor(String(outputRewrite.artifactId), Number(outputRewrite.savedBytes ?? 0)), ...(notice ? [{ type: "text" as const, text: notice }] : [])],
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
    const result = await context.runtime.invokeCapability({
      capabilityId: input.capabilityId,
      operation: input.capabilityOperation,
      input: input.input,
    }, signal);
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
  return {
    content: [{ type: "text", text: renderMcpPayload(result) }],
    details: { exitCode: result.exitCode, durationMs: result.durationMs, ...(result.externalId ? { externalId: result.externalId } : {}) },
    isError: result.exitCode !== 0,
  } as ReturnType<AgentHarnessTool<CodingResourceContext>["execute"]> extends Promise<infer TResult> ? TResult : never;
}

function toolResult(details: unknown, isError = false, maxChars?: number): ReturnType<AgentHarnessTool<CodingResourceContext>["execute"]> extends Promise<infer TResult> ? TResult : never {
  const serialized = JSON.stringify(details);
  const visible = maxChars === undefined ? serialized : snipText(serialized, maxChars).text;
  return {
    content: [{ type: "text", text: visible }],
    details,
    isError,
  } as ReturnType<AgentHarnessTool<CodingResourceContext>["execute"]> extends Promise<infer TResult> ? TResult : never;
}
