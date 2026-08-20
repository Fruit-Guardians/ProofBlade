import type { ControlStore } from "../control/control-store.js";
import { id } from "../domain/utils.js";
import type { Lane, SessionKind, SessionRecord } from "../domain/types.js";
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

/** Runtime error codes are stable so callers can route without string matching. */
export type SessionErrorCode = "NO_SESSION" | "FOREIGN_SESSION" | "NOT_OPEN" | "GENERATION_DRIFT";

export class SessionRegistryError extends Error {
  public constructor(public readonly code: SessionErrorCode, message: string) {
    super(message);
    this.name = "SessionRegistryError";
  }
}

interface LiveEntry {
  handle: ContainerSessionHandle;
  ownerLane: Lane;
  generation: number;
}

/**
 * Owner-scoped registry over the container session primitives.  It mints the
 * durable session id, records every open/interact/close as a Control Store
 * event (so the transcript survives replay), and refuses cross-lane access.
 *
 * A session's underlying host process (a docker-exec child) cannot survive a
 * ProofBlade restart, so recovery does not try to revive it: `supersedeStale`
 * marks sessions from an older generation SUPERSEDED, and the domain solver is
 * expected to reproduce from a fresh connection rather than a dead socket.
 */
export class SessionRegistry {
  private readonly live = new Map<string, LiveEntry>();

  public constructor(
    private readonly runId: string,
    private readonly runtime: ContainerRuntimePort,
    private readonly control: ControlStore,
  ) {}

  public async open(input: OpenSessionInput): Promise<SessionRecord> {
    const handle = await this.runtime.openSession(input.ref, {
      command: input.command,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.env ? { env: input.env } : {}),
      ...(input.waitTimeoutMs ? { waitTimeoutMs: input.waitTimeoutMs } : {}),
      ...(input.idleSilenceMs ? { idleSilenceMs: input.idleSilenceMs } : {}),
    });
    const sessionId = id("SES");
    const record: Omit<SessionRecord, "createdSeq" | "updatedSeq" | "status" | "interactions"> = {
      id: sessionId,
      runId: this.runId,
      kind: input.kind,
      ownerLane: input.ownerLane,
      generation: input.ref.generation,
      externalId: handle.sessionId,
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    };
    try {
      await this.control.dispatch(this.runId, { type: "session_opened", session: record, lane: input.ownerLane });
    } catch (error) {
      // Roll back the runtime process if the durable open could not be recorded,
      // so a failed open never leaks an orphaned docker-exec child.
      await this.runtime.closeSession(handle).catch(() => undefined);
      throw error;
    }
    this.live.set(sessionId, { handle, ownerLane: input.ownerLane, generation: input.ref.generation });
    return (await this.control.snapshot(this.runId)).sessions[sessionId]!;
  }

  public async write(ownerLane: Lane, sessionId: string, data: string | Uint8Array, options?: ContainerSessionReadOptions): Promise<SessionInteraction> {
    const entry = this.requireOwned(ownerLane, sessionId);
    const result = await this.runtime.sessionWrite(entry.handle, data, options);
    await this.recordInteraction(ownerLane, sessionId, result);
    return { sessionId, ...result };
  }

  public async read(ownerLane: Lane, sessionId: string, options?: ContainerSessionReadOptions): Promise<SessionInteraction> {
    const entry = this.requireOwned(ownerLane, sessionId);
    const result = await this.runtime.sessionRead(entry.handle, options);
    await this.recordInteraction(ownerLane, sessionId, result);
    return { sessionId, ...result };
  }

  public async signal(ownerLane: Lane, sessionId: string, signal: NodeJS.Signals): Promise<boolean> {
    const entry = this.requireOwned(ownerLane, sessionId);
    const delivered = await this.runtime.sessionSignal(entry.handle, signal);
    await this.control.dispatch(this.runId, { type: "session_signaled", sessionId, signal, lane: ownerLane });
    return delivered;
  }

  public async close(ownerLane: Lane, sessionId: string, reason?: string): Promise<{ exitCode: number | null }> {
    const entry = this.requireOwned(ownerLane, sessionId);
    const outcome = await this.runtime.closeSession(entry.handle);
    this.live.delete(sessionId);
    await this.control.dispatch(this.runId, { type: "session_closed", sessionId, reason, exitCode: outcome.exitCode, lane: ownerLane });
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
      superseded += 1;
    }
    return superseded;
  }

  /** Best-effort teardown of every live session; called on lane shutdown. */
  public async disposeAll(reason = "lane shutdown"): Promise<void> {
    for (const [sessionId, entry] of [...this.live]) {
      await this.runtime.closeSession(entry.handle).catch(() => undefined);
      this.live.delete(sessionId);
      await this.control.dispatch(this.runId, { type: "session_closed", sessionId, reason, lane: entry.ownerLane }).catch(() => undefined);
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
  }

  private requireOwned(ownerLane: Lane, sessionId: string): LiveEntry {
    const entry = this.live.get(sessionId);
    if (!entry) throw new SessionRegistryError("NO_SESSION", `Unknown session: ${sessionId}`);
    if (entry.ownerLane !== ownerLane) throw new SessionRegistryError("FOREIGN_SESSION", `Session ${sessionId} is owned by ${entry.ownerLane}, not ${ownerLane}`);
    return entry;
  }
}
