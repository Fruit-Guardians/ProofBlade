import type { Lane } from "../domain/types.js";
import type { ControlStore } from "../control/control-store.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { ExperimentGate } from "../competition/experiment-gate.js";
import type { ExternalResourceRecord, ExternalResourceRegistry } from "../recovery/external-resource-registry.js";
import type { SessionRuntimeCreateBroker } from "../recovery/session-resource-adapter.js";
import type { SessionRuntimeCreateRequest } from "../recovery/session-runtime-wire.js";
import { HttpSessionBackend } from "./http-session.js";
import { hostMatches } from "../pwn/pwn-tools.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";

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
  evidenceId: string;
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
  /** Optional durable registry for interactive HTTP session ownership. */
  externalResources?: ExternalResourceRegistry;
  /** Optional broker release port for externally owned HTTP sessions. */
  externalRelease?: (externalId: string, reason: string, signal?: AbortSignal) => Promise<{ released: boolean; summary?: string }>;
  /** Optional durable broker for interactive HTTP sessions. */
  sessionBroker?: SessionRuntimeCreateBroker;
  /** Set when runtime.sessionBroker is configured but unavailable. */
  sessionRuntimeRequired?: boolean;
  /** HTTP backends adopted by recovery; they are already OPEN and must not be reopened. */
  recoveredSessions?: readonly WebRecoveredSession[];
}

const VIEWPORT_MAX = 4_000;

interface LiveWebSession {
  backend: HttpSessionBackend;
  baseUrl: string;
}

export interface WebRecoveredSession {
  backend: HttpSessionBackend;
  baseUrl: string;
}

export class WebToolHandler {
  // HttpSessionBackend does not expose its base URL, so track it alongside the
  // backend for list()/replay() (which reopens a clean session at the same origin).
  private readonly sessions = new Map<string, LiveWebSession>();
  private readonly closed = new Set<string>();
  private readonly ownerLane: Lane;

  public constructor(private readonly deps: WebToolHandlerDeps) {
    this.ownerLane = deps.ownerLane ?? "main";
    for (const recovered of deps.recoveredSessions ?? []) {
      if (this.sessions.has(recovered.backend.sessionId)) throw new Error(`Duplicate recovered web session: ${recovered.backend.sessionId}`);
      this.sessions.set(recovered.backend.sessionId, { backend: recovered.backend, baseUrl: recovered.baseUrl });
      this.closed.delete(recovered.backend.sessionId);
    }
}

  public async open(input: WebOpenInput): Promise<{ sessionId: string; baseUrl: string }> {
    this.assertUrlAllowed(input.baseUrl);
    if (this.deps.sessionRuntimeRequired && !this.deps.sessionBroker) throw new Error("Session runtime broker is configured but unavailable");
    const backend = this.deps.sessionBroker
      ? await this.openBrokerSession(input)
      : await HttpSessionBackend.open({
        runId: this.deps.runId,
        baseUrl: input.baseUrl,
        ownerLane: this.ownerLane,
        controlStore: this.deps.controlStore,
        artifactStore: this.deps.artifactStore,
        ...(this.deps.scope ? { allowedHosts: this.deps.scope.allowedHosts } : {}),
        ...(this.deps.scope ? { allowedPorts: this.deps.scope.allowedPorts } : {}),
        ...(this.deps.experimentGate ? { experimentGate: this.deps.experimentGate } : {}),
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        ...(this.deps.externalResources ? { externalResources: this.deps.externalResources } : {}),
        ...(this.deps.externalRelease ? { externalRelease: this.deps.externalRelease } : {}),
      });
    this.sessions.set(backend.sessionId, { backend, baseUrl: input.baseUrl });
    this.closed.delete(backend.sessionId);
    return { sessionId: backend.sessionId, baseUrl: input.baseUrl };
  }

  private async openBrokerSession(input: WebOpenInput): Promise<HttpSessionBackend> {
    const snapshot = await this.deps.controlStore.snapshot(this.deps.runId);
    const scope = this.deps.scope ?? { allowedHosts: [], allowedPorts: [] };
    const request: SessionRuntimeCreateRequest = {
      kind: "http-session",
      runId: this.deps.runId,
      generation: snapshot.generation,
      ownerLane: this.ownerLane,
      requestKey: sha256(canonicalJson({ runId: this.deps.runId, generation: snapshot.generation, baseUrl: input.baseUrl, scope })),
      http: { baseUrl: input.baseUrl, allowedHosts: scope.allowedHosts, allowedPorts: scope.allowedPorts },
      ...(this.deps.scope ? { scopeHash: sha256(canonicalJson(scope)) } : {}),
    };
    const idempotencyKey = sha256(canonicalJson(request));
    const created = await this.deps.sessionBroker!.create(request, idempotencyKey);
    if (created.state === "UNKNOWN" || !created.sessionId || !created.externalId) throw new Error(created.summary ?? "HTTP session broker did not create a durable session");
    const resource = brokerHttpResource(this.deps.runId, snapshot.generation, this.ownerLane, created.sessionId, created.externalId, request);
    const binding = await this.deps.sessionBroker!.createBinding(resource);
    if (binding.kind !== "http-session") throw new Error("HTTP session broker returned a Pwn binding");
    const options = {
      runId: this.deps.runId,
      baseUrl: input.baseUrl,
      ownerLane: this.ownerLane,
      sessionId: created.sessionId,
      externalId: created.externalId,
      stateHashHint: created.stateHash,
      fetchImpl: binding.fetchImpl,
      controlStore: this.deps.controlStore,
      artifactStore: this.deps.artifactStore,
      allowedHosts: scope.allowedHosts,
      allowedPorts: scope.allowedPorts,
      ...(this.deps.experimentGate ? { experimentGate: this.deps.experimentGate } : {}),
      ...(this.deps.externalResources ? { externalResources: this.deps.externalResources } : {}),
      requestKey: request.requestKey,
      ...(request.scopeHash ? { scopeHash: request.scopeHash } : {}),
      externalRelease: async (externalId: string, reason: string, signal?: AbortSignal) => await this.deps.sessionBroker!.release(resource, reason, signal),
    };
    const existing = (await this.deps.controlStore.snapshot(this.deps.runId)).sessions[created.sessionId];
    if (existing?.status === "OPEN") return await HttpSessionBackend.adopt(options, created.sessionId, created.stateHash);
    return await HttpSessionBackend.open(options);
  }

  public async request(input: WebRequestInput, signal?: AbortSignal): Promise<WebRequestView> {
    const { backend } = this.require(input.sessionId);
    const resp = await backend.request(input.path, {
      ...(input.method ? { method: input.method } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    }, signal);
    await this.recordExchange(input, resp, this.sessions.get(input.sessionId)?.baseUrl);
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
      ...(this.deps.scope ? { allowedPorts: this.deps.scope.allowedPorts } : {}),
      ...(this.deps.experimentGate ? { experimentGate: this.deps.experimentGate } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.externalResources ? { externalResources: this.deps.externalResources } : {}),
      ...(this.deps.externalRelease ? { externalRelease: this.deps.externalRelease } : {}),
    });
    try {
      const resp = await clean.request(input.path, {
        ...(input.method ? { method: input.method } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
      }, signal);
      await this.recordExchange(input, resp, baseUrl, clean.sessionId);
      return this.view(clean.sessionId, resp);
    } finally {
      await clean.close("replay-complete").catch(() => undefined);
    }
  }

  public async close(sessionId: string): Promise<void> {
    if (this.closed.has(sessionId)) return;
    const { backend } = this.require(sessionId);
    await backend.close("closed by model");
    this.sessions.delete(sessionId);
    this.closed.add(sessionId);
  }

  public list(): Array<{ sessionId: string; baseUrl: string }> {
    return [...this.sessions.values()].map(({ backend, baseUrl }) => ({ sessionId: backend.sessionId, baseUrl }));
  }

  /** Best-effort teardown of every live session (lane shutdown). */
  public async disposeAll(reason = "lane shutdown"): Promise<void> {
    for (const [sessionId, { backend }] of this.sessions) {
      await backend.close(reason).catch(() => undefined);
      this.closed.add(sessionId);
    }
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

  private view(sessionId: string, resp: { status: number; headers: Record<string, string>; body: string; artifactId: string; stateHash: string; evidenceId: string }): WebRequestView {
    const truncated = resp.body.length > VIEWPORT_MAX;
    const bodyViewport = truncated ? `…${resp.body.slice(-VIEWPORT_MAX)}` : resp.body;
    return { sessionId, status: resp.status, headers: resp.headers, bodyViewport, truncated, stateHash: resp.stateHash, artifactId: resp.artifactId, evidenceId: resp.evidenceId };
  }

  private async recordExchange(
    input: WebRequestInput,
    response: { status: number; artifactId: string; stateHash: string; evidenceId: string },
    baseUrl?: string,
    sessionId = input.sessionId,
  ): Promise<void> {
    if (!baseUrl) return;
    const parsed = new URL(baseUrl);
    const method = (input.method ?? "GET").toUpperCase();
    const requestRecord = {
      id: id("WEB-REQUEST"),
      kind: "web_request" as const,
      summary: `HTTP ${method} ${input.path} returned ${response.status}.`,
      artifactIds: [response.artifactId],
      evidenceIds: [response.evidenceId],
      method,
      path: input.path,
      status: response.status,
      sessionId,
      stateHash: response.stateHash,
    };
    await this.deps.controlStore.dispatchTransaction(this.deps.runId, (snapshot) => {
      if (!["web", "mixed", "unknown"].includes(snapshot.task.target_kind)) return { commands: [], project: () => undefined };
      // Domain record ids are append-only across the whole run, so include the
      // generation in deterministic endpoint/baseline ids.  A reset must not
      // make a new current record collide with stale history.
      const baselineId = `WEB-BASELINE-${snapshot.generation}-${sessionId}`;
      const endpointId = `WEB-ENDPOINT-${snapshot.generation}-${sha256(`${method} ${input.path}`).slice(0, 32)}`;
      const priorStepRecordIds = Object.values(snapshot.domainRecords)
        .filter((record) => record.generation === snapshot.generation && record.kind === "web_request" && record.sessionId === sessionId)
        .sort((left, right) => left.createdSeq - right.createdSeq)
        .slice(-31)
        .map((record) => record.id);
      const chainId = `WEB-CHAIN-${snapshot.generation}-${requestRecord.id}`;
      const stepRecordIds = [...priorStepRecordIds, requestRecord.id];
      return {
        commands: [
          ...(snapshot.domainRecords[baselineId]?.generation === snapshot.generation ? [] : [{
            type: "domain_record" as const,
            record: {
              id: baselineId,
              kind: "web_baseline" as const,
              summary: `Baseline HTTP session for ${parsed.origin}.`,
              artifactIds: [response.artifactId],
              evidenceIds: [response.evidenceId],
              baseUrl,
              status: response.status,
              stateHash: response.stateHash,
            },
            lane: this.ownerLane,
          }]),
          ...(snapshot.domainRecords[endpointId]?.generation === snapshot.generation ? [] : [{
            type: "domain_record" as const,
            record: {
              id: endpointId,
              kind: "web_endpoint" as const,
              summary: `Observed HTTP endpoint ${method} ${input.path}.`,
              artifactIds: [response.artifactId],
              evidenceIds: [response.evidenceId],
              method,
              path: input.path,
              sourceRecordIds: [baselineId],
            },
            lane: this.ownerLane,
          }]),
          { type: "domain_record" as const, record: requestRecord, lane: this.ownerLane },
          {
            type: "domain_record" as const,
            record: {
              id: chainId,
              kind: "web_exploit_chain" as const,
              summary: `Observed HTTP chain step ${stepRecordIds.length}: ${method} ${input.path}.`,
              artifactIds: [response.artifactId],
              evidenceIds: [response.evidenceId],
              stepRecordIds,
              status: "observed" as const,
            },
            lane: this.ownerLane,
          },
        ],
        project: () => undefined,
      };
    });
  }

  private require(sessionId: string): LiveWebSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown web session: ${sessionId}`);
    return session;
  }
}

function brokerHttpResource(
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
    kind: "http-session",
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
