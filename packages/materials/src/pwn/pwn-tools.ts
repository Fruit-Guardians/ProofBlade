import type { DomainRecordInput, Lane, RunSnapshot, TargetKind } from "../domain/types.js";
import type { ContainerRef } from "../container/contracts.js";
import type { SessionRegistry } from "../container/session-registry.js";
import type { ControlStore } from "../control/control-store.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { CodingEvidenceGraph } from "../knowledge/evidence-graph.js";
import { PwnSession } from "./pwn-session.js";
import { appendByte } from "./bytes.js";
import { analyzeGdbTranscript, type PwnCrashReport } from "./analysis.js";
import { deriveBaseRecord, parseLeakHex, toHex, type AddressKind, type LeakFormat, type LeakRecord } from "./leak.js";
import { findMappedBytes, findSymbol, loadElf } from "./elfmodel.js";
import { buildChain, parseBadBytes, scanGadgets, isSupportedRopTarget, type RopEntry, type RopGoal } from "./rop.js";
import { mallocRequest, pointerProtection } from "./heap.js";
import { buildFmtstrPayload } from "./fmtstr.js";
import { derivePwnWorkflow, type PwnWorkflowState } from "./workflow.js";
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
    /** Shared evidence graph used to expose the durable leak ledger to Pwn tools. */
    private readonly evidenceGraph?: CodingEvidenceGraph,
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
      if (this.sessionRuntimeRequired && !this.sessionBroker) throw new Error(pwnRequestRefusal("Session runtime broker is configured but unavailable", "use the configured session broker or restart this run with a local Docker-backed pwn profile"));
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

  /**
   * Return the deterministic next-step view for the current target
   * generation. This is read-only and deliberately does not inspect a live
   * tube, so asking for guidance cannot block an active Pwn session.
   */
  public async workflow(): Promise<PwnWorkflowState> {
    if (!this.controlStore) throw new Error("[ProofBlade tool unavailable: pwn_workflow]\nReason: the durable Control Store is not attached to this run. The workflow was not computed.\nNext: restart the task with a Control Store-enabled pwn profile.");
    return derivePwnWorkflow(await this.controlStore.snapshot(this.runId));
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
    if (this.controlStore) {
      const workflow = derivePwnWorkflow(await this.controlStore.snapshot(this.runId));
      if (workflow.retryBlocked) {
        throw new Error(pwnRequestRefusal(
          "the latest Pwn reproduction failed and no new material evidence has changed the path",
          "call pwn_workflow, run one bounded experiment that records a new current-generation crash, leak/base derivation, primitive, or binary profile, then retry",
        ));
      }
    }
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
    if (!endpoint) throw new Error(pwnRequestRefusal("pwn remote requires an endpoint (host:port)", "provide the task-scoped endpoint and retry, or use kind=local"));
    const parsed = parseEndpoint(endpoint);
    if (!parsed) throw new Error(pwnRequestRefusal(`pwn endpoint is not a valid host:port: ${endpoint}`, "provide an endpoint such as host:port with a port from 1 to 65535"));
    if (!this.scope) return;
    const { allowedHosts, allowedPorts } = this.scope;
    if (allowedHosts.length > 0 && !allowedHosts.some((pattern) => hostMatches(parsed.host, pattern))) {
      throw new Error(pwnRequestRefusal(`pwn endpoint host ${parsed.host} is outside the task scope`, "choose a host from the task's allowed scope or use a local target"));
    }
    if (allowedPorts.length > 0 && !allowedPorts.includes(parsed.port)) {
      throw new Error(pwnRequestRefusal(`pwn endpoint port ${parsed.port} is outside the task scope`, "choose a port from the task's allowed scope or use a local target"));
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
    if (!this.controlStore) throw new Error("[ProofBlade tool unavailable: pwn_record_primitive]\nReason: primitive recording requires the durable Control Store, which is not attached to this run. The requested record was not created.\nNext: continue with bounded pwn observations, or restart the task with a Control Store-enabled profile.");
    const primitive = redactCtfCandidates(input.primitive.replace(/[\u0000\r\n]/g, " ").trim(), () => "[candidate]").slice(0, 256);
    if (!primitive) throw new Error(pwnRequestRefusal("pwn primitive requires a non-empty description", "provide a short hypothesis grounded in the observed behavior"));
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence >= 1) throw new Error(pwnRequestRefusal("pwn primitive confidence must be in [0,1)", "use a finite confidence from 0 (inclusive) up to but excluding 1"));
    const artifactIds = uniqueIds(input.artifactIds ?? []);
    const evidenceIds = uniqueIds(input.evidenceIds ?? []);
    if (artifactIds.length === 0 && evidenceIds.length === 0) throw new Error(pwnRequestRefusal("pwn primitive requires supporting artifactIds or evidenceIds", "read or inspect a supporting Artifact/Evidence first, then pass its A-* or EV-* id"));
    const preconditionRecordIds = [...new Set(input.preconditionRecordIds ?? [])].slice(0, 32);
    const snapshot = await this.controlStore.snapshot(this.runId);
    if (!["pwn", "mixed", "unknown"].includes(snapshot.task.target_kind)) throw new Error(pwnRequestRefusal(`Pwn primitive is not allowed for target kind ${snapshot.task.target_kind}`, "use the task's target-appropriate tools, or run this primitive on a pwn/mixed target"));
    assertCurrentReferences(snapshot, artifactIds, evidenceIds);
    assertCurrentPreconditionRecords(snapshot, preconditionRecordIds);
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

  /** Parse a bounded debugger transcript and persist its crash facts as a Pwn record. */
  public async analyzeCrash(input: {
    transcript: string;
    pattern?: string;
    patternLength?: number;
    alphabet?: string;
    n?: number;
    endian?: "little" | "big";
    artifactIds?: string[];
    evidenceIds?: string[];
  }): Promise<PwnCrashReport & { recordId: string; artifactId: string }> {
    const report = analyzeGdbTranscript(input.transcript, {
      ...(input.pattern === undefined ? {} : { pattern: input.pattern }),
      ...(input.patternLength === undefined ? {} : { patternLength: input.patternLength }),
      ...(input.alphabet === undefined ? {} : { alphabet: input.alphabet }),
      ...(input.n === undefined ? {} : { n: input.n }),
      ...(input.endian === undefined ? {} : { endian: input.endian }),
    });
    const persisted = await this.recordCrash({
      report,
      transcript: input.transcript,
      artifactIds: input.artifactIds,
      evidenceIds: input.evidenceIds,
    });
    return { ...report, ...persisted };
  }

  /** Persist a crash analysis without treating it as exploit success. */
  public async recordCrash(input: {
    report: PwnCrashReport;
    transcript: string;
    artifactIds?: string[];
    evidenceIds?: string[];
  }): Promise<{ recordId: string; artifactId: string }> {
    if (!this.artifactStore || !this.controlStore) throw new Error("[ProofBlade tool unavailable: pwn_crash_analyze]\nReason: crash analysis requires the durable Artifact and Control Stores, which are not attached to this run. The transcript was not recorded.\nNext: restart the task with a Control Store-enabled pwn profile.");
    if (typeof input.transcript !== "string" || input.transcript.length === 0) throw new Error(pwnRequestRefusal("pwn crash analysis requires a non-empty transcript", "pass the bounded GDB or debugger transcript"));
    const snapshot = await this.controlStore.snapshot(this.runId);
    assertPwnTarget(snapshot.task.target_kind);
    const artifactIds = uniqueIds(input.artifactIds ?? []);
    const evidenceIds = uniqueIds(input.evidenceIds ?? []);
    assertCurrentReferences(snapshot, artifactIds, evidenceIds);
    const maxTranscript = 256 * 1024;
    const storedTranscript = input.transcript.length > maxTranscript ? input.transcript.slice(-maxTranscript) : input.transcript;
    const artifact = await this.artifactStore.putText(this.runId, storedTranscript, {
      filename: `pwn-crash-${snapshot.generation}.txt`,
      mime: "text/plain",
      sensitivity: "public",
      truncated: input.transcript.length > storedTranscript.length,
      semantic: {
        name: "Pwn crash transcript",
        summary: "Bounded debugger transcript used to classify a Pwn crash.",
        tags: ["pwn", "crash", "debugger"],
        role: "supporting",
        relatedIds: [],
        annotatedBy: "harness",
      },
    });
    const allArtifactIds = uniqueIds([artifact.id, ...artifactIds]);
    const summary = crashSummary(input.report);
    const recordId = `PWN-CRASH-${snapshot.generation}-${sha256(`${artifact.id}:${canonicalJson(input.report)}`).slice(0, 32)}`;
    const record: Extract<DomainRecordInput, { kind: "pwn_crash" }> = {
      id: recordId,
      kind: "pwn_crash",
      summary,
      artifactIds: allArtifactIds,
      evidenceIds,
      classification: input.report.classification,
      ...(input.report.signal ? { signal: input.report.signal } : {}),
      ...(input.report.controlRegister ? { controlRegister: input.report.controlRegister } : {}),
      ...(input.report.faultAddress ? { faultAddress: input.report.faultAddress } : {}),
      ...(input.report.cyclic?.offset === undefined ? {} : { cyclicOffset: input.report.cyclic.offset }),
      ripControlled: input.report.ripControlled,
      transcriptTruncated: input.report.transcriptTruncated || input.transcript.length > storedTranscript.length,
    };
    await this.controlStore.dispatch(this.runId, { type: "domain_record", record, lane: this.ownerLane });
    return { recordId, artifactId: artifact.id };
  }

  /** Parse and persist one leak, reusing the existing reasoning/evidence graph. */
  public async recordLeak(input: {
    sourceHex: string;
    format: LeakFormat;
    addressKind: AddressKind;
    confidence: number;
    id?: string;
    symbol?: string;
    derivation?: { expression: string; sourceLeakIds: string[] };
    tags?: string[];
    explanation?: string;
    artifactIds?: string[];
    evidenceIds?: string[];
  }): Promise<{ leakId: string; recordId: string; value: string; reused: boolean }> {
    assertLeakInput(input.format, input.addressKind);
    const sourceHex = normalizeSourceHex(input.sourceHex);
    const value = toHex(parseLeakHex(sourceHex, input.format));
    if (!this.controlStore) throw new Error("[ProofBlade tool unavailable: pwn_record_leak]\nReason: the durable Control Store is not attached to this run. The leak was not recorded.\nNext: restart the task with a Control Store-enabled pwn profile.");
    const snapshot = await this.controlStore.snapshot(this.runId);
    assertPwnTarget(snapshot.task.target_kind);
    const leakId = normalizeLeakId(input.id, { generation: snapshot.generation, sourceHex, format: input.format, addressKind: input.addressKind, symbol: input.symbol, value });
    const leak: LeakRecord = {
      id: leakId,
      sourceHex,
      format: input.format,
      value,
      addressKind: input.addressKind,
      confidence: input.confidence,
      ...(input.symbol ? { symbol: input.symbol } : {}),
      ...(input.derivation ? { derivation: input.derivation } : {}),
    };
    return await this.persistLeak(leak, input);
  }

  /** Derive a base from a previously recorded leak and persist the formula. */
  public async deriveBase(input: {
    sourceLeakId: string;
    knownOffset: string;
    label?: string;
    confidence?: number;
    id?: string;
    tags?: string[];
    explanation?: string;
    artifactIds?: string[];
    evidenceIds?: string[];
  }): Promise<{ leakId: string; recordId: string; value: string; reused: boolean; pageAligned: boolean }> {
    if (!this.controlStore) throw new Error("[ProofBlade tool unavailable: pwn_derive_base]\nReason: base derivation requires the durable Control Store, which is not attached to this run. The derivation was not recorded.\nNext: restart the task with a Control Store-enabled pwn profile.");
    const snapshot = await this.controlStore.snapshot(this.runId);
    assertPwnTarget(snapshot.task.target_kind);
    const sourceLeakId = input.sourceLeakId.replace(/^PWN-LEAK-/, "");
    const sourceRecord = snapshot.domainRecords[`PWN-LEAK-${sourceLeakId}`];
    if (!sourceRecord || sourceRecord.kind !== "pwn_leak") throw new Error(pwnRequestRefusal(`unknown source leak record: ${input.sourceLeakId}`, "record the leak first with pwn_record_leak and use its leakId"));
    if (sourceRecord.runId !== snapshot.runId || sourceRecord.generation !== snapshot.generation) {
      throw new Error(pwnRequestRefusal(`source leak ${input.sourceLeakId} belongs to generation ${sourceRecord.generation}, current generation is ${snapshot.generation}`, "record a fresh leak for the current target generation before deriving a base"));
    }
    const knownOffset = parseHexInteger(input.knownOffset, "knownOffset");
    const sourceConfidence = typeof sourceRecord.confidence === "number" ? sourceRecord.confidence : 0.5;
    const confidence = Math.min(input.confidence ?? sourceConfidence, sourceConfidence);
    const source: LeakRecord = {
      id: sourceLeakId,
      sourceHex: sourceRecord.sourceHex,
      format: sourceRecord.format,
      value: sourceRecord.value,
      addressKind: sourceRecord.addressKind,
      confidence: confidence,
      ...(sourceRecord.symbol ? { symbol: sourceRecord.symbol } : {}),
    };
    const derived = deriveBaseRecord(source, {
      id: normalizeLeakId(input.id, { generation: snapshot.generation, sourceLeakId, knownOffset: toHex(knownOffset), label: input.label }),
      knownOffset,
      ...(input.label ? { label: input.label } : {}),
      confidence,
    });
    return {
      ...(await this.persistLeak(derived, {
        tags: input.tags,
        explanation: input.explanation,
        artifactIds: input.artifactIds ?? sourceRecord.artifactIds,
        evidenceIds: input.evidenceIds ?? sourceRecord.evidenceIds,
      })),
      pageAligned: knownOffset >= 0n && BigInt(derived.value) % 0x1000n === 0n,
    };
  }

  private async persistLeak(
    leak: LeakRecord,
    input: { tags?: string[]; explanation?: string; artifactIds?: string[]; evidenceIds?: string[] },
  ): Promise<{ leakId: string; recordId: string; value: string; reused: boolean }> {
    if (!this.controlStore || !this.evidenceGraph) throw new Error("[ProofBlade tool unavailable: pwn_record_leak]\nReason: the durable Pwn evidence graph is not attached to this run. The leak was not recorded.\nNext: restart the task with a Control Store and evidence graph-enabled pwn profile.");
    if (!Number.isFinite(leak.confidence) || leak.confidence < 0 || leak.confidence >= 1) throw new Error(pwnRequestRefusal("pwn leak confidence must be in [0,1)", "use a finite confidence below 1 until fresh reproduction confirms the exploit"));
    const snapshot = await this.controlStore.snapshot(this.runId);
    assertPwnTarget(snapshot.task.target_kind);
    const artifactIds = uniqueIds(input.artifactIds ?? []);
    const evidenceIds = uniqueIds(input.evidenceIds ?? []);
    if (artifactIds.length === 0 && evidenceIds.length === 0) throw new Error(pwnRequestRefusal("pwn leak requires supporting artifactIds or evidenceIds", "read or inspect the leak source first, then pass its A-* or EV-* id"));
    assertCurrentReferences(snapshot, artifactIds, evidenceIds);
    if (leak.derivation) assertCurrentPreconditionRecords(snapshot, leak.derivation.sourceLeakIds.map((sourceId) => `PWN-LEAK-${sourceId}`));
    const result = await this.evidenceGraph.recordLeak({
      leak,
      tags: input.tags?.slice(0, 32),
      explanation: input.explanation,
      artifactIds,
      evidenceIds,
    });
    return { leakId: leak.id, recordId: `PWN-LEAK-${leak.id}`, value: leak.value, reused: result.reused };
  }

  /**
   * Identify the leak's libc by matching its symbol against a current-generation
   * libc Artifact, then derive and persist the base through the normal ledger
   * path. Without an artifact this stays a fingerprint + guidance answer: no
   * record is written, and the model must go source the libc first.
   */
  public async identifyLibc(input: {
    sourceLeakId: string;
    libcArtifactId?: string;
    symbol?: string;
    resolve?: string[];
    artifactIds?: string[];
    evidenceIds?: string[];
  }): Promise<
    | { matched: false; fingerprint: { symbol: string; low12Bits: string }; nextActions: string[] }
    | { matched: true; symbol: string; symbolOffset: string; base: { recordId: string; leakId: string; value: string; pageAligned: boolean; reused: boolean }; resolved: Record<string, string> }
  > {
    if (!this.controlStore) throw new Error("[ProofBlade tool unavailable: pwn_identify_libc]\nReason: the durable Control Store is not attached to this run. The leak was not identified.\nNext: restart the task with a Control Store-enabled pwn profile.");
    const snapshot = await this.controlStore.snapshot(this.runId);
    assertPwnTarget(snapshot.task.target_kind);
    const sourceLeakId = input.sourceLeakId.replace(/^PWN-LEAK-/, "");
    const sourceRecord = snapshot.domainRecords[`PWN-LEAK-${sourceLeakId}`];
    if (!sourceRecord || sourceRecord.kind !== "pwn_leak") throw new Error(pwnRequestRefusal(`unknown source leak record: ${input.sourceLeakId}`, "record the leak first with pwn_record_leak and use its leakId"));
    if (sourceRecord.runId !== snapshot.runId || sourceRecord.generation !== snapshot.generation) {
      throw new Error(pwnRequestRefusal(`source leak ${input.sourceLeakId} belongs to generation ${sourceRecord.generation}, current generation is ${snapshot.generation}`, "record a fresh leak for the current target generation before identifying libc"));
    }
    const symbol = (input.symbol ?? sourceRecord.symbol)?.trim();
    if (!symbol) throw new Error(pwnRequestRefusal("the source leak record has no symbol name", "pass `symbol` (the leaked function, e.g. puts) or re-record the leak with one"));
    const leakValue = BigInt(sourceRecord.value);
    if (!input.libcArtifactId) {
      return {
        matched: false,
        fingerprint: { symbol, low12Bits: toHex(leakValue & 0xfffn) },
        nextActions: [
          `Look up "${symbol}" ending in ${toHex(leakValue & 0xfffn)} against a libc offset database (libc-database / libc.rip) to name candidate libc builds.`,
          "Obtain the matching libc (or the task-provided one), stage it as a current-generation Artifact, and re-run pwn_identify_libc with libcArtifactId to derive and persist the base.",
        ],
      };
    }
    if (!this.artifactStore) throw new Error("[ProofBlade tool unavailable: pwn_identify_libc]\nReason: the durable Artifact Store is not attached to this run. The libc was not identified.\nNext: restart the task with an Artifact Store-enabled pwn profile.");
    assertCurrentReferences(snapshot, uniqueIds([input.libcArtifactId, ...(input.artifactIds ?? [])]), uniqueIds(input.evidenceIds ?? []));
    const libcBytes = await this.artifactStore.readBytes(this.runId, snapshot.artifacts[input.libcArtifactId]!);
    let image;
    try {
      image = loadElf(libcBytes);
    } catch {
      throw new Error(pwnRequestRefusal(`artifact ${input.libcArtifactId} is not a supported ELF image`, "stage the target libc ELF as an Artifact and retry"));
    }
    const found = findSymbol(image, symbol);
    if (!found) throw new Error(pwnRequestRefusal(`symbol ${symbol} was not found in artifact ${input.libcArtifactId}`, "the artifact is probably not the target libc; verify it before deriving addresses from it"));
    const symbolOffset = found.value;
    if ((leakValue & 0xfffn) !== (symbolOffset & 0xfffn)) {
      throw new Error(pwnRequestRefusal(`leaked ${sourceRecord.value} low-12 bits do not match ${symbol} at offset ${toHex(symbolOffset)} in this artifact`, "the artifact is a different libc build; identify it from the low-12 fingerprint or stage the correct libc"));
    }
    const base = await this.deriveBase({
      sourceLeakId,
      knownOffset: toHex(symbolOffset),
      label: "libc_base",
      artifactIds: uniqueIds([input.libcArtifactId, ...(input.artifactIds ?? [])]),
      evidenceIds: input.evidenceIds,
    });
    const resolved: Record<string, string> = {};
    for (const name of input.resolve ?? []) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      if (trimmed === "/bin/sh") {
        const hit = findMappedBytes(image, libcBytes, Buffer.from("/bin/sh\0", "ascii"))[0];
        if (hit !== undefined) resolved[trimmed] = toHex(BigInt(base.value) + hit);
        continue;
      }
      const target = findSymbol(image, trimmed);
      if (target) resolved[trimmed] = toHex(BigInt(base.value) + target.value);
    }
    return {
      matched: true,
      symbol,
      symbolOffset: toHex(symbolOffset),
      base: { recordId: base.recordId, leakId: base.leakId, value: base.value, pageAligned: base.pageAligned, reused: base.reused },
      resolved,
    };
  }

  /**
   * Scan a current-generation ELF Artifact for ROP gadgets and assemble a
   * constraint-checked chain (call / syscall-execve / system("/bin/sh")).
   * The assembled plan is persisted as an Artifact for audit; it is a build
   * plan, never evidence of control — success still flows only through
   * pwn_reproduce.
   */
  public async ropChain(input: {
    binaryArtifactId: string;
    baseRecordId?: string;
    goal: {
      kind: "call" | "syscall_execve" | "system_binsh";
      target?: string;
      args?: string[];
      system?: string;
      binShAddress?: string;
      alignRet?: boolean;
    };
    badBytes?: string;
    maxWords?: number;
    artifactIds?: string[];
    evidenceIds?: string[];
  }): Promise<{ planArtifactId: string; ok: boolean; entries: RopEntry[]; payloadHex: string; payloadBytes: number; problems: string[] }> {
    if (!this.controlStore || !this.artifactStore) throw new Error("[ProofBlade tool unavailable: pwn_rop_chain]\nReason: gadget scanning requires the durable Artifact and Control Stores, which are not attached to this run. No chain was built.\nNext: restart the task with a Control Store-enabled pwn profile.");
    const snapshot = await this.controlStore.snapshot(this.runId);
    assertPwnTarget(snapshot.task.target_kind);
    assertCurrentReferences(snapshot, uniqueIds([input.binaryArtifactId, ...(input.artifactIds ?? [])]), uniqueIds(input.evidenceIds ?? []));
    let base = 0n;
    if (input.baseRecordId !== undefined) {
      assertCurrentPreconditionRecords(snapshot, [input.baseRecordId]);
      const record = snapshot.domainRecords[input.baseRecordId]!;
      if (record.kind !== "pwn_leak") throw new Error(pwnRequestRefusal(`base record ${input.baseRecordId} is a ${record.kind}, not a pwn_leak ledger record`, "pass the recordId returned by pwn_derive_base or pwn_identify_libc"));
      base = BigInt(record.value);
    }
    const artifact = snapshot.artifacts[input.binaryArtifactId]!;
    const bytes = await this.artifactStore.readBytes(this.runId, artifact);
    let image;
    try {
      image = loadElf(bytes);
    } catch {
      throw new Error(pwnRequestRefusal(`artifact ${input.binaryArtifactId} is not a supported ELF image`, "stage the target binary or libc ELF as an Artifact and retry"));
    }
    if (!isSupportedRopTarget(image)) throw new Error(pwnRequestRefusal(`machine ${image.machine} is not supported by pwn_rop_chain`, "this builder covers x86/x86-64; use the container toolchain (ROPgadget/ropper) for other architectures"));
    if (image.type === 3 && input.baseRecordId === undefined) {
      throw new Error(pwnRequestRefusal("this image is PIE/shared: gadget addresses are relative and need a runtime base", "pass baseRecordId of a current-generation pwn_leak base derived from a leak"));
    }
    if (image.type === 2 && base !== 0n) throw new Error(pwnRequestRefusal("this image loads at absolute addresses (non-PIE)", "drop baseRecordId; absolute gadget addresses need no rebase"));
    const scanned = scanGadgets(image, bytes);
    // Rebase the whole catalog once, before chain assembly: symbols, strings,
    // and payload words are all resolved against this same base, so nothing is
    // doubled or skipped downstream.
    const catalog = base === 0n
      ? scanned
      : {
          pops: new Map([...scanned.pops.entries()].map(([reg, gadgets]) => [reg, gadgets.map((gadget) => ({ ...gadget, address: gadget.address + base }))])),
          rets: scanned.rets.map((gadget) => ({ ...gadget, address: gadget.address + base })),
          syscalls: scanned.syscalls.map((gadget) => ({ ...gadget, address: gadget.address + base })),
          int80: scanned.int80.map((gadget) => ({ ...gadget, address: gadget.address + base })),
          leaveRet: scanned.leaveRet.map((gadget) => ({ ...gadget, address: gadget.address + base })),
          truncated: scanned.truncated,
        };
    const badBytes = parseBadBytes(input.badBytes);
    const maxWords = input.maxWords !== undefined && Number.isInteger(input.maxWords) && input.maxWords >= 1 && input.maxWords <= 256 ? input.maxWords : 64;
    const resolveAddress = (value: string, label: string): bigint => {
      const trimmed = value.trim();
      if (/^(?:0x)?[0-9a-f]+$/i.test(trimmed)) return parseHexInteger(trimmed, label);
      const symbol = findSymbol(image, trimmed);
      if (!symbol) throw new Error(pwnRequestRefusal(`${label} ${trimmed} matched no symbol in artifact ${input.binaryArtifactId}`, "pass a hex address, or inspect the artifact symbols first"));
      return symbol.value + base;
    };
    const defaultBinSh = (): bigint => {
      const hit = findMappedBytes(image, bytes, Buffer.from("/bin/sh\0", "ascii"))[0];
      if (hit === undefined) throw new Error(pwnRequestRefusal('no "/bin/sh\\0" string was found in this image', "pass binShAddress explicitly or chain a write of the string first"));
      return hit + base;
    };
    let goal: RopGoal;
    let alignRet = false;
    if (input.goal.kind === "call") {
      if (!input.goal.target) throw new Error(pwnRequestRefusal("goal kind call requires a target", "pass the callee as a symbol name in the artifact or a hex address"));
      alignRet = input.goal.alignRet ?? false;
      goal = { kind: "call", target: resolveAddress(input.goal.target, "call target"), args: (input.goal.args ?? []).slice(0, 6).map((value, index) => parseHexInteger(value, `arg${index}`)) };
    } else if (input.goal.kind === "syscall_execve") {
      const binSh = input.goal.binShAddress !== undefined ? parseHexInteger(input.goal.binShAddress, "binShAddress") : defaultBinSh();
      goal = { kind: "syscall", number: image.bits === 64 ? 59n : 11n, args: [binSh, 0n, 0n] };
    } else if (input.goal.kind === "system_binsh") {
      alignRet = input.goal.alignRet ?? true;
      const system = input.goal.system !== undefined ? resolveAddress(input.goal.system, "system") : resolveAddress("system", "system");
      const binSh = input.goal.binShAddress !== undefined ? parseHexInteger(input.goal.binShAddress, "binShAddress") : defaultBinSh();
      goal = { kind: "call", target: system, args: [binSh] };
    } else {
      throw new Error(pwnRequestRefusal(`unknown chain goal kind ${String((input.goal as { kind: unknown }).kind)}`, "use call, syscall_execve, or system_binsh"));
    }
    const build = buildChain(catalog, goal, { bits: image.bits, ...(badBytes ? { badBytes } : {}), maxWords });
    if (alignRet) {
      const wordBytes = image.bits === 64 ? 8 : 4;
      const cleanRet = catalog.rets.find((gadget) => !badBytes || !badBytes.size || Array.from({ length: wordBytes }, (_, index) => Number((gadget.address >> BigInt(index * 8)) & 0xffn)).every((byte) => !badBytes.has(byte)));
      if (cleanRet) {
        build.entries.unshift({ role: "gadget", address: toHex(cleanRet.address), asm: "ret", note: "stack alignment padding: glibc system/movaps paths require rsp 16-byte-aligned at call time" });
      } else {
        build.problems.push("no ret gadget survived the bad-byte filter for stack alignment; the chain may crash inside libc on movaps");
      }
    }
    // Repack the payload from the final entries so alignment padding and any
    // rebase are reflected consistently in the emitted wire bytes.
    const repackedWords: bigint[] = build.entries.map((entry) => BigInt(entry.address ?? entry.value ?? "0x0"));
    build.payloadHex = repackedWords.map((word) => Array.from({ length: image.bits === 64 ? 8 : 4 }, (_, index) => ((word >> BigInt(index * 8)) & 0xffn).toString(16).padStart(2, "0")).join("")).join("");
    build.payloadBytes = repackedWords.length * (image.bits === 64 ? 8 : 4);
    const plan = {
      goal: input.goal.kind,
      binaryArtifactId: input.binaryArtifactId,
      ...(input.baseRecordId !== undefined ? { baseRecordId: input.baseRecordId, base: toHex(base) } : {}),
      ok: build.ok,
      entries: build.entries,
      problems: build.problems,
      payloadBytes: build.payloadBytes,
      truncated: catalog.truncated,
    };
    const planArtifact = await this.artifactStore.putText(this.runId, JSON.stringify(plan, null, 2), {
      filename: `pwn-rop-chain-${snapshot.generation}.json`,
      mime: "application/json",
      sensitivity: "public",
      semantic: { name: "Pwn ROP chain plan", summary: `Gadget-selected ${input.goal.kind} chain plan (${build.ok ? "complete" : "partial"}) built from current-generation records.`, tags: ["pwn", "rop-chain"], role: "intermediate", relatedIds: [input.binaryArtifactId], annotatedBy: "harness" },
    });
    return { planArtifactId: planArtifact.id, ok: build.ok, entries: build.entries, payloadHex: build.payloadHex, payloadBytes: build.payloadBytes, problems: build.problems };
  }

  /** Deterministic glibc heap arithmetic (safe-linking, request rounding, bin indexes). */
  public heapCalc(input: {
    operation: "protect_ptr" | "reveal_ptr" | "malloc_request";
    position?: string;
    pointer?: string;
    request?: string;
    bits?: 32 | 64;
  }): unknown {
    const bits = input.bits ?? 64;
    if (input.operation === "malloc_request") {
      if (input.request === undefined) throw new Error(pwnRequestRefusal("malloc_request requires `request` (hex size)", "e.g. { operation: \"malloc_request\", request: \"0x80\" }"));
      return mallocRequest(parseHexInteger(input.request, "request"), bits);
    }
    if (input.position === undefined || input.pointer === undefined) {
      throw new Error(pwnRequestRefusal(`${input.operation} requires both position and pointer`, "position = the chunk/slot address holding the fd, pointer = the raw or stored fd value"));
    }
    return pointerProtection(input.operation, parseHexInteger(input.position, "position"), parseHexInteger(input.pointer, "pointer"));
  }

  /** Deterministic format-string payload (byte-wise %hhn) with alignment and index math. */
  public fmtstrPayload(input: {
    offset: number;
    bits?: 32 | 64;
    writes: Array<{ address: string; value: string; size?: number }>;
    prefixHex?: string;
    badBytes?: string;
    maxPayload?: number;
  }): unknown {
    const bits = input.bits ?? 64;
    const wordBytes = bits === 64 ? 8 : 4;
    const prefix = input.prefixHex ? Buffer.from(parseHexBytes(input.prefixHex, "prefixHex"), "hex") : undefined;
    const writes = input.writes.slice(0, 32).map((write, index) => ({
      address: parseHexInteger(write.address, `writes[${index}].address`),
      value: parseHexInteger(write.value, `writes[${index}].value`),
      ...(write.size !== undefined ? { size: write.size } : {}),
    }));
    if (writes.some((write) => write.size !== undefined && (write.size < 1 || write.size > wordBytes))) {
      throw new Error(pwnRequestRefusal("write sizes must fit the pointer width", `use sizes 1-${wordBytes} for a ${bits}-bit target`));
    }
    return buildFmtstrPayload(writes, {
      offset: input.offset,
      bits,
      ...(prefix ? { prefix } : {}),
      ...(parseBadBytes(input.badBytes) ? { badBytes: parseBadBytes(input.badBytes) } : {}),
      ...(input.maxPayload !== undefined ? { maxPayload: input.maxPayload } : {}),
    });
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
        attemptStatus: outcome.reproduced ? "passed" : "failed",
        inputArtifactId: artifact.id,
      },
      lane: this.ownerLane,
    }));
    await this.controlStore.dispatchBatch(this.runId, records);
    return records.map((command) => command.record.id);
  }

  private require(sessionId: string, allowExited = false): PwnSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(pwnRequestRefusal(`Unknown pwn session: ${sessionId}`, "call pwn_list and use a session id from this Run, or call pwn_open to start one"));
    if (!allowExited && this.exited.has(sessionId)) throw new Error(pwnRequestRefusal(`Pwn session has exited: ${sessionId}; only pwn_close is allowed`, "call pwn_close, then open a fresh session and replay one bounded stage"));
    return session;
  }
}

function pwnRequestRefusal(reason: string, next: string): string {
  return `[ProofBlade tool request rejected: pwn]\nReason: ${reason}. The requested action was not executed.\nNext: ${next}.`;
}

function assertPwnTarget(targetKind: TargetKind): void {
  if (!(["pwn", "mixed", "unknown"] as TargetKind[]).includes(targetKind)) {
    throw new Error(pwnRequestRefusal(`Pwn analysis is not allowed for target kind ${targetKind}`, "use the task's target-appropriate tools, or run this analysis on a pwn/mixed target"));
  }
}

function assertCurrentReferences(snapshot: RunSnapshot, artifactIds: string[], evidenceIds: string[]): void {
  for (const artifactId of artifactIds) {
    const artifact = snapshot.artifacts[artifactId];
    if (!artifact) throw new Error(pwnRequestRefusal(`unknown artifact ${artifactId}`, "read the artifact result and pass its current A-* id"));
    if (artifact.runId !== snapshot.runId || artifact.generation !== snapshot.generation) throw new Error(pwnRequestRefusal(`artifact ${artifactId} is stale`, "use an Artifact from the current target generation"));
  }
  for (const evidenceId of evidenceIds) {
    const evidence = snapshot.evidence[evidenceId];
    if (!evidence) throw new Error(pwnRequestRefusal(`unknown evidence ${evidenceId}`, "record or inspect the supporting Evidence before linking it"));
    if (evidence.provenance.runId !== snapshot.runId || evidence.provenance.generation !== snapshot.generation) throw new Error(pwnRequestRefusal(`evidence ${evidenceId} is stale`, "use Evidence from the current target generation"));
  }
}

/**
 * Precondition records anchor a primitive to earlier analysis, so they must
 * belong to the current run AND the current fixture generation — otherwise a
 * primitive created after a fixture reset could silently re-bind stale
 * crash/leak/primitive records and the generation-bound workflow would treat
 * cross-generation evidence as current.
 */
function assertCurrentPreconditionRecords(snapshot: RunSnapshot, preconditionRecordIds: string[]): void {
  for (const recordId of preconditionRecordIds) {
    const record = snapshot.domainRecords[recordId];
    if (!record) throw new Error(pwnRequestRefusal(`unknown precondition record ${recordId}`, "record the precondition with the matching pwn tool first, then pass its current record id"));
    if (record.runId !== snapshot.runId || record.generation !== snapshot.generation) {
      throw new Error(pwnRequestRefusal(`precondition record ${recordId} belongs to generation ${record.generation}, current generation is ${snapshot.generation}`, "record a fresh precondition for the current target generation before linking it"));
    }
  }
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].slice(0, 32);
}

function normalizeSourceHex(value: string): string {
  const compact = value.trim().replace(/^0x/i, "").replace(/\s+/g, "");
  if (!compact || compact.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(compact) || compact.length > 512) {
    throw new Error(pwnRequestRefusal("leak sourceHex must contain whole hexadecimal bytes", "pass bytes such as 30f4e1f7ff7f0000"));
  }
  return compact.toLowerCase();
}

function assertLeakInput(format: LeakFormat, addressKind: AddressKind): void {
  if (!( ["le64", "le32", "be64", "be32"] as string[]).includes(format)) throw new Error(pwnRequestRefusal("leak format is invalid", "use le64, le32, be64, or be32"));
  if (!( ["stack", "heap", "libc", "pie", "code", "unknown"] as string[]).includes(addressKind)) throw new Error(pwnRequestRefusal("leak address kind is invalid", "use stack, heap, libc, pie, code, or unknown"));
}

function parseHexInteger(value: string, label: string): bigint {
  const trimmed = value.trim();
  if (!/^(?:0x)?[0-9a-f]+$/i.test(trimmed) || trimmed.length > 66) throw new Error(pwnRequestRefusal(`${label} must be a bounded non-negative hexadecimal integer`, `pass ${label} such as 0x84420`));
  return BigInt(`0x${trimmed.replace(/^0x/i, "")}`);
}

/** Parse a hex byte string and return its canonical lowercase form. */
function parseHexBytes(value: string, label: string): string {
  const compact = value.trim().replace(/^0x/i, "").replace(/[\s,]+/g, "").toLowerCase();
  if (compact.length === 0 || compact.length % 2 !== 0 || !/^[0-9a-f]+$/.test(compact) || compact.length > 512) {
    throw new Error(pwnRequestRefusal(`${label} must be whole hexadecimal bytes`, `pass ${label} such as "deadbeef"`));
  }
  return compact;
}

function normalizeLeakId(value: string | undefined, seed: Record<string, unknown>): string {
  const explicit = value?.trim();
  if (explicit) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(explicit)) throw new Error(pwnRequestRefusal("leak id contains unsupported characters", "use letters, digits, dot, underscore, colon, or hyphen"));
    return explicit;
  }
  return `LEAK-${sha256(canonicalJson(seed)).slice(0, 32)}`;
}

function crashSummary(report: PwnCrashReport): string {
  const signal = report.signal ? ` ${report.signal}` : "";
  const control = report.ripControlled
    ? `control register matched the cyclic pattern at offset ${report.cyclic?.offset ?? "unknown"}`
    : report.controlRegister
      ? `${report.controlRegister} was not matched by the cyclic pattern`
      : "no control register was parsed";
  return `Pwn ${report.classification}${signal}; ${control}.`;
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
