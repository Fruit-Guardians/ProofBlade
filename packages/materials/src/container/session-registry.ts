import type { ControlStore } from "../control/control-store.js";
import { id } from "../domain/utils.js";
import type { Lane, SessionKind, SessionRecord } from "../domain/types.js";
import { ExternalResourceRegistry, type ExternalResourceKind } from "../recovery/external-resource-registry.js";
import { BindingTransactionCoordinator } from "../recovery/binding-transaction-coordinator.js";
import type {
  ContainerRef,
  ContainerRuntimePort,
  ContainerSessionHandle,
  ContainerSessionReadOptions,
  ContainerSessionResult,
} from "./contracts.js";

export interface OpenSessionInput {
  ref: ContainerRef;
  kind: SessionKind;
  ownerLane: Lane;
  /** Command that becomes the long-lived process, e.g. ["/bin/bash","-i"]. */
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  endpoint?: string;
  waitTimeoutMs?: number;
  idleSilenceMs?: number;
}

export interface SessionInteraction extends ContainerSessionResult {
  sessionId: string;
}

/** Binding returned by a durable Pwn session broker before the Control Store owner is committed. */
export interface ExternalSessionBinding {
  sessionId: string;
  externalId: string;
  handle: ContainerSessionHandle;
  runtime: Pick<ContainerRuntimePort, "sessionWrite" | "sessionRead" | "sessionSignal" | "closeSession">;
  requestKey?: string;
  policyHash?: string;
  recipeHash?: string;
  scopeHash?: string;
  bindingTxnId?: string;
  externalRelease?: (externalId: string, reason: string, signal?: AbortSignal) => Promise<{ released: boolean; summary?: string }>;
}

/** Runtime error codes are stable so callers can route without string matching. */
export type SessionErrorCode = "NO_SESSION" | "FOREIGN_SESSION" | "NOT_OPEN" | "GENERATION_DRIFT" | "BINDING_MISMATCH";

export class SessionRegistryError extends Error {
  public constructor(public readonly code: SessionErrorCode, message: string) {
    super(message);
    this.name = "SessionRegistryError";
  }
}

interface LiveEntry {
  handle: ContainerSessionHandle;
  runtime: Pick<ContainerRuntimePort, "sessionWrite" | "sessionRead" | "sessionSignal" | "closeSession">;
  ownerLane: Lane;
  generation: number;
}

/**
 * Owner-scoped registry over the container session primitives.  It mints the
 * durable session id, records every open/interact/close as a Control Store
 * event (so the transcript survives replay), and refuses cross-lane access.
 *
 * A process-local docker-exec child cannot survive a ProofBlade restart, so
 * recovery supersedes it instead of reviving a dead socket. Broker-owned
 * sessions use the same registry but carry an external handle that the
 * recovery service may inspect and adopt into a fresh registry.
 */
export class SessionRegistry {
  private readonly live = new Map<string, LiveEntry>();
  /** Handles for processes that exited during interaction but still need close cleanup. */
  private readonly exited = new Map<string, LiveEntry>();

  public constructor(
    private readonly runId: string,
    private readonly runtime: ContainerRuntimePort,
    private readonly control: ControlStore,
    private readonly externalResources?: ExternalResourceRegistry,
    private readonly bindingTransactions?: BindingTransactionCoordinator,
  ) {}

  /**
   * Build a registry for the RECOVERY path, where no container runtime exists
   * (a restart has no live handles). Its live map is empty, so supersedeOrphans
   * correctly treats every durably-OPEN session as an orphan. The runtime stub
   * throws if any session I/O is attempted — recovery only reads the snapshot
   * and dispatches supersede events, so it is never called.
   */
  public static forRecovery(runId: string, control: ControlStore, externalResources?: ExternalResourceRegistry): SessionRegistry {
    const stub = new Proxy({} as ContainerRuntimePort, {
      get() { throw new Error("SessionRegistry.forRecovery has no container runtime; only supersede/dispose are valid"); },
    });
    return new SessionRegistry(runId, stub, control, externalResources);
  }

  public async open(input: OpenSessionInput): Promise<SessionRecord> {
    const sessionId = id("SES");
    const resourceId = externalResourceId(sessionId);
    const coordinator = this.bindingCoordinator();
    await this.externalResources?.register({
      id: resourceId,
      kind: externalResourceKind(input.kind),
      runId: this.runId,
      generation: input.ref.generation,
      ownerLane: input.ownerLane,
    });
    let handle: ContainerSessionHandle | undefined;
    let bindingTxnId: string | undefined;
    let preparedIdentityHash: string | undefined;
    try {
      handle = await this.runtime.openSession(input.ref, {
        command: input.command,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.waitTimeoutMs ? { waitTimeoutMs: input.waitTimeoutMs } : {}),
        ...(input.idleSilenceMs ? { idleSilenceMs: input.idleSilenceMs } : {}),
      });
      const registration = {
        id: resourceId,
        kind: externalResourceKind(input.kind),
        runId: this.runId,
        generation: input.ref.generation,
        ownerLane: input.ownerLane,
        externalId: handle.externalId ?? handle.sessionId,
      } as const;
      if (coordinator) {
        const prepared = await coordinator.prepare({ sessionId, resource: registration });
        bindingTxnId = prepared.bindingTxnId;
        preparedIdentityHash = prepared.identityHash;
      } else {
        const started = await this.externalResources?.registerStarted(registration);
        bindingTxnId = started?.bindingTxnId;
      }
    } catch (error) {
      if (handle) await this.runtime.closeSession(handle).catch(() => undefined);
      await this.externalResources?.markUnknown(resourceId, error instanceof Error ? error.message : String(error)).catch(() => undefined);
      throw error;
    }
    if (coordinator && bindingTxnId) preparedIdentityHash = (await coordinator.get(bindingTxnId))?.identityHash;
    const record: Omit<SessionRecord, "createdSeq" | "updatedSeq" | "status" | "interactions"> = {
      id: sessionId,
      runId: this.runId,
      kind: input.kind,
      ownerLane: input.ownerLane,
      generation: input.ref.generation,
      externalId: handle!.externalId ?? handle!.sessionId,
      ...(bindingTxnId ? { bindingTxnId } : {}),
      ...(preparedIdentityHash ? { bindingIdentityHash: preparedIdentityHash } : {}),
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    };
    let controlSessionCommitted = false;
    try {
      if (coordinator && bindingTxnId) {
        const intent = await coordinator.get(bindingTxnId);
        if (!intent) throw new Error(`Unknown binding transaction: ${bindingTxnId}`);
        await coordinator.commitControl(intent, record);
        controlSessionCommitted = true;
        await coordinator.finalize(intent);
      } else {
        await this.control.dispatch(this.runId, { type: "session_opened", session: record, lane: input.ownerLane });
        controlSessionCommitted = true;
        await this.externalResources?.markControlBound(resourceId, sessionId, bindingTxnId);
      }
    } catch (error) {
      if (!controlSessionCommitted) {
        try {
          controlSessionCommitted = (await this.control.snapshot(this.runId)).sessions[sessionId]?.status === "OPEN";
        } catch {
          // Preserve the original failure if the Control Store cannot be read.
        }
      }
      if (controlSessionCommitted) {
        await this.externalResources?.markUnknown(resourceId, error instanceof Error ? error.message : String(error)).catch(() => undefined);
      } else {
        // Roll back the runtime process if the durable open could not be recorded,
        // so a failed open never leaks an orphaned docker-exec child.
        await this.runtime.closeSession(handle!).catch(() => undefined);
        await this.externalResources?.markReleased(resourceId, "durable session open rejected").catch(() => undefined);
      }
      throw error;
    }
    this.live.set(sessionId, { handle: handle!, runtime: this.runtime, ownerLane: input.ownerLane, generation: input.ref.generation });
    return (await this.control.snapshot(this.runId)).sessions[sessionId]!;
  }

  /**
   * Commit a session whose process/socket was created by a durable external
   * broker.  The method never calls `openSession`; it only binds the already
   * allocated runtime handle to the durable owner record.
   */
  public async openExternal(input: OpenSessionInput, binding: ExternalSessionBinding): Promise<SessionRecord> {
    assertSafeBindingIdentity(binding);
    if (binding.handle.ref.runId !== this.runId || binding.handle.ref.generation !== input.ref.generation) throw new SessionRegistryError("GENERATION_DRIFT", "External session handle does not match the current run generation");
    const snapshot = await this.control.snapshot(this.runId);
    if (snapshot.generation !== input.ref.generation) throw new SessionRegistryError("GENERATION_DRIFT", "External session binding does not match the current run generation");
    const resourceId = externalResourceId(binding.sessionId);
    const resourceKind = externalResourceKind(input.kind);
    const registration = {
      id: resourceId,
      kind: resourceKind,
      runId: this.runId,
      generation: input.ref.generation,
      ownerLane: input.ownerLane,
      externalId: binding.externalId,
      ...(binding.requestKey ? { requestKey: binding.requestKey } : {}),
      ...(binding.policyHash ? { policyHash: binding.policyHash } : {}),
      ...(binding.recipeHash ? { recipeHash: binding.recipeHash } : {}),
      ...(binding.scopeHash ? { scopeHash: binding.scopeHash } : {}),
      ...(binding.bindingTxnId ? { bindingTxnId: binding.bindingTxnId } : {}),
    } as const;
    const coordinator = this.bindingCoordinator();
    const prepared = coordinator
      ? await coordinator.prepare({ sessionId: binding.sessionId, resource: registration })
      : undefined;
    const started = prepared ?? await this.externalResources?.registerStarted(registration);
    const resolvedBindingTxnId = started?.bindingTxnId ?? binding.bindingTxnId;
    const record: Omit<SessionRecord, "createdSeq" | "updatedSeq" | "status" | "interactions"> = {
      id: binding.sessionId,
      runId: this.runId,
      kind: input.kind,
      ownerLane: input.ownerLane,
      generation: input.ref.generation,
      externalId: binding.externalId,
      ...(binding.requestKey ? { requestKey: binding.requestKey } : {}),
      ...(binding.policyHash ? { policyHash: binding.policyHash } : {}),
      ...(binding.recipeHash ? { recipeHash: binding.recipeHash } : {}),
      ...(binding.scopeHash ? { scopeHash: binding.scopeHash } : {}),
      ...(resolvedBindingTxnId ? { bindingTxnId: resolvedBindingTxnId } : {}),
      ...(prepared?.identityHash ? { bindingIdentityHash: prepared.identityHash } : {}),
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    };
    let controlSessionCommitted = false;
    try {
      if (coordinator && prepared) {
        await coordinator.commitControl(prepared, record);
        controlSessionCommitted = true;
        await coordinator.finalize(prepared);
      } else {
        await this.control.dispatch(this.runId, { type: "session_opened", session: record, lane: input.ownerLane });
        controlSessionCommitted = true;
        await this.externalResources?.markControlBound(resourceId, binding.sessionId, resolvedBindingTxnId);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (controlSessionCommitted) {
        await this.externalResources?.markUnknown(resourceId, reason).catch(() => undefined);
      } else if (binding.externalRelease) {
        try {
          const released = await binding.externalRelease(binding.externalId, "external session owner commit failed");
          if (released.released) await this.externalResources?.markReleased(resourceId, released.summary ?? reason);
          else await this.externalResources?.markUnknown(resourceId, released.summary ?? reason);
        } catch (releaseError) {
          await this.externalResources?.markUnknown(resourceId, releaseError instanceof Error ? releaseError.message : String(releaseError)).catch(() => undefined);
        }
      } else {
        await binding.runtime.closeSession(binding.handle).catch(() => undefined);
        await this.externalResources?.markUnknown(resourceId, reason).catch(() => undefined);
      }
      throw error;
    }
    this.live.set(binding.sessionId, { handle: binding.handle, runtime: binding.runtime, ownerLane: input.ownerLane, generation: input.ref.generation });
    return (await this.control.snapshot(this.runId)).sessions[binding.sessionId]!;
  }

  /**
   * Adopt a broker-owned Pwn process without opening a replacement process.
   * The durable session must still be OPEN at the current generation and the
   * opaque handle must carry the same run/generation binding. This method only
   * installs the handle in the process-local live map; no session_opened event
   * or external-resource registration is emitted.
   */
  public async adopt(
    ownerLane: Lane,
    sessionId: string,
    handle: ContainerSessionHandle,
    runtime: Pick<ContainerRuntimePort, "sessionWrite" | "sessionRead" | "sessionSignal" | "closeSession">,
  ): Promise<SessionRecord> {
    const snapshot = await this.control.snapshot(this.runId);
    const record = snapshot.sessions[sessionId];
    if (!record) throw new SessionRegistryError("NO_SESSION", `Unknown session: ${sessionId}`);
    if (record.ownerLane !== ownerLane) throw new SessionRegistryError("FOREIGN_SESSION", `Session ${sessionId} is owned by ${record.ownerLane}, not ${ownerLane}`);
    if (record.status !== "OPEN") throw new SessionRegistryError("NOT_OPEN", `Session ${sessionId} is ${record.status}, not OPEN`);
    if (record.kind !== "pwn-local" && record.kind !== "pwn-remote") {
      throw new SessionRegistryError("BINDING_MISMATCH", `Session ${sessionId} is not a Pwn session`);
    }
    if (record.runId !== this.runId || record.generation !== snapshot.generation || handle.ref.runId !== this.runId || handle.ref.generation !== record.generation) {
      throw new SessionRegistryError("GENERATION_DRIFT", `Session ${sessionId} does not match the current run generation`);
    }
    if (!record.externalId || handle.externalId !== record.externalId) {
      throw new SessionRegistryError("BINDING_MISMATCH", `Session ${sessionId} has a different opaque runtime handle`);
    }
    const existing = this.live.get(sessionId) ?? this.exited.get(sessionId);
    if (existing) {
      if (existing.handle.externalId !== handle.externalId) throw new SessionRegistryError("BINDING_MISMATCH", `Session ${sessionId} is already bound to a different runtime handle`);
      if (this.exited.has(sessionId)) throw new SessionRegistryError("NOT_OPEN", `Session ${sessionId} has exited; only close is allowed`);
      return record;
    }
    const resourceId = externalResourceId(sessionId);
    const started = await this.externalResources?.registerStarted({
      id: resourceId,
      kind: "pwn-session",
      runId: record.runId,
      generation: record.generation,
      ownerLane: record.ownerLane,
      externalId: handle.externalId,
      ...(record.requestKey ? { requestKey: record.requestKey } : {}),
      ...(record.policyHash ? { policyHash: record.policyHash } : {}),
      ...(record.recipeHash ? { recipeHash: record.recipeHash } : {}),
      ...(record.scopeHash ? { scopeHash: record.scopeHash } : {}),
      ...(record.bindingTxnId ? { bindingTxnId: record.bindingTxnId } : {}),
    });
    await this.externalResources?.markControlBound(resourceId, sessionId, started?.bindingTxnId ?? record.bindingTxnId);
    this.live.set(sessionId, { handle, runtime, ownerLane, generation: record.generation });
    return record;
  }

  public async write(ownerLane: Lane, sessionId: string, data: string | Uint8Array, options?: ContainerSessionReadOptions): Promise<SessionInteraction> {
    const entry = this.requireOwned(ownerLane, sessionId);
    const result = await entry.runtime.sessionWrite(entry.handle, data, options);
    await this.recordInteraction(ownerLane, sessionId, result);
    return { sessionId, ...result };
  }

  public async read(ownerLane: Lane, sessionId: string, options?: ContainerSessionReadOptions): Promise<SessionInteraction> {
    const entry = this.requireOwned(ownerLane, sessionId);
    const result = await entry.runtime.sessionRead(entry.handle, options);
    await this.recordInteraction(ownerLane, sessionId, result);
    return { sessionId, ...result };
  }

  public async signal(ownerLane: Lane, sessionId: string, signal: NodeJS.Signals): Promise<boolean> {
    const entry = this.requireOwned(ownerLane, sessionId);
    const delivered = await entry.runtime.sessionSignal(entry.handle, signal);
    // Record the ACTUAL delivery result so the durable event distinguishes "we
    // asked to send" from "the signal reached a live process". A false here means
    // the target pid was already gone / the kill failed.
    await this.control.dispatch(this.runId, { type: "session_signaled", sessionId, signal, delivered, lane: ownerLane });
    return delivered;
  }

  public async close(ownerLane: Lane, sessionId: string, reason?: string): Promise<{ exitCode: number | null }> {
    const entry = this.requireOwned(ownerLane, sessionId, true);
    const outcome = await entry.runtime.closeSession(entry.handle);
    this.live.delete(sessionId);
    this.exited.delete(sessionId);
    try {
      await this.control.dispatch(this.runId, { type: "session_closed", sessionId, reason, exitCode: outcome.exitCode, lane: ownerLane });
    } finally {
      await this.externalResources?.markReleased(externalResourceId(sessionId), reason ?? "session closed").catch(() => undefined);
    }
    return outcome;
  }

  /**
   * Recovery entry point: mark every OPEN session whose generation is older than
   * the current run generation SUPERSEDED.  The dead docker-exec child is not
   * revived; a fresh reproduce must re-establish the connection.
   */
  public async supersedeStale(currentGeneration: number, reason = "generation drift after recovery"): Promise<number> {
    const snapshot = await this.control.snapshot(this.runId);
    let superseded = 0;
    for (const session of Object.values(snapshot.sessions)) {
      if (session.status !== "OPEN" || session.generation >= currentGeneration) continue;
      this.live.delete(session.id);
      await this.control.dispatch(this.runId, { type: "session_superseded", sessionId: session.id, reason, lane: session.ownerLane });
      await this.externalResources?.markUnknown(externalResourceId(session.id), reason).catch(() => undefined);
      superseded += 1;
    }
    return superseded;
  }

  /**
   * Recovery entry point for a process restart at the SAME generation.  A
   * session's docker-exec child dies with the ProofBlade process that spawned
   * it, so any session that is durably OPEN but not tracked in THIS registry's
   * live map is an orphan whose host process is gone — supersede it instead of
   * leaving it OPEN forever.  Sessions this fresh registry actually owns (just
   * opened) are in `live` and are left untouched.  Generation-based drift is
   * still handled by {@link supersedeStale}.
   */
  public async supersedeOrphans(reason = "process restart orphaned the session", protectedSessionIds: ReadonlySet<string> = new Set()): Promise<number> {
    const snapshot = await this.control.snapshot(this.runId);
    let superseded = 0;
    for (const session of Object.values(snapshot.sessions)) {
      if (session.status !== "OPEN" || this.live.has(session.id) || protectedSessionIds.has(session.id)) continue;
      await this.control.dispatch(this.runId, { type: "session_superseded", sessionId: session.id, reason, lane: session.ownerLane });
      await this.externalResources?.markUnknown(externalResourceId(session.id), reason).catch(() => undefined);
      superseded += 1;
    }
    return superseded;
  }

  /** Best-effort teardown of every live session; called on lane shutdown. */
  public async disposeAll(reason = "lane shutdown"): Promise<void> {
    for (const [sessionId, entry] of [...this.live, ...this.exited]) {
      await entry.runtime.closeSession(entry.handle).catch(() => undefined);
      this.live.delete(sessionId);
      this.exited.delete(sessionId);
      await this.control.dispatch(this.runId, { type: "session_closed", sessionId, reason, lane: entry.ownerLane }).catch(() => undefined);
      await this.externalResources?.markReleased(externalResourceId(sessionId), reason).catch(() => undefined);
    }
  }

  private async recordInteraction(ownerLane: Lane, sessionId: string, result: ContainerSessionResult): Promise<void> {
    await this.control.dispatch(this.runId, {
      type: "session_interacted",
      sessionId,
      waitReason: result.waitReason,
      ...(result.exited ? { exited: true, exitCode: result.exitCode ?? null } : {}),
      lane: ownerLane,
    });
    if (result.exited) {
      const entry = this.live.get(sessionId);
      if (entry) {
        this.live.delete(sessionId);
        this.exited.set(sessionId, entry);
      }
    }
  }

  private requireOwned(ownerLane: Lane, sessionId: string, allowExited = false): LiveEntry {
    const entry = this.live.get(sessionId) ?? (allowExited ? this.exited.get(sessionId) : undefined);
    if (!entry) {
      if (this.exited.has(sessionId)) throw new SessionRegistryError("NOT_OPEN", `Session ${sessionId} has exited; only close is allowed`);
      throw new SessionRegistryError("NO_SESSION", `Unknown session: ${sessionId}`);
    }
    if (entry.ownerLane !== ownerLane) throw new SessionRegistryError("FOREIGN_SESSION", `Session ${sessionId} is owned by ${entry.ownerLane}, not ${ownerLane}`);
    return entry;
  }

  private bindingCoordinator(): BindingTransactionCoordinator | undefined {
    return this.externalResources ? this.bindingTransactions ?? new BindingTransactionCoordinator(this.control, this.externalResources) : undefined;
  }
}

function externalResourceId(sessionId: string): string {
  return `session:${sessionId}`;
}

function externalResourceKind(kind: SessionKind): ExternalResourceKind {
  if (kind === "pwn-local" || kind === "pwn-remote") return "pwn-session";
  if (kind === "http") return "http-session";
  return "browser-context";
}

function assertSafeBindingIdentity(binding: ExternalSessionBinding): void {
  if (!isSafeText(binding.sessionId) || !isSafeText(binding.externalId)) throw new SessionRegistryError("BINDING_MISMATCH", "External session binding identity is invalid");
  if (binding.handle.externalId !== binding.externalId) {
    throw new SessionRegistryError("BINDING_MISMATCH", "External session handle does not match its binding identity");
  }
  if (typeof binding.runtime.sessionWrite !== "function" || typeof binding.runtime.sessionRead !== "function" || typeof binding.runtime.sessionSignal !== "function" || typeof binding.runtime.closeSession !== "function") {
    throw new SessionRegistryError("BINDING_MISMATCH", "External session runtime is missing required operations");
  }

}

function isSafeText(value: unknown, maxLength = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}
