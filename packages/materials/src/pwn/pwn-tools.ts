import type { Lane } from "../domain/types.js";
import type { ContainerRef } from "../container/contracts.js";
import type { SessionRegistry } from "../container/session-registry.js";
import { PwnSession } from "./pwn-session.js";
import { appendByte } from "./bytes.js";
import type { PwnReproducer, ExploitRecipe, ExploitStage, PwnReproduceOutcome } from "../verification/pwn-reproducer.js";

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

  public constructor(
    private readonly runId: string,
    private readonly registry: SessionRegistry,
    private readonly reproducer: PwnReproducer,
    private readonly refProvider: () => ContainerRef,
    private readonly ownerLane: Lane = "executor",
    /** Task scope; when set, a remote endpoint outside it is rejected at the app layer. */
    private readonly scope?: PwnScope,
    private readonly reproductionPolicy?: PwnReproductionPolicy,
  ) {}

  public async open(input: PwnOpenInput): Promise<{ sessionId: string; kind: string; endpoint?: string }> {
    const ref = this.refProvider();
    if (input.kind === "remote") this.assertEndpointAllowed(input.endpoint);
    const session = input.kind === "remote"
      ? await PwnSession.openRemote(this.registry, { ref, ownerLane: this.ownerLane, command: input.command, endpoint: input.endpoint ?? "", ...opt(input) })
      : await PwnSession.openLocal(this.registry, { ref, ownerLane: this.ownerLane, command: input.command, ...opt(input) });
    this.sessions.set(session.sessionId, session);
    return { sessionId: session.sessionId, kind: input.kind, ...(input.endpoint ? { endpoint: input.endpoint } : {}) };
  }

  public async send(sessionId: string, data: string | Uint8Array, line = false): Promise<PwnViewport> {
    const session = this.require(sessionId);
    // Preserve exact bytes: for binary payloads append the newline as a byte so
    // sendLine's string path cannot corrupt 0x00/0xff via UTF-8 round-tripping.
    let result: Awaited<ReturnType<PwnSession["send"]>>;
    if (typeof data === "string") {
      result = line ? await session.sendLine(data) : await session.send(data);
    } else {
      const payload = line ? appendByte(data, 0x0a) : data;
      result = await session.send(payload);
    }
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
   * path. The task/runtime, rather than the model, owns the clean target and
   * flag extraction contract.
   */
  public async reproduce(stages: ExploitStage[]): Promise<PwnReproduceOutcome> {
    if (!this.reproductionPolicy) throw new Error("pwn reproduction is unavailable because this task has no immutable target and flag verifier configuration");
    const { target, flagPath, flagPattern } = this.reproductionPolicy;
    if (target.kind === "remote") this.assertEndpointAllowed(target.endpoint);
    const recipe: ExploitRecipe = { stages, flagPath, flagPattern };
    return await this.reproducer.reproduce(this.runId, recipe, async () => {
      const ref = this.refProvider();
      return target.kind === "local"
        ? await PwnSession.openLocal(this.registry, { ref, ownerLane: this.ownerLane, command: target.command })
        : await PwnSession.openRemote(this.registry, { ref, ownerLane: this.ownerLane, command: target.command, endpoint: target.endpoint });
    });
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
    if (exited) this.sessions.delete(sessionId);
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

function opt(input: PwnOpenInput): { cwd?: string; idleSilenceMs?: number; waitTimeoutMs?: number } {
  return {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.idleSilenceMs ? { idleSilenceMs: input.idleSilenceMs } : {}),
    ...(input.waitTimeoutMs ? { waitTimeoutMs: input.waitTimeoutMs } : {}),
  };
}
