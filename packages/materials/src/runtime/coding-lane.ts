import { dirname, join } from "node:path";
import {
  AgentHarness,
  createCustomMessage,
  JsonlSessionRepo,
  NodeExecutionEnv,
  type AgentMessage,
  type AgentHarnessEvent,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { resolveOutputRewriteConfig, type ProofBladeConfig } from "../config.js";
import type { ControlStore } from "../control/control-store.js";
import { prepareContextMaintenance } from "../context/maintenance-coordinator.js";
import { isRealUserTask, latestExternalUserMessage } from "../context/user-task-anchor.js";
import { CheckpointService } from "../context/checkpoint.js";
import { DurableCompactionCoordinator } from "../context/durable-compaction.js";
import { canonicalJson, estimateTokens, sha256 } from "../domain/utils.js";
import { attachPiObservability, createProviderSchedulingTelemetry } from "../observability/pi-events.js";
import { McpProjectRegistry } from "../mcp/registry.js";
import { ProofBladeSkillRegistry } from "../skills/registry.js";
import { ProofBladeToolCatalogRegistry } from "../tools/catalog.js";
import { ContainerExecutionEnv } from "../container/execution-env.js";
import { ArtifactStore } from "../effects/artifact-store.js";
import type { EffectJournal } from "../effects/effect-journal.js";
import { CodingEvidenceGraph, formatReasoningForestContext } from "../knowledge/evidence-graph.js";
import { EvidenceCurationGate } from "../knowledge/evidence-curation-gate.js";
import { createExecutionEnvRtkProcessRunner, createOutputRewritePort } from "../tools/output-rewrite.js";
import { CodingClaimVerifier } from "../verification/claim-verification.js";
import { codingActiveToolNames, createCodingToolEffectPolicyResolver, createCodingTools, createMcpFirstClassTools, type CodingFlagSubmission, type CodingResourceContext } from "./coding-resources.js";
import { IndependentVerifier } from "../verification/verifier.js";
import type { FixtureRef } from "../sandbox/fixture.js";
import type { RunSnapshot, TaskContract } from "../domain/types.js";
import { createConfiguredModels, resolveModelProfile } from "./lmstudio-provider.js";
import type { AgentLanePort, AgentOutcome } from "./pi-adapter.js";
import { promptWithContextLengthRecovery } from "./context-length-recovery.js";
import { attachCodingTurnGuards, finalizeCodingTurn, type CodingTurnTermination } from "./coding-turn-projection.js";
import { ExperimentBudgetBreaker, NoProgressToolBreaker, RepeatedToolFailureBreaker, ToolFailureStormBreaker } from "./tool-repeat-breaker.js";
import { ProofBladeToolRuntime } from "../tools/runtime.js";
import { ContainerExecutionEnv } from "../container/execution-env.js";
import { SessionRegistry } from "../container/session-registry.js";
import { PwnReproducer } from "../verification/pwn-reproducer.js";
import { PwnToolHandler } from "../pwn/pwn-tools.js";

const CODING_SYSTEM_PROMPT = `You are ProofBlade (证锋), a coding agent working with the user in their current project workspace.

Respond naturally to ordinary conversation. Use workspace tools only when the user's request benefits from inspecting, running, or editing project files. Explain completed work concisely and preserve the user's existing changes.

Tool output you receive is complete unless it says otherwise. Only when a result ends with a ProofBlade artifact anchor (\`A-*\` id, stating how many bytes were withheld) is there more to fetch — then read that id with the evidence tool rather than re-running the command. No anchor means nothing was withheld, so do not go looking for a fuller copy. Every tool output is archived regardless, and \`evidence search\` matches archived text, so a query can recover something that scrolled out of context. The evidence tools (record, annotate, inspect_forest, inspect_tree, search) are optional during an initial pass. If a ProofBlade evidence-curation or experiment-budget message appears, stop probing, preserve the strongest finding with record/annotate, and continue only after the next replan turn; do not bypass the guard by issuing another equivalent bash call.

Anything that will take more than about a minute — a brute force, a wide sweep, a fuzzer, a server you need running — belongs in \`shell_background\`, not \`bash\`. \`bash\` blocks until the command finishes, so a long sweep freezes your whole turn; \`shell_background\` returns a job id immediately and you keep working, then poll with \`shell_job\`. Do not poll in a tight loop: start the job, do other analysis, and check back.

If the same tool call keeps looking wrong or incomplete, do not re-issue it a third time. Either the output is telling you something you have not accepted yet, or the approach is wrong: change the question, change the tool, or move on with what you already have.

When the user asks for a CTF flag, challenge answer, recovered secret, or another deterministic result from workspace evidence, inspect the real inputs and test decoy hypotheses against file structures and control flow. Before reporting a final candidate as confirmed, call verify_claim with the exact candidate and a deterministic command that derives and prints it without embedding the candidate literal. Link the supporting evidence ids used by the reproduction. Treat strings output alone as an observation, not verification. If reproduction is still missing, state that the conclusion is unverified and name the missing check.

Use the capability proxy as an optional analysis instrument, not a mandatory workflow. Search it when stable binary or firmware structure would help, describe only the chosen operation to load its schema, and invoke it with workspace-relative paths. Keep planning autonomous; do not call capabilities mechanically when read or bash is more appropriate.`;

export class PiCodingLane implements AgentLanePort {
  private busy = false;

  private constructor(
    private readonly runId: string,
    private readonly controlStore: ControlStore,
    private readonly harness: AgentHarness<CodingResourceContext>,
    private readonly env: ExecutionEnv,
    private readonly sessionEnv: ExecutionEnv,
    private readonly closeTransport: () => Promise<void>,
    private readonly mcp: McpProjectRegistry,
    private readonly runtime: ProofBladeToolRuntime,
    private readonly claimVerifier: CodingClaimVerifier,
    private readonly maintenance: { compactRequested: boolean },
    private readonly repeatBreaker: RepeatedToolFailureBreaker,
    private readonly progressBreaker: NoProgressToolBreaker,
    private readonly failureStormBreaker: ToolFailureStormBreaker,
    private readonly experimentBudgetBreaker: ExperimentBudgetBreaker,
    private readonly termination: CodingTurnTermination,
    private readonly refreshForestContext: () => Promise<void>,
    private readonly latestAssistantEntryId: () => Promise<string | undefined>,
  ) {}

  public static async create(options: {
    runId: string;
    projectRoot: string;
    /** ProofBlade install root — where skills/ and .mcp.json live. Distinct from
     * projectRoot (the challenge workspace where bash runs). Defaults to the
     * ProofBlade root derived from runDir. */
    installRoot?: string;
    runDir: string;
    controlStore: ControlStore;
    artifactStore: ArtifactStore;
    journal: EffectJournal;
    config: ProofBladeConfig;
    /** Optional process backend. Files remain on the host; bash/exec runs here. */
    executionEnv?: ExecutionEnv;
    /** Path visible to commands inside the execution backend (normally /workspace). */
    workspaceRootForPrompt?: string;
    /** Skill library path visible to commands inside the execution backend. */
    skillsLibraryPathForPrompt?: string;
    /** Platform syntax visible to the execution backend (Docker is Linux on every host). */
    executionPlatform?: NodeJS.Platform;
    /** Host path for host-side MCP tools such as IDA; only use it in MCP arguments. */
    hostWorkspaceRootForMcp?: string;
    capabilities?: { enabledTools?: string[]; enabledSkills?: string[]; enabledMcpServers?: string[] };
    /** Live execution mode for a platform-judged run. "assist" records a flag for
     * operator approval instead of submitting it. Defaults to autonomous play. */
    mode?: () => "auto" | "assist";
    /** Hard ceiling in seconds on any single `bash` call. Unset means no ceiling. */
    bashTimeoutSecondsMax?: number;
    onEvent?: (event: AgentHarnessEvent) => void | Promise<void>;
  }): Promise<PiCodingLane> {
    const sessionEnv = new NodeExecutionEnv({ cwd: options.projectRoot });
    const env: ExecutionEnv = options.executionEnv ?? new NodeExecutionEnv({ cwd: options.projectRoot });
    const repo = new JsonlSessionRepo({ fs: sessionEnv, sessionsRoot: join(options.runDir, "pi-sessions") });
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
    const scheduling = createProviderSchedulingTelemetry({ runId: options.runId, lane: "main", controlStore: options.controlStore });
    const { models, model, closeTransport } = createConfiguredModels(profile, undefined, { observer: scheduling.observer });
    // skills/ and .mcp.json live in the ProofBlade install root, NOT the challenge
    // workspace. runDir is <installRoot>/runs/<runId>, so dirname(dirname(runDir))
    // recovers the install root when it is not passed explicitly.
    const installRoot = options.installRoot ?? dirname(dirname(options.runDir));
    const skills = await ProofBladeSkillRegistry.load(installRoot);
    const mcp = McpProjectRegistry.load(installRoot);
    // Host-local tool catalog: metadata stays resident in the system prompt, the
    // same way skill/MCP metadata do. A missing or broken manifest degrades to an
    // empty catalog (the registry surfaces a warning), never a hard failure. When
    // the lane's bash runs inside a container (executionEnv is a
    // ContainerExecutionEnv), the host-local catalog is suppressed entirely: the
    // host paths do not exist in the container, so injecting them would send the
    // model chasing ENOENTs.
    const inContainer = options.executionEnv instanceof ContainerExecutionEnv;
    const toolCatalog = await ProofBladeToolCatalogRegistry.load(installRoot, { container: inContainer });
    const enabledTools = options.capabilities?.enabledTools ?? ["read", "bash", "edit", "write"];
    const enabledSkills = new Set(options.capabilities?.enabledSkills ?? skills.list().map((skill) => skill.name));
    const enabledMcpServers = new Set(options.capabilities?.enabledMcpServers ?? mcp.summaries().filter((server) => !server.disabled).map((server) => server.name));
    const resources = skills.piSkills().filter((skill) => enabledSkills.has(skill.name));
    // Expose each enabled MCP server's tools as FIRST-CLASS provider tools
    // (mcp__<server>__<tool>) so the model uses them natively, like Claude Code —
    // instead of the mcp_call proxy it will not drive. mcp_call stays as a fallback.
    const mcpFirstClassTools = await createMcpFirstClassTools(mcp, enabledMcpServers);
    const artifactStore = options.artifactStore;
    const checkpointService = new CheckpointService(options.controlStore, artifactStore);
    const compactionCoordinator = new DurableCompactionCoordinator(checkpointService);
    const claimVerifier = new CodingClaimVerifier(options.runId, options.controlStore, artifactStore);
    const evidenceGraph = new CodingEvidenceGraph(options.runId, options.controlStore, artifactStore);
    // Wire the curation gate into every coding lane. Without this optional
    // context being populated, read/bash artifacts are archived but never
    // force the model to review durable findings, allowing an unbounded probe
    // loop inside a single provider turn.
    const evidenceCurationGate = new EvidenceCurationGate(options.runId, options.controlStore);
    const forestContext = { value: formatReasoningForestContext(await evidenceGraph.inspectForest()) };
    const outputRewrite = createOutputRewritePort(resolveOutputRewriteConfig(options.config), options.runDir, createExecutionEnvRtkProcessRunner(env));
    const snapshot = await options.controlStore.snapshot(options.runId);
    // A live platform is the judge only for competition runs; a GUI chat run has
    // nothing to submit to and must not be given submit_flag.
    const platformJudged = snapshot.task.verification.kind === "platform_submission";
    const fixture = {
      fixtureId: options.runId,
      generation: snapshot.generation,
      path: options.projectRoot,
      privatePath: join(options.projectRoot, ".proofblade"),
    };
    const runtime = new ProofBladeToolRuntime(
      options.runId,
      fixture,
      dirname(options.runDir),
      options.controlStore,
      artifactStore,
      options.journal,
      // MCP capability backends load from the install root (where .mcp.json is),
      // not the challenge workspace.
      installRoot,
      // Enable MCP so the reverse capability backend can route disasm/decompile
      // to a configured decompiler MCP (idalib-mcp / jadx-mcp) instead of only
      // objdump-level static analysis. The mcp_call proxy is already enabled.
      { includeMcp: true },
    );
    // When the process backend is a Docker pwn/pwn-kernel container, wire the
    // persistent tube tools: build a SessionRegistry over that container runtime
    // and a PwnToolHandler bound to this run. Without a container (GUI chat /
    // NodeExecutionEnv) pwnTools stays undefined and the pwn_* tools are neither
    // active nor callable.
    const pwnTools = env instanceof ContainerExecutionEnv && (env.containerRef.profile === "pwn" || env.containerRef.profile === "pwn-kernel")
      ? new PwnToolHandler(
        options.runId,
        new SessionRegistry(options.runId, env.containerRuntime, options.controlStore),
        new PwnReproducer(options.controlStore),
        () => (env as ContainerExecutionEnv).containerRef,
        "main",
      )
      : undefined;
    const tools = [...createCodingTools({ platformJudged }), ...mcpFirstClassTools];
    const activeToolNames = [
      ...codingActiveToolNames({ tools: enabledTools, skills: [...enabledSkills], mcpServers: [...enabledMcpServers], platformJudged, pwnEnabled: Boolean(pwnTools) }),
      ...mcpFirstClassTools.map((tool) => tool.name),
    ];
    const submitFlag = platformJudged
      ? createPlatformFlagSubmitter({
        runId: options.runId,
        runtime,
        fixture,
        controlStore: options.controlStore,
        artifactStore,
        journal: options.journal,
        runsRoot: dirname(options.runDir),
        ...(options.mode ? { mode: options.mode } : {}),
      })
      : undefined;
    const toolContext: CodingResourceContext = {
      env,
      skills,
      mcp,
      enabledSkills,
      enabledMcpServers,
      claimVerifier,
      evidenceGraph,
      evidenceCurationGate,
      runtime,
      ...(pwnTools ? { pwnTools } : {}),
      ...(submitFlag ? { submitFlag } : {}),
      ...(options.bashTimeoutSecondsMax === undefined ? {} : { bashTimeoutSecondsMax: options.bashTimeoutSecondsMax }),
      outputRewrite: { port: outputRewrite, artifactStore, runId: options.runId },
      imagesSeen: new Map<string, number>(),
    };
    const skillsLibraryPath = join(installRoot, "skills-library", "ctf-skills");
    const stableSystemPrompt = codingSystemPrompt(
      resources,
      mcp.summaries().filter((server) => enabledMcpServers.has(server.name) && !server.disabled),
      options.skillsLibraryPathForPrompt ?? skillsLibraryPath,
      options.workspaceRootForPrompt ?? options.projectRoot,
      toolCatalog.promptBlock(),
      {
        platformJudged,
        maxSubmissions: snapshot.task.constraints.max_submissions,
        targetKind: snapshot.task.target_kind,
        target: snapshot.task.target,
        ...(options.executionPlatform ? { executionPlatform: options.executionPlatform } : {}),
        ...(options.hostWorkspaceRootForMcp ? { hostWorkspaceRootForMcp: options.hostWorkspaceRootForMcp } : {}),
      },
    );
    const repeatBreaker = new RepeatedToolFailureBreaker();
    const progressBreaker = new NoProgressToolBreaker();
    const failureStormBreaker = new ToolFailureStormBreaker();
    const experimentBudgetBreaker = new ExperimentBudgetBreaker();
    const termination: CodingTurnTermination = {};
    const harness = new AgentHarness<CodingResourceContext>({
      session,
      models,
      model,
      tools,
      activeToolNames,
      resources: { skills: resources },
      toolContext,
      thinkingLevel: profile.thinkingLevel ?? "off",
      systemPrompt: () => stableSystemPrompt,
      streamOptions: { timeoutMs: profile.requestTimeoutMs, maxRetries: profile.maxRetries, maxRetryDelayMs: profile.maxRetryDelayMs, cacheRetention: profile.cacheRetention },
    });
    attachCodingTurnGuards(harness, repeatBreaker, progressBreaker, termination, createCodingToolEffectPolicyResolver(mcp, runtime), failureStormBreaker, experimentBudgetBreaker);
    const maintenance = { compactRequested: false };
    const activeTools = tools.filter((tool) => activeToolNames.includes(tool.name));
    const fixedContextTokens = estimateTokens(stableSystemPrompt) + estimateTokens(JSON.stringify(activeTools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))));
    const providerSafetyTokens = Math.min(8_192, Math.max(1_024, Math.floor(profile.contextWindow * 0.1)));
    const contextBudget = Math.max(256, profile.contextWindow - profile.maxTokens - fixedContextTokens - providerSafetyTokens);
    const targetMessageBudget = Math.max(256, Math.floor(contextBudget * 0.5));
    harness.on("context", ({ messages }) => {
      const prepared = prepareContextMaintenance({ messages: injectReasoningForestContext(messages, forestContext.value), availableTokens: contextBudget, messageBudget: targetMessageBudget });
      if (prepared.nextAction === "compact") maintenance.compactRequested = true;
      return { messages: prepared.messages };
    });
    harness.on("session_before_compact", async ({ preparation }) => ({
      compaction: await compactionCoordinator.provide(options.runId, preparation, undefined, {
        maxContextTokens: contextBudget,
        taskAnchor: await latestExternalUserMessageFromSession(session),
      }),
    }));
    attachPiObservability(harness, {
      runId: options.runId,
      lane: "main",
      controlStore: options.controlStore,
      requestContext: {
        contextWindow: profile.contextWindow,
        systemPromptHash: sha256(stableSystemPrompt),
        toolCatalogHash: sha256(canonicalJson(activeTools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })))),
        toolNames: activeToolNames,
      },
      scheduling,
    });
    if (options.onEvent) harness.subscribe(options.onEvent);
    return new PiCodingLane(
      options.runId,
      options.controlStore,
      harness,
      env,
      sessionEnv,
      closeTransport,
      mcp,
      runtime,
      claimVerifier,
      maintenance,
      repeatBreaker,
      progressBreaker,
      failureStormBreaker,
      experimentBudgetBreaker,
      termination,
      async () => { forestContext.value = formatReasoningForestContext(await evidenceGraph.inspectForest()); },
      async () => {
        const branch = await session.getBranch();
        for (let index = branch.length - 1; index >= 0; index -= 1) {
          const entry = branch[index]!;
          if (entry.type === "message" && entry.message.role === "assistant") return entry.id;
        }
        return undefined;
      },
    );
  }

  public async prompt(text: string): Promise<AgentOutcome> {
    this.repeatBreaker.reset();
    this.progressBreaker.reset();
    this.failureStormBreaker.reset();
    this.experimentBudgetBreaker.reset();
    delete this.termination.message;
    delete this.termination.reason;
    this.termination.requested = false;
    this.termination.confirmed = false;
    await this.refreshForestContext();
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
      // Transient provider-stream errors (HTTP 200 then a mid-body error) are
      // retried at the provider-stream boundary inside ProviderRequestScheduler,
      // where re-issuing sends the SAME request without restarting the turn — so
      // it never duplicates the user message or re-runs tools. Here we only
      // recover from context overflow, which legitimately changes the prompt.
      const recovered = await promptWithContextLengthRecovery({
        prompt: async (prompt) => await this.harness.prompt(prompt),
        compact: async (reason) => {
          await this.harness.compact(reason);
          this.maintenance.compactRequested = false;
        },
      }, text);
      const response = recovered.response;
      return await finalizeCodingTurn({
        runId: this.runId,
        controlStore: this.controlStore,
        correlationId,
        userPrompt: text,
        response,
        recoveryCount: recovered.recoveryCount,
        recoveryExhausted: recovered.exhausted,
        termination: this.termination,
        piEntryId: await this.latestAssistantEntryId(),
        claimVerifier: this.claimVerifier,
        maintainAfterTurn: async () => await this.maintainAfterTurn(response),
      });
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
          await this.sessionEnv.cleanup();
        } finally {
          try {
            await this.closeTransport();
          } finally {
            try {
              await this.mcp.close();
            } finally {
              await this.runtime.close();
            }
          }
        }
      }
    }
  }

  private async maintainAfterTurn(response: AssistantMessage): Promise<void> {
    if (!this.maintenance.compactRequested) return;
    this.maintenance.compactRequested = false;
    if (response.stopReason === "error" || response.stopReason === "aborted") return;
    try {
      await this.harness.compact("Compact stale exploration while preserving the latest complete tool exchange, Evidence and Artifact ids, reasoning forest roots, open hypotheses, rejected routes, and the next action.");
    } catch {
      // The append-only Pi transcript and Control Store remain the recovery source.
    }
  }
}

async function latestExternalUserMessageFromSession(session: { getBranch(): Promise<Array<{ type: string; message?: AgentMessage }>> }): Promise<Extract<AgentMessage, { role: "user" }> | undefined> {
  const branch = await session.getBranch();
  return latestExternalUserMessage(branch.flatMap((entry) => entry?.type === "message" && entry.message ? [entry.message] : []));
}

/**
 * Build the platform submission path for a competition run.
 *
 * `runtime.submitCandidate` enforces flag format, the submission budget, and
 * candidate-hash dedup, returning the existing completion for a repeat. The
 * `IndependentVerifier` then drives the journal's `fixture_score` effect, which
 * is what actually reaches `CompetitionApi.submitFlag`. Going through the
 * journal (rather than calling the API directly) is deliberate: its idempotency
 * key replays a stored verdict instead of spending a second API call, and every
 * submission stays on the event log — the two things the rules use as
 * tiebreakers (wrong-submission count, API-call efficiency).
 */
export function createPlatformFlagSubmitter(deps: {
  runId: string;
  runtime: ProofBladeToolRuntime;
  fixture: FixtureRef;
  controlStore: ControlStore;
  artifactStore: ArtifactStore;
  journal: EffectJournal;
  runsRoot: string;
  /** Live execution mode. In "assist" the flag is recorded but NOT sent. */
  mode?: () => "auto" | "assist";
}): (flag: string, signal?: AbortSignal) => Promise<CodingFlagSubmission> {
  const verifier = new IndependentVerifier(deps.controlStore, deps.artifactStore, deps.journal, deps.runsRoot);
  return async (flag, signal) => {
    const before = await deps.controlStore.snapshot(deps.runId);
    const { completionId, candidateHash } = await deps.runtime.submitCandidate(flag);
    // Assist mode: the operator wants to see the flag before it costs a real
    // submission. The completion is recorded as PROPOSED so the loop can pause
    // and a later auto-mode turn can send it, but the platform is not called.
    if (deps.mode?.() === "assist") {
      return {
        accepted: false,
        completionId,
        candidateHash,
        replayed: false,
        heldForApproval: true,
        message: "Recorded for operator approval; the platform was NOT contacted and no submission was spent. Stop here and report your derivation.",
        ...(await submissionCounters(deps.runtime, await deps.controlStore.snapshot(deps.runId))),
      };
    }
    // submitCandidate returns an existing completion for a repeated flag. If it
    // was already judged, report the stored verdict without touching the API.
    const known = before.completions[completionId];
    if (known && known.status !== "PROPOSED") {
      return {
        accepted: known.status === "ACCEPTED",
        completionId,
        candidateHash,
        replayed: true,
        message: `This flag was already submitted and ${known.status === "ACCEPTED" ? "accepted" : "rejected"}; no new submission was spent.`,
        ...(await submissionCounters(deps.runtime, before)),
      };
    }
    const outcome = await verifier.verify(deps.runId, deps.fixture, completionId, signal);
    const after = await deps.controlStore.snapshot(deps.runId);
    return {
      accepted: outcome.accepted,
      completionId: outcome.completionId,
      candidateHash: outcome.candidateHash,
      replayed: false,
      ...(await submissionCounters(deps.runtime, after)),
    };
  };
}

/**
 * Count only submittable completions, matching the budget rule in
 * `submitCandidate`. Counting every completion inflated the number reported to the
 * model and the fleet, because `verify_claim` proposes completions that are never
 * sent to the platform.
 */
async function submissionCounters(
  runtime: ProofBladeToolRuntime,
  snapshot: RunSnapshot,
): Promise<{ submissionsUsed: number; submissionsRemaining: number }> {
  const used = (await runtime.submittableCompletions(snapshot)).length;
  return { submissionsUsed: used, submissionsRemaining: Math.max(0, snapshot.task.constraints.max_submissions - used) };
}

export function injectReasoningForestContext(messages: AgentMessage[], forestContext: string): AgentMessage[] {
  if (!forestContext) return messages;
  const output = [...messages];
  let latestUserIndex = -1;
  for (let index = output.length - 1; index >= 0; index -= 1) {
    if (isRealUserTask(output[index])) { latestUserIndex = index; break; }
  }
  const insertionIndex = latestUserIndex >= 0 ? latestUserIndex : output.length;
  output.splice(insertionIndex, 0, createCustomMessage(
    "proofblade_reasoning_forest",
    forestContext,
    false,
    { durable: true, projection: "forest-index" },
    new Date(0).toISOString(),
  ));
  return output;
}

function codingSystemPrompt(
  skills: Array<{ name: string; description: string; content: string }>,
  mcpServers: Array<{ name: string; description: string }>,
  skillsLibraryPath: string,
  workspaceRoot: string,
  toolCatalogBlock: string,
  options: { platformJudged?: boolean; maxSubmissions?: number; targetKind?: TaskContract["target_kind"]; target?: string; executionPlatform?: NodeJS.Platform; hostWorkspaceRootForMcp?: string } = {},
): string {
  // State the workspace explicitly. Without it the model guesses, wanders into a
  // parent directory, and then resolves a name that means something different
  // there (a very common trap: an unzipped folder with the SAME name as the file
  // inside it, where `sqlite3 x` opens the directory and fails).
  const workspaceBlock = `\n\nYour working directory is \`${workspaceRoot.replace(/\\/g, "/")}\` — every relative path resolves there, and the task's target files are in it. Stay in it: prefer relative paths over \`cd\`, and if you must \`cd\`, come back. Before treating a name as a file, confirm it with \`ls -la\` (a name can be a directory that contains a same-named file). If a tool says a path is a directory or cannot be opened, re-check the layout instead of retrying the same command.`;
  // Resident CTF orchestrator. Category-AGNOSTIC on purpose: it only carries the
  // general recon -> categorize -> read the matching on-disk playbook -> solve ->
  // verify loop, so it never bloats or misdirects a non-matching challenge type.
  // The deep per-category techniques live on disk and are read on demand, so
  // switching challenge type just reads a different file — nothing here changes.
  const lib = skillsLibraryPath.replace(/\\/g, "/");
  const orchestrator = `\n\n## CTF solving workflow (follow this loop)\nWhen the task is to solve a CTF challenge / recover a flag:\n1. Recon: list files, \`file *\`, strings/xxd on binaries, read the prompt and any connection info.\n2. Categorize: pick the dominant category — web / crypto / reverse / pwn / forensics / misc / osint / malware.\n3. Load the playbook: a full CTF skills library is on disk at \`${lib}\`. Read the matching category's guide with bash before you start, e.g. \`cat "${lib}/ctf-<category>/SKILL.md"\`, and open the supporting files it references (same directory) as needed. Follow that playbook instead of your default habits.\n4. Converge — this is where solves are usually lost: as soon as you have extracted the data/structure the challenge turns on (a grid, key schedule, table, protocol), STOP re-reading disassembly or dumping bytes. Reconstruct the logic as a small script (Python) and let the machine solve it (search/BFS, reimplement the transform, bounded brute force). Re-reading the same thing a third time is the signal to switch to code.\n5. Produce the flag: apply exactly the transform the challenge states and the exact required flag format — no missing and no extra layers. Validate the candidate, then report it.\nUse read/bash to consult ${lib} at any point; you do not need load_skill for it.\n\n## Interactive native/Pwn protocol discipline\nFor a menu-driven native service, never synchronize on a generic suffix such as \`recv_until(b\": ")\`. Wait for the complete prompt for the current state (for example \`student_ID (0-127): \`, \`Name (max 23 chars): \`, or \`Style (1-3): \`) and consume the complete menu marker before sending the next choice. Every helper must log the step name, timeout, and last received bytes; a timeout is a protocol failure, not evidence that the exploit worked. Use a fresh connection for each retry and do not repeat a destructive heap sequence without first proving the previous step. Set Python output to UTF-8 (\`PYTHONUTF8=1\`, \`PYTHONIOENCODING=utf-8\`) and print undecodable bytes with a reversible error mode. After a suspected shell/control-flow hijack, send a unique marker such as \`echo PB_READY\` and wait for that marker; EOF or a reset alone is never shell success.`;
  const nativeSkills = skills.length > 0
    ? `\n\nAlso available via load_skill (optional): ${skills.map((s) => s.name).join(", ")}.`
    : "";
  const mcpBlock = mcpServers.length > 0
    ? `\n\nEnabled MCP servers — their tools are available DIRECTLY as first-class tools named \`mcp__<server>__<tool>\` (call them like any other tool; no mcp_call/describe needed):\n${mcpServers.map((server) => `- ${server.name}: ${server.description}`).join("\n")}\nFor reverse-engineering or binary analysis, PREFER a decompiler MCP to get pseudocode over hand-reading objdump/strings — reach for it early. Follow each server's stated usage protocol (some require opening/binding the target first).`
    : "";
  const mcpPathBlock = options.hostWorkspaceRootForMcp
    ? `\n\nMCP path boundary: shell/read/edit/write operate on the container workspace at \`${workspaceRoot}\`. Host-side MCP tools (for example IDA/JADX) cannot see that virtual path; when an MCP tool asks for a file path, pass the host workspace path \`${options.hostWorkspaceRootForMcp}\` plus the workspace-relative suffix. Never use that host path in bash.`
    : "";
  // Competition runs only. A wrong submission is scored against us (it is an
  // explicit tiebreaker), so the budget and the cost of guessing must be stated
  // where the model cannot miss them.
  const submissionBlock = options.platformJudged
    ? `\n\n## Submitting the flag\nThis challenge is judged by the live competition platform. Call \`submit_flag\` with the complete flag to submit it and get the verdict; that is the only way to score, and finishing your turn without calling it means the challenge is not solved.\nYou have at most ${options.maxSubmissions ?? 5} submissions for this challenge, and wrong submissions count against the team's ranking — do not guess or spray variants. Submit when you have derived the flag, not when you are hoping. Resubmitting a value you already submitted is free (the stored verdict is replayed) but tells you nothing new. If a submission is rejected, treat it as evidence your derivation is wrong and go back to the analysis rather than mutating the string.`
    : "";
  const categoryBlock = codingCtfCategoryGuidance(options.targetKind, options.target);
  return `${CODING_SYSTEM_PROMPT}\n\n${codingHostGuidance(options.executionPlatform ?? process.platform)}${workspaceBlock}${orchestrator}${categoryBlock}${toolCatalogBlock}${submissionBlock}${nativeSkills}${mcpBlock}${mcpPathBlock}`;
}

/**
 * Category-specialized guidance for the CTF orchestrator.
 *
 * The generic playbook already covers recon and skill-library dispatch, but two
 * failure modes recur enough to justify hard-coding them at prompt time instead
 * of hoping the model reads the on-disk guide:
 *
 * - Web: gateway is target-only, so external doc lookups WILL fail; the model
 *   must treat that as expected policy, not a broken tool.
 * - Pwn: Chinese CTF services frequently send GBK-encoded prompts and menus.
 *   The model tends to hand-type those bytes back into a script and produce a
 *   parser that never matches. State the rule once, up-front: capture bytes
 *   from actual recv output, never transcribe non-ASCII prompt text by hand.
 */
export function codingCtfCategoryGuidance(kind?: TaskContract["target_kind"], target?: string): string {
  if (!kind || kind === "unknown") return "";
  const remote = typeof target === "string" && target.startsWith("REMOTE:") ? target.slice("REMOTE:".length).trim() : undefined;
  const remoteBlock = remote ? `\nLive target: ${remote}. The container's egress gateway already permits that host/port; other outbound network is denied by policy, not by a broken tool, so do not retry the same request against a different upstream when it is refused.` : "";
  if (kind === "pwn") {
    return [
      "\n\n## Pwn category specifics",
      "- `pwntools`, `pwncli`, `gdb`, `gdb-multiarch`, `qemu-user`, `patchelf`, `ropgadget`, and `one_gadget` are already installed. Use `from pwn import *` directly. `context.log_level = 'debug'` when protocol sync is unclear.",
      "- Always run `file` and `checksec` on any provided binary before writing an exploit. If no binary is provided (remote-only pwn), your leak strategy must not depend on offsets from a local copy — derive them from actual leaks.",
      "- Chinese CTF services often speak GBK, not UTF-8. Never hand-type non-ASCII prompt bytes into a script from what you see in a tool-result echo, because that echo has already been round-tripped through a locale that may not match the wire. Instead: (1) do one probe run, save `p.recv(4096)` to a file, (2) inspect the raw bytes with `xxd`, (3) reference those exact bytes in your parser (`recvuntil(b\"\\xc7\\xeb\\xd1\\xa1\\xd4\\xf1...\")` or a stable ASCII substring/suffix that co-occurs with the prompt). If the banner is confusing, decode with `.decode('gbk', errors='replace')` and `.decode('utf-8', errors='replace')` side by side — whichever produces readable Chinese is the wire encoding, and encoding future sends with the same codec is mandatory.",
      "- Prefer stable synchronization anchors that appear in a single state, not generic suffixes like `b': '` that appear in every prompt. Log the step name, timeout, and last received bytes on every failed recv so a stall is legible.",
      "- After a suspected shell hijack, send `echo PB_READY_$RANDOM$RANDOM` and wait for that exact marker. EOF, connection reset, or a timeout is NOT shell success.",
      "- Every retry uses a fresh `remote(...)`. Do not chain destructive heap operations across attempts without first proving the previous step landed via a confirmed leak or marker.",
      "- Persist every confirmed fact before moving on. An interactive pwn run is NOT reproducible — heap addresses and one-shot protocol state differ on every fresh connection — so recovering a fact you already proved costs turns and budget. Keep a running notes file (e.g. `/workspace/NOTES.md`) and `write` each confirmed fact to it as a line: the menu byte sequence, field offsets, struct size, input length limit, index semantics, and any leaked address delta. Before rewriting an exploit script, `read` the notes back instead of probing again. If a bash result ended with an `A-*` anchor, `evidence record` that id instead for a searchable durable record.",
      "- Fix the helper, not the whole script. When a protocol helper desyncs or times out, edit that one function and add a log line (step name + last received bytes); do not rewrite the file as a fresh `mapNN.py`. A full rewrite throws away the working parts you already validated and is the biggest single source of lost turns in pwn.",
      remoteBlock,
    ].join("\n");
  }
  if (kind === "web") {
    return [
      "\n\n## Web category specifics",
      "- `curl`, `python-requests`, `beautifulsoup4`, `sqlmap`, `chromium` (headless), and `playwright` are already installed. Prefer `curl -sSik` for one-shot probes and Python `requests.Session()` for anything stateful (cookies, CSRF).",
      "- Read the initial page and its response headers first: `curl -sSikL <target>` shows the framework fingerprint (Server, X-Powered-By, Set-Cookie shape, error page style) that decides your subsequent playbook branch (SQLi vs SSTI vs SSRF vs auth-bypass vs deserialization).",
      "- Check `/robots.txt`, `/.git/HEAD`, `/.env`, `/admin`, `/login`, source view (`view-source:` equivalent via `curl`), sitemap, and any JS bundles for endpoints — a large fraction of web CTFs hinge on a route that is not linked from the landing page.",
      "- Decode any JWT with `python -c 'import jwt,sys;print(jwt.decode(sys.argv[1], options={\"verify_signature\":False}))'` (or manual base64) before treating it as opaque. Note the algorithm — `alg:none` and weak HS256 keys are common CTF traps.",
      "- Chinese CTF web challenges frequently return GBK-encoded response bodies. If `curl` output looks mojibake, add `--output` and inspect with `file`/`iconv -f gbk -t utf-8`. Do not rely on the terminal echo of Chinese strings for parsing.",
      "- When you think the vulnerability is SQLi, try `sqlmap -u '<url>' --batch --level=3 --risk=2` in `shell_background` before hand-rolling payloads; when it's SSTI/RCE, jump to `{{7*7}}` and `${{7*7}}` fingerprints across common template engines.",
      remoteBlock,
    ].join("\n");
  }
  if (kind === "reverse") {
    return [
      "\n\n## Reverse category specifics",
      "- Prefer a decompiler MCP (idalib-mcp / jadx-mcp when available) over hand-reading `objdump -d`. Open the target once, then work from pseudocode.",
      "- `file`, `strings`, `nm`, `readelf -a`, `checksec` describe the shape; run them first. For packed binaries note the entropy and section layout before decompiling.",
      "- Once you have identified the transform, reconstruct it in Python instead of stepping through disassembly a fourth time. Search/BFS/bounded brute force is the fifth step of the loop; do not skip it.",
    ].join("\n");
  }
  if (kind === "crypto") {
    return [
      "\n\n## Crypto category specifics",
      "- `pycryptodome`, `gmpy2`, `sagemath`-style scripting via Python, and `openssl` are available. For classic modular-arithmetic tasks reach for `gmpy2.iroot`, Chinese Remainder Theorem, and lattice reduction (`fpylll`) before trying to brute force.",
      "- Identify the primitive first (RSA / DLP / AES-mode / hash / stream) and the exact operation being requested. A confused primitive check is the top cause of wasted turns in this category.",
    ].join("\n");
  }
  return "";
}

export function codingHostGuidance(platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return "Keep generated intermediate files inside the current workspace so later tools can read them.";
  return [
    "The host is Windows but bash runs your commands: use bash syntax, never cmd.exe syntax.",
    "Do not use `cd /d`, `dir`, `2>nul`, or `%VAR%`; use `cd`, `ls`, `2>/dev/null`, and `$VAR`.",
    "Use python or py for Python commands, never python3.",
    "Keep generated intermediate files in workspace-relative paths such as work/.",
    "Do not write analysis files to /tmp and then ask the Windows read tool to open them.",
  ].join(" ");
}
