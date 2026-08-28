import type { BrowserActionKind, BrowserSelector } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import {
  BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
  BrowserRuntimeWireRequestError,
  parseBrowserRuntimeWireResource,
  type BrowserRuntimeWireResource,
} from "./browser-runtime-broker.js";
import type { BrowserContextPort, BrowserDriverResponse } from "./browser-session.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ACTION_CONTENT_BYTES = 1_048_576;
const MAX_ACTION_RESPONSE_BYTES = MAX_ACTION_CONTENT_BYTES + 8 * 1024;

export type BrowserRuntimeAction =
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "click" | "submit"; readonly selector: BrowserSelector }
  | { readonly kind: "fill"; readonly selector: BrowserSelector; readonly value: string }
  | { readonly kind: "wait"; readonly milliseconds: number };

export interface BrowserRuntimeActionWireRequest {
  schemaVersion: typeof BROWSER_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "action";
  resource: BrowserRuntimeWireResource;
  action: BrowserRuntimeAction;
}

export interface BrowserRuntimeActionWireResponse {
  schemaVersion: typeof BROWSER_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "action";
  action: BrowserActionKind;
  status?: number;
  content: string;
  currentUrl: string;
  stateHash: string;
}

/** Service-side action seam. The implementation owns the real browser context. */
export interface BrowserRuntimeActionService {
  action(resource: BrowserRuntimeWireResource, action: BrowserRuntimeAction, signal?: AbortSignal): Promise<Pick<BrowserRuntimeActionWireResponse, "status" | "content" | "currentUrl" | "stateHash">>;
}

/**
 * Resolves a broker-owned context after validating the immutable resource
 * binding. Implementations must not create a replacement context for an
 * unknown handle; they should reject or return no context instead.
 */
export interface BrowserRuntimeContextResolver {
  (resource: BrowserRuntimeWireResource, signal?: AbortSignal): Promise<BrowserContextPort | undefined>;
}

/**
 * Service-side action adapter for a real browser context.
 *
 * Lifecycle ownership stays in the broker service. This adapter only maps the
 * bounded wire actions to a resolver-provided context and returns a redacted
 * state hash, so Playwright objects and storage values never cross the wire.
 */
export class BrowserRuntimeContextActionService implements BrowserRuntimeActionService {
  public constructor(private readonly resolveContext: BrowserRuntimeContextResolver) {
    if (typeof resolveContext !== "function") throw new Error("Browser action service requires a context resolver");
  }

  public async action(resource: BrowserRuntimeWireResource, action: BrowserRuntimeAction, signal?: AbortSignal): Promise<Pick<BrowserRuntimeActionWireResponse, "status" | "content" | "currentUrl" | "stateHash">> {
    const context = await this.resolveContext(resource, signal);
    if (!context) throw new Error("Browser action resource has no currently bound context");
    const result = await executeContextAction(context, action, signal);
    const currentUrl = await context.currentUrl();
    const stateHash = context.storageStateHash ? await context.storageStateHash() : sha256(canonicalJson(await context.storageState()));
    return { ...(result.status === undefined ? {} : { status: result.status }), content: result.content, currentUrl, stateHash };
  }
}

/** A malformed action request that must not reach the browser service. */
export class BrowserRuntimeActionRequestError extends BrowserRuntimeWireRequestError {
  public constructor(message: string) {
    super(message);
    this.name = "BrowserRuntimeActionRequestError";
  }
}

export async function dispatchBrowserRuntimeActionWire(
  value: unknown,
  service: BrowserRuntimeActionService,
  signal?: AbortSignal,
): Promise<BrowserRuntimeActionWireResponse> {
  let request: BrowserRuntimeActionWireRequest;
  try {
    request = parseActionRequest(value);
  } catch (error) {
    if (error instanceof BrowserRuntimeActionRequestError) throw error;
    throw new BrowserRuntimeActionRequestError(error instanceof Error ? error.message : String(error));
  }
  const result = await service.action(request.resource, request.action, signal);
  return validateActionResponse({
    schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
    operation: "action",
    action: request.action.kind,
    ...(result.status === undefined ? {} : { status: result.status }),
    content: result.content,
    currentUrl: result.currentUrl,
    stateHash: result.stateHash,
  }, request.action.kind);
}

export interface HttpBrowserRuntimeContextPortOptions {
  /** Absolute HTTP(S) broker endpoint. */
  readonly baseUrl: string;
  /** Exact immutable resource binding confirmed by the lifecycle broker. */
  readonly resource: BrowserRuntimeWireResource;
  /** URL used only until the first action response supplies the current URL. */
  readonly initialUrl?: string;
  /** Redacted state hash returned by the create/open handshake. */
  readonly initialStateHash?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Refresh the remote lease before each action so long-running replays do not expire mid-chain. */
  readonly heartbeat?: (signal?: AbortSignal) => Promise<{ state: "CONFIRMED" | "UNKNOWN"; externalId?: string; expiresAt?: string; summary?: string }>;
  /** Persist the Control Store handoff marker before the context is exposed. */
  readonly bind?: (binding: { readonly bindingTxnId: string; readonly controlSessionId: string }, signal?: AbortSignal) => Promise<void>;
  /** Closes the remote context; failures remain visible to recovery. */
  readonly release: (reason: string, signal?: AbortSignal) => Promise<{ released: boolean; summary?: string }>;
}

/**
 * BrowserContextPort backed by the broker action wire. It transports bounded
 * action results only; storage contents and browser driver objects never cross
 * the process boundary.
 */
export class HttpBrowserRuntimeContextPort implements BrowserContextPort {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly releaseRemote: HttpBrowserRuntimeContextPortOptions["release"];
  private readonly heartbeatRemote: HttpBrowserRuntimeContextPortOptions["heartbeat"];
  private readonly bindRemote: HttpBrowserRuntimeContextPortOptions["bind"];
  private current?: string;
  private stateHash?: string;
  private closed = false;
  private closePromise?: Promise<void>;

  public constructor(options: HttpBrowserRuntimeContextPortOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
    this.headers = normalizeHeaders(options.headers);
    this.releaseRemote = options.release;
    this.heartbeatRemote = options.heartbeat;
    this.bindRemote = options.bind;
    if (typeof this.releaseRemote !== "function") throw new Error("HTTP browser context port requires a release callback");
    if (options.initialUrl !== undefined) this.current = normalizeUrl(options.initialUrl);
    if (options.initialStateHash !== undefined && !/^[a-f0-9]{64}$/i.test(options.initialStateHash)) throw new Error("HTTP browser context initial state hash is invalid");
    this.stateHash = options.initialStateHash;
    this.resource = parseBrowserRuntimeWireResource(options.resource);
  }

  private readonly resource: BrowserRuntimeWireResource;

  public async goto(url: string, signal?: AbortSignal): Promise<BrowserDriverResponse> {
    return await this.execute({ kind: "navigate", url }, signal);
  }

  public async click(selector: BrowserSelector, signal?: AbortSignal): Promise<BrowserDriverResponse> {
    return await this.execute({ kind: "click", selector }, signal);
  }

  public async fill(selector: BrowserSelector, value: string, signal?: AbortSignal): Promise<BrowserDriverResponse> {
    return await this.execute({ kind: "fill", selector, value }, signal);
  }

  public async submit(selector: BrowserSelector, signal?: AbortSignal): Promise<BrowserDriverResponse> {
    return await this.execute({ kind: "submit", selector }, signal);
  }

  public async wait(milliseconds: number, signal?: AbortSignal): Promise<BrowserDriverResponse> {
    return await this.execute({ kind: "wait", milliseconds }, signal);
  }

  public async currentUrl(): Promise<string> {
    if (!this.current) throw new Error("HTTP browser context has no current URL before its first action");
    return this.current;
  }

  public async storageState(): Promise<unknown> {
    // The remote broker returns a state hash, never cookies or storage values.
    return { cookies: [], origins: [] };
  }

  public async storageStateHash(): Promise<string> {
    return this.stateHash ?? sha256(canonicalJson({ remote: this.resource.externalId, state: "unknown" }));
  }

  public async bind(binding: { readonly bindingTxnId: string; readonly controlSessionId: string }, signal?: AbortSignal): Promise<void> {
    if (!this.bindRemote) return;
    if (binding.controlSessionId !== this.resource.id.slice("session:".length) || binding.bindingTxnId !== this.resource.bindingTxnId) {
      throw new Error("HTTP browser context binding does not match its immutable resource");
    }
    await this.bindRemote(binding, signal);
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    if (this.closePromise) return await this.closePromise;
    this.closePromise = this.releaseRemote("browser-context-closed").then((result) => {
      if (!result.released) throw new Error(result.summary ?? "Browser broker did not confirm context release");
      this.closed = true;
    }).finally(() => {
      if (!this.closed) this.closePromise = undefined;
    });
    return await this.closePromise;
  }

  private async execute(action: BrowserRuntimeAction, signal?: AbortSignal): Promise<BrowserDriverResponse> {
    if (this.closed || this.closePromise) throw new Error("HTTP browser context is closed or closing");
    if (this.heartbeatRemote) {
      const heartbeat = await this.heartbeatRemote(signal);
      if (heartbeat.state !== "CONFIRMED") throw new Error(heartbeat.summary ?? "Browser broker lease heartbeat was not confirmed");
    }
    const response = await this.request(action, signal);
    this.current = response.currentUrl;
    this.stateHash = response.stateHash;
    return { ...(response.status === undefined ? {} : { status: response.status }), content: response.content };
  }

  private async request(action: BrowserRuntimeAction, signal?: AbortSignal): Promise<BrowserRuntimeActionWireResponse> {
    const controller = new AbortController();
    const mergedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error("Browser action request timed out")), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/browser/action`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", ...this.headers },
        body: JSON.stringify({ schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION, operation: "action", resource: this.resource, action } satisfies BrowserRuntimeActionWireRequest),
        redirect: "manual",
        signal: mergedSignal,
      });
      if (!response.ok) throw new Error(`Browser action request failed with HTTP ${response.status}`);
      const body = await readBoundedBody(response, mergedSignal);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error("Browser action response is not valid JSON");
      }
      return validateActionResponse(parsed, action.kind);
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseActionRequest(value: unknown): BrowserRuntimeActionWireRequest {
  if (!isObject(value)) throw new Error("Browser action request must be an object");
  assertKeys(value, ["schemaVersion", "operation", "resource", "action"], "request");
  if (value.schemaVersion !== BROWSER_RUNTIME_WIRE_SCHEMA_VERSION || value.operation !== "action") throw new Error("Browser action request has an unsupported schema or operation");
  const resource = parseBrowserRuntimeWireResource(value.resource);
  const action = parseAction(value.action);
  return { schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION, operation: "action", resource, action };
}

async function executeContextAction(context: BrowserContextPort, action: BrowserRuntimeAction, signal?: AbortSignal): Promise<BrowserDriverResponse> {
  switch (action.kind) {
    case "navigate":
      return await context.goto(action.url, signal);
    case "click":
      if (!context.click) throw new Error("Browser action context does not support click");
      return await context.click(action.selector, signal);
    case "fill":
      if (!context.fill) throw new Error("Browser action context does not support fill");
      return await context.fill(action.selector, action.value, signal);
    case "submit":
      if (!context.submit) throw new Error("Browser action context does not support submit");
      return await context.submit(action.selector, signal);
    case "wait":
      if (!context.wait) throw new Error("Browser action context does not support wait");
      return await context.wait(action.milliseconds, signal);
  }
}

function parseAction(value: unknown): BrowserRuntimeAction {
  if (!isObject(value) || typeof value.kind !== "string") throw new Error("Browser action payload is invalid");
  switch (value.kind) {
    case "navigate":
      assertKeys(value, ["kind", "url"], "navigate action");
      return { kind: "navigate", url: normalizeUrl(value.url) };
    case "click":
    case "submit":
      assertKeys(value, ["kind", "selector"], `${value.kind} action`);
      return { kind: value.kind, selector: parseSelector(value.selector) };
    case "fill":
      assertKeys(value, ["kind", "selector", "value"], "fill action");
      if (typeof value.value !== "string" || value.value.length > 4_096 || /[\u0000\u007f]/.test(value.value)) throw new Error("Browser fill action value is invalid");
      return { kind: "fill", selector: parseSelector(value.selector), value: value.value };
    case "wait":
      assertKeys(value, ["kind", "milliseconds"], "wait action");
      if (!Number.isInteger(value.milliseconds) || Number(value.milliseconds) < 1 || Number(value.milliseconds) > 10_000) throw new Error("Browser wait action milliseconds are invalid");
      return { kind: "wait", milliseconds: value.milliseconds as number };
    default:
      throw new Error(`Unsupported browser action: ${value.kind}`);
  }
}

function parseSelector(value: unknown): BrowserSelector {
  if (!isObject(value)) throw new Error("Browser selector must be an object");
  assertKeys(value, ["kind", "value", "name"], "selector");
  if (!["role", "label", "test_id", "css"].includes(value.kind as string) || !isSafeText(value.value, 256)) throw new Error("Browser selector is invalid");
  if (value.name !== undefined && (value.kind !== "role" || !isSafeText(value.name, 256))) throw new Error("Browser selector name is invalid");
  return { kind: value.kind as BrowserSelector["kind"], value: value.value, ...(value.name === undefined ? {} : { name: value.name as string }) };
}

function validateActionResponse(value: unknown, expectedAction?: BrowserActionKind): BrowserRuntimeActionWireResponse {
  if (!isObject(value)) throw new Error("Browser action response must be an object");
  assertKeys(value, ["schemaVersion", "operation", "action", "status", "content", "currentUrl", "stateHash"], "response");
  if (value.schemaVersion !== BROWSER_RUNTIME_WIRE_SCHEMA_VERSION || value.operation !== "action" || !isActionKind(value.action)) throw new Error("Browser action response has an unsupported schema or action");
  if (expectedAction !== undefined && value.action !== expectedAction) throw new Error("Browser action response does not match the requested action");
  if (value.status !== undefined && (!Number.isInteger(value.status) || Number(value.status) < 100 || Number(value.status) > 599)) throw new Error("Browser action response status is invalid");
  if (typeof value.content !== "string" || byteLength(value.content) > MAX_ACTION_CONTENT_BYTES) throw new Error("Browser action response content exceeds its byte limit");
  const currentUrl = normalizeUrl(value.currentUrl);
  if (typeof value.stateHash !== "string" || !/^[a-f0-9]{64}$/i.test(value.stateHash)) throw new Error("Browser action response state hash is invalid");
  return { schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION, operation: "action", action: value.action, ...(value.status === undefined ? {} : { status: value.status as number }), content: value.content, currentUrl, stateHash: value.stateHash };
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  let oversized = false;
  try {
    while (bytesRead < MAX_ACTION_RESPONSE_BYTES) {
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = MAX_ACTION_RESPONSE_BYTES - bytesRead;
      if (value.byteLength > remaining) {
        oversized = true;
        throw new Error(`Browser action response exceeds ${MAX_ACTION_RESPONSE_BYTES} bytes`);
      }
      text += decoder.decode(value, { stream: true });
      bytesRead += value.byteLength;
    }
    return text + decoder.decode();
  } finally {
    if (oversized || bytesRead >= MAX_ACTION_RESPONSE_BYTES) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then((result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function normalizeBaseUrl(value: string): string {
  if (typeof value !== "string") throw new Error("HTTP browser context baseUrl must be an absolute HTTP(S) URL");
  const trimmed = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("HTTP browser context baseUrl must be an absolute HTTP(S) URL");
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("HTTP browser context baseUrl must be a clean HTTP(S) URL");
  return trimmed;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 100 || value > 120_000) throw new Error("HTTP browser context timeoutMs must be an integer between 100 and 120000");
  return value;
}

function normalizeHeaders(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  if (!value) return {};
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof headerValue !== "string" || headerValue.length > 4_096 || /[\u0000-\u001f\u007f]/.test(headerValue)) throw new Error("HTTP browser context headers are invalid");
    headers[name] = headerValue;
  }
  return headers;
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Browser action URL is invalid");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Browser action URL is invalid");
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error("Browser action URL must use a credential-free HTTP(S) URL");
  return parsed.toString();
}

function assertKeys(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (unexpected) throw new Error(`Browser action ${label} contains an unsupported field: ${unexpected}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeText(value: unknown, maxLength = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

function isActionKind(value: unknown): value is BrowserActionKind {
  return value === "navigate" || value === "click" || value === "fill" || value === "submit" || value === "wait";
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Browser action request aborted");
}
