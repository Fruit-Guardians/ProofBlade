import type { Lane } from "../domain/types.js";
import type { ControlStore } from "../control/control-store.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { ExperimentGate } from "../competition/experiment-gate.js";
import { HttpSessionBackend } from "./http-session.js";
import { hostMatches } from "../pwn/pwn-tools.js";

/**
 * Model-facing bridge for interactive web exploration.  It wraps the durable
 * `HttpSessionBackend` (host-side fetch, origin-locked, cookie jar + CSRF reuse,
 * artifact capture, experiment gate) so the model can drive a STATEFUL multi-step
 * HTTP flow — login then act, CSRF token reuse — with cookies persisting across
 * calls.  A one-shot `curl`/`bash` cannot keep that state; this is the gap the
 * verifier-only `web_reproduce` path does not fill.
 *
 * This is the exploration counterpart to `web_reproduce`: the model interacts
 * here, and confirms a solve through the immutable `web_reproduce` verifier.  It
 * never submits, gates, or judges anything.
 */
export interface WebOpenInput {
  /** Base URL of the target, e.g. "http://10.0.0.9:80/". Scope-checked. */
  baseUrl: string;
}

export interface WebRequestInput {
  sessionId: string;
  /** Path or absolute URL; resolved against the session baseUrl and origin-locked. */
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface WebRequestView {
  sessionId: string;
  status: number;
  headers: Record<string, string>;
  bodyViewport: string;
  truncated: boolean;
  stateHash: string;
  artifactId: string;
}

/** The task's target boundary, used to reject a model-supplied URL outside scope. */
export interface WebScope {
  allowedHosts: string[];
  allowedPorts: number[];
}

export interface WebToolHandlerDeps {
  runId: string;
  controlStore: ControlStore;
  artifactStore: ArtifactStore;
  experimentGate?: ExperimentGate;
  ownerLane?: Lane;
  scope?: WebScope;
  /** Injectable fetch for tests; forwarded to HttpSessionBackend. */
  fetchImpl?: typeof fetch;
}

const VIEWPORT_MAX = 4_000;

interface LiveWebSession {
  backend: HttpSessionBackend;
  baseUrl: string;
}

export class WebToolHandler {
  // HttpSessionBackend does not expose its base URL, so track it alongside the
  // backend for list()/replay() (which reopens a clean session at the same origin).
  private readonly sessions = new Map<string, LiveWebSession>();
  private readonly ownerLane: Lane;

  public constructor(private readonly deps: WebToolHandlerDeps) {
    this.ownerLane = deps.ownerLane ?? "main";
  }

  public async open(input: WebOpenInput): Promise<{ sessionId: string; baseUrl: string }> {
    this.assertUrlAllowed(input.baseUrl);
    const backend = await HttpSessionBackend.open({
      runId: this.deps.runId,
      baseUrl: input.baseUrl,
      ownerLane: this.ownerLane,
      controlStore: this.deps.controlStore,
      artifactStore: this.deps.artifactStore,
      ...(this.deps.scope ? { allowedHosts: this.deps.scope.allowedHosts } : {}),
      ...(this.deps.experimentGate ? { experimentGate: this.deps.experimentGate } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
    this.sessions.set(backend.sessionId, { backend, baseUrl: input.baseUrl });
    return { sessionId: backend.sessionId, baseUrl: input.baseUrl };
  }

  public async request(input: WebRequestInput, signal?: AbortSignal): Promise<WebRequestView> {
    const { backend } = this.require(input.sessionId);
    const resp = await backend.request(input.path, {
      ...(input.method ? { method: input.method } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    }, signal);
    return this.view(input.sessionId, resp);
  }

  /**
   * Re-issue a request in a NEW clean session (fresh cookie jar, same baseUrl) to
   * check whether it still works without accumulated auth state.  The clean
   * session's own baseUrl is derived from the model-supplied path resolved
   * against the existing session — but since HttpSessionBackend is origin-locked,
   * we reopen against the same origin and issue the single request there.
   */
  public async replay(input: WebRequestInput, signal?: AbortSignal): Promise<WebRequestView> {
    const { baseUrl } = this.require(input.sessionId);
    this.assertUrlAllowed(baseUrl);
    const clean = await HttpSessionBackend.open({
      runId: this.deps.runId,
      baseUrl,
      ownerLane: this.ownerLane,
      controlStore: this.deps.controlStore,
      artifactStore: this.deps.artifactStore,
      ...(this.deps.scope ? { allowedHosts: this.deps.scope.allowedHosts } : {}),
      ...(this.deps.experimentGate ? { experimentGate: this.deps.experimentGate } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
    try {
      const resp = await clean.request(input.path, {
        ...(input.method ? { method: input.method } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
      }, signal);
      return this.view(clean.sessionId, resp);
    } finally {
      await clean.close("replay-complete").catch(() => undefined);
    }
  }

  public async close(sessionId: string): Promise<void> {
    const { backend } = this.require(sessionId);
    await backend.close("closed by model");
    this.sessions.delete(sessionId);
  }

  public list(): Array<{ sessionId: string; baseUrl: string }> {
    return [...this.sessions.values()].map(({ backend, baseUrl }) => ({ sessionId: backend.sessionId, baseUrl }));
  }

  /** Best-effort teardown of every live session (lane shutdown). */
  public async disposeAll(reason = "lane shutdown"): Promise<void> {
    for (const { backend } of this.sessions.values()) await backend.close(reason).catch(() => undefined);
    this.sessions.clear();
  }

  /**
   * Reject a URL outside the task scope BEFORE opening. HttpSessionBackend already
   * checks the host against allowedHosts and locks the origin, but it does not
   * check the port or reject non-http(s) schemes with a task-scope message, so we
   * validate host + port + scheme here to match PwnScope's app-layer boundary.
   */
  private assertUrlAllowed(url: string): void {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error(`web url is not a valid URL: ${url}`); }
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
    if (scheme !== "http" && scheme !== "https") throw new Error(`web url scheme ${scheme} is not allowed (http/https only)`);
    if (!this.deps.scope) return;
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port ? Number(parsed.port) : scheme === "https" ? 443 : 80;
    const { allowedHosts, allowedPorts } = this.deps.scope;
    if (allowedHosts.length > 0 && !allowedHosts.some((pattern) => hostMatches(host, pattern))) {
      throw new Error(`web url host ${host} is outside the task scope`);
    }
    if (allowedPorts.length > 0 && !allowedPorts.includes(port)) {
      throw new Error(`web url port ${port} is outside the task scope`);
    }
  }

  private view(sessionId: string, resp: { status: number; headers: Record<string, string>; body: string; artifactId: string; stateHash: string }): WebRequestView {
    const truncated = resp.body.length > VIEWPORT_MAX;
    const bodyViewport = truncated ? `…${resp.body.slice(-VIEWPORT_MAX)}` : resp.body;
    return { sessionId, status: resp.status, headers: resp.headers, bodyViewport, truncated, stateHash: resp.stateHash, artifactId: resp.artifactId };
  }

  private require(sessionId: string): LiveWebSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown web session: ${sessionId}`);
    return session;
  }
}
