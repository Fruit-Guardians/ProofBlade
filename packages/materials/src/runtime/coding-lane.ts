import { dirname, join } from "node:path";
import {
  AgentHarness,
  createCustomMessage,
  JsonlSessionRepo,
  NodeExecutionEnv,
  type AgentMessage,
  type AgentHarnessEvent,
} from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { resolveOutputRewriteConfig, type ProofBladeConfig } from "../config.js";
import type { ControlStore } from "../control/control-store.js";
import { prepareContextMaintenance } from "../context/maintenance-coordinator.js";
import { isRealUserTask, latestExternalUserMessage } from "../context/user-task-anchor.js";
import { CheckpointService } from "../context/checkpoint.js";
import { DurableCompactionCoordinator } from "../context/durable-compaction.js";
import { estimateTokens } from "../domain/utils.js";
import { attachPiObservability, createProviderSchedulingTelemetry } from "../observability/pi-events.js";
import { McpProjectRegistry } from "../mcp/registry.js";
import { ProofBladeSkillRegistry } from "../skills/registry.js";
import { ArtifactStore } from "../effects/artifact-store.js";
import type { EffectJournal } from "../effects/effect-journal.js";
import { CodingEvidenceGraph, formatReasoningForestContext } from "../knowledge/evidence-graph.js";
import { createExecutionEnvRtkProcessRunner, createOutputRewritePort } from "../tools/output-rewrite.js";
import { CodingClaimVerifier } from "../verification/claim-verification.js";
import { codingActiveToolNames, createCodingToolEffectPolicyResolver, createCodingTools, createMcpFirstClassTools, type CodingFlagSubmission, type CodingResourceContext } from "./coding-resources.js";
import { IndependentVerifier } from "../verification/verifier.js";
import type { FixtureRef } from "../sandbox/fixture.js";
import type { RunSnapshot } from "../domain/types.js";
import { createConfiguredModels, resolveModelProfile } from "./lmstudio-provider.js";
import type { AgentLanePort, AgentOutcome } from "./pi-adapter.js";
import { promptWithContextLengthRecovery } from "./context-length-recovery.js";
import { attachCodingTurnGuards, finalizeCodingTurn, type CodingTurnTermination } from "./coding-turn-projection.js";
import { NoProgressToolBreaker, RepeatedToolFailureBreaker, ToolFailureStormBreaker } from "./tool-repeat-breaker.js";
import { ProofBladeToolRuntime } from "../tools/runtime.js";

const CODING_SYSTEM_PROMPT = `You are ProofBlade (证锋), a coding agent working with the user in their current project workspace.

Respond naturally to ordinary conversation. Use workspace tools only when the user's request benefits from inspecting, running, or editing project files. Explain completed work concisely and preserve the user's existing changes.

Tool output you receive is complete unless it says otherwise. Only when a result ends with a ProofBlade artifact anchor (\`A-*\` id, stating how many bytes were withheld) is there more to fetch — then read that id with the evidence tool rather than re-running the command. No anchor means nothing was withheld, so do not go looking for a fuller copy. Every tool output is archived regardless, and \`evidence search\` matches archived text, so a query can recover something that scrolled out of context. The evidence tools (record, annotate, inspect_forest, inspect_tree, search) are OPTIONAL note-taking aids — use them only if they help you, never as a required step, and never let them interrupt active investigation.

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
    private readonly env: NodeExecutionEnv,
    private readonly closeTransport: () => Promise<void>,
    private readonly mcp: McpProjectRegistry,
    private readonly runtime: ProofBladeToolRuntime,
    private readonly claimVerifier: CodingClaimVerifier,
    private readonly maintenance: { compactRequested: boolean },
    private readonly repeatBreaker: RepeatedToolFailureBreaker,
    private readonly progressBreaker: NoProgressToolBreaker,
    private readonly failureStormBreaker: ToolFailureStormBreaker,
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
    capabilities?: { enabledTools?: string[]; enabledSkills?: string[]; enabledMcpServers?: string[] };
    /** Live execution mode for a platform-judged run. "assist" records a flag for
     * operator approval instead of submitting it. Defaults to autonomous play. */
    mode?: () => "auto" | "assist";
    /** Hard ceiling in seconds on any single `bash` call. Unset means no ceiling. */
    bashTimeoutSecondsMax?: number;
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
    const scheduling = createProviderSchedulingTelemetry({ runId: options.runId, lane: "main", controlStore: options.controlStore });
    const { models, model, closeTransport } = createConfiguredModels(profile, undefined, { observer: scheduling.observer });
    // skills/ and .mcp.json live in the ProofBlade install root, NOT the challenge
    // workspace. runDir is <installRoot>/runs/<runId>, so dirname(dirname(runDir))
    // recovers the install root when it is not passed explicitly.
    const installRoot = options.installRoot ?? dirname(dirname(options.runDir));
    const skills = await ProofBladeSkillRegistry.load(installRoot);
    const mcp = McpProjectRegistry.load(installRoot);
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
    const tools = [...createCodingTools({ platformJudged }), ...mcpFirstClassTools];
    const activeToolNames = [
      ...codingActiveToolNames({ tools: enabledTools, skills: [...enabledSkills], mcpServers: [...enabledMcpServers], platformJudged }),
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
      runtime,
      ...(submitFlag ? { submitFlag } : {}),
      ...(options.bashTimeoutSecondsMax === undefined ? {} : { bashTimeoutSecondsMax: options.bashTimeoutSecondsMax }),
      outputRewrite: { port: outputRewrite, artifactStore, runId: options.runId },
    };
    const skillsLibraryPath = join(installRoot, "skills-library", "ctf-skills");
    const stableSystemPrompt = codingSystemPrompt(
      resources,
      mcp.summaries().filter((server) => enabledMcpServers.has(server.name) && !server.disabled),
      skillsLibraryPath,
      options.projectRoot,
      { platformJudged, maxSubmissions: snapshot.task.constraints.max_submissions },
    );
    const repeatBreaker = new RepeatedToolFailureBreaker();
    const progressBreaker = new NoProgressToolBreaker();
    const failureStormBreaker = new ToolFailureStormBreaker();
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
    attachCodingTurnGuards(harness, repeatBreaker, progressBreaker, termination, createCodingToolEffectPolicyResolver(mcp, runtime), failureStormBreaker);
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
      scheduling,
    });
    if (options.onEvent) harness.subscribe(options.onEvent);
    return new PiCodingLane(
      options.runId,
      options.controlStore,
      harness,
      env,
      closeTransport,
      mcp,
      runtime,
      claimVerifier,
      maintenance,
      repeatBreaker,
      progressBreaker,
      failureStormBreaker,
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
  options: { platformJudged?: boolean; maxSubmissions?: number } = {},
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
  const orchestrator = `\n\n## CTF solving workflow (follow this loop)\nWhen the task is to solve a CTF challenge / recover a flag:\n1. Recon: list files, \`file *\`, strings/xxd on binaries, read the prompt and any connection info.\n2. Categorize: pick the dominant category — web / crypto / reverse / pwn / forensics / misc / osint / malware.\n3. Load the playbook: a full CTF skills library is on disk at \`${lib}\`. Read the matching category's guide with bash before you start, e.g. \`cat "${lib}/ctf-<category>/SKILL.md"\`, and open the supporting files it references (same directory) as needed. Follow that playbook instead of your default habits.\n4. Converge — this is where solves are usually lost: as soon as you have extracted the data/structure the challenge turns on (a grid, key schedule, table, protocol), STOP re-reading disassembly or dumping bytes. Reconstruct the logic as a small script (Python) and let the machine solve it (search/BFS, reimplement the transform, bounded brute force). Re-reading the same thing a third time is the signal to switch to code.\n5. Produce the flag: apply exactly the transform the challenge states and the exact required flag format — no missing and no extra layers. Validate the candidate, then report it.\nUse read/bash to consult ${lib} at any point; you do not need load_skill for it.`;
  const nativeSkills = skills.length > 0
    ? `\n\nAlso available via load_skill (optional): ${skills.map((s) => s.name).join(", ")}.`
    : "";
  const mcpBlock = mcpServers.length > 0
    ? `\n\nEnabled MCP servers — their tools are available DIRECTLY as first-class tools named \`mcp__<server>__<tool>\` (call them like any other tool; no mcp_call/describe needed):\n${mcpServers.map((server) => `- ${server.name}: ${server.description}`).join("\n")}\nFor reverse-engineering or binary analysis, PREFER a decompiler MCP to get pseudocode over hand-reading objdump/strings — reach for it early. Follow each server's stated usage protocol (some require opening/binding the target first).`
    : "";
  // Competition runs only. A wrong submission is scored against us (it is an
  // explicit tiebreaker), so the budget and the cost of guessing must be stated
  // where the model cannot miss them.
  const submissionBlock = options.platformJudged
    ? `\n\n## Submitting the flag\nThis challenge is judged by the live competition platform. Call \`submit_flag\` with the complete flag to submit it and get the verdict; that is the only way to score, and finishing your turn without calling it means the challenge is not solved.\nYou have at most ${options.maxSubmissions ?? 5} submissions for this challenge, and wrong submissions count against the team's ranking — do not guess or spray variants. Submit when you have derived the flag, not when you are hoping. Resubmitting a value you already submitted is free (the stored verdict is replayed) but tells you nothing new. If a submission is rejected, treat it as evidence your derivation is wrong and go back to the analysis rather than mutating the string.`
    : "";
  return `${CODING_SYSTEM_PROMPT}\n\n${codingHostGuidance()}${workspaceBlock}${orchestrator}${submissionBlock}${nativeSkills}${mcpBlock}`;
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
