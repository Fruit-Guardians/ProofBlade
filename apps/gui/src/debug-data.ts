import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  CheckpointService,
  RunRecoveryService,
  RunTelemetry,
  SingleAgentCtfLoop,
  createServices,
  fixtureTask,
  listFixtureProfiles,
  type AppServices,
  type HarnessEvent,
  type ProofBladeConfig,
  type RunSnapshot,
} from "@proofblade/materials";
import type {
  ActiveRunInfo,
  AssistantTurnDebug,
  BootstrapData,
  PiSessionDebug,
  RunDetail,
  RunListItem,
  ToolCallDebug,
} from "./shared.js";

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
  arguments?: unknown;
}

const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

export class DebugDataService {
  private readonly services: AppServices;
  private readonly active = new Map<string, ActiveRunInfo>();

  public constructor(
    private readonly root: string,
    private readonly config: ProofBladeConfig,
    private readonly configPath: string,
  ) {
    this.services = createServices(root, config);
  }

  public bootstrap(): BootstrapData {
    const profile = this.config.modelProfiles.executor;
    return {
      projectName: "ProofBlade / 证锋",
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
      .filter((entry) => entry.isDirectory() && runIdPattern.test(entry.name))
      .map(async (entry): Promise<RunListItem | undefined> => {
        try {
          const [snapshot, eventsStat] = await Promise.all([
            this.services.control.snapshot(entry.name),
            stat(join(this.services.runsRoot, entry.name, "events.jsonl")),
          ]);
          const events = await this.services.control.events(entry.name);
          return {
            runId: snapshot.runId,
            objective: snapshot.task.objective,
            targetKind: snapshot.task.target_kind,
            status: snapshot.status,
            phase: snapshot.phase,
            generation: snapshot.generation,
            lastSeq: snapshot.lastSeq,
            updatedAt: eventsStat.mtime.toISOString(),
            counts: {
              tools: events.filter((event) => event.type === "tool_call_recorded").length,
              evidence: Object.keys(snapshot.evidence).length,
              artifacts: Object.keys(snapshot.artifacts).length,
              effects: Object.keys(snapshot.effects).length,
            },
            active: this.active.get(snapshot.runId),
          };
        } catch {
          return undefined;
        }
      }));
    return items.filter((item): item is RunListItem => Boolean(item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public async getRun(runId: string): Promise<RunDetail> {
    assertRunId(runId);
    const [snapshot, events, telemetry, sessions, eventsStat] = await Promise.all([
      this.services.control.snapshot(runId),
      this.services.control.events(runId),
      new RunTelemetry(this.services.control).report(runId),
      this.loadSessions(runId),
      stat(join(this.services.runsRoot, runId, "events.jsonl")),
    ]);
    return { snapshot, events, telemetry, sessions, active: this.active.get(runId), updatedAt: eventsStat.mtime.toISOString() };
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
    return await new RunRecoveryService(this.services.control, this.services.journal, this.services.sandbox).recover(runId);
  }

  public async startSolve(input: { runId: string; fixtureId: string; mode: "auto" | "assist"; maxTurns?: number }): Promise<ActiveRunInfo> {
    assertRunId(input.runId);
    if (this.active.get(input.runId)?.state === "running") throw new Error(`Run is already active: ${input.runId}`);
    const info: ActiveRunInfo = { runId: input.runId, startedAt: new Date().toISOString(), state: "running" };
    this.active.set(input.runId, info);
    const loop = new SingleAgentCtfLoop(this.root, this.config, this.services);
    void loop.run({
      runId: input.runId,
      task: fixtureTask(input.runId, input.fixtureId, this.root, this.config),
      mode: input.mode,
      maxTurns: input.maxTurns,
    }).then(() => {
      this.active.delete(input.runId);
    }).catch((error: unknown) => {
      this.active.set(input.runId, { ...info, state: "failed", error: error instanceof Error ? error.message : String(error) });
    });
    return info;
  }

  private async loadSessions(runId: string): Promise<PiSessionDebug[]> {
    const runDir = join(this.services.runsRoot, runId);
    const env = new NodeExecutionEnv({ cwd: runDir });
    try {
      const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(runDir, "pi-sessions") });
      const metadata = await repo.list({ cwd: runDir });
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
          entries,
          branchEntryIds: branch.map((entry) => entry.id),
          assistantTurns,
          toolCalls: correlateToolCalls(entries, events, snapshot, assistantTurns),
        };
      }));
    } finally {
      await env.cleanup();
    }
  }
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
        assistantEntry,
        resultEntry: matched?.entry,
        telemetry: { call: callEvents.get(callId), result: resultEvents.get(callId) },
        links: { artifacts, evidence, effects },
      });
    });
  }
  return output;
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

function asContent(value: unknown): ContentLike[] {
  return Array.isArray(value) ? value.filter((item): item is ContentLike => Boolean(item && typeof item === "object")) : [];
}

export function assertRunId(runId: string): void {
  if (!runIdPattern.test(runId)) throw new Error("Run ID must contain only letters, numbers, dots, underscores, and hyphens");
}
