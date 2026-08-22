import type { ControlStore } from "../control/control-store.js";
import type { Lane } from "../domain/types.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { ExperimentGate } from "../competition/experiment-gate.js";
import { DeterministicObserver } from "../knowledge/observer.js";

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
  controlStore: ControlStore;
  artifactStore: ArtifactStore;
  fetchImpl?: typeof fetch;
  allowedHosts?: string[];
  allowedPorts?: number[];
  experimentGate?: ExperimentGate;
}

/** Per-run HTTP session with a bounded cookie jar and CSRF token reuse. */
export class HttpSessionBackend {
  public readonly sessionId = id("HTTP");
  private readonly base: URL;
  private readonly cookies = new Map<string, string>();
  private readonly observer: DeterministicObserver;
  private csrfToken?: string;
  private closed = false;
  private exchangeCount = 0;
  private generation?: number;

  private constructor(private readonly options: HttpSessionOptions) {
    this.base = new URL(options.baseUrl);
    this.observer = new DeterministicObserver(options.controlStore);
  }

  public static async open(options: HttpSessionOptions): Promise<HttpSessionBackend> {
    const session = new HttpSessionBackend(options);
    if (!/^https?:$/.test(session.base.protocol)) throw new Error("HTTP session requires an http(s) base URL");
    assertHttpScope(session.base, options.allowedHosts, options.allowedPorts);
    const snapshot = await options.controlStore.snapshot(options.runId);
    session.generation = snapshot.generation;
    await options.controlStore.dispatch(options.runId, {
      type: "session_opened",
      session: { id: session.sessionId, runId: options.runId, kind: "http", ownerLane: options.ownerLane, generation: snapshot.generation, endpoint: session.base.origin, stateHash: session.stateHash() },
      lane: options.ownerLane,
    });
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
    this.captureCookies(response.headers);
    const body = (await response.text()).slice(0, 1_048_576);
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
  }

  public async close(reason = "closed"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const snapshot = await this.options.controlStore.snapshot(this.options.runId);
    if (!snapshot.sessions[this.sessionId] || ["CLOSED", "SUPERSEDED"].includes(snapshot.sessions[this.sessionId]!.status)) return;
    await this.options.controlStore.dispatch(this.options.runId, { type: "session_closed", sessionId: this.sessionId, reason, exitCode: 0, lane: this.options.ownerLane });
  }

  public stateHash(): string {
    return sha256(canonicalJson({ cookies: [...this.cookies].sort(([a], [b]) => a.localeCompare(b)), csrfToken: this.csrfToken ?? "" }));
  }

  /** A clean reproducer must start before any cookie or CSRF state is observed. */
  public isPristine(): boolean {
    return this.cookies.size === 0 && this.csrfToken === undefined;
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
