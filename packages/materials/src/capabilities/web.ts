import type { RawEffectResult, TaskContract } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import type { FixtureRef } from "../sandbox/fixture.js";

const sensitiveRequestHeaders = new Set(["authorization", "cookie", "proxy-authorization"]);
const sensitiveResponseHeaders = new Set(["set-cookie", "www-authenticate", "proxy-authenticate"]);
const controlledRequestHeaders = new Set(["host", "content-length", "connection"]);
const methods = new Set(["GET", "HEAD", "POST"]);

export interface PreparedWebRequest {
  auditArgs: Record<string, unknown>;
  execute(signal: AbortSignal): Promise<RawEffectResult>;
}

export interface PersistedWebInvocationInput {
  input: Record<string, unknown>;
  argsRedacted: true;
}

interface NormalizedWebInput {
  method: "GET" | "HEAD" | "POST";
  path: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
}

interface NormalizedWebRequest extends NormalizedWebInput {
  url: URL;
}

export function persistedWebInput(input: Record<string, unknown>): PersistedWebInvocationInput {
  const request = normalizeInput(input);
  const relative = new URL(request.path, "http://proofblade.invalid");
  return {
    input: {
      method: request.method,
      pathname: relative.pathname,
      queryKeys: [...new Set(relative.searchParams.keys())].sort(),
      headerNames: Object.keys(request.headers).sort(),
      bodyBytes: Buffer.byteLength(request.body ?? "", "utf8"),
      timeoutMs: request.timeoutMs,
      maxBytes: request.maxBytes,
      requestHash: sha256(canonicalJson(request)),
    },
    argsRedacted: true,
  };
}

export function prepareWebRequest(task: TaskContract, fixture: FixtureRef, input: Record<string, unknown>): PreparedWebRequest {
  const normalized = normalizeInput(input);
  const base = targetBaseUrl(task, fixture);
  const url = new URL(normalized.path, base);
  if (url.origin !== base.origin) throw new Error("Web request path escapes the target origin");
  assertAllowedTarget(task, fixture, url);
  const request: NormalizedWebRequest = { ...normalized, url };
  const persisted = persistedWebInput(input).input;
  const auditArgs = {
    ...persisted,
    targetOrigin: fixture.endpoint && url.origin === new URL(fixture.endpoint).origin ? "LOCAL_FIXTURE" : url.origin,
  };
  return { auditArgs, execute: async (signal) => await executeRequest(request, signal) };
}

function normalizeInput(input: Record<string, unknown>): NormalizedWebInput {
  const method = String(input.method ?? "GET").toUpperCase();
  if (!methods.has(method)) throw new Error(`Unsupported web method: ${method}`);
  const path = typeof input.path === "string" ? input.path.trim() : "";
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Web request path must be an origin-relative path");
  const parsed = new URL(path, "http://proofblade.invalid");
  if (parsed.origin !== "http://proofblade.invalid") throw new Error("Web request path escapes the target origin");
  const headers = normalizeHeaders(input.headers);
  const body = input.body === undefined ? undefined : String(input.body);
  if (method !== "POST" && body) throw new Error(`${method} requests cannot include a body`);
  if (Buffer.byteLength(body ?? "", "utf8") > 16_384) throw new Error("Web request body exceeds 16384 bytes");
  const timeoutMs = boundedInteger(input.timeoutMs, 100, 30_000, 10_000, "timeoutMs");
  const maxBytes = boundedInteger(input.maxBytes, 256, 1_048_576, 262_144, "maxBytes");
  return { method: method as NormalizedWebInput["method"], path, headers, ...(body ? { body } : {}), timeoutMs, maxBytes };
}

function targetBaseUrl(task: TaskContract, fixture: FixtureRef): URL {
  const raw = fixture.endpoint ?? (/^https?:\/\//i.test(task.target) ? task.target : undefined);
  if (!raw) throw new Error("The active target does not expose an HTTP endpoint");
  const base = new URL(raw);
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("Web target must use HTTP or HTTPS");
  if (base.username || base.password) throw new Error("Web target URL must not contain credentials");
  return base;
}

function assertAllowedTarget(task: TaskContract, fixture: FixtureRef, url: URL): void {
  const localFixture = fixture.endpoint !== undefined && url.origin === new URL(fixture.endpoint).origin;
  const allowedHost = task.scope.allowed_hosts.includes(url.hostname)
    || (localFixture && task.scope.allowed_hosts.includes("LOCAL_FIXTURE"));
  if (!allowedHost) throw new Error(`Web target host is outside task scope: ${url.hostname}`);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!localFixture && !task.scope.allowed_ports.includes(port)) throw new Error(`Web target port is outside task scope: ${port}`);
  if (!task.scope.external_network && !isLoopback(url.hostname) && !localFixture) {
    throw new Error(`External network is disabled for this task: ${url.hostname}`);
  }
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Web request headers must be an object");
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const name = rawName.trim().toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new Error(`Invalid web request header: ${rawName}`);
    if (sensitiveRequestHeaders.has(name) || controlledRequestHeaders.has(name)) throw new Error(`Web request header is controlled by the host: ${name}`);
    if (typeof rawValue !== "string" || rawValue.length > 4_096 || /[\r\n]/.test(rawValue)) throw new Error(`Invalid web request header value: ${name}`);
    headers[name] = rawValue;
  }
  return headers;
}

async function executeRequest(request: NormalizedWebRequest, signal: AbortSignal): Promise<RawEffectResult> {
  const started = Date.now();
  const combined = AbortSignal.any([signal, AbortSignal.timeout(request.timeoutMs)]);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: combined,
    });
    const body = request.method === "HEAD" ? { text: "", bytes: 0, truncated: false } : await readBounded(response.body, request.maxBytes, combined);
    const headers = Object.fromEntries([...response.headers.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, sensitiveResponseHeaders.has(name.toLowerCase()) ? "[REDACTED]" : value]));
    return {
      stdout: JSON.stringify({
        request: { method: request.method, pathname: request.url.pathname },
        response: { status: response.status, statusText: response.statusText, headers, body: body.text, bodyBytes: body.bytes, truncated: body.truncated },
      }),
      stderr: "",
      exitCode: 0,
      durationMs: Date.now() - started,
    };
  } catch {
    return {
      stdout: "",
      stderr: combined.aborted ? "web request aborted or timed out" : "web request failed",
      exitCode: combined.aborted ? null : 1,
      durationMs: Date.now() - started,
    };
  }
}

async function readBounded(stream: ReadableStream<Uint8Array> | null, maxBytes: number, signal: AbortSignal): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!stream) return { text: "", bytes: 0, truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const next = await reader.read();
      if (next.done) break;
      const remaining = maxBytes - bytes;
      if (next.value.byteLength > remaining) {
        if (remaining > 0) chunks.push(next.value.slice(0, remaining));
        bytes += Math.max(remaining, 0);
        truncated = true;
        await reader.cancel("response body limit reached");
        break;
      }
      chunks.push(next.value);
      bytes += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { text: new TextDecoder().decode(concat(chunks, bytes)), bytes, truncated };
}

function concat(chunks: Uint8Array[], bytes: number): Uint8Array {
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Web request ${label} must be between ${min} and ${max}`);
  return Number(value);
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}
