/**
 * Platform-specific CompetitionApi for the DASCTF / 西湖论剑 AI Agent 夺旗赛.
 *
 * The generic HttpCompetitionApi's configurable paths cannot express this
 * platform's real contract, so this adapter targets it exactly:
 *  - Every response is a `{code, message, data}` envelope; only code "00000" is
 *    success (HTTP stays 200 even for a wrong flag or a business error).
 *  - Auth is the `X-Agent-AccessKey` header (NOT a bearer token).
 *  - The challenge list is two-level (category -> corpus[]); we flatten it.
 *  - Attachments are download URLs, not inline base64 — we fetch and encode them
 *    so the existing sandbox (which decodes base64) is unchanged.
 *  - Flag submit is `{exerciseId, flag}` -> `{isCorrect}`; a wrong flag comes
 *    back as a non-"00000" code, which we map to `correct:false` (not an error).
 *  - Environment build is async: POST then poll the detail until it is ready.
 */

import type {
  CompetitionApi,
  CompetitionAttachment,
  CompetitionChallengeSummary,
  CompetitionEnvironment,
  CompetitionSubmitResult,
} from "./api.js";
import { normalizeCategory } from "./api.js";

/** Platform success envelope code. */
const OK_CODE = "00000";
// Observed at contest time (西湖论剑 2026 测试赛): the platform returns code
// "40001" with message "提交flag错误，请重新提交（当前还有N次提交机会）" for a WRONG
// flag. It is a verdict, not an operational failure, so it must map to
// correct:false rather than throwing — a throw crashes the verifier
// (JSON.parse of empty stdout → "Unexpected end of JSON input") and the model
// then misreads it as a platform outage and retries uselessly.
const DEFAULT_WRONG_FLAG_CODES = ["40001"];
const API_PREFIX = "/slab-match/api/v1/agent";

export interface DasctfCompetitionApiOptions {
  /** Platform origin, e.g. "https://gcsis.dasctf.com". */
  serverHost: string;
  /** Team Agent AccessKey, sent as the X-Agent-AccessKey header. Never logged. */
  accessKey: string;
  /** Request timeout per HTTP call. Defaults to 30s. */
  timeoutMs?: number;
  /** Max time to wait for an async env build before giving up. Defaults to 120s. */
  envReadyTimeoutMs?: number;
  /** Delay between env-readiness polls. Defaults to 3s. */
  envPollIntervalMs?: number;
  /**
   * Platform response codes that mean "wrong flag" (NOT an operational error).
   * Only these are mapped to correct:false; every other non-"00000" code throws.
   * Defaults to the observed contest wrong-flag code ["40001"]; pass an explicit
   * array to override (an empty array restores the strict fail-safe behavior).
   */
  wrongFlagCodes?: string[];
  /** Max bytes to download for a single attachment. Defaults to 64 MiB. */
  maxAttachmentBytes?: number;
  /**
   * Minimum spacing between platform API calls. The platform rate-limits bursts
   * (concurrent requests return HTTP 429 Retry-After), so calls are serialized
   * with at least this gap. Defaults to 350ms.
   */
  minRequestIntervalMs?: number;
  /** Max retries on a 429/503 before giving up. Defaults to 4. */
  maxRateLimitRetries?: number;
  /** Injectable fetch for tests. */
  fetch?: typeof globalThis.fetch;
  /** Injectable clock sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for tests (min-interval spacing). Defaults to Date.now. */
  now?: () => number;
}

export class DasctfCompetitionApi implements CompetitionApi {
  private readonly baseUrl: string;
  private readonly accessKey: string;
  private readonly timeoutMs: number;
  private readonly envReadyTimeoutMs: number;
  private readonly envPollIntervalMs: number;
  private readonly wrongFlagCodes: Set<string>;
  private readonly maxAttachmentBytes: number;
  private readonly minRequestIntervalMs: number;
  private readonly maxRateLimitRetries: number;
  private readonly requestFetch: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Serialization gate: platform requests chain through this so they never burst. */
  private gate: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  public constructor(options: DasctfCompetitionApiOptions) {
    this.baseUrl = normalizeHost(options.serverHost) + API_PREFIX;
    this.accessKey = options.accessKey.trim();
    if (!this.accessKey) throw new Error("DasctfCompetitionApi requires a non-empty accessKey");
    this.timeoutMs = intOption(options.timeoutMs, 30_000, "timeoutMs");
    // 300s (not 120s): during a live test match many teams provision envs at
    // once and Docker-backed web targets can take minutes to come up. All fleet
    // challenges share ONE api instance + ONE serialization gate, so a slot's
    // env poll also queues behind other challenges' calls, eating wall-clock.
    // 120s lost both web challenges (10661/10664) to premature timeout.
    this.envReadyTimeoutMs = intOption(options.envReadyTimeoutMs, 300_000, "envReadyTimeoutMs");
    this.envPollIntervalMs = intOption(options.envPollIntervalMs, 3_000, "envPollIntervalMs");
    this.wrongFlagCodes = new Set((options.wrongFlagCodes ?? DEFAULT_WRONG_FLAG_CODES).map((code) => code.trim()).filter(Boolean));
    this.maxAttachmentBytes = byteOption(options.maxAttachmentBytes, 64 * 1024 * 1024, "maxAttachmentBytes");
    this.minRequestIntervalMs = nonNegIntOption(options.minRequestIntervalMs, 350, "minRequestIntervalMs");
    const retries = options.maxRateLimitRetries ?? 4;
    if (!Number.isInteger(retries) || retries < 0 || retries > 10) throw new Error("DasctfCompetitionApi maxRateLimitRetries must be an integer in [0, 10]");
    this.maxRateLimitRetries = retries;
    this.requestFetch = options.fetch ?? globalThis.fetch;
    if (typeof this.requestFetch !== "function") throw new Error("DasctfCompetitionApi requires a fetch implementation");
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  public async listChallenges(): Promise<CompetitionChallengeSummary[]> {
    const data = await this.get("/ctf/exercise-list");
    const categories = asArray(data);
    if (!categories) throw payloadError("exercise-list", "an array of categories");
    const summaries: CompetitionChallengeSummary[] = [];
    for (const category of categories) {
      const categoryRecord = asRecord(category);
      if (!categoryRecord) continue;
      const categoryName = optionalString(categoryRecord, ["name"]) ?? "unknown";
      const corpus = asArray(categoryRecord.corpus) ?? [];
      for (const item of corpus) {
        const record = asRecord(item);
        if (!record) continue;
        // Only surface challenges the platform has actually opened.
        if (record.isOpen === false) continue;
        const challengeId = idField(record, ["id"], `${categoryName}.corpus.id`);
        summaries.push({
          challengeId,
          title: optionalString(record, ["name"]) ?? challengeId,
          category: categoryName,
          normalizedCategory: normalizeCategory(categoryName),
          ...(booleanField(record, ["hasSolved"]) === undefined ? {} : { solved: booleanField(record, ["hasSolved"]) }),
        });
      }
    }
    return summaries;
  }

  public async getChallenge(challengeId: string): Promise<{ summary: CompetitionChallengeSummary; attachments: CompetitionAttachment[] }> {
    const detail = await this.exerciseDetail(challengeId);
    const summary = this.parseSummary(detail, challengeId);
    const attachments = await this.downloadAttachments(detail);
    return { summary, attachments };
  }

  public async startEnvironment(challengeId: string): Promise<CompetitionEnvironment> {
    let detail = await this.exerciseDetail(challengeId);
    // Order matters: check isNeedCheck FIRST. A challenge can report
    // isNeedInit:true AND isNeedCheck:true at once (build already in flight); in
    // that state we must only poll, never POST build again — a second build can
    // restart provisioning, create duplicate resources, or error on the platform.
    if (detail.isNeedCheck === true) {
      detail = await this.pollUntilReady(challengeId);
    } else if (detail.isNeedInit === true) {
      // Needs an environment and none is building yet — start it, then poll.
      await this.post("/ctf/build-exercise-env", { exerciseId: toExerciseId(challengeId) });
      detail = await this.pollUntilReady(challengeId);
    }
    // else: static challenge (attachment-only), no environment to provision.
    return this.parseEnvironment(detail);
  }

  public async submitFlag(challengeId: string, flag: string): Promise<CompetitionSubmitResult> {
    const candidate = flag.trim();
    if (!candidate) throw new Error("DasctfCompetitionApi submitFlag requires a non-empty flag");
    if (candidate.length > 256) throw new Error("DASCTF flags are limited to 256 characters");
    const envelope = await this.postEnvelope("/answer-panel/answer", { exerciseId: toExerciseId(challengeId), flag: candidate });
    if (envelope.code === OK_CODE) {
      // Success envelope: the verdict is the isCorrect boolean.
      const record = asRecord(envelope.data) ?? {};
      const correct = booleanField(record, ["isCorrect"]);
      if (correct === undefined) throw payloadError("answer", "a boolean isCorrect");
      return { correct, ...(envelope.message ? { message: envelope.message } : {}), raw: envelope.raw };
    }
    // A non-"00000" code is AMBIGUOUS: it can be a wrong flag OR an operational
    // failure (auth A0401, rate limit, service error). Blindly mapping all of
    // them to correct:false would let an auto-solver treat an auth/rate error as
    // a wrong answer and keep burning the 50-submission budget. So only codes
    // KNOWN to mean "wrong flag" become a verdict; everything else throws so the
    // failure surfaces instead of silently wasting submissions. The known-wrong
    // set is configurable because the platform's exact wrong-flag code is only
    // observable at contest time — default empty = fail safe.
    if (this.wrongFlagCodes.has(envelope.code)) {
      return { correct: false, ...(envelope.message ? { message: envelope.message } : {}), raw: envelope.raw };
    }
    throw new Error(`DASCTF submitFlag returned code ${envelope.code}${envelope.message ? `: ${envelope.message}` : ""}`);
  }

  public async stopEnvironment(challengeId: string, _instanceId?: string): Promise<void> {
    // The platform keys teardown by exerciseId, not an instance handle.
    await this.post("/ctf/recover-exercise-env", { exerciseId: toExerciseId(challengeId) });
  }

  // --- internals -----------------------------------------------------------

  private async exerciseDetail(challengeId: string): Promise<Record<string, unknown>> {
    const data = await this.get(`/ctf/exercise?exerciseId=${encodeURIComponent(challengeId)}`);
    const record = asRecord(data);
    if (!record) throw payloadError("exercise", "a challenge detail object");
    return record;
  }

  private async pollUntilReady(challengeId: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + this.envReadyTimeoutMs;
    for (;;) {
      const detail = await this.exerciseDetail(challengeId);
      if (detail.isNeedCheck !== true) return detail;
      if (Date.now() >= deadline) throw new Error(`DASCTF environment for exercise ${challengeId} was not ready within ${this.envReadyTimeoutMs}ms`);
      await this.sleep(this.envPollIntervalMs);
    }
  }

  private parseSummary(detail: Record<string, unknown>, challengeId: string): CompetitionChallengeSummary {
    const category = optionalString(detail, ["category", "type"]) ?? "unknown";
    const scoreText = optionalString(detail, ["score"]);
    const value = scoreText !== undefined ? Number(scoreText) : numberField(detail, ["score"]);
    return {
      challengeId,
      title: optionalString(detail, ["name", "title"]) ?? challengeId,
      category,
      normalizedCategory: normalizeCategory(category === "unknown" ? optionalString(detail, ["difficulty"]) : category),
      ...(value !== undefined && Number.isFinite(value) ? { value } : {}),
      ...(booleanField(detail, ["hasSolved"]) === undefined ? {} : { solved: booleanField(detail, ["hasSolved"]) }),
      ...(optionalString(detail, ["description"]) === undefined ? {} : { description: optionalString(detail, ["description"]) }),
    };
  }

  private async downloadAttachments(detail: Record<string, unknown>): Promise<CompetitionAttachment[]> {
    const attachment = asRecord(detail.attachment);
    const files = attachment ? asArray(attachment.files) : undefined;
    if (!files || files.length === 0) return [];
    const results: CompetitionAttachment[] = [];
    for (const entry of files) {
      const record = asRecord(entry);
      if (!record) continue;
      const url = optionalString(record, ["url"]);
      const name = optionalString(record, ["name"]) ?? "attachment";
      if (!url) throw payloadError("attachment.files[].url", "a download URL");
      const base64 = await this.downloadBase64(url);
      results.push({ name, base64 });
    }
    return results;
  }

  private async downloadBase64(url: string): Promise<string> {
    // Only follow http(s). The URL comes from the platform payload; refusing
    // other schemes keeps a download from reaching file:/data: or similar.
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("DASCTF attachment URL is not a valid URL"); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`DASCTF attachment URL must be http(s), got ${parsed.protocol}`);
    let response: Response;
    try {
      // redirect:"error" — do not silently follow a redirect to an unexpected
      // host; a legitimate attachment CDN returns the bytes directly.
      response = await this.requestFetch(url, { signal: AbortSignal.timeout(this.timeoutMs), redirect: "error" });
    } catch (error) {
      throw new Error(`DASCTF attachment download failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`DASCTF attachment download failed with HTTP ${response.status}`);
    // Cheap precheck: reject an oversized attachment by its declared length
    // before reading a single byte.
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxAttachmentBytes) {
      throw new Error(`DASCTF attachment exceeds ${this.maxAttachmentBytes} bytes (content-length ${declared})`);
    }
    // Stream and accumulate with a hard cap, so a server that lies about (or
    // omits) content-length still cannot exhaust memory.
    const body = response.body;
    if (!body) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > this.maxAttachmentBytes) throw new Error(`DASCTF attachment exceeds ${this.maxAttachmentBytes} bytes`);
      return buffer.toString("base64");
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > this.maxAttachmentBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`DASCTF attachment exceeds ${this.maxAttachmentBytes} bytes`);
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks).toString("base64");
  }

  private parseEnvironment(detail: Record<string, unknown>): CompetitionEnvironment {
    const endpoints = asArray(detail.endpoints) ?? [];
    const lines: string[] = [];
    let expiresAt: number | undefined;
    for (const entry of endpoints) {
      const record = asRecord(entry);
      if (!record) continue;
      const isProxy = record.isProxy === true;
      const ips = (asArray(isProxy ? record.proxyIps : record.exposeIps) ?? []).map(String);
      const mappings = asArray(record.portMappings) ?? [];
      if (isProxy && mappings.length > 0) {
        for (const mapping of mappings) {
          const m = asRecord(mapping);
          if (!m) continue;
          for (const ip of ips) lines.push(`${optionalString(m, ["type"]) ?? "tcp"} ${ip}:${String(m.proxy ?? m.port ?? "")} (proxy of :${String(m.port ?? "")})`);
        }
      } else {
        const ports = (asArray(record.ports) ?? []).map(String);
        for (const ip of ips) for (const port of ports) lines.push(`${ip}:${port}`);
      }
      const users = asArray(record.users) ?? [];
      for (const user of users) {
        const u = asRecord(user);
        if (u) lines.push(`  login ${optionalString(u, ["username"]) ?? ""} / ${optionalString(u, ["password"]) ?? ""}`);
      }
      const expiry = numberField(record, ["expireTime"]);
      if (expiry !== undefined) expiresAt = expiresAt === undefined ? expiry : Math.min(expiresAt, expiry);
    }
    return {
      ...(lines.length > 0 ? { connectionInfo: lines.join("\n") } : {}),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      raw: detail,
    };
  }

  private async get(path: string): Promise<unknown> {
    return (await this.requestEnvelope("GET", path)).data;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    return (await this.requestEnvelope("POST", path, body)).data;
  }

  private async postEnvelope(path: string, body: unknown): Promise<Envelope> {
    return this.requestEnvelope("POST", path, body, { allowNonOk: true });
  }

  /**
   * Send one platform HTTP request through the serialization gate. Every call
   * chains onto `this.gate`, so requests never overlap (the platform 429s
   * concurrent bursts); each waits at least minRequestIntervalMs since the
   * previous one started. A 429/503 is retried up to maxRateLimitRetries,
   * sleeping for Retry-After (or an exponential fallback) — that is the ONLY
   * retry here; other statuses return their response for the caller to handle.
   */
  private async gatedFetch(method: "GET" | "POST", url: string, body: unknown): Promise<Response> {
    const run = this.gate.then(async () => {
      const wait = Math.max(0, this.minRequestIntervalMs - (this.now() - this.lastRequestAt));
      if (wait > 0) await this.sleep(wait);
      for (let attempt = 0; ; attempt += 1) {
        this.lastRequestAt = this.now();
        const headers = new Headers({ Accept: "application/json", "X-Agent-AccessKey": this.accessKey });
        if (body !== undefined) headers.set("Content-Type", "application/json");
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
          throw new Error(`DASCTF API ${method} ${redact(url)} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if ((response.status === 429 || response.status === 503) && attempt < this.maxRateLimitRetries) {
          const retryAfterMs = parseRetryAfter(response.headers.get("retry-after")) ?? this.minRequestIntervalMs * 2 ** attempt;
          await this.sleep(retryAfterMs);
          continue;
        }
        return response;
      }
    });
    // Keep the gate chained even if this request throws, so a failure does not
    // wedge every later request; swallow the error on the gate copy only.
    this.gate = run.then(() => undefined, () => undefined);
    return run;
  }

  private async requestEnvelope(method: "GET" | "POST", path: string, body?: unknown, options: { allowNonOk?: boolean } = {}): Promise<Envelope> {
    const url = `${this.baseUrl}${path}`;
    // Serialize + rate-limit-retry: the platform 429s concurrent bursts (with
    // Retry-After), so every platform call chains through a single gate that
    // spaces requests, and a 429/503 backs off (honoring Retry-After) instead of
    // failing the challenge outright. Bounded so a persistent limit still ends.
    const response = await this.gatedFetch(method, url, body);
    const text = await response.text();
    if (!response.ok) throw new Error(`DASCTF API ${method} ${redact(url)} failed with HTTP ${response.status}`);
    let parsed: unknown;
    try {
      parsed = text.trim() ? JSON.parse(text) : {};
    } catch {
      throw new Error(`DASCTF API ${method} ${redact(url)} returned invalid JSON`);
    }
    const record = asRecord(parsed) ?? {};
    const code = typeof record.code === "string" ? record.code : String(record.code ?? "");
    const message = typeof record.message === "string" ? record.message : undefined;
    const envelope: Envelope = { code, data: record.data, raw: record, ...(message ? { message } : {}) };
    // Business failures (wrong flag, etc.) may be allowed through for the caller
    // to interpret; everything else must be code "00000".
    if (code !== OK_CODE && !options.allowNonOk) {
      throw new Error(`DASCTF API ${method} ${redact(url)} returned code ${code}${message ? `: ${message}` : ""}`);
    }
    return envelope;
  }
}

interface Envelope {
  code: string;
  message?: string;
  data: unknown;
  raw: Record<string, unknown>;
}

function normalizeHost(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw new Error("DasctfCompetitionApi serverHost must be an absolute HTTP(S) URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("DasctfCompetitionApi serverHost must use HTTP or HTTPS");
  return trimmed;
}

function intOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 100 || value > 600_000) throw new Error(`DasctfCompetitionApi ${name} must be an integer between 100 and 600000`);
  return value;
}

function nonNegIntOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 600_000) throw new Error(`DasctfCompetitionApi ${name} must be an integer between 0 and 600000`);
  return value;
}

function byteOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 1024 * 1024 * 1024) throw new Error(`DasctfCompetitionApi ${name} must be an integer between 1 and 1073741824`);
  return value;
}

/** The platform uses integer exerciseIds; the seam carries them as strings. */
function toExerciseId(challengeId: string): number {
  const value = Number(challengeId);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`DASCTF exerciseId must be a positive integer, got ${JSON.stringify(challengeId)}`);
  return value;
}

function idField(record: Record<string, unknown>, keys: string[], label: string): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value)) return String(value);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  throw payloadError(label, "an id");
}

function optionalString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) if (typeof record[key] === "number" && Number.isFinite(record[key])) return record[key] as number;
  return undefined;
}

function booleanField(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) if (typeof record[key] === "boolean") return record[key] as boolean;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function payloadError(operation: string, expected: string): Error {
  return new Error(`DASCTF API ${operation} returned an invalid payload; expected ${expected}`);
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) to ms, capped at 30s. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(30_000, Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
  return undefined;
}

/** Strip query (may carry ids) for safe error messages; the accessKey is a header, never in the URL. */
function redact(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}
