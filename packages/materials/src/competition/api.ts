/**
 * The single seam between ProofBlade and the live competition platform.
 *
 * The platform exposes only an HTTP API: fetch challenges, access a challenge
 * environment, submit a flag, and read feedback. Every method here maps to one
 * of those operations. `HttpCompetitionApi` keeps the wire contract explicit
 * and configurable because each contest publishes slightly different paths and
 * envelope names; `NotConfiguredCompetitionApi` remains available for callers
 * that have not supplied a live endpoint.
 */

import { readBoundedResponseText } from "./http-body.js";

export type CompetitionCategory =
  | "web"
  | "misc"
  | "crypto"
  | "script"
  | "pwn"
  | "reverse"
  | "unknown";

export interface CompetitionChallengeSummary {
  challengeId: string;
  title: string;
  /** Raw platform category string, kept verbatim for prompts. */
  category: string;
  /** Normalized category used to pick a per-category playbook/Skill. */
  normalizedCategory: CompetitionCategory;
  /** Point value, used to prioritize the fleet. */
  value?: number;
  /** Whether this team has already solved it. */
  solved?: boolean;
  description?: string;
}

export interface CompetitionAttachment {
  /** File name to write into the run workspace. */
  name: string;
  /** Base64-encoded file body as returned by the platform. */
  base64: string;
}

export interface CompetitionEnvironment {
  /** Opaque handle used to stop the environment; absent for static challenges. */
  instanceId?: string;
  /** Stable key echoed by platforms that support idempotent environment creation. */
  idempotencyKey?: string;
  /** Connection string for the live target, e.g. "nc host 1337" or a URL. */
  connectionInfo?: string;
  /**
   * Some challenges hand the team its flag at provisioning time (dynamic flag).
   * When present, the solver never has to derive it — it is submitted directly.
   */
  teamFlag?: string;
  /** Epoch ms after which the environment is reclaimed by the platform. */
  expiresAt?: number;
  /** Full platform payload, retained for the debug GUI. */
  raw?: Record<string, unknown>;
}

/**
 * Conservative remote observation used during recovery. Platforms that do
 * not expose a query-by-idempotency contract may omit this capability; callers
 * must then keep an owned ledger record but cannot prove a remote resource is
 * still present.
 */
export interface CompetitionEnvironmentInspection {
  status: "ACTIVE" | "ABSENT" | "UNKNOWN";
  challengeId?: string;
  instanceId?: string;
  /** Stable key returned by a query-by-idempotency-key endpoint, when supported. */
  idempotencyKey?: string;
  connectionInfo?: string;
  expiresAt?: number;
  summary?: string;
  raw?: Record<string, unknown>;
}

/**
 * Stable remote identity that a competition platform can prove after a
 * ProofBlade process restart. `challenge-only` is intentionally not an
 * ownership proof: two workers can observe the same challenge while owning
 * different environment leases.
 */
export type CompetitionEnvironmentIdentityStrategy = "idempotency-key" | "instance-id" | "challenge-only" | "none";

/** Capability declaration for the platform's environment query contract. */
export interface CompetitionEnvironmentIdentityCapabilities {
  readonly strategy: CompetitionEnvironmentIdentityStrategy;
  /** Whether the selected identity remains valid across client restarts. */
  readonly stableAcrossRestart: boolean;
}

export type CompetitionEnvironmentIdentityMatch = "MATCH" | "MISMATCH" | "UNKNOWN";

/**
 * Compare a durable local reservation with one normalized remote observation.
 * Missing identity is unknown, never a match; a mismatch is safe to expose as
 * such because callers must not release a foreign environment.
 */
export function classifyCompetitionEnvironmentIdentity(
  expected: { challengeId: string; instanceId?: string; idempotencyKey?: string },
  observed: CompetitionEnvironmentInspection,
  capabilities?: CompetitionEnvironmentIdentityCapabilities,
): CompetitionEnvironmentIdentityMatch {
  // Recovery requires an explicit platform contract; undocumented matching
  // fields do not prove identity survives a client restart.
  if (!capabilities) return "UNKNOWN";
  if (observed.status !== "ACTIVE") return "UNKNOWN";
  if (observed.challengeId === undefined) return "UNKNOWN";
  if (observed.challengeId !== expected.challengeId) return "MISMATCH";

  if (!capabilities.stableAcrossRestart) return "UNKNOWN";
  switch (capabilities.strategy) {
    case "idempotency-key":
      if (expected.idempotencyKey === undefined || observed.idempotencyKey === undefined) return "UNKNOWN";
      if (observed.idempotencyKey !== expected.idempotencyKey) return "MISMATCH";
      if (expected.instanceId !== undefined && observed.instanceId !== undefined && observed.instanceId !== expected.instanceId) return "MISMATCH";
      return "MATCH";
    case "instance-id":
      if (expected.instanceId === undefined || observed.instanceId === undefined) return "UNKNOWN";
      return observed.instanceId === expected.instanceId ? "MATCH" : "MISMATCH";
    case "challenge-only":
    case "none":
      return "UNKNOWN";
  }
}

/** Durable identity supplied when starting a remotely provisioned environment. */
export interface CompetitionEnvironmentStartOptions {
  /** Must be persisted before the non-idempotent request is sent. */
  idempotencyKey?: string;
}

/** Query hint used by platforms that can find an environment by its stable key. */
export interface CompetitionEnvironmentInspectOptions {
  idempotencyKey?: string;
}

export interface CompetitionSubmitResult {
  correct: boolean;
  /** Platform feedback message, surfaced to the human supervisor. */
  message?: string;
  /** True when the flag was right but the challenge was already solved. */
  alreadySolved?: boolean;
  /** Remaining submission attempts if the platform reports them. */
  remainingAttempts?: number;
  raw?: Record<string, unknown>;
}

export interface CompetitionApi {
  /** Optional platform declaration used by recovery and orphan cleanup. */
  readonly environmentIdentity?: CompetitionEnvironmentIdentityCapabilities;
  /** List every currently open challenge. */
  listChallenges(): Promise<CompetitionChallengeSummary[]>;
  /** Fetch one challenge's detail plus its (decoded-by-caller) attachments. */
  getChallenge(challengeId: string): Promise<{
    summary: CompetitionChallengeSummary;
    attachments: CompetitionAttachment[];
  }>;
  /** Provision the challenge environment. No-op-friendly for static challenges. */
  startEnvironment(challengeId: string, options?: CompetitionEnvironmentStartOptions): Promise<CompetitionEnvironment>;
  /** Optional idempotent remote lookup used by orphan recovery. */
  inspectEnvironment?(challengeId: string, instanceId?: string, options?: CompetitionEnvironmentInspectOptions): Promise<CompetitionEnvironmentInspection>;
  /** Submit a flag and return the platform's verdict. */
  submitFlag(challengeId: string, flag: string): Promise<CompetitionSubmitResult>;
  /** Release the challenge environment. Safe to call when none is running. */
  stopEnvironment(challengeId: string, instanceId?: string): Promise<void>;
}

export type CompetitionHttpMethod = "GET" | "POST" | "DELETE";

/** Endpoint templates use `{challengeId}`, `{instanceId}` and `{idempotencyKey}` placeholders. */
export interface CompetitionHttpEndpoints {
  listChallenges: string;
  getChallenge: string;
  startEnvironment: string;
  submitFlag: string;
  stopEnvironment: string;
  /** Optional GET endpoint used for exact remote recovery. */
  inspectEnvironment?: string;
}

export interface CompetitionHttpApiOptions {
  /** Origin or API prefix, for example `https://ctf.example/api`. */
  baseUrl: string;
  /** Headers sent on every request, excluding the optional token header. */
  headers?: Record<string, string>;
  /** Optional bearer/API token. The token is never included in error messages. */
  token?: string;
  /** Header receiving `token`; defaults to `Authorization` (Bearer scheme). */
  tokenHeader?: string;
  /** Request timeout. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Maximum UTF-8 response body size. Defaults to 8 MiB. */
  maxResponseBytes?: number;
  /** Dependency injection seam for tests or a platform-specific fetch wrapper. */
  fetch?: typeof globalThis.fetch;
  /** Override platform paths without changing the response normalization. */
  endpoints?: Partial<CompetitionHttpEndpoints>;
  /** Explicitly declare which remote environment identity the platform proves. */
  environmentIdentity?: CompetitionEnvironmentIdentityCapabilities;
}

export class CompetitionHttpError extends Error {
  public readonly status: number;
  public readonly method: CompetitionHttpMethod;
  public readonly url: string;
  public readonly responseBody: string;

  public constructor(method: CompetitionHttpMethod, url: string, status: number, responseBody: string, sensitiveValues: readonly string[] = []) {
    const safeBody = sanitizeResponseBody(responseBody, sensitiveValues);
    super(`Competition API ${method} ${url} failed with HTTP ${status}${safeBody ? `: ${safeBody}` : ""}`);
    this.name = "CompetitionHttpError";
    this.status = status;
    this.method = method;
    this.url = url;
    this.responseBody = safeBody;
  }
}

/**
 * A failure confined to one challenge's identifier, metadata, or attachment.
 * Schedulers may fail that challenge and continue healthy work; all untyped API
 * failures remain fail-safe shared-platform failures.
 */
export class CompetitionChallengeError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CompetitionChallengeError";
  }
}

/** A local Docker/runtime failure confined to one challenge execution. */
export class CompetitionContainerError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CompetitionContainerError";
  }
}

const DEFAULT_HTTP_ENDPOINTS: CompetitionHttpEndpoints = {
  listChallenges: "/challenges",
  getChallenge: "/challenges/{challengeId}",
  startEnvironment: "/challenges/{challengeId}/environment",
  submitFlag: "/challenges/{challengeId}/submit",
  stopEnvironment: "/challenges/{challengeId}/environment/{instanceId}",
};

/**
 * HTTP implementation of the competition seam.
 *
 * Request paths are intentionally configurable: the contest API specification
 * is supplied outside this repository, while response parsing accepts the
 * common `{data: ...}`, `{result: ...}` and direct-payload envelopes. Unknown or
 * incomplete payloads fail loudly instead of being interpreted as a solved
 * challenge or an empty attachment set.
 */
export class HttpCompetitionApi implements CompetitionApi {
  public readonly environmentIdentity?: CompetitionEnvironmentIdentityCapabilities;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly token?: string;
  private readonly tokenHeader: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly requestFetch: typeof globalThis.fetch;
  private readonly endpoints: CompetitionHttpEndpoints;

  public constructor(options: CompetitionHttpApiOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.headers = { ...options.headers };
    this.token = options.token;
    this.tokenHeader = options.tokenHeader?.trim() || "Authorization";
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
    this.maxResponseBytes = normalizeResponseBytes(options.maxResponseBytes);
    this.requestFetch = options.fetch ?? globalThis.fetch;
    if (typeof this.requestFetch !== "function") throw new Error("Competition API requires a fetch implementation");
    this.endpoints = { ...DEFAULT_HTTP_ENDPOINTS, ...options.endpoints };
    this.environmentIdentity = options.environmentIdentity;
  }

  public async listChallenges(): Promise<CompetitionChallengeSummary[]> {
    const payload = await this.request("GET", this.endpoints.listChallenges);
    const entries = asArray(unwrap(payload, ["challenges", "items", "data", "result"]));
    if (!entries) throw payloadError("listChallenges", "an array of challenges");
    return entries.map((entry, index) => parseChallenge(entry, `listChallenges[${index}]`));
  }

  public async getChallenge(challengeId: string): Promise<{ summary: CompetitionChallengeSummary; attachments: CompetitionAttachment[] }> {
    const payload = await this.request("GET", this.endpoints.getChallenge, { challengeId });
    try {
      const envelope = asRecord(unwrap(payload, ["data", "result"])) ?? payload;
      const challengePayload = asRecord(firstDefined(envelope, ["challenge", "item"])) ?? envelope;
      const summary = parseChallenge(challengePayload, "getChallenge");
      const attachmentKeys = ["attachments", "files", "artifacts"];
      const attachmentsPayload = firstDefined(challengePayload, attachmentKeys) ?? firstDefined(envelope, attachmentKeys) ?? firstDefined(payload, attachmentKeys);
      if (attachmentsPayload === undefined) throw payloadError("getChallenge.attachments", "an explicit attachments array");
      const attachments = parseAttachments(attachmentsPayload);
      return { summary, attachments };
    } catch (error) {
      throw asChallengeError(error);
    }
  }

  public async startEnvironment(challengeId: string, options: CompetitionEnvironmentStartOptions = {}): Promise<CompetitionEnvironment> {
    const payload = await this.request("POST", this.endpoints.startEnvironment, { challengeId }, undefined, idempotencyHeaders(options.idempotencyKey));
    const environment = parseEnvironment(unwrap(payload, ["environment", "instance", "data", "result"]));
    if (environment.connectionInfo && !environment.instanceId && this.endpoints.stopEnvironment.includes("{instanceId}")) {
      throw payloadError("startEnvironment.instanceId", "an instanceId for live environment teardown");
    }
    return environment;
  }

  public async inspectEnvironment(challengeId: string, instanceId?: string, options: CompetitionEnvironmentInspectOptions = {}): Promise<CompetitionEnvironmentInspection> {
    const endpoint = this.endpoints.inspectEnvironment;
    if (!endpoint) return { status: "UNKNOWN", challengeId, summary: "competition platform has no environment inspection endpoint" };
    if (endpoint.includes("{instanceId}") && !instanceId) return { status: "UNKNOWN", challengeId, summary: "environment inspection requires an instance id" };
    try {
      const payload = await this.request("GET", endpoint, { challengeId, instanceId, idempotencyKey: options.idempotencyKey }, undefined, idempotencyHeaders(options.idempotencyKey));
      const environment = parseEnvironment(unwrap(payload, ["environment", "instance", "data", "result"]));
      const envelope = asRecord(unwrap(payload, ["data", "result"])) ?? asRecord(payload) ?? {};
      const returnedChallengeId = optionalStringField(envelope, ["challengeId", "challenge_id", "exerciseId", "exercise_id"])
        ?? optionalStringField(environment.raw ?? {}, ["challengeId", "challenge_id", "exerciseId", "exercise_id"]);
      const state = optionalStringField(envelope, ["status", "state"])?.toLowerCase()
        ?? optionalStringField(environment.raw ?? {}, ["status", "state"])?.toLowerCase();
      if (["absent", "stopped", "not_found", "not-found", "missing"].includes(state ?? "")) {
        return { status: "ABSENT", challengeId: returnedChallengeId ?? challengeId, summary: "platform query reports an absent environment", raw: environment.raw };
      }
      if (["unknown", "pending", "building", "starting"].includes(state ?? "")) {
        return { status: "UNKNOWN", challengeId: returnedChallengeId ?? challengeId, summary: `platform query reports environment state ${state}`, raw: environment.raw };
      }
      if (!environment.connectionInfo && !environment.instanceId && environment.expiresAt === undefined && !environment.idempotencyKey) {
        return { status: "UNKNOWN", challengeId: returnedChallengeId ?? challengeId, summary: "platform query returned no environment identity", raw: environment.raw };
      }
      return {
        status: "ACTIVE",
        challengeId: returnedChallengeId ?? challengeId,
        ...(environment.instanceId ? { instanceId: environment.instanceId } : {}),
        ...(environment.idempotencyKey ? { idempotencyKey: environment.idempotencyKey } : {}),
        ...(environment.connectionInfo ? { connectionInfo: environment.connectionInfo } : {}),
        ...(environment.expiresAt === undefined ? {} : { expiresAt: environment.expiresAt }),
        summary: "platform query confirms an active environment",
        raw: environment.raw,
      };
    } catch (error) {
      if (error instanceof CompetitionHttpError && error.status === 404) return { status: "ABSENT", challengeId, summary: "platform query returned HTTP 404 (absent)" };
      throw error;
    }
  }

  public async submitFlag(challengeId: string, flag: string): Promise<CompetitionSubmitResult> {
    const candidate = flag.trim();
    if (!candidate) throw new Error("Competition API submitFlag requires a non-empty flag");
    const payload = await this.request("POST", this.endpoints.submitFlag, { challengeId }, { flag: candidate });
    const result = hasExplicitSubmitVerdict(payload) ? payload : unwrap(payload, ["submission", "result", "data"]);
    return parseSubmitResult(result);
  }

  public async stopEnvironment(challengeId: string, instanceId?: string): Promise<void> {
    if (!instanceId && this.endpoints.stopEnvironment.includes("{instanceId}")) return;
    await this.request("DELETE", this.endpoints.stopEnvironment, { challengeId, instanceId });
  }

  private async request(
    method: CompetitionHttpMethod,
    endpoint: string,
    params: { challengeId?: string; instanceId?: string; idempotencyKey?: string } = {},
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const url = expandEndpoint(this.baseUrl, endpoint, params);
    const headers = new Headers(this.headers);
    headers.set("Accept", "application/json");
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (this.token) headers.set(this.tokenHeader, this.tokenHeader.toLowerCase() === "authorization" ? `Bearer ${this.token}` : this.token);
    let response: Response;
    try {
      response = await this.requestFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CompetitionHttpError(method, url, 0, message, sensitiveValues(this.headers, this.token, body));
    }
    let text: string;
    try {
      text = await readBoundedResponseText(response, this.maxResponseBytes, `Competition API ${method} ${url}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CompetitionHttpError(method, url, response.status, message, sensitiveValues(this.headers, this.token, body));
    }
    if (!response.ok) throw new CompetitionHttpError(method, url, response.status, text, sensitiveValues(this.headers, this.token, body));
    if (method === "DELETE" && response.status === 204) return undefined;
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Competition API ${method} ${url} returned invalid JSON`);
    }
  }
}

/**
 * Fail-closed placeholder for deployments that have not supplied a platform
 * endpoint. It keeps local/demo paths type-checked without inventing challenge
 * data or silently contacting an unknown service.
 */
export class NotConfiguredCompetitionApi implements CompetitionApi {
  public constructor(private readonly reason = "Competition API is not configured yet") {}

  private fail(): never {
    throw new Error(`${this.reason}. Provide a CompetitionApi implementation once the platform spec is known.`);
  }

  public async listChallenges(): Promise<CompetitionChallengeSummary[]> {
    return this.fail();
  }

  public async getChallenge(): Promise<{ summary: CompetitionChallengeSummary; attachments: CompetitionAttachment[] }> {
    return this.fail();
  }

  public async startEnvironment(): Promise<CompetitionEnvironment> {
    return this.fail();
  }

  public async submitFlag(): Promise<CompetitionSubmitResult> {
    return this.fail();
  }

  public async stopEnvironment(): Promise<void> {
    return this.fail();
  }
}

const CATEGORY_ALIASES: Record<string, CompetitionCategory> = {
  web: "web",
  misc: "misc",
  crypto: "crypto",
  cryptography: "crypto",
  script: "script",
  "script analysis": "script",
  scripting: "script",
  pwn: "pwn",
  exploitation: "pwn",
  "binary exploitation": "pwn",
  reverse: "reverse",
  reversing: "reverse",
  re: "reverse",
};

/** Best-effort mapping of a platform category label to a known playbook bucket. */
export function normalizeCategory(raw: string | undefined): CompetitionCategory {
  if (!raw) return "unknown";
  const key = raw.trim().toLowerCase();
  return CATEGORY_ALIASES[key] ?? "unknown";
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw new Error("Competition API baseUrl must be an absolute HTTP(S) URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Competition API baseUrl must use HTTP or HTTPS");
  return trimmed;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return 30_000;
  if (!Number.isInteger(value) || value < 100 || value > 300_000) throw new Error("Competition API timeoutMs must be an integer between 100 and 300000");
  return value;
}

function normalizeResponseBytes(value: number | undefined): number {
  if (value === undefined) return 8 * 1024 * 1024;
  if (!Number.isInteger(value) || value < 1_024 || value > 256 * 1024 * 1024) {
    throw new Error("Competition API maxResponseBytes must be an integer between 1024 and 268435456");
  }
  return value;
}

function expandEndpoint(baseUrl: string, template: string, params: { challengeId?: string; instanceId?: string; idempotencyKey?: string }): string {
  const path = template.replace(/\{(challengeId|instanceId|idempotencyKey)\}/g, (_match, key: "challengeId" | "instanceId" | "idempotencyKey") => {
    const value = params[key];
    if (!value) throw new Error(`Competition API endpoint requires ${key}`);
    return encodeURIComponent(value);
  });
  return new URL(path.replace(/^\/+/, ""), `${baseUrl}/`).toString();
}

function parseChallenge(value: unknown, label: string): CompetitionChallengeSummary {
  const record = asRecord(value);
  if (!record) throw payloadError(label, "a challenge object");
  const challengeId = stringField(record, ["challengeId", "challenge_id", "id"], `${label}.challengeId`);
  const title = stringField(record, ["title", "name"], `${label}.title`);
  const category = stringField(record, ["category", "type", "kind"], `${label}.category`);
  const valueField = numberField(record, ["value", "points", "score"]);
  const solved = booleanField(record, ["solved", "completed", "isSolved"]);
  const description = optionalStringField(record, ["description", "desc", "statement"]);
  return { challengeId, title, category, normalizedCategory: normalizeCategory(category), ...(valueField === undefined ? {} : { value: valueField }), ...(solved === undefined ? {} : { solved }), ...(description === undefined ? {} : { description }) };
}

function parseAttachments(value: unknown): CompetitionAttachment[] {
  if (!Array.isArray(value)) throw payloadError("attachments", "an array");
  return value.map((entry, index) => {
    const record = asRecord(entry);
    if (!record) throw payloadError(`attachments[${index}]`, "an attachment object");
    const name = stringField(record, ["name", "filename", "fileName", "path"], `attachments[${index}].name`);
    const base64 = base64Field(record, ["base64", "contentBase64", "data", "content"], `attachments[${index}].base64`);
    return { name, base64 };
  });
}

function parseEnvironment(value: unknown): CompetitionEnvironment {
  const record = asRecord(value);
  if (!record) throw payloadError("startEnvironment", "an environment object");
  const instanceId = optionalStringField(record, ["instanceId", "instance_id", "id"]);
  const idempotencyKey = optionalStringField(record, ["idempotencyKey", "idempotency_key", "requestKey", "request_key"]);
  const connectionInfo = optionalStringField(record, ["connectionInfo", "connection_info", "connection", "target"]);
  const teamFlag = optionalStringField(record, ["teamFlag", "team_flag", "flag"]);
  const expiresAt = numberField(record, ["expiresAt", "expires_at", "expiry"]);
  return { ...(instanceId === undefined ? {} : { instanceId }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }), ...(connectionInfo === undefined ? {} : { connectionInfo }), ...(teamFlag === undefined ? {} : { teamFlag }), ...(expiresAt === undefined ? {} : { expiresAt }), raw: record };
}

function idempotencyHeaders(key: string | undefined): Record<string, string> {
  const normalized = key?.trim();
  return normalized ? { "Idempotency-Key": normalized } : {};
}

function parseSubmitResult(value: unknown): CompetitionSubmitResult {
  const record = asRecord(value);
  if (!record) throw payloadError("submitFlag", "a submission result object");
  const correct = booleanField(record, ["correct", "accepted", "isCorrect"]);
  if (correct === undefined) throw payloadError("submitFlag.correct", "a boolean verdict");
  const alreadySolved = booleanField(record, ["alreadySolved", "already_solved", "duplicate"]);
  const remainingAttempts = numberField(record, ["remainingAttempts", "remaining_attempts", "attemptsLeft"]);
  const message = optionalStringField(record, ["message", "feedback", "detail"]);
  return { correct, ...(message === undefined ? {} : { message }), ...(alreadySolved === undefined ? {} : { alreadySolved }), ...(remainingAttempts === undefined ? {} : { remainingAttempts }), raw: record };
}

function hasExplicitSubmitVerdict(value: unknown): value is Record<string, unknown> {
  const record = asRecord(value);
  return record !== undefined && ["correct", "accepted", "isCorrect"].some((key) => record[key] !== undefined);
}

function firstDefined(value: unknown, keys: string[]): unknown {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of keys) if (record[key] !== undefined) return record[key];
  return undefined;
}

function unwrap(value: unknown, keys: string[]): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (Array.isArray(current)) return current;
    const next = firstDefined(current, keys);
    if (next === undefined || next === current) return current;
    current = next;
  }
  return current;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function stringField(record: Record<string, unknown>, keys: string[], label: string): string {
  const value = optionalStringField(record, keys);
  if (value === undefined) throw payloadError(label, "a non-empty string");
  return value;
}

function optionalStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return undefined;
}

function base64Field(record: Record<string, unknown>, keys: string[], label: string): string {
  for (const key of keys) {
    if (record[key] === undefined) continue;
    if (typeof record[key] !== "string" || !isBase64(record[key])) throw payloadError(label, "valid base64 content");
    return record[key];
  }
  throw payloadError(label, "a base64 string");
}

function isBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (value.length % 4 === 1) return false;
  if (value.includes("=") && value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64").toString("base64") === padded;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) if (typeof record[key] === "number" && Number.isFinite(record[key])) return record[key];
  return undefined;
}

function booleanField(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) if (typeof record[key] === "boolean") return record[key];
  return undefined;
}

function payloadError(operation: string, expected: string): Error {
  return new Error(`Competition API ${operation} returned an invalid payload; expected ${expected}`);
}

function asChallengeError(error: unknown): CompetitionChallengeError {
  if (error instanceof CompetitionChallengeError) return error;
  return new CompetitionChallengeError(error instanceof Error ? error.message : String(error), error);
}

function truncate(value: string, limit = 512): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, Math.max(0, limit - 3))}...`;
}

function sanitizeResponseBody(value: string, sensitive: readonly string[]): string {
  let sanitized = value;
  for (const secret of sensitive) {
    if (secret) sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  return truncate(sanitized);
}

function sensitiveValues(headers: Record<string, string>, token: string | undefined, body: unknown): string[] {
  const values = [...Object.values(headers), token ?? ""];
  collectStrings(body, values);
  return [...new Set(values.filter((value) => value.length > 0))];
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, output);
    return;
  }
  const record = asRecord(value);
  if (record) for (const entry of Object.values(record)) collectStrings(entry, output);
}
