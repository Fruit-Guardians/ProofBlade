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
  /** Injectable fetch for tests. */
  fetch?: typeof globalThis.fetch;
  /** Injectable clock sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class DasctfCompetitionApi implements CompetitionApi {
  private readonly baseUrl: string;
  private readonly accessKey: string;
  private readonly timeoutMs: number;
  private readonly envReadyTimeoutMs: number;
  private readonly envPollIntervalMs: number;
  private readonly requestFetch: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  public constructor(options: DasctfCompetitionApiOptions) {
    this.baseUrl = normalizeHost(options.serverHost) + API_PREFIX;
    this.accessKey = options.accessKey.trim();
    if (!this.accessKey) throw new Error("DasctfCompetitionApi requires a non-empty accessKey");
    this.timeoutMs = intOption(options.timeoutMs, 30_000, "timeoutMs");
    this.envReadyTimeoutMs = intOption(options.envReadyTimeoutMs, 120_000, "envReadyTimeoutMs");
    this.envPollIntervalMs = intOption(options.envPollIntervalMs, 3_000, "envPollIntervalMs");
    this.requestFetch = options.fetch ?? globalThis.fetch;
    if (typeof this.requestFetch !== "function") throw new Error("DasctfCompetitionApi requires a fetch implementation");
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
    // Static challenges (attachment-only) need no environment.
    if (detail.isNeedInit === true) {
      await this.post("/ctf/build-exercise-env", { exerciseId: toExerciseId(challengeId) });
      detail = await this.pollUntilReady(challengeId);
    } else if (detail.isNeedCheck === true) {
      // Already building from a prior call — just wait for it.
      detail = await this.pollUntilReady(challengeId);
    }
    return this.parseEnvironment(detail);
  }

  public async submitFlag(challengeId: string, flag: string): Promise<CompetitionSubmitResult> {
    const candidate = flag.trim();
    if (!candidate) throw new Error("DasctfCompetitionApi submitFlag requires a non-empty flag");
    if (candidate.length > 256) throw new Error("DASCTF flags are limited to 256 characters");
    const envelope = await this.postEnvelope("/answer-panel/answer", { exerciseId: toExerciseId(challengeId), flag: candidate });
    // A wrong flag is NOT a transport error: the platform returns a non-"00000"
    // code with a message. Map that to correct:false so the caller does not treat
    // it as a crash (and does not waste a retry).
    if (envelope.code !== OK_CODE) {
      return { correct: false, ...(envelope.message ? { message: envelope.message } : {}), raw: envelope.raw };
    }
    const record = asRecord(envelope.data) ?? {};
    const correct = booleanField(record, ["isCorrect"]);
    if (correct === undefined) throw payloadError("answer", "a boolean isCorrect");
    return { correct, ...(envelope.message ? { message: envelope.message } : {}), raw: envelope.raw };
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
    let response: Response;
    try {
      response = await this.requestFetch(url, { signal: AbortSignal.timeout(this.timeoutMs), redirect: "follow" });
    } catch (error) {
      throw new Error(`DASCTF attachment download failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`DASCTF attachment download failed with HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.toString("base64");
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

  private async requestEnvelope(method: "GET" | "POST", path: string, body?: unknown, options: { allowNonOk?: boolean } = {}): Promise<Envelope> {
    const url = `${this.baseUrl}${path}`;
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

/** Strip query (may carry ids) for safe error messages; the accessKey is a header, never in the URL. */
function redact(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}
