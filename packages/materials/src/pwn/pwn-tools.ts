import type { DomainRecordInput, Lane } from "../domain/types.js";
import type { ContainerRef } from "../container/contracts.js";
import type { SessionRegistry } from "../container/session-registry.js";
import type { ControlStore } from "../control/control-store.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import { PwnSession } from "./pwn-session.js";
import { appendByte } from "./bytes.js";
import type { PwnReproducer, ExploitRecipe, ExploitStage, PwnReproduceOutcome } from "../verification/pwn-reproducer.js";
import type { PwnTrustedReproducer } from "../verification/pwn-reproduction-verifier.js";
import type { ExperimentGate } from "../competition/experiment-gate.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import { redactCtfCandidates } from "../domain/candidate.js";
import type { ExternalResourceRecord } from "../recovery/external-resource-registry.js";
import type { SessionRuntimeCreateBroker } from "../recovery/session-resource-adapter.js";
import type { SessionRuntimeCreateRequest } from "../recovery/session-runtime-wire.js";

/**
 * Model-facing bridge for pwn interaction.  The model tracks a durable session
 * id string; owner identity is fixed to a lane and never taken from the model.
 * Every recv/send returns a BOUNDED viewport (the full transcript stays in the
 * session/artifact layer), so a chatty tube cannot flood the context window.
 *
 * `reproduce` is deliberately the only path that can assert success: it opens a
 * FRESH session and runs the PwnReproducer's shell-probe + flag barriers, so the
 * model proposing a recipe is not the same as the model claiming a shell.
 */
export interface PwnOpenInput {
  kind: "local" | "remote";
  command: string[];
  endpoint?: string;
  cwd?: string;
  idleSilenceMs?: number;
  waitTimeoutMs?: number;
}

export type PwnReproduceTarget =
  | { kind: "local"; command: string[] }
  | { kind: "remote"; command: string[]; endpoint: string };

/** Immutable verifier inputs supplied by the task/runtime, never by the model. */
export interface PwnReproductionPolicy {
  target: PwnReproduceTarget;
  flagPath: string;
  flagPattern: string;
}

/** The task's target boundary, used to reject a model-supplied remote endpoint outside scope. */
export interface PwnScope {
  allowedHosts: string[];
  allowedPorts: number[];
}

export interface PwnViewport {
  sessionId: string;
  viewport: string;
  matched?: boolean;
  exited: boolean;
  truncated: boolean;
}

const VIEWPORT_MAX = 4_000;

export class PwnToolHandler {
  private readonly sessions = new Map<string, PwnSession>();
  private readonly exited = new Set<string>();
  private readonly closed = new Set<string>();

  public constructor(
    private readonly runId: string,
    private readonly registry: SessionRegistry,
    private readonly reproducer: PwnReproducer,
    private readonly refProvider: () => ContainerRef,
    private readonly ownerLane: Lane = "executor",
    /** Task scope; when set, a remote endpoint outside it is rejected at the app layer. */
    private readonly scope?: PwnScope,
    private readonly reproductionPolicy?: PwnReproductionPolicy,
    private readonly experimentGate?: ExperimentGate,
    private readonly artifactStore?: ArtifactStore,
    private readonly controlStore?: ControlStore,
    /** Trusted clean-process adapter; absent in unit/GUI paths, which remain untrusted. */
    private readonly trustedReproducer?: PwnTrustedReproducer,
    /** Optional durable broker for sessions that must outlive this process. */
    private readonly sessionBroker?: SessionRuntimeCreateBroker,
    /** Set when runtime.sessionBroker is configured but its token/host is unavailable. */
    private readonly sessionRuntimeRequired = false,
  ) {}

  /** Register a broker-reconnected session without emitting a new open event. */
  public adopt(session: PwnSession): void {
    if (session.record.runId !== this.runId) throw new Error(`Pwn session belongs to a different run: ${session.sessionId}`);
    if (session.record.ownerLane !== this.ownerLane) throw new Error(`Pwn session belongs to ${session.record.ownerLane}, not ${this.ownerLane}`);
    if (session.record.kind !== "pwn-local" && session.record.kind !== "pwn-remote") throw new Error(`Session ${session.sessionId} is not a Pwn session`);
    if (this.sessions.has(session.sessionId)) throw new Error(`Duplicate Pwn session: ${session.sessionId}`);
    this.sessions.set(session.sessionId, session);
    this.closed.delete(session.sessionId);
    this.exited.delete(session.sessionId);
  }

  public async open(input: PwnOpenInput): Promise<{ sessionId: string; kind: string; endpoint?: string }> {
    return await this.runExperiment(() => this.openInternal(input));
  }

  private async openInternal(input: PwnOpenInput): Promise<{ sessionId: string; kind: string; endpoint?: string }> {
    await this.experimentGate?.assertAllowed({ runId: this.runId, action: "pwn_open", input });
    let session: PwnSession;
    try {
      const ref = this.refProvider();
      if (input.kind === "remote") this.assertEndpointAllowed(input.endpoint);
      if (this.sessionRuntimeRequired && !this.sessionBroker) throw new Error("Session runtime broker is configured but unavailable");
      session = this.sessionBroker
        ? await this.openBrokerSession(input, ref)
        : input.kind === "remote"
          ? await PwnSession.openRemote(this.registry, { ref, ownerLane: this.ownerLane, command: input.command, endpoint: input.endpoint ?? "", ...opt(input) })
          : await PwnSession.openLocal(this.registry, { ref, ownerLane: this.ownerLane, command: input.command, ...opt(input) });
      this.sessions.set(session.sessionId, session);
      this.closed.delete(session.sessionId);
    } catch (error) {
      await this.experimentGate?.record({ runId: this.runId, action: "pwn_open", input, outcome: "failure", summary: String(error).slice(0, 1_000) }).catch(() => undefined);
      throw error;
    }
    await this.experimentGate?.record({ runId: this.runId, action: "pwn_open", input, outcome: "success", summary: "Pwn session opened." });
    return { sessionId: session.sessionId, kind: input.kind, ...(input.endpoint ? { endpoint: input.endpoint } : {}) };
  }

  private async openBrokerSession(input: PwnOpenInput, ref: ContainerRef, reproductionNonce?: string): Promise<PwnSession> {
    const requestIdentity = {
      runId: this.runId,
      generation: ref.generation,
      kind: input.kind,
      command: input.command,
      endpoint: input.endpoint ?? "",
      cwd: input.cwd ?? "",
      waitTimeoutMs: input.waitTimeoutMs ?? null,
      idleSilenceMs: input.idleSilenceMs ?? null,
      ...(reproductionNonce ? { reproductionNonce } : {}),
    };
    const request = {
      kind: "pwn-session" as const,
      runId: this.runId,
      generation: ref.generation,
      ownerLane: this.ownerLane,
      requestKey: sha256(canonicalJson(requestIdentity)),
      pwn: {
        mode: input.kind,
        command: input.command,
        ...(input.endpoint ? { endpoint: input.endpoint } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.waitTimeoutMs === undefined ? {} : { waitTimeoutMs: input.waitTimeoutMs }),
        ...(input.idleSilenceMs === undefined ? {} : { idleSilenceMs: input.idleSilenceMs }),
      },
      ...(this.reproductionPolicy ? { policyHash: sha256(canonicalJson(this.reproductionPolicy)) } : {}),
      ...(this.scope ? { scopeHash: sha256(canonicalJson(this.scope)) } : {}),
    };
    const idempotencyKey = sha256(canonicalJson(request));
    const created = await this.sessionBroker!.create(request, idempotencyKey);
    if (created.state === "UNKNOWN" || !created.sessionId || !created.externalId) throw new Error(created.summary ?? "Pwn session broker did not create a durable session");
    const resource = brokerResource(this.runId, ref.generation, this.ownerLane, created.sessionId, created.externalId, request);
    const binding = await this.sessionBroker!.createBinding(resource);
    if (binding.kind !== "pwn-session") throw new Error("Pwn session broker returned an HTTP binding");
    const existing = this.controlStore ? (await this.controlStore.snapshot(this.runId)).sessions[created.sessionId] : undefined;
    if (existing?.status === "OPEN") {
      return await PwnSession.adopt(this.registry, { ownerLane: this.ownerLane, sessionId: created.sessionId, handle: binding.handle, runtime: binding.runtime });
    }
    return await PwnSession.openExternal(this.registry, {
      ref,
      ownerLane: this.ownerLane,
      command: input.command,
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.waitTimeoutMs === undefined ? {} : { waitTimeoutMs: input.waitTimeoutMs }),
      ...(input.idleSilenceMs === undefined ? {} : { idleSilenceMs: input.idleSilenceMs }),
      sessionId: created.sessionId,
      externalId: created.externalId,
      handle: binding.handle,
      runtime: binding.runtime,
      requestKey: request.requestKey,
      ...(request.policyHash ? { policyHash: request.policyHash } : {}),
      ...(request.scopeHash ? { scopeHash: request.scopeHash } : {}),
      externalRelease: async (externalId, reason, signal) => await this.sessionBroker!.release(resource, reason, signal),
    });
  }

  public async send(sessionId: string, data: string | Uint8Array, line = false): Promise<PwnViewport> {
    return await this.runExperiment(() => this.sendInternal(sessionId, data, line));
  }

  private async sendInternal(sessionId: string, data: string | Uint8Array, line: boolean): Promise<PwnViewport> {
    const input = { data: typeof data === "string" ? data : Buffer.from(data).toString("base64"), line };
    await this.experimentGate?.assertAllowed({ runId: this.runId, action: "pwn_send", input });
    let result: Awaited<ReturnType<PwnSession["send"]>>;
    try {
      const session = this.require(sessionId);
      // Preserve exact bytes: for binary payloads append the newline as a byte so
      // sendLine's string path cannot corrupt 0x00/0xff via UTF-8 round-tripping.
      if (typeof data === "string") {
        result = line ? await session.sendLine(data) : await session.send(data);
      } else {
        const payload = line ? appendByte(data, 0x0a) : data;
        result = await session.send(payload);
      }
    } catch (error) {
      await this.experimentGate?.record({ runId: this.runId, action: "pwn_send", input, outcome: "failure", summary: String(error).slice(0, 1_000) }).catch(() => undefined);
      throw error;
    }
    const viewport = this.viewport(sessionId, result.data, result.exited, result.matched);
    await this.experimentGate?.record({ runId: this.runId, action: "pwn_send", input, outcome: result.exited ? "failure" : "success", summary: result.exited ? "Pwn session exited while sending payload." : "Pwn payload sent." });
    await this.recordTranscript(sessionId, "pwn_send", []);
    return viewport;
  }

  public async recv(sessionId: string, until: string, maxReads?: number): Promise<PwnViewport> {
    return await this.runExperiment(() => this.recvInternal(sessionId, until, maxReads));
  }

  private async recvInternal(sessionId: string, until: string, maxReads?: number): Promise<PwnViewport> {
    const input = { until, maxReads };
    await this.experimentGate?.assertAllowed({ runId: this.runId, action: "pwn_recv", input });
    let result: Awaited<ReturnType<PwnSession["recvUntil"]>>;
    try {
      const session = this.require(sessionId);
      result = await session.recvUntil(until, maxReads ? { maxReads } : {});
    } catch (error) {
      await this.experimentGate?.record({ runId: this.runId, action: "pwn_recv", input, outcome: "failure", summary: String(error).slice(0, 1_000) }).catch(() => undefined);
      throw error;
    }
    const viewport = this.viewport(sessionId, result.data, result.exited, result.matched);
    const succeeded = result.matched && !result.exited;
    await this.experimentGate?.record({ runId: this.runId, action: "pwn_recv", input, outcome: succeeded ? "success" : "failure", summary: succeeded ? "Pwn response matched the anchor." : "Pwn response timed out or the session exited before the anchor." });
    await this.recordTranscript(sessionId, "pwn_recv", [until]);
    return viewport;
  }

  public async signal(sessionId: string, signal: NodeJS.Signals): Promise<{ delivered: boolean }> {
    return await this.runExperiment(() => this.signalInternal(sessionId, signal));
  }

  private async signalInternal(sessionId: string, signal: NodeJS.Signals): Promise<{ delivered: boolean }> {
    const input = { signal };
    await this.experimentGate?.assertAllowed({ runId: this.runId, action: "pwn_signal", input });
    let delivered: boolean;
    try {
      this.require(sessionId);
      delivered = await this.registry.signal(this.ownerLane, sessionId, signal);
    } catch (error) {
      await this.experimentGate?.record({ runId: this.runId, action: "pwn_signal", input, outcome: "failure", summary: String(error).slice(0, 1_000) }).catch(() => undefined);
      throw error;
    }
    await this.experimentGate?.record({ runId: this.runId, action: "pwn_signal", input, outcome: delivered ? "success" : "failure", summary: delivered ? "Pwn signal delivered." : "Pwn signal was not delivered." });
    await this.recordTranscript(sessionId, "pwn_signal", []);
    return { delivered };
  }

  public async shellProbe(sessionId: string): Promise<{ ok: boolean; marker: string }> {
    return await this.runExperiment(() => this.shellProbeInternal(sessionId));
  }

  private async shellProbeInternal(sessionId: string): Promise<{ ok: boolean; marker: string }> {
    const input = { operation: "shell_probe" };
    await this.experimentGate?.assertAllowed({ runId: this.runId, action: "pwn_shell_probe", input });
    let result: { ok: boolean; marker: string };
    try {
      result = await this.require(sessionId).shellProbe();
    } catch (error) {
      await this.experimentGate?.record({ runId: this.runId, action: "pwn_shell_probe", input, outcome: "failure", summary: String(error).slice(0, 1_000) }).catch(() => undefined);
      throw error;
    }
    await this.experimentGate?.record({ runId: this.runId, action: "pwn_shell_probe", input, outcome: result.ok ? "success" : "failure", summary: result.ok ? "Pwn shell probe matched its marker." : "Pwn shell probe did not match its marker." });
    await this.recordTranscript(sessionId, "pwn_shell_probe", result.ok ? [result.marker] : []);
    return result;
  }

  public async close(sessionId: string): Promise<{ exitCode: number | null }> {
    if (this.closed.has(sessionId)) return { exitCode: null };
    const session = this.require(sessionId, true);
    const outcome = await this.registry.close(this.ownerLane, sessionId, "closed by model");
    void session;
    this.sessions.delete(sessionId);
    this.exited.delete(sessionId);
    this.closed.add(sessionId);
    return outcome;
  }

  public list(): Array<{ sessionId: string; kind: string }> {
    return [...this.sessions.values()]
      .filter((session) => !this.exited.has(session.sessionId))
      .map((session) => ({ sessionId: session.sessionId, kind: session.record.kind }));
  }

  private async runExperiment<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.experimentGate) return await operation();
    return await this.experimentGate.runExclusive(this.runId, operation);
  }

  /**
   * Open a FRESH session and run the barrier-gated reproduce; the ONLY success
  * path. The task/runtime, rather than the model, owns the clean target and
  * flag extraction contract.
  */
  public async reproduce(stages: ExploitStage[]): Promise<PwnReproduceOutcome> {
    return await this.runExperiment(() => this.reproduceInternal(stages));
  }

  private async reproduceInternal(stages: ExploitStage[]): Promise<PwnReproduceOutcome> {
    if (!this.reproductionPolicy) throw new Error("pwn reproduction is unavailable because this task has no immutable target and flag verifier configuration");
    const { target, flagPath, flagPattern } = this.reproductionPolicy;
    if (target.kind === "remote") this.assertEndpointAllowed(target.endpoint);
    const recipe: ExploitRecipe = { stages, flagPath, flagPattern };
    const input = { stages };
    if (this.experimentGate) await this.experimentGate.assertAllowed({ runId: this.runId, action: "pwn_reproduce", input });
    let outcome: PwnReproduceOutcome;
    try {
      outcome = this.trustedReproducer
        ? await this.trustedReproducer.reproduce(this.runId, stages)
        : await this.reproducer.reproduce(this.runId, recipe, async () => await this.openReproductionSession(target));
    } catch (error) {
      await this.experimentGate?.record({ runId: this.runId, action: "pwn_reproduce", input, outcome: "failure", summary: String(error).slice(0, 1_000) }).catch(() => undefined);
      throw error;
    }
    await this.experimentGate?.record({ runId: this.runId, action: "pwn_reproduce", input, outcome: outcome.reproduced ? "success" : "failure", summary: outcome.reproduced ? "Pwn reproduction passed its shell and flag barriers." : "Pwn reproduction did not pass its shell and flag barriers." });
    const domainRecordIds = await this.recordExploitStages(outcome);
    return domainRecordIds.length > 0 ? { ...outcome, domainRecordIds } : outcome;
  }

  /** Open the clean reproduction through the same durable broker as exploration when one is configured. */
  private async openReproductionSession(target: PwnReproduceTarget): Promise<PwnSession> {
    const ref = this.refProvider();
    if (this.sessionBroker) {
      return await this.openBrokerSession({
        kind: target.kind,
        command: target.command,
        ...(target.kind === "remote" ? { endpoint: target.endpoint } : {}),
      }, ref, id("PWN-REPRO"));
    }
    return target.kind === "local"
      ? await PwnSession.openLocal(this.registry, { ref, ownerLane: this.ownerLane, command: target.command })
      : await PwnSession.openRemote(this.registry, { ref, ownerLane: this.ownerLane, command: target.command, endpoint: target.endpoint });
  }

  /**
   * Reject a remote endpoint outside the task scope BEFORE any connection. The
   * Docker egress gateway is the real boundary, but a same-network deployment or
   * a bridge/none policy has no gateway enforcement, so validate at the app layer
   * too: parse host:port, require the host in allowed_hosts and the port in
   * allowed_ports (empty lists / no scope = unrestricted, e.g. GUI chat).
   */
  private assertEndpointAllowed(endpoint: string | undefined): void {
    if (!endpoint) throw new Error("pwn remote requires an endpoint (host:port)");
    const parsed = parseEndpoint(endpoint);
    if (!parsed) throw new Error(`pwn endpoint is not a valid host:port: ${endpoint}`);
    if (!this.scope) return;
    const { allowedHosts, allowedPorts } = this.scope;
    if (allowedHosts.length > 0 && !allowedHosts.some((pattern) => hostMatches(parsed.host, pattern))) {
      throw new Error(`pwn endpoint host ${parsed.host} is outside the task scope`);
    }
    if (allowedPorts.length > 0 && !allowedPorts.includes(parsed.port)) {
      throw new Error(`pwn endpoint port ${parsed.port} is outside the task scope`);
    }
  }

  private viewport(sessionId: string, data: string, exited: boolean, matched?: boolean): PwnViewport {
    if (exited) this.exited.add(sessionId);
    const truncated = data.length > VIEWPORT_MAX;
    const viewport = truncated ? `…${data.slice(-VIEWPORT_MAX)}` : data;
    return { sessionId, viewport, ...(matched !== undefined ? { matched } : {}), exited, truncated };
  }

  /** Record a bounded, non-verifier primitive hypothesis with explicit provenance. */
  public async recordPrimitive(input: {
    primitive: string;
    confidence: number;
    preconditionRecordIds?: string[];
    artifactIds?: string[];
    evidenceIds?: string[];
  }): Promise<{ recordId: string }> {
    if (!this.controlStore) throw new Error("pwn primitive recording is unavailable without the Control Store");
    const primitive = redactCtfCandidates(input.primitive.replace(/[\u0000\r\n]/g, " ").trim(), () => "[candidate]").slice(0, 256);
    if (!primitive) throw new Error("pwn primitive requires a non-empty description");
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence >= 1) throw new Error("pwn primitive confidence must be in [0,1)");
    const artifactIds = [...new Set(input.artifactIds ?? [])].slice(0, 32);
    const evidenceIds = [...new Set(input.evidenceIds ?? [])].slice(0, 32);
    if (artifactIds.length === 0 && evidenceIds.length === 0) throw new Error("pwn primitive requires supporting artifactIds or evidenceIds");
    const preconditionRecordIds = [...new Set(input.preconditionRecordIds ?? [])].slice(0, 32);
    const snapshot = await this.controlStore.snapshot(this.runId);
    if (!["pwn", "mixed", "unknown"].includes(snapshot.task.target_kind)) throw new Error(`Pwn primitive is not allowed for target kind ${snapshot.task.target_kind}`);
    const recordId = id("PWN-PRIMITIVE");
    await this.controlStore.dispatch(this.runId, {
      type: "domain_record",
      record: {
        id: recordId,
        kind: "pwn_primitive",
        summary: `Candidate pwn primitive: ${primitive}.`,
        artifactIds,
        evidenceIds,
        primitive,
        confidence: input.confidence,
        preconditionRecordIds,
      },
      lane: this.ownerLane,
    });
    return { recordId };
  }

  private async recordTranscript(sessionId: string, operation: string, anchors: string[]): Promise<void> {
    if (!this.artifactStore || !this.controlStore) return;
    const snapshot = await this.controlStore.snapshot(this.runId);
    if (!["pwn", "mixed", "unknown"].includes(snapshot.task.target_kind)) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const transcript = session.log.slice(-65_536);
    const artifact = await this.artifactStore.putText(this.runId, transcript, {
      filename: `pwn-${sessionId}-transcript.txt`,
      mime: "text/plain",
      sensitivity: "public",
      truncated: session.log.length > transcript.length,
      semantic: { name: `Pwn ${operation} transcript`, summary: "Bounded interaction transcript for a pwn session.", tags: ["pwn", "transcript", operation], role: "supporting", relatedIds: [], annotatedBy: "harness" },
    });
    const current = await this.controlStore.snapshot(this.runId);
    await this.controlStore.dispatch(this.runId, {
      type: "domain_record",
      record: {
        id: id("PWN-TRANSCRIPT"),
        kind: "pwn_protocol_transcript",
        summary: `Pwn ${operation} produced a bounded transcript artifact.`,
        artifactIds: [artifact.id],
        evidenceIds: [],
        sessionId,
        interactionCount: current.sessions[sessionId]?.interactions ?? 0,
        anchors: anchors.filter((anchor) => typeof anchor === "string" && anchor.length > 0 && !/[\r\n]/.test(anchor)).slice(0, 16),
      },
      lane: this.ownerLane,
    });
  }

  /** Persist stage outcomes as observed records without promoting them to a verifier claim. */
  private async recordExploitStages(outcome: PwnReproduceOutcome): Promise<string[]> {
    if (!this.artifactStore || !this.controlStore) return [];
    const snapshot = await this.controlStore.snapshot(this.runId);
    if (!["pwn", "mixed", "unknown"].includes(snapshot.task.target_kind)) return [];
    const stages = outcome.stages.slice(0, 64).map((stage, index) => ({
      index,
      name: safeStageName(stage.name, index),
      ok: stage.ok,
    }));
    if (stages.length === 0) return [];
    // Do not persist stage details or the candidate flag; the verifier owns the
    // full reproduction transcript. This artifact is only a bounded stage map.
    const artifact = await this.artifactStore.putText(this.runId, JSON.stringify({ stages }), {
      filename: `pwn-reproduce-stages-${sha256(JSON.stringify(stages)).slice(0, 16)}.json`,
      mime: "application/json",
      sensitivity: "public",
      semantic: { name: "Pwn exploit stage outcomes", summary: "Bounded stage statuses from a fresh model-proposed reproduction attempt.", tags: ["pwn", "exploit-stage"], role: "supporting", relatedIds: [], annotatedBy: "harness" },
    });
    const records: Array<{ type: "domain_record"; record: Extract<DomainRecordInput, { kind: "pwn_exploit_stage" }>; lane: Lane }> = stages.map((stage) => ({
      type: "domain_record",
      record: {
        id: `PWN-STAGE-${snapshot.generation}-${sha256(`${artifact.id}:${stage.index}`).slice(0, 32)}`,
        kind: "pwn_exploit_stage",
        summary: `Observed reproduction stage ${stage.index + 1} (${stage.name}): ${stage.ok ? "passed" : "failed"}.`,
        artifactIds: [artifact.id],
        evidenceIds: [],
        stageIndex: stage.index,
        stageName: stage.name,
        status: stage.ok ? "passed" : "failed",
        inputArtifactId: artifact.id,
      },
      lane: this.ownerLane,
    }));
    await this.controlStore.dispatchBatch(this.runId, records);
    return records.map((command) => command.record.id);
  }

  private require(sessionId: string, allowExited = false): PwnSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown pwn session: ${sessionId}`);
    if (!allowExited && this.exited.has(sessionId)) throw new Error(`Pwn session has exited: ${sessionId}; only pwn_close is allowed`);
    return session;
  }
}

/** Parse "host:port" (rejecting IPv6/garbage) for scope checks. */
export function parseEndpoint(endpoint: string): { host: string; port: number } | undefined {
  const trimmed = endpoint.trim();
  const m = /^([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?):(\d{1,5})$/.exec(trimmed);
  if (!m) return undefined;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: m[1]!.toLowerCase(), port };
}

/** Host allow-match: exact, "*" wildcard-all, or "*.suffix" subdomain wildcard. */
export function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (p === "*") return true;
  if (p.startsWith("*.")) { const suffix = p.slice(1); return host === p.slice(2) || host.endsWith(suffix); }
  return host === p;
}

function brokerResource(
  runId: string,
  generation: number,
  ownerLane: Lane,
  sessionId: string,
  externalId: string,
  request: SessionRuntimeCreateRequest,
): ExternalResourceRecord {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `session:${sessionId}`,
    kind: "pwn-session",
    runId,
    generation,
    ownerLane,
    state: "STARTED",
    externalId,
    requestKey: request.requestKey,
    ...(request.policyHash ? { policyHash: request.policyHash } : {}),
    ...(request.recipeHash ? { recipeHash: request.recipeHash } : {}),
    ...(request.scopeHash ? { scopeHash: request.scopeHash } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    inspectCount: 0,
  };
}

function opt(input: PwnOpenInput): { cwd?: string; idleSilenceMs?: number; waitTimeoutMs?: number } {
  return {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.idleSilenceMs ? { idleSilenceMs: input.idleSilenceMs } : {}),
    ...(input.waitTimeoutMs ? { waitTimeoutMs: input.waitTimeoutMs } : {}),
  };
}

function safeStageName(value: string, index: number): string {
  const normalized = value.replace(/[\u0000\r\n]/g, " ").trim().slice(0, 160);
  return normalized || `stage-${index}`;
}
