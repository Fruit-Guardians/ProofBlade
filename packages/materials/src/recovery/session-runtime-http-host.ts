import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { atomicWriteFile, KeyedOperationQueue, withFileLock, type FileLockOptions } from "@proofblade/atoms";
import { canonicalJson, sha256 } from "../domain/utils.js";
import type { ContainerSessionReadOptions, ContainerSessionResult } from "../container/contracts.js";
import type {
  SessionRuntimeActionService,
  SessionRuntimeCreateRequest,
  SessionRuntimeHttpWireResponse,
} from "./session-runtime-wire.js";
import type {
  SessionRuntimeCreatedSession,
  SessionRuntimeHost,
  SessionRuntimeHostInspection,
  SessionRuntimeHostPresence,
} from "./session-runtime-service.js";

const SCHEMA_VERSION = 1 as const;
const MAX_RECORDS = 2_048;
const MAX_COOKIE_VALUE = 4_096;
const MAX_BODY_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_HEADERS = 64;
const MAX_HEADER_VALUE = 8_192;
const MAX_REDIRECTS = 5;
const SAFE_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const SENSITIVE_HEADERS = /^(?:authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;

export interface DurableHttpSessionRuntimeHostOptions {
  /** Private host ledger containing encrypted cookie/CSRF state. */
  readonly statePath: string;
  /** Secret used to encrypt the private state; required for restart stability. */
  readonly stateKey?: string;
  readonly lock?: FileLockOptions;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

interface HttpHostState {
  cookies: Record<string, string>;
  csrfToken?: string;
}

interface HttpHostRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  idempotencyKey: string;
  sessionId: string;
  externalId: string;
  request: SessionRuntimeCreateRequest;
  state: "ACTIVE" | "RELEASED";
  encryptedState: string;
  stateHash: string;
  createdAt: string;
  updatedAt: string;
}

interface HttpHostLedger {
  schemaVersion: typeof SCHEMA_VERSION;
  records: HttpHostRecord[];
}

/**
 * A production HTTP session host with no process-local session authority.
 * Cookie and CSRF state are encrypted and persisted by the host, while the
 * ProofBlade process receives only bounded response data and a state hash.
 */
export class DurableHttpSessionRuntimeHost implements SessionRuntimeHost {
  public readonly actions: SessionRuntimeActionService;
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly lock: FileLockOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly key?: Buffer;
  private readonly queue = new KeyedOperationQueue();

  public constructor(options: DurableHttpSessionRuntimeHostOptions) {
    if (!options.statePath.trim()) throw new Error("Durable HTTP session host requires a state path");
    this.statePath = options.statePath;
    this.lockPath = `${options.statePath}.lock`;
    this.lock = options.lock ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.key = options.stateKey && options.stateKey.length >= 16
      ? createHash("sha256").update(options.stateKey).digest()
      : undefined;
    this.actions = {
      pwnWrite: async () => await unsupportedPwnAction(),
      pwnRead: async () => await unsupportedPwnAction(),
      pwnSignal: async () => { throw new Error("Durable HTTP session host does not expose Pwn actions"); },
      pwnClose: async () => { throw new Error("Durable HTTP session host does not expose Pwn actions"); },
      httpRequest: async (resource, request, signal) => await this.httpRequest(resource.externalId, request, signal),
    };
  }

  public async create(request: SessionRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<SessionRuntimeCreatedSession> {
    assertHttpCreateRequest(request);
    assertHash(idempotencyKey, "idempotencyKey");
    this.requireStateKey();
    return await this.queue.run(`create:${idempotencyKey}`, async () => await withFileLock(this.lockPath, async () => {
      const ledger = await this.load();
      const existing = ledger.records.find((record) => record.idempotencyKey === idempotencyKey);
      if (existing) {
        assertSameRequest(existing.request, request);
        if (existing.state === "RELEASED") throw new Error("HTTP session create key was already released");
        return describe(existing);
      }
      if (ledger.records.length >= MAX_RECORDS) throw new Error("Durable HTTP session host ledger is full");
      throwIfAborted(signal);
      const timestamp = this.timestamp();
      const state = emptyState();
      const record: HttpHostRecord = {
        schemaVersion: SCHEMA_VERSION,
        idempotencyKey,
        sessionId: `http-session-${idempotencyKey.slice(0, 48)}`,
        externalId: `http-runtime-${idempotencyKey.slice(0, 48)}`,
        request: structuredClone(request),
        state: "ACTIVE",
        encryptedState: encryptState(state, this.key!),
        stateHash: stateHash(state),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      ledger.records.push(record);
      await this.persist(ledger);
      return describe(record);
    }, this.lock));
  }

  public async inspect(externalId: string, request: SessionRuntimeCreateRequest, signal?: AbortSignal): Promise<SessionRuntimeHostInspection> {
    assertHttpCreateRequest(request);
    this.requireStateKey();
    throwIfAborted(signal);
    const record = await this.find(externalId);
    if (!record || record.state === "RELEASED") return { status: "ABSENT", externalId };
    if (!sameRequest(record.request, request)) return { status: "PRESENT", externalId: record.externalId, summary: "HTTP host request binding does not match" };
    return { status: "PRESENT", externalId: record.externalId };
  }

  public async adopt(externalId: string, request: SessionRuntimeCreateRequest, signal?: AbortSignal): Promise<boolean> {
    const inspection = await this.inspect(externalId, request, signal);
    return inspection.status === "PRESENT" && inspection.externalId === externalId;
  }

  public async release(externalId: string, request: SessionRuntimeCreateRequest, reason: string, signal?: AbortSignal): Promise<boolean> {
    assertHttpCreateRequest(request);
    this.requireStateKey();
    return await this.queue.run(`release:${externalId}`, async () => await withFileLock(this.lockPath, async () => {
      throwIfAborted(signal);
      const ledger = await this.load();
      const record = ledger.records.find((candidate) => candidate.externalId === externalId);
      if (!record || record.state === "RELEASED") return true;
      if (!sameRequest(record.request, request)) return false;
      record.state = "RELEASED";
      record.encryptedState = encryptState(emptyState(), this.key!);
      record.stateHash = stateHash(emptyState());
      record.updatedAt = this.timestamp();
      await this.persist(ledger);
      return Boolean(reason.trim() || reason === "");
    }, this.lock));
  }

  public async inspectByIdempotency(request: SessionRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<{ status: SessionRuntimeHostPresence; created?: SessionRuntimeCreatedSession }> {
    assertHttpCreateRequest(request);
    assertHash(idempotencyKey, "idempotencyKey");
    this.requireStateKey();
    throwIfAborted(signal);
    const record = await this.findByIdempotency(idempotencyKey);
    if (!record || record.state === "RELEASED") return { status: "ABSENT" };
    if (!sameRequest(record.request, request)) return { status: "UNKNOWN" };
    return { status: "PRESENT", created: describe(record) };
  }

  public async health(): Promise<{ status: "READY" | "DEGRADED" | "UNAVAILABLE"; capabilities: { kinds: readonly ["http-session"]; maxRequestBytes: number; maxResponseBytes: number; stableAcrossRestart: boolean }; summary?: string }> {
    if (!this.key) {
      return {
        status: "DEGRADED",
        capabilities: { kinds: ["http-session"], maxRequestBytes: MAX_BODY_BYTES, maxResponseBytes: MAX_RESPONSE_BYTES, stableAcrossRestart: false },
        summary: "Durable HTTP session host requires PROOFBLADE_SESSION_RUNTIME_STATE_KEY",
      };
    }
    try {
      const ledger = await this.load();
      for (const record of ledger.records) if (record.state === "ACTIVE") decryptState(record.encryptedState, this.key);
      return {
        status: "READY",
        capabilities: { kinds: ["http-session"], maxRequestBytes: MAX_BODY_BYTES, maxResponseBytes: MAX_RESPONSE_BYTES, stableAcrossRestart: true },
        summary: "HTTP cookie and CSRF state is encrypted in the host ledger and restart-adoptable",
      };
    } catch (error) {
      return {
        status: "UNAVAILABLE",
        capabilities: { kinds: ["http-session"], maxRequestBytes: MAX_BODY_BYTES, maxResponseBytes: MAX_RESPONSE_BYTES, stableAcrossRestart: false },
        summary: `Durable HTTP session host ledger is unavailable: ${bounded(String(error))}`,
      };
    }
  }

  private async httpRequest(externalId: string, request: { method: string; url: string; headers: Record<string, string>; body?: string; bodyEncoding?: "utf8" | "base64" }, signal?: AbortSignal): Promise<SessionRuntimeHttpWireResponse> {
    this.requireStateKey();
    return await this.queue.run(`request:${externalId}`, async () => await withFileLock(this.lockPath, async () => {
      const ledger = await this.load();
      const record = ledger.records.find((candidate) => candidate.externalId === externalId);
      if (!record || record.state !== "ACTIVE") throw new Error("HTTP host session is not active");
      assertHttpCreateRequest(record.request);
      const state = decryptState(record.encryptedState, this.key!);
      const body = decodeBody(request.body, request.bodyEncoding);
      if (body !== undefined && (typeof body === "string" ? Buffer.byteLength(body) : body.byteLength) > MAX_BODY_BYTES) throw new Error("HTTP host request body exceeds 1 MiB");
      const method = request.method.toUpperCase();
      if (!SAFE_METHODS.has(method)) throw new Error(`Unsupported HTTP method: ${method}`);
      const headers = safeHeaders(request.headers);
      if (Object.keys(headers).length > MAX_HEADERS) throw new Error("HTTP host request has too many headers");
      if (state.csrfToken && !Object.keys(headers).some((name) => name.toLowerCase() === "x-csrf-token")) headers["x-csrf-token"] = state.csrfToken;
      if (Object.keys(state.cookies).length > 0) headers.cookie = Object.entries(state.cookies).map(([name, value]) => `${name}=${value}`).join("; ");
      let url = assertUrlInScope(request.url, record.request.http!);
      let response: Response | undefined;
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        throwIfAborted(signal);
        response = await this.fetchImpl(url, { method, headers, body: body as BodyInit | undefined, redirect: "manual", signal });
        if (response.status < 300 || response.status >= 400) break;
        captureCookies(state, response.headers);
        if (Object.keys(state.cookies).length > 0) headers.cookie = Object.entries(state.cookies).map(([name, value]) => `${name}=${value}`).join("; ");
        const location = response.headers.get("location");
        if (!location || redirects === MAX_REDIRECTS) break;
        url = assertUrlInScope(new URL(location, url).toString(), record.request.http!);
      }
      if (!response) throw new Error("HTTP host did not receive a response");
      captureCookies(state, response.headers);
      const responseBody = await readBoundedResponseBody(response);
      state.csrfToken = extractCsrfToken(response.headers, responseBody) ?? state.csrfToken;
      record.encryptedState = encryptState(state, this.key!);
      record.stateHash = stateHash(state);
      record.updatedAt = this.timestamp();
      await this.persist(ledger);
      return { schemaVersion: 1, operation: "http_request", status: response.status, headers: safeResponseHeaders(response.headers), body: responseBody, stateHash: record.stateHash };
    }, this.lock));
  }

  private async find(externalId: string): Promise<HttpHostRecord | undefined> {
    return await this.findWith((record) => record.externalId === externalId);
  }

  private async findByIdempotency(idempotencyKey: string): Promise<HttpHostRecord | undefined> {
    return await this.findWith((record) => record.idempotencyKey === idempotencyKey);
  }

  private async findWith(predicate: (record: HttpHostRecord) => boolean): Promise<HttpHostRecord | undefined> {
    return await withFileLock(this.lockPath, async () => {
      const record = (await this.load()).records.find(predicate);
      return record ? structuredClone(record) : undefined;
    }, this.lock);
  }

  private async load(): Promise<HttpHostLedger> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
      if (!isLedger(parsed)) throw new Error("Durable HTTP session host ledger has an unsupported schema");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: SCHEMA_VERSION, records: [] };
      throw error;
    }
  }

  private async persist(ledger: HttpHostLedger): Promise<void> {
    ledger.records.sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey));
    await atomicWriteFile(this.statePath, `${canonicalJson({ schemaVersion: SCHEMA_VERSION, records: ledger.records.slice(-MAX_RECORDS) })}\n`);
  }

  private requireStateKey(): Buffer {
    if (!this.key) throw new Error("Durable HTTP session host requires a state key of at least 16 characters");
    return this.key;
  }

  private timestamp(): string { return new Date(this.now()).toISOString(); }
}

function describe(record: HttpHostRecord): SessionRuntimeCreatedSession {
  return { sessionId: record.sessionId, externalId: record.externalId, stateHash: record.stateHash };
}

function assertHttpCreateRequest(request: SessionRuntimeCreateRequest): void {
  if (request.kind !== "http-session" || !request.http) throw new Error("Durable HTTP session host only supports http-session requests");
  if (!/^https?:$/.test(new URL(request.http.baseUrl).protocol)) throw new Error("HTTP host requires an http(s) base URL");
  if (request.http.allowedHosts.length === 0) throw new Error("HTTP host requires an explicit allowed host scope");
  assertUrlInScope(request.http.baseUrl, request.http);
}

function assertSameRequest(left: SessionRuntimeCreateRequest, right: SessionRuntimeCreateRequest): void {
  if (!sameRequest(left, right)) throw new Error("HTTP host idempotency key was reused with a different request");
}

function sameRequest(left: SessionRuntimeCreateRequest, right: SessionRuntimeCreateRequest): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} must be a 64-character hash`);
}

function emptyState(): HttpHostState { return { cookies: {} }; }

function stateHash(state: HttpHostState): string {
  return sha256(canonicalJson({ cookies: Object.fromEntries(Object.entries(state.cookies).sort(([left], [right]) => left.localeCompare(right))), csrfToken: state.csrfToken ?? "" }));
}

function encryptState(state: HttpHostState, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((value) => value.toString("base64url")).join(".");
}

function decryptState(value: string, key: Buffer): HttpHostState {
  const parts = value.split(".");
  if (parts.length !== 3) throw new Error("Durable HTTP session host state is malformed");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0]!, "base64url"));
  decipher.setAuthTag(Buffer.from(parts[1]!, "base64url"));
  const parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[2]!, "base64url")), decipher.final()]).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Durable HTTP session host state is invalid");
  const input = parsed as { cookies?: unknown; csrfToken?: unknown };
  if (!input.cookies || typeof input.cookies !== "object" || Array.isArray(input.cookies)) throw new Error("Durable HTTP session host state is invalid");
  const cookies: Record<string, string> = {};
  for (const [name, cookie] of Object.entries(input.cookies as Record<string, unknown>)) {
    if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) && typeof cookie === "string" && cookie.length <= MAX_COOKIE_VALUE) cookies[name] = cookie;
  }
  return { cookies, ...(typeof input.csrfToken === "string" ? { csrfToken: input.csrfToken.slice(0, MAX_COOKIE_VALUE) } : {}) };
}

function decodeBody(body: string | undefined, encoding: "utf8" | "base64" | undefined): string | Uint8Array | undefined {
  if (body === undefined) return undefined;
  if (encoding === "base64") return Buffer.from(body, "base64");
  return body;
}

function safeHeaders(input: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\u0000-\u001f\u007f]/.test(value) || value.length > MAX_HEADER_VALUE) continue;
    if (SENSITIVE_HEADERS.test(name)) continue;
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

function safeResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    if (Object.keys(result).length >= MAX_HEADERS) break;
    result[name.toLowerCase()] = SENSITIVE_HEADERS.test(name) ? "[REDACTED]" : value.slice(0, MAX_HEADER_VALUE);
  }
  return result;
}

function assertUrlInScope(value: string, spec: NonNullable<SessionRuntimeCreateRequest["http"]>): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("HTTP host request URL is invalid");
  const host = url.hostname.toLowerCase();
  if (!spec.allowedHosts.map((item) => item.toLowerCase()).includes(host)) throw new Error(`HTTP host request is outside scope: ${host}`);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (spec.allowedPorts.length > 0 && !spec.allowedPorts.includes(port)) throw new Error(`HTTP host request port is outside scope: ${port}`);
  return url.toString();
}

function captureCookies(state: HttpHostState, headers: Headers): void {
  const values = typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
    ? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
    : headers.get("set-cookie") ? [headers.get("set-cookie")!] : [];
  for (const value of values.flatMap(splitSetCookieHeader)) {
    const pair = value.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const cookie = pair.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || cookie.length > MAX_COOKIE_VALUE) continue;
    if (!cookie || /(?:^|;)\s*max-age\s*=\s*0(?:;|$)/i.test(value)) delete state.cookies[name];
    else state.cookies[name] = cookie;
  }
  const names = Object.keys(state.cookies);
  if (names.length > MAX_HEADERS) for (const name of names.slice(0, names.length - MAX_HEADERS)) delete state.cookies[name];
}

function splitSetCookieHeader(value: string): string[] {
  return value.split(/,(?=\s*[^;,=\s]+\s*=)/g).map((item) => item.trim()).filter(Boolean);
}

function extractCsrfToken(headers: Headers, body: string): string | undefined {
  const header = headers.get("x-csrf-token") ?? headers.get("x-xsrf-token");
  if (header?.trim()) return header.trim().slice(0, MAX_COOKIE_VALUE);
  const match = /(?:name=["'](?:csrf-token|csrf_token|_csrf)["'][^>]*content=["']([^"']+)|name=["'](?:csrf_token|_csrf)["'][^>]*value=["']([^"']+))/i.exec(body);
  return (match?.[1] ?? match?.[2])?.slice(0, MAX_COOKIE_VALUE);
}

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
      if (chunk.byteLength < value.byteLength) { truncated = true; break; }
    }
  } finally {
    if (bytesRead >= MAX_RESPONSE_BYTES) truncated = true;
    if (truncated) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return body + decoder.decode();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Durable HTTP session host operation aborted");
}

function bounded(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512); }

function isLedger(value: unknown): value is HttpHostLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.schemaVersion === SCHEMA_VERSION && Array.isArray(input.records) && input.records.length <= MAX_RECORDS && input.records.every(isRecord);
}

function isRecord(value: unknown): value is HttpHostRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.schemaVersion === SCHEMA_VERSION
    && typeof input.idempotencyKey === "string" && /^[a-f0-9]{64}$/i.test(input.idempotencyKey)
    && typeof input.sessionId === "string" && input.sessionId.length > 0
    && typeof input.externalId === "string" && input.externalId.length > 0
    && input.request !== undefined
    && (input.state === "ACTIVE" || input.state === "RELEASED")
    && typeof input.encryptedState === "string" && input.encryptedState.length > 0
    && typeof input.stateHash === "string" && /^[a-f0-9]{64}$/i.test(input.stateHash)
    && typeof input.createdAt === "string" && typeof input.updatedAt === "string";
}

async function unsupportedPwnAction(): Promise<ContainerSessionResult> {
  throw new Error("Durable HTTP session host does not expose Pwn actions");
}
