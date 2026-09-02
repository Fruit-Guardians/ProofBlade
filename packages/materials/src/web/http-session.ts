import type { ControlStore } from "../control/control-store.js";
import type { Lane } from "../domain/types.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { ExperimentGate } from "../competition/experiment-gate.js";
import type { ExternalResourceRegistry } from "../recovery/external-resource-registry.js";
import { DeterministicObserver } from "../knowledge/observer.js";
import { BindingTransactionCoordinator } from "../recovery/binding-transaction-coordinator.js";

export interface HttpSessionResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  artifactId: string;
  stateHash: string;
  observationId: string;
  evidenceId: string;
  candidateKinds: string[];
}

/** The remote request completed, but durable local recording failed. */
export class HttpRequestPersistenceError extends Error {
  public readonly requestSent = true;

  public constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "HttpRequestPersistenceError";
  }
}

/** Bounded, replay-friendly record persisted for every HTTP exchange. */
export interface HttpExchangeArtifact {
  schemaVersion: 1;
  kind: "http_exchange";
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
  stateHash: string;
}

export interface HttpSessionOptions {
  runId: string;
  baseUrl: string;
  ownerLane: Lane;
  /** Broker-minted durable id; omitted for a process-local session. */
  sessionId?: string;
  /** Broker-owned state identity when cookies live outside this process. */
  stateHashHint?: string;
  controlStore: ControlStore;
  artifactStore: ArtifactStore;
  fetchImpl?: typeof fetch;
  allowedHosts?: string[];
  allowedPorts?: number[];
  experimentGate?: ExperimentGate;
  externalResources?: ExternalResourceRegistry;
  /** Opaque id minted by a durable HTTP session broker, when available. */
  externalId?: string;
  /** Immutable broker binding fields persisted alongside the external handle. */
  requestKey?: string;
  policyHash?: string;
  recipeHash?: string;
  scopeHash?: string;
  bindingTxnId?: string;
  /**
   * Release a broker-owned session when the local Control Store owner cannot
   * be committed or when the session is closed.  The callback must be
   * idempotent and must only release the exact opaque externalId it receives.
   */
  externalRelease?: (externalId: string, reason: string, signal?: AbortSignal) => Promise<{ released: boolean; summary?: string }>;
}

/** Per-run HTTP session with a bounded cookie jar and CSRF token reuse. */
export class HttpSessionBackend {
  public readonly sessionId: string;
  private readonly base: URL;
  private readonly cookies = new Map<string, string>();
  private readonly observer: DeterministicObserver;
  private csrfToken?: string;
  private closed = false;
  private exchangeCount = 0;
  private generation?: number;
  /** Broker-provided state identity for cookies that are not present locally. */
  private readonly stateHashHint?: string;

  private constructor(private readonly options: HttpSessionOptions, sessionId = id("HTTP"), stateHashHint?: string) {
    this.sessionId = sessionId;
    this.base = new URL(options.baseUrl);
    this.observer = new DeterministicObserver(options.controlStore);
    this.stateHashHint = stateHashHint;
  }

  public static async open(options: HttpSessionOptions): Promise<HttpSessionBackend> {
    const session = new HttpSessionBackend(options, options.sessionId, options.stateHashHint);
    if (!/^https?:$/.test(session.base.protocol)) throw new Error("HTTP session requires an http(s) base URL");
    assertHttpScope(session.base, options.allowedHosts, options.allowedPorts);
    const snapshot = await options.controlStore.snapshot(options.runId);
    session.generation = snapshot.generation;
    const resourceId = `session:${session.sessionId}`;
    const externalId = options.externalId ?? session.sessionId;
    const coordinator = options.externalResources ? new BindingTransactionCoordinator(options.controlStore, options.externalResources) : undefined;
    const registration = {
      id: resourceId,
      kind: "http-session",
      runId: options.runId,
      generation: snapshot.generation,
      ownerLane: options.ownerLane,
      externalId,
      ...(options.requestKey ? { requestKey: options.requestKey } : {}),
      ...(options.policyHash ? { policyHash: options.policyHash } : {}),
      ...(options.recipeHash ? { recipeHash: options.recipeHash } : {}),
      ...(options.scopeHash ? { scopeHash: options.scopeHash } : {}),
      ...(options.bindingTxnId ? { bindingTxnId: options.bindingTxnId } : {}),
    } as const;
    const prepared = coordinator ? await coordinator.prepare({ sessionId: session.sessionId, resource: registration }) : undefined;
    const started = prepared ?? await options.externalResources?.registerStarted(registration);
    let controlSessionCommitted = false;
    try {
      const openedSession = {
        id: session.sessionId,
        runId: options.runId,
        kind: "http" as const,
        ownerLane: options.ownerLane,
        generation: snapshot.generation,
        endpoint: session.base.origin,
        externalId,
        stateHash: session.stateHash(),
        ...(options.requestKey ? { requestKey: options.requestKey } : {}),
        ...(options.policyHash ? { policyHash: options.policyHash } : {}),
        ...(options.recipeHash ? { recipeHash: options.recipeHash } : {}),
        ...(options.scopeHash ? { scopeHash: options.scopeHash } : {}),
        ...(started?.bindingTxnId ? { bindingTxnId: started.bindingTxnId } : {}),
        ...(prepared ? { bindingIdentityHash: prepared.identityHash } : {}),
      };
      if (coordinator && prepared) await coordinator.commitControl(prepared, openedSession);
      else await options.controlStore.dispatch(options.runId, { type: "session_opened", session: openedSession, lane: options.ownerLane });
      controlSessionCommitted = true;
      if (coordinator && prepared) await coordinator.finalize(prepared);
      else await options.externalResources?.markControlBound(resourceId, session.sessionId, started?.bindingTxnId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (started && controlSessionCommitted) {
        // The Control Store owner is durable.  A failed binding marker must
        // remain adoptable; releasing here could destroy a session whose owner
        // recovery can still reconcile safely.
        await options.externalResources?.markUnknown(resourceId, reason).catch(() => undefined);
      } else if (started) {
        if (options.externalRelease) {
          try {
            const released = await options.externalRelease(externalId, "HTTP session owner commit failed");
            if (released.released) await options.externalResources?.markReleased(resourceId, released.summary ?? "HTTP session owner commit failed");
            else await options.externalResources?.markUnknown(resourceId, released.summary ?? reason);
          } catch (releaseError) {
            await options.externalResources?.markUnknown(resourceId, releaseError instanceof Error ? releaseError.message : String(releaseError)).catch(() => undefined);
          }
        } else {
          // A generated session id is process-local and has no external owner.
          // It is safe to close its registry record immediately. Explicit
          // broker handles remain UNKNOWN until their broker can be reconciled.
          if (options.externalId === undefined) await options.externalResources?.markReleased(resourceId, "HTTP session owner commit failed");
          else await options.externalResources?.markUnknown(resourceId, reason).catch(() => undefined);
        }
      }
      throw error;
    }
    return session;
  }

  /**
   * Adopt an already-open broker session. The broker transport is required so
   * requests continue through the same cookie/session authority; this method
   * never emits session_opened or creates a replacement HTTP session.
   */
  public static async adopt(options: HttpSessionOptions, sessionId: string, stateHash?: string): Promise<HttpSessionBackend> {
    if (!options.externalId) throw new Error("HTTP session adoption requires an opaque externalId");
    if (!options.fetchImpl) throw new Error("HTTP session adoption requires a broker-owned fetchImpl");
    const session = new HttpSessionBackend(options, sessionId, stateHash);
    if (!/^https?:$/.test(session.base.protocol)) throw new Error("HTTP session requires an http(s) base URL");
    assertHttpScope(session.base, options.allowedHosts, options.allowedPorts);
    const snapshot = await options.controlStore.snapshot(options.runId);
    const record = snapshot.sessions[sessionId];
    if (!record || record.kind !== "http") throw new Error(`Unknown HTTP session: ${sessionId}`);
    if (record.status !== "OPEN") throw new Error(`HTTP session is ${record.status}: ${sessionId}`);
    if (record.ownerLane !== options.ownerLane) throw new Error(`HTTP session is owned by ${record.ownerLane}, not ${options.ownerLane}`);
    if (record.runId !== options.runId || record.generation !== snapshot.generation) throw new Error(`HTTP session generation drift: ${sessionId}`);
    if (record.externalId !== options.externalId) throw new Error(`HTTP session opaque handle mismatch: ${sessionId}`);
    if (record.endpoint && record.endpoint !== session.base.origin) throw new Error(`HTTP session endpoint mismatch: ${sessionId}`);
    const resourceId = `session:${sessionId}`;
    const started = await options.externalResources?.registerStarted({
      id: resourceId,
      kind: "http-session",
      runId: record.runId,
      generation: record.generation,
      ownerLane: record.ownerLane,
      externalId: record.externalId,
      ...(record.requestKey ? { requestKey: record.requestKey } : {}),
      ...(record.policyHash ? { policyHash: record.policyHash } : {}),
      ...(record.recipeHash ? { recipeHash: record.recipeHash } : {}),
      ...(record.scopeHash ? { scopeHash: record.scopeHash } : {}),
      ...(record.bindingTxnId ? { bindingTxnId: record.bindingTxnId } : {}),
    });
    await options.externalResources?.markControlBound(resourceId, sessionId, started?.bindingTxnId ?? record.bindingTxnId);
    session.generation = snapshot.generation;
    return session;
  }

  public async request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}, signal?: AbortSignal): Promise<HttpSessionResponse> {
    if (this.closed) throw new Error(`HTTP session is closed: ${this.sessionId}`);
    const snapshot = await this.options.controlStore.snapshot(this.options.runId);
    const record = snapshot.sessions[this.sessionId];
    if (!record || record.status !== "OPEN") throw new Error(`HTTP session is not OPEN: ${this.sessionId}`);
    if (record.generation !== this.generation || snapshot.generation !== this.generation) throw new Error(`HTTP session generation drift: ${this.sessionId}`);
    const url = new URL(path, this.base);
    if (url.origin !== this.base.origin) throw new Error(`HTTP session request crosses origin: ${url.origin}`);
    const method = (init.method ?? "GET").toUpperCase();
    const action = `http:${method}`;
    const gateInput = { path, method, body: init.body ?? "", headers: init.headers ?? {} };
    await this.options.experimentGate?.assertAllowed({ runId: this.options.runId, action, input: gateInput });
    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) throw new Error(`Unsupported HTTP method: ${method}`);
    if ((init.body?.length ?? 0) > 1_048_576) throw new Error("HTTP session request body exceeds 1 MiB");
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) headers.set("cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    if (this.csrfToken && !headers.has("x-csrf-token")) headers.set("x-csrf-token", this.csrfToken);
    const requestHeaders = sanitizeHeaders(Object.fromEntries(headers.entries()));
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(url, { method, headers, body: init.body, redirect: "manual", signal });
    } catch (error) {
      await this.options.experimentGate?.record({ runId: this.options.runId, action, input: gateInput, outcome: /timed out|timeout/i.test(String(error)) ? "timeout" : "failure", summary: String(error).slice(0, 1_000) });
      throw error;
    }
    try {
      this.captureCookies(response.headers);
      const body = await readBoundedResponseBody(response);
      this.csrfToken = extractCsrfToken(response.headers, body) ?? this.csrfToken;
      const stateHash = this.stateHash();
      const responseHeaders = sanitizeHeaders(Object.fromEntries(response.headers.entries()));
      const exchange: HttpExchangeArtifact = {
        schemaVersion: 1,
        kind: "http_exchange",
        request: {
          method,
          url: url.toString(),
          headers: requestHeaders,
          ...(init.body === undefined ? {} : { body: init.body }),
        },
        response: { status: response.status, headers: responseHeaders, body },
        stateHash,
      };
      this.exchangeCount += 1;
      const exchangeArtifact = await this.options.artifactStore.putText(this.options.runId, JSON.stringify(exchange), {
        filename: `http-${this.sessionId}-${String(this.exchangeCount).padStart(4, "0")}.exchange.json`,
        mime: "application/json",
        sensitivity: "public",
        semantic: { name: `HTTP ${method} ${url.pathname} exchange`, summary: `Replayable HTTP exchange for ${url.pathname}.`, tags: ["web", "http", "exchange", String(response.status)], role: "supporting", relatedIds: [], annotatedBy: "harness" },
      });
      const observed = await this.observer.observe(this.options.runId, {
        operation: action,
        artifactId: exchangeArtifact.id,
        generation: snapshot.generation,
        result: { stdout: body, stderr: "", exitCode: response.status >= 400 ? response.status : 0, durationMs: 0 },
      });
      await this.options.controlStore.dispatch(this.options.runId, { type: "session_interacted", sessionId: this.sessionId, transcriptArtifactId: exchangeArtifact.id, stateHash, waitReason: "idle", lane: this.options.ownerLane });
      await this.options.experimentGate?.record({ runId: this.options.runId, action, input: gateInput, outcome: response.status >= 500 ? "failure" : "success", summary: `HTTP ${response.status} response.` });
      return { status: response.status, headers: responseHeaders, body, artifactId: exchangeArtifact.id, stateHash, observationId: observed.observationId, evidenceId: observed.evidenceId, candidateKinds: observed.candidateKinds };
    } catch (error) {
      throw new HttpRequestPersistenceError(`HTTP ${method} request was sent, but durable recording failed; remote outcome is unknown.`, error);
    }
  }

  public async close(reason = "closed"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const snapshot = await this.options.controlStore.snapshot(this.options.runId);
    if (!snapshot.sessions[this.sessionId] || ["CLOSED", "SUPERSEDED"].includes(snapshot.sessions[this.sessionId]!.status)) {
      await this.releaseExternalResource(`session:${this.sessionId}`, reason);
      return;
    }
    try {
      await this.options.controlStore.dispatch(this.options.runId, { type: "session_closed", sessionId: this.sessionId, reason, exitCode: 0, lane: this.options.ownerLane });
    } finally {
      await this.releaseExternalResource(`session:${this.sessionId}`, reason);
    }
  }

  public stateHash(): string {
    return this.stateHashHint ?? sha256(canonicalJson({ cookies: [...this.cookies].sort(([a], [b]) => a.localeCompare(b)), csrfToken: this.csrfToken ?? "" }));
  }

  /** A clean reproducer must start before any cookie or CSRF state is observed. */
  public isPristine(): boolean {
    return this.stateHashHint === undefined && this.cookies.size === 0 && this.csrfToken === undefined;
  }

  private async releaseExternalResource(resourceId: string, reason: string): Promise<void> {
    if (this.options.externalRelease && this.options.externalId) {
      try {
        const released = await this.options.externalRelease(this.options.externalId, reason);
        if (released.released) await this.options.externalResources?.markReleased(resourceId, released.summary ?? reason);
        else await this.options.externalResources?.markUnknown(resourceId, released.summary ?? "HTTP broker did not confirm release");
      } catch (error) {
        await this.options.externalResources?.markUnknown(resourceId, error instanceof Error ? error.message : String(error)).catch(() => undefined);
      }
      return;
    }
    await this.options.externalResources?.markReleased(resourceId, reason).catch(() => undefined);
  }

  private captureCookies(headers: Headers): void {
    const values = typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : headers.get("set-cookie") ? [headers.get("set-cookie")!] : [];
    for (const value of values.flatMap(splitSetCookieHeader)) {
      const pair = value.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const cookie = pair.slice(separator + 1).trim();
      if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) && cookie.length <= 4_096) this.cookies.set(name, cookie);
    }
    while (this.cookies.size > 64) this.cookies.delete(this.cookies.keys().next().value!);
  }
}

const MAX_RESPONSE_BYTES = 1_048_576;
const SENSITIVE_HTTP_HEADERS = /^(?:authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).slice(0, 64).map(([name, value]) => [name, SENSITIVE_HTTP_HEADERS.test(name) ? "[REDACTED]" : value.slice(0, 8_192)]));
}

function splitSetCookieHeader(value: string): string[] {
  return value.split(/,(?=\s*[^;,=\s]+\s*=)/g).map((item) => item.trim()).filter(Boolean);
}

function assertHttpScope(url: URL, allowedHosts?: string[], allowedPorts?: number[]): void {
  if (allowedHosts?.length && !allowedHosts.map((host) => host.toLowerCase()).includes(url.hostname.toLowerCase())) throw new Error(`HTTP session host is outside task scope: ${url.hostname}`);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (allowedPorts?.length && !allowedPorts.includes(port)) throw new Error(`HTTP session port is outside task scope: ${port}`);
}

function extractCsrfToken(headers: Headers, body: string): string | undefined {
  const header = headers.get("x-csrf-token") ?? headers.get("x-xsrf-token");
  if (header?.trim()) return header.trim().slice(0, 4_096);
  const match = /(?:name=["'](?:csrf-token|csrf_token|_csrf)["'][^>]*content=["']([^"']+)|name=["'](?:csrf_token|_csrf)["'][^>]*value=["']([^"']+))/i.exec(body);
  return (match?.[1] ?? match?.[2])?.slice(0, 4_096);
}

/** Read at most one MiB from a response and cancel an unbounded stream early. */
async function readBoundedResponseBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytesRead = 0;
  let truncated = false;
  try {
    while (bytesRead < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = MAX_RESPONSE_BYTES - bytesRead;
      const chunk = value.byteLength > remaining ? new Uint8Array(value.subarray(0, remaining)) : value;
      body += decoder.decode(chunk, { stream: true });
      bytesRead += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) {
        truncated = true;
        break;
      }
    }
  } finally {
    if (bytesRead >= MAX_RESPONSE_BYTES) truncated = true;
    if (truncated) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return body + decoder.decode();
}
