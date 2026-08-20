import type { ControlStore } from "../control/control-store.js";
import type { Lane } from "../domain/types.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import type { ArtifactStore } from "../effects/artifact-store.js";

export interface HttpSessionResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  artifactId: string;
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
}

/** Per-run HTTP session with a bounded cookie jar and CSRF token reuse. */
export class HttpSessionBackend {
  public readonly sessionId = id("HTTP");
  private readonly base: URL;
  private readonly cookies = new Map<string, string>();
  private csrfToken?: string;
  private closed = false;

  private constructor(private readonly options: HttpSessionOptions) {
    this.base = new URL(options.baseUrl);
  }

  public static async open(options: HttpSessionOptions): Promise<HttpSessionBackend> {
    const session = new HttpSessionBackend(options);
    if (!/^https?:$/.test(session.base.protocol)) throw new Error("HTTP session requires an http(s) base URL");
    if (options.allowedHosts?.length && !options.allowedHosts.map((host) => host.toLowerCase()).includes(session.base.hostname.toLowerCase())) throw new Error(`HTTP session host is outside task scope: ${session.base.hostname}`);
    const snapshot = await options.controlStore.snapshot(options.runId);
    await options.controlStore.dispatch(options.runId, {
      type: "session_opened",
      session: { id: session.sessionId, runId: options.runId, kind: "http", ownerLane: options.ownerLane, generation: snapshot.generation, endpoint: session.base.origin, stateHash: session.stateHash() },
      lane: options.ownerLane,
    });
    return session;
  }

  public async request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}, signal?: AbortSignal): Promise<HttpSessionResponse> {
    if (this.closed) throw new Error(`HTTP session is closed: ${this.sessionId}`);
    const url = new URL(path, this.base);
    if (url.origin !== this.base.origin) throw new Error(`HTTP session request crosses origin: ${url.origin}`);
    const method = (init.method ?? "GET").toUpperCase();
    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) throw new Error(`Unsupported HTTP method: ${method}`);
    if ((init.body?.length ?? 0) > 1_048_576) throw new Error("HTTP session request body exceeds 1 MiB");
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) headers.set("cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    if (this.csrfToken && !headers.has("x-csrf-token")) headers.set("x-csrf-token", this.csrfToken);
    const response = await (this.options.fetchImpl ?? fetch)(url, { method, headers, body: init.body, redirect: "manual", signal });
    this.captureCookies(response.headers);
    const body = (await response.text()).slice(0, 1_048_576);
    this.csrfToken = extractCsrfToken(response.headers, body) ?? this.csrfToken;
    const artifact = await this.options.artifactStore.putText(this.options.runId, body, {
      filename: `http-${this.sessionId}-${Date.now()}.txt`,
      mime: response.headers.get("content-type") ?? "text/plain",
      sensitivity: "public",
      semantic: { name: `HTTP ${method} ${url.pathname}`, summary: `HTTP ${response.status} response from ${url.pathname}.`, tags: ["web", "http", String(response.status)], role: "supporting", relatedIds: [], annotatedBy: "harness" },
    });
    const stateHash = this.stateHash();
    await this.options.controlStore.dispatch(this.options.runId, { type: "session_interacted", sessionId: this.sessionId, transcriptArtifactId: artifact.id, stateHash, waitReason: "idle", lane: this.options.ownerLane });
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body, artifactId: artifact.id, stateHash };
  }

  public async close(reason = "closed"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.options.controlStore.dispatch(this.options.runId, { type: "session_closed", sessionId: this.sessionId, reason, exitCode: 0, lane: this.options.ownerLane });
  }

  public stateHash(): string {
    return sha256(canonicalJson({ cookies: [...this.cookies].sort(([a], [b]) => a.localeCompare(b)), csrfToken: this.csrfToken ?? "" }));
  }

  private captureCookies(headers: Headers): void {
    const values = typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : headers.get("set-cookie") ? [headers.get("set-cookie")!] : [];
    for (const value of values) {
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

function extractCsrfToken(headers: Headers, body: string): string | undefined {
  const header = headers.get("x-csrf-token") ?? headers.get("x-xsrf-token");
  if (header?.trim()) return header.trim().slice(0, 4_096);
  const match = /(?:name=["'](?:csrf-token|csrf_token|_csrf)["'][^>]*content=["']([^"']+)|name=["'](?:csrf_token|_csrf)["'][^>]*value=["']([^"']+))/i.exec(body);
  return (match?.[1] ?? match?.[2])?.slice(0, 4_096);
}
