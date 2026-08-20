import type { Lane } from "../domain/types.js";
import type { ContainerRef } from "../container/contracts.js";
import type { SessionRegistry } from "../container/session-registry.js";
import { PwnSession } from "./pwn-session.js";
import type { PwnReproducer, ExploitRecipe, PwnReproduceOutcome } from "../verification/pwn-reproducer.js";

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

  public constructor(
    private readonly runId: string,
    private readonly registry: SessionRegistry,
    private readonly reproducer: PwnReproducer,
    private readonly refProvider: () => ContainerRef,
    private readonly ownerLane: Lane = "executor",
  ) {}

  public async open(input: PwnOpenInput): Promise<{ sessionId: string; kind: string; endpoint?: string }> {
    const ref = this.refProvider();
    const session = input.kind === "remote"
      ? await PwnSession.openRemote(this.registry, { ref, ownerLane: this.ownerLane, command: input.command, endpoint: input.endpoint ?? "", ...opt(input) })
      : await PwnSession.openLocal(this.registry, { ref, ownerLane: this.ownerLane, command: input.command, ...opt(input) });
    this.sessions.set(session.sessionId, session);
    return { sessionId: session.sessionId, kind: input.kind, ...(input.endpoint ? { endpoint: input.endpoint } : {}) };
  }

  public async send(sessionId: string, data: string, line = false): Promise<PwnViewport> {
    const session = this.require(sessionId);
    const result = line ? await session.sendLine(data) : await session.send(data);
    return this.viewport(sessionId, result.data, result.exited, result.matched);
  }

  public async recv(sessionId: string, until: string, maxReads?: number): Promise<PwnViewport> {
    const session = this.require(sessionId);
    const result = await session.recvUntil(until, maxReads ? { maxReads } : {});
    return this.viewport(sessionId, result.data, result.exited, result.matched);
  }

  public async signal(sessionId: string, signal: NodeJS.Signals): Promise<{ delivered: boolean }> {
    this.require(sessionId);
    const delivered = await this.registry.signal(this.ownerLane, sessionId, signal);
    return { delivered };
  }

  public async shellProbe(sessionId: string): Promise<{ ok: boolean; marker: string }> {
    return await this.require(sessionId).shellProbe();
  }

  public async close(sessionId: string): Promise<{ exitCode: number | null }> {
    const session = this.require(sessionId);
    const outcome = await this.registry.close(this.ownerLane, sessionId, "closed by model");
    void session;
    this.sessions.delete(sessionId);
    return outcome;
  }

  public list(): Array<{ sessionId: string; kind: string }> {
    return [...this.sessions.values()].map((session) => ({ sessionId: session.sessionId, kind: session.record.kind }));
  }

  /**
   * Open a FRESH session and run the barrier-gated reproduce; the ONLY success
   * path.  `reproduce.target` decides whether the clean run is local or remote,
   * mirroring the design's local→remote clean-reproduce requirement.
   */
  public async reproduce(recipe: ExploitRecipe, target: PwnReproduceTarget): Promise<PwnReproduceOutcome> {
    return await this.reproducer.reproduce(this.runId, recipe, async () => {
      const ref = this.refProvider();
      return target.kind === "local"
        ? await PwnSession.openLocal(this.registry, { ref, ownerLane: this.ownerLane, command: target.command })
        : await PwnSession.openRemote(this.registry, { ref, ownerLane: this.ownerLane, command: target.command, endpoint: target.endpoint });
    });
  }

  private viewport(sessionId: string, data: string, exited: boolean, matched?: boolean): PwnViewport {
    const truncated = data.length > VIEWPORT_MAX;
    const viewport = truncated ? `…${data.slice(-VIEWPORT_MAX)}` : data;
    return { sessionId, viewport, ...(matched !== undefined ? { matched } : {}), exited, truncated };
  }

  private require(sessionId: string): PwnSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown pwn session: ${sessionId}`);
    return session;
  }
}

function opt(input: PwnOpenInput): { cwd?: string; idleSilenceMs?: number; waitTimeoutMs?: number } {
  return {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.idleSilenceMs ? { idleSilenceMs: input.idleSilenceMs } : {}),
    ...(input.waitTimeoutMs ? { waitTimeoutMs: input.waitTimeoutMs } : {}),
  };
}
