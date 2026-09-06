import { access, open, readdir, rm, stat } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { join, relative } from "node:path";
import { JsonlSessionRepo, NodeExecutionEnv, type AgentHarnessEvent } from "@earendil-works/pi-agent-core/node";
import {
  CheckpointService,
  CodingClaimVerifier,
  AUTOMATIC_CONTEXT_RECOVERY_MARKER,
  PiCodingLane,
  ProofBladeToolRuntime,
  RunRecoveryService,
  RunTelemetry,
  RunCoordinator,
  ApprovalPolicy,
  ProofBladeAppServer,
  SingleAgentCtfLoop,
  createServices,
  assertRunId,
  RUN_ID_PATTERN,
  fixtureTask,
  listFixtureProfiles,
  requiresClaimVerification,
  rewriteUnverifiedClaimText,
  type AppServices,
  type AgentLanePort,
  type AgentOutcome,
  type HarnessEvent,
  type ModelProfileConfig,
  type ProofBladeConfig,
  type RunSnapshot,
  type AgentLaneFactory,
  type TaskContract,
  type BrowserVerifierFactory,
  tryCreateConfiguredBrowserVerifierFactory,
  withBrowserResourceAdapter,
  tryCreateConfiguredSessionRuntimeBrokers,
  withSessionResourceAdapters,
  projectObservationQueue,
  JsonlControlStore,
  projectionHash,
} from "@proofblade/materials";
import { buildRunControlView } from "./control-view.js";
import { stageCtfWorkspace, type CtfWorkspaceInput } from "./ctf-workspace.js";
import type {
  ActiveRunInfo,
  AssistantTurnDebug,
  BootstrapData,
  ChatMessageDebug,
  ChatStreamEvent,
  ContextRuntimeInfo,
  PiSessionDebug,
  RunDetail,
  RunKind,
  RunListItem,
  ToolCallDebug,
  TokenUsage,
} from "./shared.js";
import { BoundedLruCache } from "./bounded-lru-cache.js";
import { toolPresentation } from "./tool-presentation.js";

interface SessionEntryLike {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: unknown;
}

interface MessageLike {
  role?: string;
  content?: unknown;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: unknown;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
}

interface ContentLike {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  thinking?: string;
  arguments?: unknown;
}

const runDetailCacheCapacity = 32;
const runDetailCacheMaxBytes = 64 * 1024 * 1024;
const runDetailCacheMaxEntryBytes = 8 * 1024 * 1024;
type CodingLaneFactory = (options: Parameters<typeof PiCodingLane.create>[0]) => Promise<AgentLanePort>;

export class DebugDataService {
  private readonly services: AppServices;
  private readonly browserVerifierFactory?: BrowserVerifierFactory;
  private readonly createCodingLane: CodingLaneFactory;
  private readonly materializedRuns: JsonlControlStore;
  public readonly appServer: ProofBladeAppServer;
  private readonly active = new Map<string, ActiveRunInfo>();
  private readonly activeLanes = new Map<string, AgentLanePort>();
  private readonly chatTasks = new Set<Promise<void>>();
  private readonly solveTasks = new Map<string, { controller: AbortController; promise: Promise<unknown> }>();
  private readonly pauseRequests = new Set<string>();
  private readonly streamEmitters = new Map<string, (event: ChatStreamEvent) => void>();
  private readonly runListCache = new Map<string, { mtimeMs: number; item: RunListItem }>();
  private readonly runDetailLoads = new Map<string, Promise<RunDetail>>();
  private readonly runDetailCache = new BoundedLruCache<string, {
    mtimeMs: number;
    size: number;
    sessionsVersion: string;
    bytes: number;
    detail: RunDetail;
  }>(runDetailCacheCapacity, runDetailCacheMaxBytes, (entry) => entry.bytes);
  private closing = false;
  private closePromise: Promise<void> | undefined;

  public constructor(
    private readonly root: string,
    private readonly config: ProofBladeConfig,
    private readonly configPath: string,
    createCodingLane?: CodingLaneFactory,
    private readonly createCtfLane?: AgentLaneFactory,
  ) {
    this.browserVerifierFactory = tryCreateConfiguredBrowserVerifierFactory(config);
    const sessionRuntime = tryCreateConfiguredSessionRuntimeBrokers(config);
    this.createCodingLane = createCodingLane ?? ((options) => PiCodingLane.create({ ...options, ...(options.browserVerifierFactory ? {} : { browserVerifierFactory: this.browserVerifierFactory }) }));
    const authoritySecret = process.env.PROOFBLADE_CONTROL_AUTHORITY;
    this.services = createServices(root, config, {
      ...(authoritySecret ? { authoritySecret } : {}),
      ...(sessionRuntime.brokers.length > 0 ? { sessionRuntimeBrokers: sessionRuntime.brokers } : {}),
      ...(sessionRuntime.configured ? { sessionRuntimeRequired: !sessionRuntime.tokenAvailable } : {}),
      ...(config.runtime.browserBroker ? { browserRuntimeRequired: true } : {}),
    });
    this.materializedRuns = new JsonlControlStore(this.services.runsRoot);
    this.appServer = new ProofBladeAppServer({
      control: this.services.control,
      approvals: new ApprovalPolicy({ ledgerPath: join(this.services.runsRoot, "approvals.json") }),
    });
  }

  public updateModelProfile(profile: ModelProfileConfig): void {
    this.config.modelProfiles.executor = { ...profile, input: [...profile.input] };
  }

  public async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closing = true;
    this.closePromise = this.shutdown();
    return await this.closePromise;
  }

  private async shutdown(): Promise<void> {
    this.runDetailLoads.clear();
    const aborts: Promise<unknown>[] = [];
    for (const [runId, lane] of this.activeLanes) {
      if (!this.solveTasks.has(runId)) aborts.push(Promise.resolve().then(() => lane.abort("GUI shutting down")));
    }
    for (const task of this.solveTasks.values()) task.controller.abort("GUI shutting down");
    const abortResults = await Promise.allSettled(aborts);
    const taskResults = await Promise.allSettled([
      ...this.chatTasks,
      ...[...this.solveTasks.values()].map((task) => task.promise),
    ]);
    const sandboxResult = await Promise.allSettled([this.services.sandbox.close()]);
    const failures = [...abortResults, ...taskResults, ...sandboxResult]
      .flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    this.runListCache.clear();
    this.runDetailCache.clear();
    this.runDetailLoads.clear();
    if (failures.length > 0) throw new AggregateError(failures, "GUI shutdown failed");
  }

  public bootstrap(): BootstrapData {
    const profile = this.config.modelProfiles.executor;
    return {
      projectName: "ProofBlade / 证锋",
      projectRoot: this.root,
      configPath: this.configPath,
      storage: this.config.storage,
      model: {
        provider: profile.provider,
        model: profile.model,
        baseUrl: profile.baseUrl,
        thinkingLevel: profile.thinkingLevel ?? "off",
      },
      fixtures: listFixtureProfiles().map(({ id, targetKind, description }) => ({ id, targetKind, description })),
      refreshIntervalMs: 2_000,
    };
  }

  public async listRuns(): Promise<RunListItem[]> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(this.services.runsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const items = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
      .map(async (entry): Promise<RunListItem | undefined> => {
        try {
          const eventsStat = await stat(join(this.services.runsRoot, entry.name, "events.jsonl"));
          const cached = this.runListCache.get(entry.name);
          if (cached?.mtimeMs === eventsStat.mtimeMs) return { ...cached.item, active: this.active.get(entry.name) };
          const snapshot = await this.runListSnapshot(entry.name, eventsStat);
          const item: RunListItem = {
            runId: snapshot.runId,
            kind: runKind(snapshot.task),
            objective: snapshot.task.objective,
            targetKind: snapshot.task.target_kind,
            status: snapshot.status,
            phase: snapshot.phase,
            generation: snapshot.generation,
            lastSeq: snapshot.lastSeq,
            updatedAt: eventsStat.mtime.toISOString(),
            counts: {
              evidence: Object.keys(snapshot.evidence).length,
              artifacts: Object.keys(snapshot.artifacts).length,
              effects: Object.keys(snapshot.effects).length,
            },
            active: this.active.get(snapshot.runId),
          };
          this.runListCache.set(entry.name, { mtimeMs: eventsStat.mtimeMs, item });
          return item;
        } catch {
          return undefined;
        }
      }));
    return items.filter((item): item is RunListItem => Boolean(item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async runListSnapshot(runId: string, eventsStat: Stats): Promise<RunSnapshot> {
    try {
      const [snapshot, projectionStat] = await Promise.all([
        this.materializedRuns.loadProjection(runId),
        stat(join(this.services.runsRoot, runId, "projection.json")),
      ]);
      if (snapshot
        && snapshot.runId === runId
        && snapshot.projectionHash === projectionHash(snapshot)
        && (projectionStat.mtimeMs >= eventsStat.mtimeMs
          || await hasSingleTrailingAuthorityMigration(join(this.services.runsRoot, runId, "events.jsonl"), eventsStat, snapshot))) return snapshot;
    } catch {
      // Missing, malformed, or stale projections are disposable. The event
      // stream remains authoritative and is replayed only for this Run.
    }
    return await this.services.control.snapshot(runId);
  }

  public async getRun(runId: string): Promise<RunDetail> {
    assertRunId(runId);
    const eventsStat = await stat(join(this.services.runsRoot, runId, "events.jsonl"));
    const sessionsRoot = join(this.services.runsRoot, runId, "pi-sessions");
    const sessionsVersion = await filesystemVersion(sessionsRoot);
    const cacheKey = runDetailVersionKey(runId, eventsStat.mtimeMs, eventsStat.size, sessionsVersion);
    const cached = this.runDetailCache.peek(runId);
    if (cached?.mtimeMs === eventsStat.mtimeMs && cached.size === eventsStat.size && cached.sessionsVersion === sessionsVersion) {
      const current = this.runDetailCache.get(runId);
      return { ...current!.detail, active: this.active.get(runId) };
    }
    if (cached) this.runDetailCache.delete(runId);
    const existing = this.runDetailLoads.get(cacheKey);
    if (existing) return { ...(await existing), active: this.active.get(runId) };
    const load = this.loadRunDetail(runId, eventsStat, sessionsRoot, sessionsVersion);
    this.runDetailLoads.set(cacheKey, load);
    try {
      return { ...(await load), active: this.active.get(runId) };
    } finally {
      if (this.runDetailLoads.get(cacheKey) === load) this.runDetailLoads.delete(cacheKey);
    }
  }

  private async loadRunDetail(runId: string, eventsStat: Stats, sessionsRoot: string, sessionsVersion: string): Promise<RunDetail> {
    const [snapshot, events, telemetry, sessionRead] = await Promise.all([
      this.services.control.snapshot(runId),
      this.services.control.events(runId),
      new RunTelemetry(this.services.control).report(runId),
      this.loadStableSessions(runId, sessionsRoot, sessionsVersion),
    ]);
    const { sessions, version: loadedSessionsVersion, stable: sessionsStable } = sessionRead;
    const detail = { kind: runKind(snapshot.task), snapshot, events, telemetry, sessions, controlView: buildRunControlView(snapshot), active: this.active.get(runId), updatedAt: eventsStat.mtime.toISOString(), context: contextRuntimeInfo(events), observationQueue: projectObservationQueue(events, snapshot) } satisfies RunDetail;
    const currentVersion = sessionsStable && await this.isCurrentRunVersion(runId, eventsStat, sessionsRoot, loadedSessionsVersion);
    const bytes = currentVersion ? boundedJsonByteSize(detail, runDetailCacheMaxEntryBytes) : runDetailCacheMaxEntryBytes + 1;
    if (!this.closing && currentVersion && bytes <= runDetailCacheMaxEntryBytes) {
      this.runDetailCache.set(runId, { mtimeMs: eventsStat.mtimeMs, size: eventsStat.size, sessionsVersion: loadedSessionsVersion, bytes, detail });
    }
    return detail;
  }

  private async isCurrentRunVersion(runId: string, eventsStat: Stats, sessionsRoot: string, sessionsVersion: string): Promise<boolean> {
    try {
      const currentEventsStat = await stat(join(this.services.runsRoot, runId, "events.jsonl"));
      if (currentEventsStat.mtimeMs !== eventsStat.mtimeMs || currentEventsStat.size !== eventsStat.size) return false;
      return await filesystemVersion(sessionsRoot) === sessionsVersion;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  public async artifact(runId: string, artifactId: string): Promise<{ artifact: RunSnapshot["artifacts"][string]; content: string }> {
    assertRunId(runId);
    const snapshot = await this.services.control.snapshot(runId);
    const artifact = snapshot.artifacts[artifactId];
    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
    return { artifact, content: await this.services.artifacts.readText(runId, artifact) };
  }

  public async checkpoint(runId: string, reason: string): Promise<unknown> {
    assertRunId(runId);
    return await new CheckpointService(this.services.control, this.services.artifacts).create(runId, reason || "GUI manual checkpoint");
  }

  public async recover(runId: string): Promise<unknown> {
    assertRunId(runId);
    return await new RunRecoveryService(this.services.control, this.services.journal, this.services.sandbox, this.services.fixtureControl, undefined, this.services.verificationRecovery, this.services.verificationRecoveryAdapters, this.services.externalResources, withSessionResourceAdapters(withBrowserResourceAdapter(this.services.externalResourceAdapters, this.browserVerifierFactory), this.services.sessionRuntimeBrokers ?? [])).recover(runId);
  }

  public async startSolve(input: { runId: string; fixtureId: string; mode: "auto" | "assist"; maxTurns?: number }): Promise<ActiveRunInfo> {
    this.assertOpen();
    assertRunId(input.runId);
    const task = fixtureTask(input.runId, input.fixtureId, this.root, this.config);
    await this.ensureRunCreated(input.runId, task);
    return await this.startCtfTask(task, input.mode, input.maxTurns);
  }

  /** Start an arbitrary attachment-backed CTF Run through the same durable loop as Fixture and Competition. */
  public async startCtfSolve(input: CtfWorkspaceInput & { mode: "auto" | "assist"; maxTurns?: number }): Promise<ActiveRunInfo> {
    this.assertOpen();
    assertRunId(input.runId);
    if (this.active.has(input.runId)) throw new Error(`Run is already active: ${input.runId}`);
    await this.assertRunDoesNotExist(input.runId);
    const task = await stageCtfWorkspace(input, this.services.runsRoot);
    await this.ensureRunCreated(input.runId, task);
    return await this.startCtfTask(task, input.mode, input.maxTurns);
  }

  private async startCtfTask(task: TaskContract, mode: "auto" | "assist", maxTurns?: number): Promise<ActiveRunInfo> {
    const current = this.active.get(task.task_id);
    if (current && current.state !== "failed") throw new Error(`Run is already active: ${task.task_id}`);
    this.assertOpen();
    const info: ActiveRunInfo = { runId: task.task_id, startedAt: new Date().toISOString(), state: "running" };
    this.active.set(task.task_id, info);
    const loop = new SingleAgentCtfLoop(this.root, this.config, this.services, this.createCtfLane, this.browserVerifierFactory);
    const controller = new AbortController();
    const runPromise = loop.run({
      runId: task.task_id,
      task,
      mode,
      maxTurns,
      signal: controller.signal,
      onLaneReady: async (lane) => {
        this.activeLanes.set(task.task_id, lane);
        if (this.pauseRequests.has(task.task_id)) {
          await this.ensurePaused(task.task_id, "Paused by user");
          await lane.abort("Paused by user");
        }
      },
    }).then(() => {
      this.active.delete(task.task_id);
    }).catch((error: unknown) => {
      if (controller.signal.aborted && error instanceof Error && error.message === "Run aborted") {
        this.active.delete(task.task_id);
        return;
      }
      this.active.set(task.task_id, { ...info, state: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }).finally(() => {
      this.activeLanes.delete(task.task_id);
      this.pauseRequests.delete(task.task_id);
      if (this.solveTasks.get(task.task_id)?.promise === runPromise) this.solveTasks.delete(task.task_id);
    });
    this.solveTasks.set(task.task_id, { controller, promise: runPromise });
    void runPromise.catch(() => undefined);
    return info;
  }

  private async ensureRunCreated(runId: string, task: TaskContract): Promise<void> {
    try {
      await access(join(this.services.runsRoot, runId, "task.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.services.control.createRun(runId, task);
    }
  }

  public async createConversation(input: { runId: string; title: string; workspacePath?: string; verificationCommand?: string }): Promise<RunSnapshot> {
    this.assertOpen();
    assertRunId(input.runId);
    await this.assertRunDoesNotExist(input.runId);
    return await this.services.control.createRun(input.runId, codingConversationTask(input.runId, input.title, input.workspacePath ?? this.root, input.verificationCommand));
  }

  public async deleteConversation(runId: string): Promise<void> {
    assertRunId(runId);
    if (this.active.has(runId) || this.activeLanes.has(runId)) throw new Error("运行中的对话不能删除，请先暂停");
    const snapshot = await this.services.control.snapshot(runId);
    if (runKind(snapshot.task) !== "chat") throw new Error("只能删除普通对话，Fixture Run 请保留用于复盘");
    await rm(join(this.services.runsRoot, runId), { recursive: true, force: false });
    this.runListCache.delete(runId);
    this.runDetailCache.delete(runId);
  }

  public async createFixtureConversation(input: { runId: string; fixtureId: string; objective: string }): Promise<RunSnapshot> {
    this.assertOpen();
    assertRunId(input.runId);
    await this.assertRunDoesNotExist(input.runId);
    const task = fixtureTask(input.runId, input.fixtureId, this.root, this.config);
    task.objective = input.objective.trim() || task.objective;
    await this.services.control.createRun(input.runId, task);
    const fixture = await this.services.sandbox.build(task);
    await this.services.fixtureControl.assertResetAllowed(input.runId);
    const generation = await this.services.sandbox.reset(fixture);
    await this.services.fixtureControl.reset(input.runId, generation);
    await new RunCoordinator(this.services.control, this.services.verifier).setDomainPhase(input.runId, "RECON");
    return await this.services.control.snapshot(input.runId);
  }

  private async assertRunDoesNotExist(runId: string): Promise<void> {
    try {
      await access(join(this.services.runsRoot, runId, "task.json"));
      throw new Error(`Run already exists: ${runId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  public async chat(
    runId: string,
    prompt: string,
    emit: (event: ChatStreamEvent) => void,
    profile?: ModelProfileConfig,
    capabilities?: { enabledTools?: string[]; enabledSkills?: string[]; enabledMcpServers?: string[] },
    workspacePath?: string,
    contextCompactionThreshold?: number,
  ): Promise<void> {
    this.assertOpen();
    const task = this.runChat(runId, prompt, emit, profile, capabilities, workspacePath, contextCompactionThreshold);
    this.chatTasks.add(task);
    try {
      await task;
    } finally {
      this.chatTasks.delete(task);
    }
  }

  private async runChat(
    runId: string,
    prompt: string,
    emit: (event: ChatStreamEvent) => void,
    profile?: ModelProfileConfig,
    capabilities?: { enabledTools?: string[]; enabledSkills?: string[]; enabledMcpServers?: string[] },
    workspacePath?: string,
    contextCompactionThreshold?: number,
  ): Promise<void> {
    assertRunId(runId);
    const text = prompt.trim();
    if (!text) throw new Error("Prompt is required");
    const active = this.active.get(runId);
    if (active) {
      const solveTask = this.solveTasks.get(runId);
      const pausedSnapshot = solveTask ? await this.services.control.snapshot(runId) : undefined;
      if (solveTask && pausedSnapshot?.status === "PAUSED") await solveTask.promise.catch(() => undefined);
      if (this.active.has(runId)) throw new Error(`Run is already active: ${runId}`);
    }
    const snapshot = await this.services.control.snapshot(runId);
    this.assertOpen();
    if (["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"].includes(snapshot.status)) {
      throw new Error(`Run is terminal (${snapshot.status}); start a new conversation`);
    }
    if (snapshot.status === "PAUSED") await this.services.control.dispatch(runId, { type: "resume" });
    const info: ActiveRunInfo = { runId, startedAt: new Date().toISOString(), state: "running" };
    this.active.set(runId, info);
    this.streamEmitters.set(runId, emit);
    emit({ type: "started", runId });
    let runtime: ProofBladeToolRuntime | undefined;
    let lane: AgentLanePort | undefined;
    const runConfig = profile ? { ...this.config, modelProfiles: { ...this.config.modelProfiles, executor: profile } } : this.config;
    try {
      if (snapshot.task.mode === "ctf_solve") {
        let ctfOutcome: AgentOutcome | undefined;
        const loop = new SingleAgentCtfLoop(this.root, runConfig, this.services, this.createCtfLane, this.browserVerifierFactory);
        const result = await loop.run({
          runId,
          task: snapshot.task,
          mode: "assist",
          maxTurns: 1,
          userPrompt: text,
          onTurn: (outcome) => { ctfOutcome = outcome; },
          onEvent: (event) => emitAgentEvent(event, emit),
          onLaneReady: async (activeLane) => {
            this.activeLanes.set(runId, activeLane);
            if (this.pauseRequests.has(runId)) {
              await this.ensurePaused(runId, "Paused by user");
              await activeLane.abort("Paused by user");
            }
          },
        });
        if (this.pauseRequests.has(runId)) {
          emit({ type: "paused", runId });
          return;
        }
        emit({
          type: "done",
          text: ctfOutcome?.text ?? `CTF turn finished with ${result.status}.`,
          stopReason: ctfOutcome?.stopReason ?? result.status.toLowerCase(),
          usage: normalizeUsage(ctfOutcome?.usage) ?? emptyUsage(),
          claimVerification: ctfOutcome?.claimVerification,
        });
        return;
      }
      if (runKind(snapshot.task) === "chat") {
        const projectRoot = codingWorkspace(snapshot.task, workspacePath, this.root);
        lane = await this.createCodingLane({
          projectRoot,
          installRoot: this.root,
          runId,
          runDir: join(this.services.runsRoot, runId),
          controlStore: this.services.control,
          artifactStore: this.services.artifacts,
          journal: this.services.journal,
          claimVerifier: new CodingClaimVerifier(runId, this.services.control, this.services.artifacts, this.services.journal, this.services.verifierJournal, this.services.verifier),
          config: runConfig,
          ...(this.services.sessionRuntimeBrokers ? { sessionRuntimeBrokers: this.services.sessionRuntimeBrokers } : {}),
          ...(this.services.sessionRuntimeRequired === undefined ? {} : { sessionRuntimeRequired: this.services.sessionRuntimeRequired }),
          ...(this.services.browserRuntimeRequired === undefined ? {} : { browserRuntimeRequired: this.services.browserRuntimeRequired }),
          capabilities,
          contextCompactionThreshold,
          onEvent: (event: AgentHarnessEvent) => emitAgentEvent(event, emit),
        });
      } else {
        this.assertOpen();
        const recovery = await new RunRecoveryService(this.services.control, this.services.journal, this.services.sandbox, this.services.fixtureControl, undefined, this.services.verificationRecovery, this.services.verificationRecoveryAdapters, this.services.externalResources, withSessionResourceAdapters(withBrowserResourceAdapter(this.services.externalResourceAdapters, this.browserVerifierFactory), this.services.sessionRuntimeBrokers ?? [])).recover(runId);
        runtime = new ProofBladeToolRuntime(runId, recovery.fixture, this.services.runsRoot, this.services.control, this.services.artifacts, this.services.journal, this.root);
        lane = await PiCodingLane.create({
          projectRoot: recovery.fixture.path,
          installRoot: this.root,
          runId,
          runDir: join(this.services.runsRoot, runId),
          controlStore: this.services.control,
          artifactStore: this.services.artifacts,
          journal: this.services.journal,
          claimVerifier: new CodingClaimVerifier(runId, this.services.control, this.services.artifacts, this.services.journal, this.services.verifierJournal, this.services.verifier),
          config: runConfig,
          browserVerifierFactory: this.browserVerifierFactory,
          ...(this.services.sessionRuntimeBrokers ? { sessionRuntimeBrokers: this.services.sessionRuntimeBrokers } : {}),
          ...(this.services.sessionRuntimeRequired === undefined ? {} : { sessionRuntimeRequired: this.services.sessionRuntimeRequired }),
          ...(this.services.browserRuntimeRequired === undefined ? {} : { browserRuntimeRequired: this.services.browserRuntimeRequired }),
          deferClaimAcceptance: true,
          sessionId: `${runId}-coding`,
          sessionHandoffs: recovery.sessionHandoffs,
          onEvent: (event: AgentHarnessEvent) => emitAgentEvent(event, emit),
        });
      }
      this.assertOpen();
      this.activeLanes.set(runId, lane);
      if (this.pauseRequests.has(runId)) {
        await this.ensurePaused(runId, "Paused by user");
        emit({ type: "paused", runId });
        return;
      }
      let outcome = await lane.prompt(text);
      if (this.pauseRequests.has(runId)) {
        await this.ensurePaused(runId, "Paused by user");
        emit({ type: "paused", runId });
        return;
      }
      const recoverableTermination = isRecoverableTermination(outcome.termination);
      if (!recoverableTermination && (outcome.errorMessage || outcome.stopReason === "error")) {
        emit({ type: "error", error: outcome.errorMessage || "模型请求失败" });
        return;
      }
      emit({ type: "done", text: outcome.text, stopReason: recoverableTermination ? "stop" : outcome.stopReason, usage: normalizeUsage(outcome.usage) ?? emptyUsage(), claimVerification: outcome.claimVerification });
    } catch (error) {
      if (this.pauseRequests.has(runId)) {
        await this.ensurePaused(runId, "Paused by user");
        emit({ type: "paused", runId });
      } else {
        emit({ type: "error", error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      await lane?.close().catch(() => undefined);
      this.activeLanes.delete(runId);
      this.pauseRequests.delete(runId);
      this.streamEmitters.delete(runId);
      this.active.delete(runId);
    }
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("GUI is shutting down");
  }

  public async pause(runId: string, reason = "Paused by user"): Promise<ActiveRunInfo> {
    assertRunId(runId);
    const current = this.active.get(runId);
    if (!current || current.state === "failed") throw new Error(`Run is not active: ${runId}`);
    if (current.state === "paused") return current;
    const stopping: ActiveRunInfo = { ...current, state: "stopping" };
    this.active.set(runId, stopping);
    this.pauseRequests.add(runId);
    this.streamEmitters.get(runId)?.({ type: "stopping", runId });
    await this.ensurePaused(runId, reason);
    const paused: ActiveRunInfo = { ...current, state: "paused" };
    this.active.set(runId, paused);
    const solveTask = this.solveTasks.get(runId);
    if (solveTask) solveTask.controller.abort(reason);
    else await this.activeLanes.get(runId)?.abort(reason);
    return paused;
  }

  private async ensurePaused(runId: string, reason: string): Promise<void> {
    const snapshot = await this.services.control.snapshot(runId);
    if (snapshot.status === "PAUSED" || ["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"].includes(snapshot.status)) return;
    await this.services.control.dispatch(runId, { type: "pause", reason, lane: "main" });
  }

  private async loadSessions(runId: string): Promise<PiSessionDebug[]> {
    const runDir = join(this.services.runsRoot, runId);
    const env = new NodeExecutionEnv({ cwd: runDir });
    try {
      const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(runDir, "pi-sessions") });
      const metadata = await repo.list();
      const events = await this.services.control.events(runId);
      const snapshot = await this.services.control.snapshot(runId);
      return await Promise.all(metadata.map(async (item): Promise<PiSessionDebug> => {
        const session = await repo.open(item);
        const [entries, branch, stats] = await Promise.all([session.getEntries(), session.getBranch(), session.getSessionStats()]);
        const assistantTurns = assistantTurnsFromEntries(entries);
        return {
          id: item.id,
          createdAt: item.createdAt,
          path: item.path,
          metadata: item.metadata,
          stats,
          usage: usageFromMessages(conversationMessagesFromEntries(branch, events)),
          entries,
          branchEntryIds: branch.map((entry) => entry.id),
          assistantTurns,
          messages: conversationMessagesFromEntries(branch, events),
          toolCalls: correlateToolCalls(entries, events, snapshot, assistantTurns),
        };
      }));
    } finally {
      await env.cleanup();
    }
  }

  private async loadStableSessions(
    runId: string,
    sessionsRoot: string,
    initialVersion: string,
  ): Promise<{ sessions: PiSessionDebug[]; version: string; stable: boolean }> {
    let version = initialVersion;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sessions = await this.loadSessions(runId);
      const nextVersion = await filesystemVersion(sessionsRoot);
      if (version === nextVersion) return { sessions, version, stable: true };
      version = nextVersion;
      if (attempt === 1) return { sessions, version, stable: false };
    }
    throw new Error("Unreachable session load state");
  }
}

async function hasSingleTrailingAuthorityMigration(eventsPath: string, eventsStat: Stats, snapshot: RunSnapshot): Promise<boolean> {
  const tailBytes = Math.min(eventsStat.size, 64 * 1024);
  if (tailBytes <= 0) return false;
  const handle = await open(eventsPath, "r");
  try {
    const tail = Buffer.allocUnsafe(tailBytes);
    await handle.read(tail, 0, tailBytes, eventsStat.size - tailBytes);
    const line = tail.toString("utf8").trimEnd().split(/\r?\n/).at(-1);
    if (!line) return false;
    const event = JSON.parse(line) as { schemaVersion?: unknown; streamId?: unknown; runId?: unknown; seq?: unknown; type?: unknown; payload?: Record<string, unknown> };
    const legacySnapshot = snapshot as RunSnapshot & { authorityHash?: string; taskHash?: string };
    const migratedTaskHash = event.payload?.taskHash;
    return (legacySnapshot.authorityHash === undefined || legacySnapshot.authorityHash === "LEGACY-UNTRUSTED")
      && event.schemaVersion === 1
      && event.streamId === snapshot.runId
      && event.runId === snapshot.runId
      && event.type === "run_authority_migrated"
      && event.seq === snapshot.lastSeq + 1
      && event.payload?.migratedFrom === "legacy-v1"
      && typeof migratedTaskHash === "string"
      && /^[a-f0-9]{64}$/i.test(migratedTaskHash)
      && (legacySnapshot.taskHash === undefined || migratedTaskHash === legacySnapshot.taskHash)
      && typeof event.payload.authorityHash === "string"
      && /^[a-f0-9]{64}$/i.test(event.payload.authorityHash);
  } finally {
    await handle.close();
  }
}

async function filesystemVersion(root: string): Promise<string> {
  const entries: string[] = [];
  async function visit(directory: string): Promise<void> {
    let children: Dirent<string>[];
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await Promise.all(children.map(async (child) => {
      const path = join(directory, child.name);
      if (child.isDirectory()) {
        await visit(path);
        return;
      }
      try {
        const metadata = await stat(path, { bigint: true });
        entries.push(`${relative(root, path)}\0${metadata.size}\0${metadata.mtimeNs}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        entries.push(`${relative(root, path)}\0missing`);
      }
    }));
  }
  await visit(root);
  entries.sort();
  return entries.join("\n");
}

function runDetailVersionKey(runId: string, eventsMtimeMs: number, eventsSize: number, sessionsVersion: string): string {
  return runId + "\0" + eventsMtimeMs + "\0" + eventsSize + "\0" + sessionsVersion;
}

export function boundedJsonByteSize(value: unknown, limit: number): number {
  let bytes = 0;
  const stack = new WeakSet<object>();
  const add = (amount: number): void => {
    bytes = Math.min(limit + 1, bytes + amount);
  };
  const visit = (current: unknown, arrayItem = false): void => {
    if (bytes > limit) return;
    if (current === null) {
      add(4);
      return;
    }
    switch (typeof current) {
      case "string":
        if (Buffer.byteLength(current, "utf8") > limit) {
          add(limit + 1);
        } else {
          add(Buffer.byteLength(JSON.stringify(current), "utf8"));
        }
        return;
      case "number":
      case "boolean":
        add(Buffer.byteLength(JSON.stringify(current), "utf8"));
        return;
      case "undefined":
      case "function":
      case "symbol":
        if (arrayItem) add(4);
        return;
      case "bigint":
        add(limit + 1);
        return;
      default:
        break;
    }
    if (typeof current !== "object") return;
    if (stack.has(current)) {
      add(limit + 1);
      return;
    }
    stack.add(current);
    if (Array.isArray(current)) {
      add(1);
      current.forEach((item, index) => {
        if (index > 0) add(1);
        visit(item, true);
      });
      add(1);
    } else {
      const keys = Object.keys(current);
      add(1);
      let included = 0;
      for (const key of keys) {
        const item = (current as Record<string, unknown>)[key];
        if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
        if (included > 0) add(1);
        add(Buffer.byteLength(JSON.stringify(key), "utf8") + 1);
        visit(item);
        included += 1;
      }
      add(1);
    }
    stack.delete(current);
  };
  visit(value);
  return bytes;
}

export function runKind(task: Pick<TaskContract, "mode">): RunKind {
  return task.mode === "coding_assistant" ? "chat" : "fixture";
}

export function codingConversationTask(runId: string, title: string, root: string, verificationCommand?: string): TaskContract {
  const normalizedVerificationCommand = verificationCommand?.trim();
  if (normalizedVerificationCommand && normalizedVerificationCommand.length > 16_000) throw new Error("Verification command is too long (maximum 16,000 characters)");
  return {
    schema_version: 1,
    task_id: runId,
    mode: "coding_assistant",
    target_kind: "unknown",
    target: root,
    objective: title.trim() || "新对话",
    inputs: [],
    success_criteria: [],
    verification: {
      kind: "reproduction",
      required_reproductions: normalizedVerificationCommand ? 1 : 0,
      ...(normalizedVerificationCommand ? { command: normalizedVerificationCommand } : {}),
    },
    scope: {
      allowed_hosts: ["*"],
      allowed_ports: [],
      external_network: true,
      allowed_workspace: root,
    },
    pause_policy: [],
    constraints: {
      deadline_ms: 86_400_000,
      max_cost_usd: 100,
      max_tool_calls: 1_000,
      max_submissions: 0,
    },
  };
}

export function assistantTurnsFromEntries(entries: readonly SessionEntryLike[]): AssistantTurnDebug[] {
  const turns: AssistantTurnDebug[] = [];
  for (const entry of entries) {
    const message = asMessage(entry.message);
    if (entry.type !== "message" || message?.role !== "assistant") continue;
    const content = asContent(message.content);
    const ordinal = turns.length + 1;
    turns.push({
      id: `${entry.id ?? ordinal}`,
      entryId: `${entry.id ?? ordinal}`,
      timestamp: entry.timestamp ?? "",
      ordinal,
      provider: message.provider,
      model: message.model,
      stopReason: message.stopReason,
      text: content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n"),
      toolCallIds: content.filter((item) => item.type === "toolCall" && item.id).map((item) => item.id!),
      raw: entry,
    });
  }
  return turns;
}

export function conversationMessagesFromEntries(entries: readonly SessionEntryLike[], events: readonly HarnessEvent[] = []): ChatMessageDebug[] {
  const messages: ChatMessageDebug[] = [];
  for (const entry of entries) {
    const message = asMessage(entry.message);
    if (entry.type !== "message" || (message?.role !== "user" && message?.role !== "assistant")) continue;
    const content = asContent(message.content);
    const text = content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
    if (message.role === "user" && text.startsWith(AUTOMATIC_CONTEXT_RECOVERY_MARKER)) continue;
    messages.push({
      id: entry.id ?? `${messages.length + 1}`,
      entryId: entry.id ?? `${messages.length + 1}`,
      role: message.role,
      timestamp: entry.timestamp ?? "",
      text,
      thinking: content.filter((item) => item.type === "thinking").map((item) => item.thinking ?? "").join("\n"),
      toolCallIds: content.filter((item) => item.type === "toolCall" && item.id).map((item) => item.id!),
      provider: message.provider,
      model: message.model,
      stopReason: message.stopReason,
      error: message.errorMessage,
      usage: normalizeUsage(message.usage),
      raw: entry,
    });
  }
  const assistantEvents = events.filter((event) => event.type === "assistant_message");
  for (const event of [...assistantEvents].reverse()) {
    const text = typeof event.payload?.text === "string" ? event.payload.text : undefined;
    const providerStopReason = event.payload?.stopReason;
    const isVisibleInterruptedTurn = providerStopReason === "error" || providerStopReason === "aborted" || providerStopReason === "toolUse";
    if ((isRecoverableTermination(event.payload?.termination) || isVisibleInterruptedTurn) && text) {
      const piEntryId = typeof event.payload?.piEntryId === "string" ? event.payload.piEntryId : undefined;
      const interrupted = piEntryId
        ? messages.find((item) => item.role === "assistant" && item.entryId === piEntryId && !item.text && (item.stopReason === "error" || item.stopReason === "aborted" || item.stopReason === "toolUse"))
        : undefined;
      if (interrupted) {
        interrupted.text = text;
        interrupted.stopReason = typeof event.payload?.stopReason === "string" ? event.payload.stopReason : "stop";
        interrupted.error = undefined;
      }
    }
    if (!isRecord(event.payload?.claimVerification)) continue;
    const claimVerification = event.payload?.claimVerification as unknown as ChatMessageDebug["claimVerification"];
    const piEntryId = typeof event.payload?.piEntryId === "string" ? event.payload.piEntryId : undefined;
    const message = (piEntryId ? messages.find((item) => item.role === "assistant" && item.entryId === piEntryId) : undefined)
      ?? [...messages].reverse().find((item) => item.role === "assistant" && item.text === text && item.claimVerification === undefined);
    if (message) {
      message.claimVerification = claimVerification;
      if (claimVerification?.status === "unverified") {
        message.text = rewriteUnverifiedClaimText(message.text, claimVerification.reason);
      }
    }
  }
  let latestUserPrompt = "";
  for (const message of messages) {
    if (message.role === "user") {
      latestUserPrompt = message.text;
      continue;
    }
    if (message.claimVerification || message.stopReason === "toolUse" || !message.text) continue;
    if (requiresClaimVerification(latestUserPrompt, message.text)) {
      message.claimVerification = {
        required: true,
        status: "unverified",
        reason: "历史消息没有候选复现记录。",
      };
      message.text = rewriteUnverifiedClaimText(message.text, message.claimVerification.reason);
    }
  }
  return messages;
}

function isRecoverableTermination(value: unknown): value is NonNullable<AgentOutcome["termination"]> {
  return value === "repeated_tool_failure" || value === "no_progress" || value === "tool_failure_storm" || value === "experiment_budget";
}

export function correlateToolCalls(
  entries: readonly SessionEntryLike[],
  events: readonly HarnessEvent[],
  snapshot: RunSnapshot,
  turns = assistantTurnsFromEntries(entries),
): ToolCallDebug[] {
  const results = new Map<string, { message: MessageLike; entry: SessionEntryLike }>();
  for (const entry of entries) {
    const message = asMessage(entry.message);
    if (entry.type === "message" && message?.role === "toolResult" && message.toolCallId) results.set(message.toolCallId, { message, entry });
  }
  const callEvents = new Map(events.filter((event) => event.type === "tool_call_recorded").map((event) => [String(event.payload?.toolCallId), event]));
  const resultEvents = new Map(events.filter((event) => event.type === "tool_result_recorded").map((event) => [String(event.payload?.toolCallId), event]));
  const output: ToolCallDebug[] = [];
  for (const turn of turns) {
    const assistantEntry = entries.find((entry) => entry.id === turn.entryId);
    const message = asMessage(assistantEntry?.message);
    const calls = asContent(message?.content).filter((item) => item.type === "toolCall");
    calls.forEach((call, callIndex) => {
      const callId = call.id ?? `${turn.entryId}:${callIndex}`;
      const matched = results.get(callId);
      const referenced = collectReferencedIds([call.arguments, matched?.message.details], snapshot);
      const artifacts = Object.values(snapshot.artifacts).filter((item) => referenced.has(item.id));
      const effects = Object.values(snapshot.effects).filter((item) => referenced.has(item.id) || (item.artifactId && referenced.has(item.artifactId)));
      const effectIds = new Set(effects.map((item) => item.id));
      const artifactIds = new Set(artifacts.map((item) => item.id));
      const evidence = Object.values(snapshot.evidence).filter((item) =>
        referenced.has(item.id)
        || Boolean(item.source.artifactId && artifactIds.has(item.source.artifactId))
        || Boolean(item.source.effectId && effectIds.has(item.source.effectId)),
      );
      output.push({
        id: callId,
        name: call.name ?? matched?.message.toolName ?? "unknown",
        timestamp: turn.timestamp,
        status: matched ? (matched.message.isError ? "error" : "success") : "pending",
        assistantEntryId: turn.entryId,
        assistantOrdinal: turn.ordinal,
        callIndex,
        arguments: call.arguments ?? {},
        call,
        result: matched?.message,
        completedAt: matched?.entry.timestamp,
        presentation: toolPresentation(call.name ?? matched?.message.toolName ?? "unknown", call.arguments ?? {}, matched?.message),
        assistantEntry,
        resultEntry: matched?.entry,
        telemetry: { call: callEvents.get(callId), result: resultEvents.get(callId) },
        links: { artifacts, evidence, effects },
      });
    });
  }
  return output;
}

export function codingWorkspace(task: Pick<TaskContract, "mode" | "target" | "scope">, preferred: string | undefined, fallback: string): string {
  if (task.mode !== "coding_assistant") return fallback;
  return preferred || task.scope.allowed_workspace || task.target || fallback;
}

function collectReferencedIds(values: unknown[], snapshot: RunSnapshot): Set<string> {
  const known = new Set([
    ...Object.keys(snapshot.artifacts),
    ...Object.keys(snapshot.evidence),
    ...Object.keys(snapshot.effects),
  ]);
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (known.has(value)) found.add(value);
      for (const id of known) if (value.includes(id)) found.add(id);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(visit);
  };
  values.forEach(visit);
  return found;
}

function asMessage(value: unknown): MessageLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as MessageLike : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asContent(value: unknown): ContentLike[] {
  return Array.isArray(value) ? value.filter((item): item is ContentLike => Boolean(item && typeof item === "object")) : [];
}

function contextRuntimeInfo(events: readonly HarnessEvent[]): ContextRuntimeInfo | undefined {
  const usageEvent = [...events].reverse().find((event) => event.type === "model_usage");
  if (!usageEvent) return undefined;
  const usage = usageEvent.payload?.usage as { input?: unknown; cacheRead?: unknown } | undefined;
  const usageInput = Number(usage?.input ?? 0);
  const cacheReported = typeof usage?.cacheRead === "number";
  const cacheRead = cacheReported ? Number(usage?.cacheRead) : 0;
  const epochEvent = [...events].reverse().find((event) => event.type === "request_epoch_started");
  const contextWindow = Number((epochEvent?.payload?.epoch as { contextWindow?: unknown } | undefined)?.contextWindow ?? 0);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  const usedTokens = Math.max(0, usageInput) + Math.max(0, cacheRead);
  const estimatedTokens = Number(usageEvent.payload?.contextEstimatedTokens);
  const epochId = typeof epochEvent?.payload?.epochId === "string"
    ? epochEvent?.payload?.epochId
    : typeof (epochEvent?.payload?.epoch as { id?: unknown } | undefined)?.id === "string"
      ? (epochEvent?.payload?.epoch as { id: string }).id
      : undefined;
  const epoch = epochEvent?.payload?.epoch as { requestContextHash?: unknown; contextManifestHash?: unknown; manifestSummary?: unknown } | undefined;
  const manifestSummary = isRecord(epoch?.manifestSummary) ? epoch.manifestSummary : undefined;
  const layerTokens = numericRecord(manifestSummary?.layerTokens);
  const blockHashes = stringRecord(manifestSummary?.blockHashes);
  const manifestBudget = isRecord(manifestSummary?.budget) ? manifestSummary.budget : undefined;
  const manifestMaintenance = isRecord(manifestSummary?.maintenance) ? manifestSummary.maintenance : undefined;
  const contextEvent = [...events].reverse().find((event) => event.type === "request_epoch_context" && (!epochId || event.payload?.requestEpochId === epochId || event.payload?.requestEpochId === undefined));
  const fields = contextEvent?.payload?.fields as { requestBodyHash?: unknown; stablePrefixHash?: unknown; dynamicSuffixHash?: unknown } | undefined;
  const lastCompaction = [...events].reverse().find((event) => event.type === "compaction_recorded");
  const lastConsolidation = [...events].reverse().find((event) => event.type === "consolidate_finished" || event.type === "consolidate_failed");
  return {
    contextWindow,
    usedTokens,
    remainingTokens: Math.max(0, contextWindow - usedTokens),
    utilization: usedTokens / contextWindow,
    ...(Number.isFinite(estimatedTokens) && estimatedTokens > 0 ? { estimatedTokens } : {}),
    cacheReported,
    ...(cacheReported ? { lastCacheRead: Math.max(0, cacheRead) } : {}),
    ...(typeof fields?.requestBodyHash === "string" ? { requestBodyHash: fields.requestBodyHash } : {}),
    ...(typeof fields?.stablePrefixHash === "string" ? { stablePrefixHash: fields.stablePrefixHash } : {}),
    ...(typeof fields?.dynamicSuffixHash === "string" ? { dynamicSuffixHash: fields.dynamicSuffixHash } : {}),
    ...(epochId ? { requestEpochId: epochId } : {}),
    ...(typeof epoch?.requestContextHash === "string" ? { requestContextHash: epoch.requestContextHash } : {}),
    ...(typeof epoch?.contextManifestHash === "string" ? { contextManifestHash: epoch.contextManifestHash } : {}),
    ...(typeof manifestSummary?.hash === "string" ? { contextManifestHash: manifestSummary.hash } : {}),
    ...(typeof manifestSummary?.firstChangedBlock === "string" ? { firstChangedBlock: manifestSummary.firstChangedBlock } : {}),
    ...(typeof manifestSummary?.compressionTarget === "string" ? { compressionTarget: manifestSummary.compressionTarget } : {}),
    ...(typeof manifestSummary?.droppedCount === "number" ? { droppedCount: manifestSummary.droppedCount } : {}),
    ...(layerTokens ? { layerTokens } : {}),
    ...(blockHashes ? { blockHashes } : {}),
    ...(typeof manifestBudget?.availableInput === "number" ? { availableInput: manifestBudget.availableInput } : {}),
    ...(typeof manifestBudget?.estimatedInput === "number" ? { estimatedInput: manifestBudget.estimatedInput } : {}),
    ...(typeof manifestBudget?.overBudget === "boolean" ? { overBudget: manifestBudget.overBudget } : {}),
    ...(typeof manifestMaintenance?.stage === "string" ? { maintenanceStage: manifestMaintenance.stage } : {}),
    ...(typeof manifestMaintenance?.targetRatio === "number" ? { targetRatio: manifestMaintenance.targetRatio } : {}),
    ...(typeof manifestMaintenance?.hardRatio === "number" ? { hardRatio: manifestMaintenance.hardRatio } : {}),
    ...(typeof manifestMaintenance?.nextAction === "string" ? { nextMaintenanceAction: manifestMaintenance.nextAction } : {}),
    ...(lastCompaction ? { maintenanceStage: "compact", nextMaintenanceAction: "none" } : lastConsolidation?.type === "consolidate_failed" ? { maintenanceStage: "notice", nextMaintenanceAction: "consolidate" } : {}),
    ...(lastConsolidation ? { lastConsolidationAt: lastConsolidation.ts } : {}),
    lastUpdatedAt: usageEvent.ts,
  };
}

function numericRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "number" && Number.isFinite(item))) as Record<string, number>;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string")) as Record<string, string>;
}

function emitAgentEvent(event: AgentHarnessEvent, emit: (event: ChatStreamEvent) => void): void {
  if (event.type === "before_provider_payload") {
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    const messageChars = JSON.stringify(messages).length;
    const toolSchemaChars = JSON.stringify(tools).length;
    const systemPromptChars = messages.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).role === "system").map((item) => JSON.stringify(item)).join("").length;
    emit({ type: "context_snapshot", messages: messages.length, tools: tools.length, systemPromptChars, messageChars, toolSchemaChars, estimatedVisibleTokens: Math.ceil((messageChars + toolSchemaChars) / 4) });
    return;
  }
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") emit({ type: "text_delta", delta: update.delta });
    if (update.type === "thinking_delta") emit({ type: "thinking_delta", delta: update.delta });
    return;
  }
  if (event.type === "tool_execution_start") {
    emit({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
    return;
  }
  if (event.type === "tool_execution_end") {
    emit({ type: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError });
  }
}

function normalizeUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const number = (key: string): number => typeof usage[key] === "number" && Number.isFinite(usage[key]) ? usage[key] as number : 0;
  return {
    input: number("input"),
    output: number("output"),
    cacheRead: number("cacheRead"),
    cacheWrite: number("cacheWrite"),
    reasoning: number("reasoning"),
    totalTokens: number("totalTokens") || number("input") + number("output") + number("cacheRead") + number("cacheWrite"),
  };
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 };
}

function usageFromMessages(messages: ChatMessageDebug[]): TokenUsage & { requests: number } {
  const total: TokenUsage & { requests: number } = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, requests: 0 };
  for (const message of messages) {
    if (!message.usage) continue;
    total.requests += 1;
    total.input += message.usage.input;
    total.output += message.usage.output;
    total.cacheRead += message.usage.cacheRead;
    total.cacheWrite += message.usage.cacheWrite;
    total.reasoning += message.usage.reasoning;
    total.totalTokens += message.usage.totalTokens;
  }
  return total;
}

export { assertRunId };
