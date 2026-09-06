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
import { ContextCompiler } from "../context/compiler.js";
import { latestExternalUserMessage } from "../context/user-task-anchor.js";
import { CheckpointService } from "../context/checkpoint.js";
import { DurableCompactionCoordinator } from "../context/durable-compaction.js";
import { canonicalJson, estimateTokens, sha256 } from "../domain/utils.js";
import { boundModelText } from "../domain/text-bounds.js";
import { attachPiObservability, createProviderSchedulingTelemetry } from "../observability/pi-events.js";
import type { ModelContextItem } from "../context/model-context-frame.js";
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
import { codingActiveToolNames, createCodingToolEffectPolicyResolver, createCodingTools, createMcpFirstClassTools, selectFirstClassMcpTools, stopAllShellJobs, type CodingFlagSubmission, type CodingResourceContext } from "./coding-resources.js";
import { IndependentVerifier } from "../verification/verifier.js";
import type { FixtureRef } from "../sandbox/fixture.js";
import type { ContextBuildOutput, PwnReproductionContract, RunSnapshot, RunToolPreparation, RuntimeResourceSnapshot, TaskContract } from "../domain/types.js";
import { createConfiguredModels, resolveModelProfile } from "./lmstudio-provider.js";
import { contextSnapshot, type AgentLanePort, type AgentOutcome } from "./pi-adapter.js";
import { promptWithContextLengthRecovery } from "./context-length-recovery.js";
import { attachCodingTurnGuards, finalizeCodingTurn, type AblationPolicyBinding, type CodingTurnTermination, type FirstActionBudget, type ToolCallBudget } from "./coding-turn-projection.js";
import { ExperimentBudgetBreaker, NoProgressToolBreaker, RepeatedToolFailureBreaker, ToolFailureStormBreaker } from "./tool-repeat-breaker.js";
import { ProofBladeToolRuntime } from "../tools/runtime.js";
import { SessionRegistry } from "../container/session-registry.js";
import type { ContainerRef, ContainerRuntimePort } from "../container/contracts.js";
import { PwnReproducer } from "../verification/pwn-reproducer.js";
import { PwnReproductionVerifier } from "../verification/pwn-reproduction-verifier.js";
import { PwnToolHandler, type PwnReproductionPolicy } from "../pwn/pwn-tools.js";
import { PwnSession } from "../pwn/pwn-session.js";
import { ExperimentGate } from "../competition/experiment-gate.js";
import { HttpSessionBackend } from "../web/http-session.js";
import { WebReproducer, type BrowserWebExploitStep, type WebExploitRecipe, type HttpWebExploitRecipe } from "../verification/web-reproducer.js";
import { BrowserReproducer, type BrowserCleanSessionFactory } from "../verification/browser-reproducer.js";
import { adoptVerifierBrowserSession, openVerifierBrowserSession, type BrowserVerifierFactory } from "../web/browser-session.js";
import type { BrowserRuntimeHandoff } from "../web/browser-resource-adapter.js";
import { WebToolHandler } from "../web/web-tools.js";
import type { ApprovalPolicy } from "../security/approval-policy.js";
import { assertToolPreparationPublished, ToolPreflightService, preflightFromRunToolPreparation, profileForTargetKind, runToolPreparationFromPreflight, type ChallengeToolProfile, type ChallengeToolPreflight } from "./challenge-tool-profile.js";
import { RunCoordinator } from "../orchestration/run-coordinator.js";
import { RunEventIngress } from "../orchestration/event-ingress.js";
import { acknowledgeObservationItems, projectObservationQueue } from "../orchestration/observation-queue.js";
import type { ExternalResourceRegistry } from "../recovery/external-resource-registry.js";
import type { SessionRuntimeHandoff } from "../recovery/session-resource-adapter.js";
import type { SessionRuntimeCreateBroker } from "../recovery/session-resource-adapter.js";
import { preflightSessionRuntimeBrokers, type SessionRuntimePreflight } from "../recovery/session-runtime-composition.js";

const MAX_CONTEXT_PROJECTION_MESSAGE_TOKENS = 10_000;

const CODING_SYSTEM_PROMPT = `You are ProofBlade (证锋), a coding agent working with the user in their current project workspace.

Respond naturally to ordinary conversation. Use workspace tools only when the user's request benefits from inspecting, running, or editing project files. Explain completed work concisely and preserve the user's existing changes.

Tool output you receive is complete unless it says otherwise. Only when a result ends with a ProofBlade artifact anchor (\`A-*\` id, stating how many bytes were withheld) is there more to fetch — then read that id with the evidence tool rather than re-running the command. No anchor means nothing was withheld, so do not go looking for a fuller copy. Every tool output is archived regardless, and \`evidence search\` matches archived text, so a query can recover something that scrolled out of context. The evidence tools (record, annotate, inspect_forest, inspect_tree, search) are optional during an initial pass. If a ProofBlade evidence-curation or experiment-budget message appears, stop probing, preserve the strongest finding with record/annotate, and continue only after the next replan turn; do not bypass the guard by issuing another equivalent bash call.

Anything that will take more than about a minute — a brute force, a wide sweep, a fuzzer, a server you need running — belongs in \`shell_background\`, not \`bash\`. \`bash\` blocks until the command finishes, so a long sweep freezes your whole turn; \`shell_background\` returns a job id immediately and you keep working, then poll with \`shell_job\`. Do not poll in a tight loop: start the job, do other analysis, and check back.

If the same tool call keeps looking wrong or incomplete, do not re-issue it a third time. Either the output is telling you something you have not accepted yet, or the approach is wrong: change the question, change the tool, or move on with what you already have.

Use the capability proxy as an optional analysis instrument, not a mandatory workflow. Search it when stable binary or firmware structure would help, describe only the chosen operation to load its schema, and invoke it with workspace-relative paths. Keep planning autonomous; do not call capabilities mechanically when read or bash is more appropriate.`;

export class PiCodingLane implements AgentLanePort {
  private busy = false;
  private readonly eventIngress: RunEventIngress;

  private constructor(
    private readonly runId: string,
    private readonly controlStore: ControlStore,
    private readonly turnContext: { guidance: string },
    private readonly harness: AgentHarness<CodingResourceContext>,
    private readonly env: ExecutionEnv,
    private readonly sessionEnv: ExecutionEnv,
    private readonly closeTransport: () => Promise<void>,
    private readonly mcp: McpProjectRegistry,
    private readonly runtime: ProofBladeToolRuntime,
    private readonly claimVerifier: CodingClaimVerifier,
    private readonly maintenance: { compactRequested: boolean; injectedObservationItems: import("../domain/types.js").ObservationQueueItem[] },
    private readonly repeatBreaker: RepeatedToolFailureBreaker,
    private readonly progressBreaker: NoProgressToolBreaker,
    private readonly failureStormBreaker: ToolFailureStormBreaker,
    private readonly experimentBudgetBreaker: ExperimentBudgetBreaker,
    private readonly termination: CodingTurnTermination,
    private readonly refreshForestContext: () => Promise<void>,
    private readonly refreshAblationRoute: () => Promise<void>,
    private readonly latestAssistantEntryId: () => Promise<string | undefined>,
    /** Teardown hook for durable shell jobs owned by this lane. */
    private readonly closeShellJobs: () => Promise<void>,
    /** Present only for a Docker pwn lane; its live tube sessions are torn down on close. */
    private readonly pwnRegistry?: SessionRegistry,
    /** Separate owner-scoped registry for trusted clean-process Pwn reproduction. */
    private readonly pwnVerifierRegistry?: SessionRegistry,
    /** Exploratory HTTP sessions are lane-owned and must be closed with the lane. */
    private readonly webSession?: WebToolHandler,
  ) {
    this.eventIngress = new RunEventIngress(controlStore);
  }

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
    /** Safe claim service; owns but does not expose the trusted verifier capabilities. */
    claimVerifier: CodingClaimVerifier;
    /** Present only for platform-judged lanes; executes through the real Sandbox scorer. */
    platformVerifier?: IndependentVerifier;
    config: ProofBladeConfig;
    /** Optional process backend. Files remain on the host; bash/exec runs here. */
    executionEnv?: ExecutionEnv;
    /** Optional application-owned browser runtime; it never enters model context. */
    browserVerifierFactory?: BrowserVerifierFactory;
    /** Durable ledger for Pwn/Web/Browser external session ownership. */
    externalResources?: ExternalResourceRegistry;
    /** Broker clients for sessions that must outlive this process. */
    sessionRuntimeBrokers?: readonly SessionRuntimeCreateBroker[];
    /** A caller-owned preflight result for these exact broker clients. */
    sessionRuntimePreflight?: SessionRuntimePreflight;
    /** Set when runtime.sessionBroker is configured but unavailable. */
    sessionRuntimeRequired?: boolean;
    /** Set when runtime.browserBroker is configured but unavailable. */
    browserRuntimeRequired?: boolean;
    /** Runtime bindings recovered before this lane was constructed. */
    sessionHandoffs?: readonly SessionRuntimeHandoff[];
    /** Browser bindings recovered before this lane was constructed. */
    browserHandoffs?: readonly BrowserRuntimeHandoff[];
    /** Path visible to commands inside the execution backend (normally /workspace). */
    workspaceRootForPrompt?: string;
    /** Platform syntax visible to the execution backend (Docker is Linux on every host). */
    executionPlatform?: NodeJS.Platform;
    /** Host path for host-side MCP tools such as IDA; only use it in MCP arguments. */
    hostWorkspaceRootForMcp?: string;
    capabilities?: { enabledTools?: string[]; enabledSkills?: string[]; enabledMcpServers?: string[] };
    /** Prepared challenge direction; keeps only profile tools resident in the prompt. */
    challengeProfile?: ChallengeToolProfile;
    /** Live execution mode for a platform-judged run. "assist" records a flag for
     * operator approval instead of submitting it. Defaults to autonomous play. */
    mode?: () => "auto" | "assist";
    /** Optional durable approval gate for high-risk platform effects. */
    approvalPolicy?: ApprovalPolicy;
    /** Keep hidden-scorer completions proposed until the outer CTF verifier runs. */
    deferClaimAcceptance?: boolean;
    /** Percentage of the available input budget used as the proactive compaction soft limit. */
    contextCompactionThreshold?: number;
    /** Optional session id override for non-chat CTF runs. */
    sessionId?: string;
    /** Called when the submission path pauses on a pending approval. */
    onApprovalRequired?: (approvalId: string) => void;
    /** Optional strict-ablation policy binding; safety checks remain unconditional. */
    ablationPolicy?: AblationPolicyBinding;
    /** Hard ceiling in seconds on any single `bash` call. Unset means no ceiling. */
    bashTimeoutSecondsMax?: number;
    onEvent?: (event: AgentHarnessEvent) => void | Promise<void>;
  }): Promise<PiCodingLane> {
    const sessionEnv = new NodeExecutionEnv({ cwd: options.projectRoot });
    const env: ExecutionEnv = options.executionEnv ?? new NodeExecutionEnv({ cwd: options.projectRoot });
    const repo = new JsonlSessionRepo({ fs: sessionEnv, sessionsRoot: join(options.runDir, "pi-sessions") });
    const sessionId = options.sessionId ?? `${options.runId}-chat`;
    const known = await repo.list({ cwd: options.projectRoot });
    const metadata = known.find((item) => item.id === sessionId);
    const session = metadata
      ? await repo.open(metadata)
      : await repo.create({
        id: sessionId,
        cwd: options.projectRoot,
        metadata: { runId: options.runId, lane: "main", purpose: sessionId === `${options.runId}-chat` ? "chat" : "ctf" },
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
    const snapshot = await options.controlStore.snapshot(options.runId);
    const sessionPreflight = options.sessionRuntimePreflight
      ?? await preflightSessionRuntimeBrokers(sessionRuntimeBrokersForTask(snapshot.task, options.sessionRuntimeBrokers ?? []));
    const sessionRuntimeBrokers = sessionPreflight.brokers;
    const sessionRuntimeRequired = Boolean(options.sessionRuntimeRequired);
    const pwnRuntimeRequired = sessionRuntimeRequired || sessionPreflight.unavailableKinds.includes("pwn-session");
    const httpRuntimeRequired = sessionRuntimeRequired || sessionPreflight.unavailableKinds.includes("http-session");
    if (options.browserRuntimeRequired && snapshot.task.verification.web?.transport === "browser" && !options.browserVerifierFactory) {
      throw new Error("Browser runtime broker is configured but unavailable for browser verification");
    }
    // Domain labels may select optional capability preparation, but never
    // change the Agent Loop or inject a domain-specific workflow prompt.
    const challengeMode = isChallengeTask(snapshot.task) || Boolean(options.challengeProfile);
    const challengeProfile = options.challengeProfile ?? (challengeMode ? profileForTargetKind(snapshot.task.target_kind, `${snapshot.task.target}\n${snapshot.task.objective}`) : undefined);
    const runtimeKey = inContainer && env instanceof ContainerExecutionEnv ? `container:${env.containerRef.imageDigest}` : inContainer ? "container" : "host";
    let preflight: ChallengeToolPreflight | undefined;
    let preparation: RunToolPreparation | undefined;
    if (challengeProfile) {
      const existing = snapshot.toolPreparation;
      const reusable = existing
        && existing.generation === snapshot.generation
        && existing.profileId === challengeProfile.id
        && existing.runtime === (inContainer ? "container" : "host")
        && existing.runtimeKey === runtimeKey;
      preflight = reusable
        ? preflightFromRunToolPreparation(existing)
        : inContainer
          ? await new ToolPreflightService(installRoot).prepareInExecution(challengeProfile, env, mcp, { runtimeKey })
          : await new ToolPreflightService(installRoot).prepare(challengeProfile, toolCatalog, mcp);
      preparation = runToolPreparationFromPreflight(preflight, challengeProfile, snapshot.generation);
      if (!reusable) {
        await new RunCoordinator(options.controlStore).recordToolPreparation(options.runId, preparation);
      }
      assertToolPreparationPublished(await options.controlStore.snapshot(options.runId), preparation);
    }
    const enabledTools = options.capabilities?.enabledTools ?? ["read", "bash", "edit", "write", "glob", "grep"];
    const enabledSkills = new Set(options.capabilities?.enabledSkills ?? skills.list().map((skill) => skill.name));
    const enabledMcpServers = new Set(options.capabilities?.enabledMcpServers ?? mcp.summaries().filter((server) => !server.disabled).map((server) => server.name));
    const resources = skills.piSkills().filter((skill) => enabledSkills.has(skill.name));
    const skillResourceSnapshot = skills.contextSnapshot();
    const activeSkillResources = skillResourceSnapshot.skills.filter((skill) => enabledSkills.has(skill.name));
    const toolResourceSnapshot = toolCatalog.contextSnapshot();
    const contextResources: RuntimeResourceSnapshot = {
      ...skillResourceSnapshot,
      skillCatalogHash: sha256(canonicalJson(activeSkillResources)),
      skills: activeSkillResources,
      ...toolResourceSnapshot,
      mcpCatalogHash: mcp.catalogHash(),
      mcpServers: mcp.summaries().filter((server) => enabledMcpServers.has(server.name) && !server.disabled).map(({ name, description, configHash }) => ({ name, description, configHash })),
    };
    // Expose each enabled MCP server's tools as FIRST-CLASS provider tools
    // (mcp__<server>__<tool>) so the model uses them natively, like Claude Code —
    // instead of the mcp_call proxy it will not drive. mcp_call stays as a fallback.
    // Provider-native tool schemas belong to the stable prefix. A per-turn chat
    // classification may steer the dynamic suffix, but only the immutable task
    // contract may alter the top-level tool surface.
    const effectiveTargetKind = snapshot.task.target_kind;
    const mcpFirstClassTools = await createMcpFirstClassTools(mcp, firstClassMcpServers(effectiveTargetKind, snapshot.task.target, enabledMcpServers));
    const activeMcpTools = selectFirstClassMcpTools(mcpFirstClassTools, effectiveTargetKind, snapshot.task.target);
    const artifactStore = options.artifactStore;
    const checkpointService = new CheckpointService(options.controlStore, artifactStore);
    const compactionCoordinator = new DurableCompactionCoordinator(checkpointService);
    const claimVerifier = options.claimVerifier;
    const evidenceGraph = new CodingEvidenceGraph(options.runId, options.controlStore, artifactStore);
    // Wire the curation gate into every coding lane. Without this optional
    // context being populated, read/bash artifacts are archived but never
    // force the model to review durable findings, allowing an unbounded probe
    // loop inside a single provider turn.
    const evidenceCurationGate = new EvidenceCurationGate(options.runId, options.controlStore);
    const forestContext = { value: formatReasoningForestContext(await evidenceGraph.inspectForest()) };
    const outputRewrite = createOutputRewritePort(resolveOutputRewriteConfig(options.config), options.runDir, createExecutionEnvRtkProcessRunner(env));
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
      { includeMcp: true, skills },
    );
    // Wire persistent tube tools either over the per-run Docker runtime or over
    // a configured durable session broker. Without either backend (ordinary
    // GUI chat / NodeExecutionEnv), pwn_* tools stay inactive and uncallable.
    const pwnBroker = sessionRuntimeBrokers.find((broker) => broker.kind === "pwn-session");
    const containerPwn = env instanceof ContainerExecutionEnv
      && (env.containerRef.profile === "pwn" || env.containerRef.profile === "pwn-kernel")
      && !pwnBroker
      && !pwnRuntimeRequired;
    const pwnRegistry = containerPwn
      ? new SessionRegistry(options.runId, (env as ContainerExecutionEnv).containerRuntime, options.controlStore, options.externalResources)
      : pwnBroker
        ? new SessionRegistry(options.runId, brokerOnlySessionRuntime(), options.controlStore, options.externalResources)
        : undefined;
    const pwnRef = containerPwn ? (env as ContainerExecutionEnv).containerRef : brokerSessionRef(options.runId, snapshot.generation, options.projectRoot);
    const recoveredPwnSessions = pwnRegistry
      ? await Promise.all((options.sessionHandoffs ?? [])
        .filter((handoff) => handoff.binding.kind === "pwn-session")
        .map(async (handoff) => {
          if (handoff.binding.kind !== "pwn-session") throw new Error(`Recovered Pwn session ${handoff.resourceId} has the wrong binding kind`);
          return await PwnSession.adopt(pwnRegistry, {
            ownerLane: handoff.record.ownerLane,
            sessionId: sessionIdFromResourceId(handoff.resourceId),
            handle: handoff.binding.handle,
            runtime: handoff.binding.runtime,
          });
        }))
      : [];
    const experimentGate = new ExperimentGate(options.controlStore);
    const pwnReproductionPolicy = pwnReproductionPolicyFor(snapshot.task.verification.pwn);
    const pwnVerifierRegistry = containerPwn && pwnReproductionPolicy
      ? new SessionRegistry(options.runId, (env as ContainerExecutionEnv).containerRuntime, options.controlStore, options.externalResources)
      : undefined;
    const pwnTrustedReproducer = pwnVerifierRegistry && pwnReproductionPolicy
      ? new PwnReproductionVerifier(options.controlStore, artifactStore, {
        prepareReplay: async (input) => await options.claimVerifier.prepareReplay(input),
        startReplay: async (effectId, sessionId, externalId) => await options.claimVerifier.startReplay(effectId, sessionId, externalId),
        finishReplay: async (effectId, result) => await options.claimVerifier.finishReplay(effectId, result),
        executeEffect: async (input, signal) => await options.claimVerifier.executePwnReproductionEffect(input, signal),
        recordEvidence: async (_runId, evidence) => await options.claimVerifier.recordVerifierEvidence(evidence),
        finalize: async (_runId, completionId, accepted, evidenceIds) => await options.claimVerifier.finalizePwnReproduction(completionId, accepted, evidenceIds),
      }, pwnVerifierRegistry, () => (env as ContainerExecutionEnv).containerRef, pwnReproductionPolicy)
      : undefined;
    const pwnTools = pwnRegistry
      ? new PwnToolHandler(
        options.runId,
        pwnRegistry,
        new PwnReproducer(options.controlStore),
        () => pwnRef,
        "main",
        // Enforce the task's target boundary at the app layer too, not just the
        // Docker egress gateway (a bridge/none policy has no gateway).
        { allowedHosts: snapshot.task.scope.allowed_hosts, allowedPorts: snapshot.task.scope.allowed_ports },
        pwnReproductionPolicy,
        experimentGate,
        artifactStore,
        options.controlStore,
        pwnTrustedReproducer,
        pwnBroker,
        pwnRuntimeRequired,
      )
      : undefined;
    for (const session of recoveredPwnSessions) pwnTools?.adopt(session);
    const webPolicy = snapshot.task.verification.web;
    const webTransport = webPolicy?.transport ?? "http";
    const webBaseUrl = webBaseUrlFromTarget(snapshot.task.target);
    const recoveredHttpSessions = webBaseUrl
      ? await Promise.all((options.sessionHandoffs ?? [])
        .filter((handoff) => handoff.binding.kind === "http-session")
        .map(async (handoff) => {
          const sessionId = sessionIdFromResourceId(handoff.resourceId);
          const sessionRecord = snapshot.sessions[sessionId];
          if (handoff.record.ownerLane !== "main") throw new Error(`Recovered HTTP session ${handoff.resourceId} is not owned by the coding lane`);
          if (!sessionRecord?.endpoint) throw new Error(`Recovered HTTP session ${handoff.resourceId} has no durable endpoint`);
          const binding = handoff.binding;
          if (binding.kind !== "http-session") throw new Error(`Recovered HTTP session ${handoff.resourceId} has the wrong binding kind`);
          const backend = await HttpSessionBackend.adopt({
            runId: options.runId,
            baseUrl: sessionRecord.endpoint,
            ownerLane: "main",
            controlStore: options.controlStore,
            artifactStore,
            fetchImpl: binding.fetchImpl,
            externalId: binding.externalId,
            allowedHosts: snapshot.task.scope.allowed_hosts,
            allowedPorts: snapshot.task.scope.allowed_ports,
            experimentGate,
            ...(options.externalResources ? { externalResources: options.externalResources } : {}),
          }, sessionId, binding.stateHash);
          return { backend, baseUrl: sessionRecord.endpoint };
        }))
      : [];
    const webReproducer = webPolicy && webTransport === "http" && webBaseUrl
      ? new WebReproducer(options.controlStore, artifactStore, {
        prepareReplay: async (input) => await options.claimVerifier.prepareReplay(input),
        startReplay: async (effectId, sessionId, externalId) => await options.claimVerifier.startReplay(effectId, sessionId, externalId),
        finishReplay: async (effectId, result) => await options.claimVerifier.finishReplay(effectId, result),
        executeEffect: async (input, signal) => await options.claimVerifier.executeWebReproductionEffect(input, signal),
        recordEvidence: async (_runId, evidence) => await options.claimVerifier.recordVerifierEvidence(evidence),
        recordDomainRecords: async (_runId, records) => await options.claimVerifier.recordVerifierDomainRecords(records),
        finalize: async (_runId, completionId, accepted, evidenceIds) => await options.claimVerifier.finalizeWebReproduction(completionId, accepted, evidenceIds),
      })
      : undefined;
    const browserCleanSessionFactory: BrowserCleanSessionFactory | undefined = webPolicy && webTransport === "browser" && options.browserVerifierFactory
      ? async (request, signal) => await openVerifierBrowserSession(options.browserVerifierFactory!, request, options.controlStore, artifactStore, signal, options.externalResources)
      : undefined;
    const browserReproducer = webPolicy && webTransport === "browser" && browserCleanSessionFactory
      ? new BrowserReproducer(options.controlStore, artifactStore, {
        prepareReplay: async (input) => await options.claimVerifier.prepareReplay(input),
        startReplay: async (effectId, sessionId, externalId) => await options.claimVerifier.startReplay(effectId, sessionId, externalId),
        finishReplay: async (effectId, result) => await options.claimVerifier.finishReplay(effectId, result),
        executeEffect: async (input, signal) => await options.claimVerifier.executeBrowserReproductionEffect(input, signal),
        recordEvidence: async (_runId, evidence) => await options.claimVerifier.recordVerifierEvidence(evidence),
        recordDomainRecords: async (_runId, records) => await options.claimVerifier.recordVerifierDomainRecords(records),
        finalize: async (_runId, completionId, accepted, evidenceIds) => await options.claimVerifier.finalizeBrowserReproduction(completionId, accepted, evidenceIds),
      }, {
        handoffs: options.browserHandoffs,
        createRecoveredSession: async (handoff, request) => {
          const sessionId = handoff.resourceId.startsWith("session:") ? handoff.resourceId.slice("session:".length) : "";
          if (!sessionId) throw new Error(`Recovered Browser resource ${handoff.resourceId} has no session id`);
          return await adoptVerifierBrowserSession(handoff.binding, request, sessionId, options.controlStore, artifactStore, options.externalResources);
        },
      })
      : undefined;
    // Interactive web session tools: available whenever the task has a resolvable
    // web target (host-side fetch, origin-locked — no container needed). This is
    // the exploration counterpart to the verifier-only web_reproduce; it lets the
    // model keep cookies/CSRF across calls instead of losing them between curls.
    const webSession = webBaseUrl
      ? new WebToolHandler({
        runId: options.runId,
        controlStore: options.controlStore,
        artifactStore,
        ownerLane: "main",
        scope: { allowedHosts: snapshot.task.scope.allowed_hosts, allowedPorts: snapshot.task.scope.allowed_ports },
        ...(recoveredHttpSessions.length > 0 ? { recoveredSessions: recoveredHttpSessions } : {}),
        ...(experimentGate ? { experimentGate } : {}),
        ...(options.externalResources ? { externalResources: options.externalResources } : {}),
        ...(sessionRuntimeBrokers.find((broker) => broker.kind === "http-session") ? { sessionBroker: sessionRuntimeBrokers.find((broker) => broker.kind === "http-session") } : {}),
        sessionRuntimeRequired: httpRuntimeRequired,
      })
      : undefined;
    const tools = [...createCodingTools({ platformJudged, webReproductionEnabled: Boolean(webReproducer || browserReproducer), webSessionEnabled: Boolean(webSession) }), ...mcpFirstClassTools];
    const activeToolNames = [
      ...codingActiveToolNames({
        tools: enabledTools,
        skills: [...enabledSkills],
        mcpServers: [...enabledMcpServers],
        platformJudged,
        pwnEnabled: Boolean(pwnTools),
        pwnReproductionEnabled: Boolean(pwnTools && pwnReproductionPolicy),
        webReproductionEnabled: Boolean(webReproducer || browserReproducer),
        webSessionEnabled: Boolean(webSession),
      }),
      ...activeMcpTools.map((tool) => tool.name),
    ];
    if (platformJudged && !options.platformVerifier) throw new Error("Platform-judged lane requires a trusted platform verifier");
    const submitFlag = platformJudged
      ? createPlatformFlagSubmitter({
        runId: options.runId,
        runtime,
        fixture,
        controlStore: options.controlStore,
        verifier: options.platformVerifier!,
        artifactStore,
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
        ...(options.onApprovalRequired ? { onApprovalRequired: options.onApprovalRequired } : {}),
      })
      : undefined;
    const toolContext: CodingResourceContext = {
      env,
      ownerLane: "main",
      controlStore: options.controlStore,
      artifactStore,
      skills,
      mcp,
      enabledSkills,
      enabledMcpServers,
      claimVerifier,
      ...(options.deferClaimAcceptance ? { deferClaimAcceptance: true } : {}),
      continuousRecovery: true,
      evidenceGraph,
      evidenceCurationGate,
      runtime,
      experimentGate,
      ...(webReproducer || browserReproducer ? {
        webReproduce: async (recipe: WebExploitRecipe, signal?: AbortSignal) => {
          const transport = recipe.transport ?? webTransport;
          if (transport !== webTransport) throw new Error(`web_reproduce transport ${transport} does not match the immutable task policy ${webTransport}`);
          if (transport === "browser") {
            if (!browserReproducer || !browserCleanSessionFactory) throw new Error("web_reproduce browser transport is unavailable: no trusted browser verifier backend is configured");
            const browserRecipe = recipe.transport === "browser" ? recipe : { transport: "browser" as const, steps: recipe.steps as BrowserWebExploitStep[] };
          return browserReproducer.reproduce(options.runId, browserRecipe, browserCleanSessionFactory, signal);
          }
          if (!webReproducer || !webBaseUrl) throw new Error("web_reproduce HTTP transport is unavailable: no immutable HTTP target is configured");
          const httpRecipe: HttpWebExploitRecipe = recipe.transport === "http" || recipe.transport === undefined ? recipe : { transport: "http", steps: recipe.steps as HttpWebExploitRecipe["steps"] };
          return webReproducer.reproduce(options.runId, httpRecipe, async () => await HttpSessionBackend.open({ runId: options.runId, baseUrl: webBaseUrl, ownerLane: "verifier", controlStore: options.controlStore, artifactStore, allowedHosts: snapshot.task.scope.allowed_hosts, allowedPorts: snapshot.task.scope.allowed_ports, experimentGate, ...(options.externalResources ? { externalResources: options.externalResources } : {}) }), signal);
        },
      } : {}),
      ...(pwnTools ? { pwnTools } : {}),
      ...(webSession ? { webSession } : {}),
      ...(submitFlag ? { submitFlag } : {}),
      ...(options.bashTimeoutSecondsMax === undefined ? {} : { bashTimeoutSecondsMax: options.bashTimeoutSecondsMax }),
      outputRewrite: { port: outputRewrite, artifactStore, runId: options.runId },
      artifactOutputRefs: new Map(),
      imagesSeen: new Map<string, number>(),
    };
    const stableSystemPrompt = codingSystemPrompt(
      resources,
      mcp.summaries().filter((server) => enabledMcpServers.has(server.name) && !server.disabled),
      options.workspaceRootForPrompt ?? options.projectRoot,
      toolCatalog.promptBlock(),
      {
        ...(options.executionPlatform ? { executionPlatform: options.executionPlatform } : {}),
        ...(options.hostWorkspaceRootForMcp ? { hostWorkspaceRootForMcp: options.hostWorkspaceRootForMcp } : {}),
      },
    );
    const turnContext = { guidance: "" };
    const repeatBreaker = new RepeatedToolFailureBreaker();
    const progressBreaker = new NoProgressToolBreaker();
    const failureStormBreaker = new ToolFailureStormBreaker();
    const experimentBudgetBreaker = new ExperimentBudgetBreaker();
    const toolBudget: ToolCallBudget = { max: Math.max(0, snapshot.task.constraints.max_tool_calls), count: 0 };
    const firstActionPlan = preflight?.firstActionPlan ?? challengeProfile?.firstActionPlan;
    const firstActionBudget: FirstActionBudget | undefined = firstActionPlan
      ? {
        allowedToolNames: [...firstActionPlan.allowedToolNames],
        maxCalls: firstActionPlan.maxCalls,
        count: 0,
        // Observations are durable and generation-bound, so a recovered lane
        // does not force the model to repeat its initial probe.
        completed: Object.values(snapshot.observations).some((item) => item.generation === snapshot.generation),
      }
      : undefined;
    const termination: CodingTurnTermination = {};
    // All lanes remain live: guard pressure becomes a recovery hint and the
    // existing maintenance hook performs compaction/checkpoint work in-band.
    termination.continuousRecovery = true;
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
    const ablationRoute = options.ablationPolicy ? {
      domainPhase: snapshot.domainPhase,
      actionBundles: preparation?.actionBundles ?? snapshot.toolPreparation?.actionBundles ?? [],
    } : undefined;
    const ablationBinding = options.ablationPolicy && ablationRoute
      ? { ...options.ablationPolicy, route: () => ablationRoute }
      : options.ablationPolicy;
    attachCodingTurnGuards(harness, repeatBreaker, progressBreaker, termination, createCodingToolEffectPolicyResolver(mcp, runtime), failureStormBreaker, experimentBudgetBreaker, toolBudget, firstActionBudget, ablationBinding, options.deferClaimAcceptance);
    const maintenance = { compactRequested: false, injectedObservationItems: [] as import("../domain/types.js").ObservationQueueItem[] };
    const activeTools = tools.filter((tool) => activeToolNames.includes(tool.name));
    const fixedContextTokens = estimateTokens(stableSystemPrompt) + estimateTokens(JSON.stringify(activeTools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))));
    const providerSafetyTokens = Math.min(8_192, Math.max(1_024, Math.floor(profile.contextWindow * 0.1)));
    const contextBudget = Math.max(256, profile.contextWindow - profile.maxTokens - fixedContextTokens - providerSafetyTokens);
    const targetMessageBudget = Math.max(256, Math.floor(contextBudget * 0.35));
    const threshold = Math.min(80, Math.max(20, Math.round(options.contextCompactionThreshold ?? 40))) / 100;
    // planContextMaintenance enters compact at 80% of its supplied budget.
    // Scale the internal budget so the user's selected percentage is the
    // actual compact trigger relative to the provider input budget.
    const proactiveMaintenanceLimit = Math.min(contextBudget, Math.max(8_192, Math.floor(contextBudget * threshold / 0.8)));
    let currentContextTokens = 0;
    let lastOmittedItems: ModelContextItem[] = [];
    const contextCompiler = new ContextCompiler();
    let previousContextBlocks: import("../domain/types.js").ContextBlock[] | undefined;
    harness.on("context", async ({ messages }) => {
      const current = await options.controlStore.snapshot(options.runId);
      const queue = projectObservationQueue(await options.controlStore.events(options.runId), current);
      if (queue.total > 0) {
        const injectedById = new Map(maintenance.injectedObservationItems.map((item) => [item.id, item]));
        for (const item of queue.items.slice(0, 8)) injectedById.set(item.id, item);
        maintenance.injectedObservationItems = [...injectedById.values()];
      }
      const compiled = contextCompiler.build({
        runId: options.runId,
        lane: "main",
        phase: current.phase,
        task: current.task,
        snapshot: current,
        contextWindow: profile.contextWindow,
        outputBudget: profile.maxTokens,
        safetyMargin: providerSafetyTokens,
        resources: contextResources,
        observationQueue: queue.items,
        previousBlocks: previousContextBlocks,
      });
      previousContextBlocks = compiled.manifest.blocks;
      const dynamicProjection = contextProjectionMessage(compiled, turnContext.guidance);
      const contextMessages = injectReasoningForestContext(messages, forestContext.value);
      const prepared = prepareContextMaintenance({
        messages: contextMessages,
        availableTokens: contextBudget,
        maintenanceLimitTokens: proactiveMaintenanceLimit,
        messageBudget: targetMessageBudget,
        baseTokens: estimateTokens(JSON.stringify(dynamicProjection)),
      });
      lastOmittedItems = contextPruneOmissions(prepared.dropped);
      currentContextTokens = prepared.estimatedTokens + estimateTokens(JSON.stringify(dynamicProjection));
      if (prepared.checkpointRecommended) {
        // Coding lanes use a stable system prompt rather than ContextCompiler,
        // so persist the bounded ledger checkpoint directly before Pi compacts.
        // The append-only transcript remains the source of truth if this
        // observer-side write is temporarily unavailable.
        await checkpointService.create(options.runId, "context-prune").catch(() => undefined);
      }
      if (prepared.nextAction === "compact") maintenance.compactRequested = true;
      return { messages: [...prepared.messages, dynamicProjection] };
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
      estimateContextTokens: async () => currentContextTokens,
      getContextSnapshot: async () => {
        const current = await options.controlStore.snapshot(options.runId);
        const observationQueue = projectObservationQueue(await options.controlStore.events(options.runId), current);
        const compiled = contextCompiler.build({
          runId: options.runId,
          lane: "main",
          phase: current.phase,
          task: current.task,
          snapshot: current,
          contextWindow: profile.contextWindow,
          outputBudget: profile.maxTokens,
          safetyMargin: providerSafetyTokens,
          resources: contextResources,
          observationQueue: observationQueue.items,
          previousBlocks: previousContextBlocks,
        });
        previousContextBlocks = compiled.manifest.blocks;
        const summary = contextSnapshot(compiled.manifest);
        return {
          ...summary,
          estimatedTokens: currentContextTokens > 0 ? currentContextTokens : summary.estimatedTokens,
          omittedItems: lastOmittedItems,
        };
      },
      scheduling,
    });
    if (options.onEvent) harness.subscribe(options.onEvent);
    return new PiCodingLane(
      options.runId,
      options.controlStore,
      turnContext,
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
      ablationRoute ? async () => {
        const current = await options.controlStore.snapshot(options.runId);
        ablationRoute.domainPhase = current.domainPhase;
        ablationRoute.actionBundles = current.toolPreparation?.actionBundles ?? [];
      } : async () => undefined,
      async () => {
        const branch = await session.getBranch();
        for (let index = branch.length - 1; index >= 0; index -= 1) {
          const entry = branch[index]!;
          if (entry.type === "message" && entry.message.role === "assistant") return entry.id;
        }
        return undefined;
      },
      async () => await stopAllShellJobs(toolContext),
      pwnRegistry,
      pwnVerifierRegistry,
      webSession,
    );
  }

  public async prompt(text: string): Promise<AgentOutcome> {
    // Prompt wording never changes the runtime policy. Safety boundaries and
    // any explicitly selected ablation policy remain the only control gates.
    this.repeatBreaker.reset();
    this.progressBreaker.reset();
    this.failureStormBreaker.reset();
    this.experimentBudgetBreaker.reset();
    delete this.termination.message;
    delete this.termination.reason;
    this.termination.requested = false;
    this.termination.confirmed = false;
    this.turnContext.guidance = "";
    await this.refreshForestContext();
    await this.refreshAblationRoute();
    this.busy = true;
    const correlationId = `${this.runId}:main:chat-turn`;
    const coordinator = new RunCoordinator(this.controlStore);
    // Admit durable user/control signals at the idle safe point before the
    // next Provider request. The queue itself remains projected from events.
    await coordinator.drainEventsAndComplete(this.runId, "idle");
    await this.eventIngress.enqueue(this.runId, {
      source: "user",
      kind: "user.message",
      correlationId,
      idempotencyKey: `${correlationId}:${sha256(text)}`,
      replayPolicy: "pure",
      payload: { text },
    });
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
      // Apply urgent control signals only after the Provider/tool pair has
      // reached a terminal boundary; never rewrite a half-finished turn.
      await coordinator.drainEventsAndComplete(this.runId, "provider_terminal").catch(() => undefined);
      const injected = this.maintenance.injectedObservationItems;
      this.maintenance.injectedObservationItems = [];
      if (injected.length > 0) await acknowledgeObservationItems(this.controlStore, this.runId, injected).catch(() => undefined);
      this.turnContext.guidance = "";
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
        await this.closeShellJobs().catch(() => undefined);
        // Tear down live pwn tube sessions first: their docker-exec children are
        // host processes that would otherwise outlive the lane, and the durable
        // sessions would stay OPEN until the container is destroyed. Best-effort
        // so a session cleanup failure never blocks the rest of teardown.
        if (this.pwnRegistry) await this.pwnRegistry.disposeAll("lane shutdown").catch(() => undefined);
        if (this.pwnVerifierRegistry) await this.pwnVerifierRegistry.disposeAll("lane shutdown").catch(() => undefined);
        if (this.webSession) await this.webSession.disposeAll("lane shutdown");
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
  verifier: Pick<IndependentVerifier, "verify">;
  artifactStore: ArtifactStore;
  /** Live execution mode. In "assist" the flag is recorded but NOT sent. */
  mode?: () => "auto" | "assist";
  /** Optional durable approval gate for high-risk platform effects. */
  approvalPolicy?: ApprovalPolicy;
  /** Called when the submission path pauses on a pending approval. */
  onApprovalRequired?: (approvalId: string) => void;
}): (flag: string, signal?: AbortSignal) => Promise<CodingFlagSubmission> {
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
    if (deps.approvalPolicy) {
      const approval = await deps.approvalPolicy.check({
        runId: deps.runId,
        operation: "platform.submit",
        resource: flag,
        reason: "A model-derived flag is ready for platform submission.",
      });
      if (!approval.allowed) {
        if (approval.approvalId) deps.onApprovalRequired?.(approval.approvalId);
        return {
          accepted: false,
          completionId,
          candidateHash,
          replayed: false,
          heldForApproval: true,
          message: `${approval.reason ?? "Operator approval is required before submission."}${approval.approvalId ? ` approvalId=${approval.approvalId}` : ""}`,
          ...(await submissionCounters(deps.runtime, await deps.controlStore.snapshot(deps.runId))),
        };
      }
    }
    const outcome = await deps.verifier.verify(deps.runId, deps.fixture, completionId, signal);
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

function contextPruneOmissions(dropped: readonly { kind: string; id?: string }[]): ModelContextItem[] {
  const omissions = new Map<string, ModelContextItem>();
  for (const item of dropped) {
    const sourceId = item.id?.slice(0, 128);
    const identity = canonicalJson({ kind: item.kind, ...(sourceId ? { sourceId } : {}) });
    const contentHash = sha256(identity);
    omissions.set(identity, {
      itemId: `pruned:${item.kind.slice(0, 64)}:${contentHash.slice(0, 16)}`,
      role: "unknown",
      source: "context",
      sourceIds: sourceId ? [sourceId] : [],
      // The pruner reports identities rather than discarded bodies. Recording
      // a hash of that metadata keeps telemetry informative without retaining
      // model-visible text that the final request did not contain.
      contentHash,
      visibleChars: 0,
      estimatedTokens: 0,
      included: false,
      artifactRefs: [],
      evidenceRefs: [],
    });
  }
  return [...omissions.values()];
}

export function injectReasoningForestContext(messages: AgentMessage[], forestContext: string): AgentMessage[] {
  if (!forestContext) return messages;
  const output = [...messages];
  // Keep changing context after the append-only transcript. This preserves the
  // existing transcript prefix for provider prompt/KV-cache reuse while leaving
  // tool-call/result pairs and the external user task untouched.
  const insertionIndex = output.length;
  output.splice(insertionIndex, 0, createCustomMessage(
    "proofblade_reasoning_forest",
    forestContext,
    false,
    { durable: true, projection: "forest-index" },
    new Date(0).toISOString(),
  ));
  return output;
}

/**
 * Attach the compiler's current dynamic projection to the provider view only.
 * The message is hidden from the session UI and never persisted as a Pi entry;
 * its hash/details make the exact provider suffix explainable from the same
 * snapshot and ContextManifest used by observability.
 */
function contextProjectionMessage(compiled: ContextBuildOutput, turnGuidance = ""): AgentMessage {
  const dynamicContent = [
    compiled.messages.slice(1).map((message) => `[${message.role}]\n${message.content}`).join("\n\n"),
    turnGuidance ? `<proofblade-turn-guidance>\n${turnGuidance}\n</proofblade-turn-guidance>` : "",
  ].filter(Boolean).join("\n\n");
  const hashPlaceholder = "0".repeat(64);
  const prefix = `<proofblade-context manifest-hash="${compiled.manifest.hash}" dynamic-hash="${hashPlaceholder}">\n`;
  const suffix = "\n</proofblade-context>";
  // ContextCompiler bounds individual blocks, but the provider receives this
  // projection as one message. Bound the final envelope as well.
  const emptyMessage = createCustomMessage("proofblade_context_projection", `${prefix}${suffix}`, false, undefined, new Date(0).toISOString());
  const envelopeTokens = estimateTokens(JSON.stringify(emptyMessage));
  const dynamicBudget = Math.max(16, MAX_CONTEXT_PROJECTION_MESSAGE_TOKENS - envelopeTokens);
  const bounded = boundModelText(dynamicContent, Math.max(64, dynamicContent.length), dynamicBudget);
  const dynamicHash = sha256(bounded.text);
  const prefixWithVisibleHash = `<proofblade-context manifest-hash="${compiled.manifest.hash}" dynamic-hash="${dynamicHash}">\n`;
  const content = `${prefixWithVisibleHash}${bounded.text}${suffix}`;
  return createCustomMessage(
    "proofblade_context_projection",
    content,
    false,
    {
      manifestHash: compiled.manifest.hash,
      dynamicSuffixHash: dynamicHash,
        sourceIds: compiled.manifest.sourceIds ?? [],
        blockIds: compiled.manifest.blocks?.map((block) => block.id) ?? [],
        ...(bounded.truncated ? { truncated: true, maxTokens: MAX_CONTEXT_PROJECTION_MESSAGE_TOKENS } : {}),
    },
    new Date(0).toISOString(),
  );
}

function pwnReproductionPolicyFor(contract: PwnReproductionContract | undefined): PwnReproductionPolicy | undefined {
  if (!contract || contract.target.command.length === 0 || !contract.flag_path || !contract.flag_pattern) return undefined;
  const target = contract.target.kind === "remote"
    ? contract.target.endpoint
      ? { kind: "remote" as const, command: [...contract.target.command], endpoint: contract.target.endpoint }
      : undefined
    : { kind: "local" as const, command: [...contract.target.command] };
  if (!target) return undefined;
  return {
    target,
    flagPath: contract.flag_path,
    flagPattern: contract.flag_pattern,
  };
}

/**
 * Detect challenge-shaped prompts at the GUI boundary, where the durable chat
 * task is intentionally target-agnostic and therefore cannot provide a
 * category-specific TaskContract. This stays conservative so a normal request
 * about a software "feature flag" remains an ordinary coding turn.
 */
export function isLikelyCtfPrompt(text: string): boolean {
  return /(?:\bctf\b|\bchallenge\b|\bpyjail\b|\bpwn\b|\breverse(?:[- ]engineering)?\b|\bapk\b|\bshellcode\b|\bflag\s*\{|(?:题目描述|求解\s*flag|解题|夺旗|靶机|逆向题|破解题|漏洞题|二进制题))/i.test(text);
}

/** Durable task classification used when generated executor prompts omit CTF keywords. */
export function isChallengeTask(task: Pick<TaskContract, "mode" | "target_kind"> & Partial<Pick<TaskContract, "verification">>): boolean {
  // Domain tags and the legacy mode do not select a loop. Challenge-oriented
  // preparation is needed only for tasks with a scorer or external platform;
  // ordinary coding tasks may analyze the same web/binary domains directly.
  return task.verification?.kind === "hidden_scorer"
    || task.verification?.kind === "platform_submission"
    || (!task.verification && task.mode === "ctf_solve");
}

function codingCtfWorkflowGuidance(skillsLibraryPath: string): string {
  const lib = skillsLibraryPath.replace(/\\/g, "/");
  return `## CTF solving workflow (follow this loop)\nWhen the task is to solve a CTF challenge / recover a flag:\n1. Recon: list files, \`file *\`, strings/xxd on binaries, read the prompt and any connection info.\n2. Categorize: pick the dominant category — web / crypto / reverse / pwn / forensics / misc / osint / malware.\n3. Load the playbook: a full CTF skills library is on disk at \`${lib}\`. Read the matching category's guide with bash before you start, e.g. \`cat "${lib}/ctf-<category>/SKILL.md"\`, and open the supporting files it references (same directory) as needed. Follow that playbook instead of your default habits.\n4. Converge — this is where solves are usually lost: as soon as you have extracted the data/structure the challenge turns on (a grid, key schedule, table, protocol), STOP re-reading disassembly or dumping bytes. Reconstruct the logic as a small script (Python) and let the machine solve it (search/BFS, reimplement the transform, bounded brute force). Re-reading the same thing a third time is the signal to switch to code.\n5. Produce the flag: apply exactly the transform the challenge states and the exact required flag format — no missing and no extra layers. Validate the candidate, then report it.\nUse read/bash to consult ${lib} at any point; you do not need load_skill for it.\n\n## Interactive native/Pwn protocol discipline\nFor a menu-driven native service, never synchronize on a generic suffix such as \`recv_until(b\": ")\`. Wait for the complete prompt for the current state (for example \`student_ID (0-127): \`, \`Name (max 23 chars): \`, or \`Style (1-3): \`) and consume the complete menu marker before sending the next choice. Every helper must log the step name, timeout, and last received bytes; a timeout is a protocol failure, not evidence that the exploit worked. Use a fresh connection for each retry and do not repeat a destructive heap sequence without first proving the previous step. Set Python output to UTF-8 (\`PYTHONUTF8=1\`, \`PYTHONIOENCODING=utf-8\`) and print undecodable bytes with a reversible error mode. After a suspected shell/control-flow hijack, send a unique marker such as \`echo PB_READY\` and wait for that marker; EOF or a reset alone is never shell success.`;
}

function codingSystemPrompt(
  skills: Array<{ name: string; description: string; content: string }>,
  mcpServers: Array<{ name: string; description: string }>,
  workspaceRoot: string,
  toolCatalogBlock: string,
  options: { executionPlatform?: NodeJS.Platform; hostWorkspaceRootForMcp?: string } = {},
): string {
  // State the workspace explicitly. Without it the model guesses, wanders into a
  // parent directory, and then resolves a name that means something different
  // there (a very common trap: an unzipped folder with the SAME name as the file
  // inside it, where `sqlite3 x` opens the directory and fails).
  const workspaceBlock = `\n\nYour working directory is \`${workspaceRoot.replace(/\\/g, "/")}\` — every relative path resolves there, and the task's target files are in it. Stay in it: prefer relative paths over \`cd\`, and if you must \`cd\`, come back. Before treating a name as a file, confirm it with \`ls -la\` (a name can be a directory that contains a same-named file). If a tool says a path is a directory or cannot be opened, re-check the layout instead of retrying the same command.`;
  const nativeSkills = skills.length > 0
    ? `\n\nAlso available via load_skill (optional): ${skills.map((s) => s.name).join(", ")}.`
    : "";
  const mcpBlock = mcpServers.length > 0
    ? `\n\nEnabled MCP servers — their tools are available DIRECTLY as first-class tools named \`mcp__<server>__<tool>\` (call them like any other tool; no mcp_call/describe needed):\n${mcpServers.map((server) => `- ${server.name}: ${server.description}`).join("\n")}\nFor reverse-engineering or binary analysis, PREFER a decompiler MCP to get pseudocode over hand-reading objdump/strings — reach for it early. Follow each server's stated usage protocol (some require opening/binding the target first).`
    : "";
  const mcpPathBlock = options.hostWorkspaceRootForMcp
    ? `\n\nMCP path boundary: shell/read/edit/write operate on the container workspace at \`${workspaceRoot}\`. Host-side MCP tools (for example IDA/JADX) cannot see that virtual path; when an MCP tool asks for a file path, pass the host workspace path \`${options.hostWorkspaceRootForMcp}\` plus the workspace-relative suffix. Never use that host path in bash.`
    : "";
  return `${CODING_SYSTEM_PROMPT}\n\n${codingHostGuidance(options.executionPlatform ?? process.platform)}${workspaceBlock}${toolCatalogBlock}${nativeSkills}${mcpBlock}${mcpPathBlock}`;
}

function preparedChallengeProfileBlock(profile: ChallengeToolProfile, preflight?: ChallengeToolPreflight): string {
  const runtime = preflight?.runtime === "container"
    ? `the target execution container (${preflight.runtimeKey})`
    : "the host execution environment";
  const required = preflight?.missingRequiredTools.length
    ? `Missing required tools in ${runtime}: ${preflight.missingRequiredTools.join(", ")}. Use a listed fallback; do not install interactively.`
    : `Required tools in ${runtime} are ready or not applicable.`;
  const optional = preflight?.missingOptionalTools.length
    ? ` Missing optional tools in ${runtime}: ${preflight.missingOptionalTools.join(", ")}; do not rediscover or install them during the challenge.`
    : "";
  const mcp = preflight?.mcpServers.length
    ? ` MCP readiness: ${preflight.mcpServers.map((server) => `${server.name}=${server.status}${server.toolchainState ? `/${server.toolchainState}` : ""}`).join(", ")}.`
    : "";
  const readiness = preflight?.tools.length
    ? ` Tool readiness in ${runtime}: ${preflight.tools.map((tool) => `${tool.id}=${tool.status}`).join(", ")}.`
    : "";
  const firstAction = profile.firstActionPlan;
  const firstActionBudget = ` First action budget: at most ${firstAction.maxCalls} calls through ${firstAction.allowedToolNames.join(", ")}; completion tools may be used immediately when a verifier-ready candidate exists.`;
  const actionBundles = preflight?.actionBundles ?? profile.actionBundles;
  const actionBundleBlock = actionBundles.length > 0
    ? `\nPhase action bundles (select the bundle matching the durable phase; do not mix phases):\n${actionBundles.map((bundle) => `- ${bundle.domainPhase} / ${bundle.id}: ${bundle.objective} Tools: ${bundle.toolNames.join(", ")}. Preconditions: ${bundle.preconditions.join("; ")}. Success: ${bundle.successCriteria.join("; ")}. Failure: ${bundle.failureCriteria.join("; ")}. Max calls: ${bundle.maxCalls}.`).join("\n")}`
    : "";
  return `\n\n## Prepared challenge tool profile\nDirection: ${profile.id}; target kind: ${profile.targetKind}. The ${runtime} preflight is authoritative and has already classified this challenge. Do not spend a model turn reclassifying the task, reading unrelated playbooks, discovering tools, installing packages, or retrying a missing binary. Use the selected direction directly. First action contract: ${profile.firstAction}${firstActionBudget} Otherwise persist the new fact before choosing the next action. Required tool ids: ${profile.requiredToolIds.join(", ") || "none"}. Optional tool ids: ${profile.optionalToolIds.join(", ") || "none"}. Prepared fallback order: ${profile.fallbackStrategies.join(" -> ")}.${actionBundleBlock} ${required}${optional}${readiness}${mcp}`;
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
export function codingCtfCategoryGuidance(kind?: TaskContract["target_kind"], target?: string, pwnToolsAvailable?: boolean, pwnReproductionAvailable = pwnToolsAvailable, webToolsAvailable?: boolean): string {
  if (!kind || kind === "unknown") return "";
  const remote = typeof target === "string" && target.startsWith("REMOTE:") ? target.slice("REMOTE:".length).trim() : undefined;
  const remoteBlock = remote ? `\nLive target: ${remote}. The container's egress gateway already permits that host/port; other outbound network is denied by policy, not by a broken tool, so do not retry the same request against a different upstream when it is refused.` : "";
  if (kind === "pwn") {
    // The single biggest source of lost pwn turns is running an interactive
    // exploit as ONE foreground `bash` call: recvuntil/interactive blocks, the
    // command hits the hard timeout, is killed, and the model rewrites the whole
    // script and blocks again. State the interaction model up front so the
    // exploit is driven turn-by-turn, not one monolithic blocking script.
    const interactionRule = pwnToolsAvailable
      ? `- INTERACTION MODEL — use the persistent pwn tube, not a blocking bash script. Open the target once with \`pwn_open\` (kind=remote, endpoint=host:port for an \`nc\` target; kind=local, command=[\"./chall\"] for a local binary) and keep the returned sessionId. Drive it turn-by-turn with \`pwn_send\` (encoding=base64 for non-UTF-8 payloads/addresses; line=true for a newline) and \`pwn_recv\` (until=<anchor>). After a bounded observation, persist the primitive hypothesis with \`pwn_record_primitive\` and its Artifact/Evidence ids; confidence is always below 1 and it is never a shell claim. This is how you avoid the #1 pwn failure: a full \`from pwn import *\` script run in one \`bash\` call blocks on recv and dies at the command timeout. Use bash/python only to compute offsets, gadgets, and payload bytes (base64-encode them for pwn_send) — never to hold the live connection.${pwnReproductionAvailable ? " Confirm a solve with \`pwn_reproduce\` (fresh session + shell-marker + flag-extract barriers); proposing a script is not the same as landing a shell." : " The immutable task verifier is not configured for \`pwn_reproduce\`; validate the exploit through the live session and submit through the platform workflow."}`
      : "- INTERACTION MODEL — never hold a live interactive connection inside one foreground `bash` call: an exploit that calls `recvuntil`/`interactive`/`p.recv()` will block until the command timeout kills it, and rewriting the whole script and re-running it is the #1 way pwn turns are lost. Run any long or interactive exploit under `shell_background` and poll with `shell_job`, so a stall costs one bounded poll instead of the whole command budget. Keep each foreground `bash` short: compute offsets/gadgets/payloads, do a single bounded probe (`timeout 20 python solve.py`), inspect, iterate — do not launch the full interactive solve in the foreground.";
    return [
      "\n\n## Pwn category specifics",
      "- Use the exact paths in the prepared `<tool-catalog>` profile for `pwntools`, `gdb`, `qemu`, `patchelf`, `ropgadget`, or `one_gadget` when present. Optional tools may be absent; do not install or rediscover them during the solve. `context.log_level = 'debug'` when protocol sync is unclear.",
      interactionRule,
      "- Always run `file` and `checksec` (or the prepared `capability` proofblade.binary identify/inspect_elf operation) on any provided binary before writing an exploit. If no binary is provided (remote-only pwn), your leak strategy must not depend on offsets from a local copy — derive them from actual leaks.",
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
    // When the interactive web session tools are wired, steer stateful work onto
    // them: a durable session keeps the cookie jar / CSRF across calls, so the
    // model does not re-establish `requests.Session()` state on every bash call.
    const webInteractionRule = webToolsAvailable
      ? "- INTERACTION MODEL — for anything stateful use the persistent web session, not repeated one-shot curls. Open the target once with `web_open` (baseUrl=the target URL) and keep the returned sessionId; drive it with `web_request` (path/method/headers/body) so cookies, CSRF tokens, and redirects persist across the whole chain. Use `web_replay` to check whether a request still works in a clean cookie jar. `curl`/`sqlmap`/`python-requests` remain available for one-shot probes."
      : "- For stateful flows (login then act, CSRF token reuse) use Python `requests.Session()` in a single script; a chain of separate `curl` calls drops the cookie jar between calls.";
    return [
      "\n\n## Web category specifics",
      webInteractionRule,
      "- `curl`, `python-requests`, `beautifulsoup4`, `sqlmap`, `chromium` (headless), and `playwright` are already installed. Prefer `curl -sSik` for one-shot probes and Python `requests.Session()` for anything stateful (cookies, CSRF).",
      "- Use the exact prepared catalog paths for `curl`, `chromium`, or `playwright` when present. Python HTTP libraries are the baseline; optional scanners such as `sqlmap` must not be assumed or installed mid-challenge. Prefer `curl -sSik` for one-shot probes and Python `requests.Session()` for anything stateful (cookies, CSRF).",
      "- Read the initial page and its response headers first: `curl -sSikL <target>` shows the framework fingerprint (Server, X-Powered-By, Set-Cookie shape, error page style) that decides your subsequent playbook branch (SQLi vs SSTI vs SSRF vs auth-bypass vs deserialization).",
      "- Check `/robots.txt`, `/.git/HEAD`, `/.env`, `/admin`, `/login`, source view (`view-source:` equivalent via `curl`), sitemap, and any JS bundles for endpoints — a large fraction of web CTFs hinge on a route that is not linked from the landing page.",
      "- Decode any JWT with `python -c 'import jwt,sys;print(jwt.decode(sys.argv[1], options={\"verify_signature\":False}))'` (or manual base64) before treating it as opaque. Note the algorithm — `alg:none` and weak HS256 keys are common CTF traps.",
      "- Chinese CTF web challenges frequently return GBK-encoded response bodies. If `curl` output looks mojibake, add `--output` and inspect with `file`/`iconv -f gbk -t utf-8`. Do not rely on the terminal echo of Chinese strings for parsing.",
      "- When `sqlmap` is present in the prepared catalog and the vulnerability looks like SQLi, run it in `shell_background` before hand-rolling payloads; otherwise use a bounded requests reproducer. For SSTI/RCE, jump to `{{7*7}}` and `${{7*7}}` fingerprints across common template engines.",
      remoteBlock,
    ].join("\n");
  }
  if (kind === "reverse") {
    return [
      "\n\n## Reverse category specifics",
      "- Prefer a decompiler MCP (idalib-mcp / jadx-mcp when available) over hand-reading `objdump -d`. Open the target once, then work from pseudocode.",
      "- Call `capability` for `proofblade.binary.packed_probe` early. It detects UPX signatures and returns a bounded fallback plan; run the exact catalog UPX path with `-t` before attempting `-d`.",
      "- If UPX is missing or reports a corrupt header, switch once to `gdb_batch` (`starti`, `info proc mappings`, then a bounded `dump memory` into a workspace-relative file) or QEMU; do not keep retrying the same unpacker download.",
      "- Use `proofblade.binary.identify` as the portable file-magic baseline, then run the exact prepared catalog paths for `strings`, `readelf`, `objdump`, `gdb`, or `checksec` when present. For packed binaries note the entropy and section layout before decompiling.",
      "- Once you have identified the transform, reconstruct it in Python instead of stepping through disassembly a fourth time. Search/BFS/bounded brute force is the fifth step of the loop; do not skip it.",
    ].join("\n");
  }
  if (kind === "crypto") {
    return [
      "\n\n## Crypto category specifics",
      "- Use the prepared catalog to decide whether `pycryptodome`, `gmpy2`, Sage, OpenSSL, or `fpylll` are available; otherwise keep a pure-Python implementation as the fallback and do not install packages mid-challenge. For classic modular-arithmetic tasks reach for `gmpy2.iroot`, Chinese Remainder Theorem, and lattice reduction (`fpylll`) before trying to brute force when those tools are ready.",
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

function webBaseUrlFromTarget(target: string): string | undefined {
  const match = /^REMOTE:https?:\/\/([^\s]+)$/i.exec(target.trim());
  const value = match
    ? match[0].slice("REMOTE:".length)
    : /^REMOTE:http\s+([^\s:]+):(\d+)$/i.test(target.trim())
      ? `http://${/^REMOTE:http\s+([^\s:]+):(\d+)$/i.exec(target.trim())![1]}:${/^REMOTE:http\s+([^\s:]+):(\d+)$/i.exec(target.trim())![2]}`
      : undefined;
  if (!value) return undefined;
  try { return new URL(value).toString().replace(/\/$/, ""); } catch { return undefined; }
}

/**
 * Keep the lane's broker health check scoped to the capabilities the task can
 * actually use. A configured deployment may expose both Pwn and HTTP brokers,
 * but a fixture Web task without a web verification contract has no reason to
 * probe either durable transport during lane startup.
 */
function sessionRuntimeBrokersForTask(
  task: TaskContract,
  brokers: readonly SessionRuntimeCreateBroker[],
): readonly SessionRuntimeCreateBroker[] {
  const requiredKinds = new Set<SessionRuntimeCreateBroker["kind"]>();
  if (task.target_kind === "pwn" || task.verification.pwn) requiredKinds.add("pwn-session");
  const webTransport = task.verification.web?.transport ?? "http";
  if (webTransport === "http" && (task.verification.web || webBaseUrlFromTarget(task.target))) requiredKinds.add("http-session");
  return brokers.filter((broker) => requiredKinds.has(broker.kind));
}

function sessionIdFromResourceId(resourceId: string): string {
  if (!resourceId.startsWith("session:") || resourceId.length <= "session:".length) throw new Error(`Invalid recovered session resource id: ${resourceId}`);
  return resourceId.slice("session:".length);
}

function brokerOnlySessionRuntime(): ContainerRuntimePort {
  return new Proxy({} as ContainerRuntimePort, {
    get() {
      return async () => { throw new Error("This lane has no local container runtime; use the configured session broker"); };
    },
  });
}

function brokerSessionRef(runId: string, generation: number, workspaceHostPath: string): ContainerRef {
  const digest = sha256(`${runId}:${generation}:session-runtime`);
  return {
    runId,
    generation,
    containerId: `session-runtime-${digest.slice(0, 24)}`,
    name: `session-runtime-${digest.slice(24, 40)}`,
    profile: "pwn",
    image: "proofblade/session-runtime",
    imageDigest: `sha256:${sha256("proofblade/session-runtime")}`,
    workspaceHostPath,
    workspaceContainerPath: "/workspace",
    networkPolicy: "target-only",
  };
}

function firstClassMcpServers(targetKind: TaskContract["target_kind"], target: string, enabledServers: Set<string>, profileId?: string): string[] {
  if (targetKind !== "reverse") return [];
  const preferred = profileId === "mobile" || /\.(?:apk|dex|aab)\b|android|jadx/i.test(target) ? ["jadx"] : ["idalib-mcp"];
  return preferred.filter((server) => enabledServers.has(server));
}
