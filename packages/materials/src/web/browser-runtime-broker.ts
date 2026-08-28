import type {
  BrowserContextPort,
  BrowserRuntimeAdoptResult,
  BrowserRuntimeBroker,
} from "./browser-session.js";
import type {
  ExternalResourceInspection,
  ExternalResourceRecord,
} from "../recovery/external-resource-registry.js";

export const BROWSER_RUNTIME_WIRE_SCHEMA_VERSION = 1 as const;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_WIRE_RESPONSE_BYTES = 64 * 1024;
const MAX_SUMMARY_LENGTH = 512;

/** A malformed request that must be reported as a client-side wire error. */
export class BrowserRuntimeWireRequestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BrowserRuntimeWireRequestError";
  }
}

export interface BrowserRuntimeContextConnector {
  (input: {
    readonly externalId: string;
    readonly record: ExternalResourceRecord;
    readonly signal: AbortSignal;
  }): Promise<BrowserContextPort>;
}

export interface HttpBrowserRuntimeBrokerOptions {
  /** Absolute HTTP(S) endpoint of the browser runtime broker. */
  readonly baseUrl: string;
  /** Stable broker name used in diagnostics and adapter composition. */
  readonly name?: string;
  /** Fetch implementation used by the broker; injectable for wire fixtures. */
  readonly fetchImpl?: typeof fetch;
  /** Upper bound for one broker HTTP exchange. */
  readonly timeoutMs?: number;
  /** Non-secret transport headers, such as an application-level auth header. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Turns a broker-confirmed opaque handle into a current-process context port. */
  readonly connectContext: BrowserRuntimeContextConnector;
}

export interface BrowserRuntimeWireResource {
  schemaVersion: typeof BROWSER_RUNTIME_WIRE_SCHEMA_VERSION;
  id: string;
  kind: "browser-context";
  runId: string;
  generation: number;
  ownerLane: ExternalResourceRecord["ownerLane"];
  externalId: string;
  effectId?: string;
  requestKey?: string;
  policyHash?: string;
  recipeHash?: string;
  scopeHash?: string;
  /** Stable handoff identity shared with the External Resource ledger. */
  bindingTxnId?: string;
}

export interface BrowserRuntimeWireRequest {
  schemaVersion: typeof BROWSER_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "inspect" | "adopt" | "release" | "bind";
  resource: BrowserRuntimeWireResource;
  reason?: string;
}

export interface BrowserRuntimeInspectWireResponse {
  schemaVersion: typeof BROWSER_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "inspect";
  status: "PRESENT" | "ABSENT" | "UNKNOWN";
  binding: "MATCH" | "MISMATCH" | "UNKNOWN";
  externalId?: string;
  summary?: string;
}

export interface BrowserRuntimeAdoptWireResponse {
  schemaVersion: typeof BROWSER_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "adopt";
  state: "CONFIRMED" | "UNKNOWN";
  externalId?: string;
  summary?: string;
}

export interface BrowserRuntimeReleaseWireResponse {
  schemaVersion: typeof BROWSER_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "release";
  released: boolean;
  summary?: string;
}

export interface BrowserRuntimeBindWireResponse {
  schemaVersion: typeof BROWSER_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "bind";
  state: "BOUND" | "UNKNOWN";
  externalId?: string;
  summary?: string;
}

export type BrowserRuntimeHealthStatus = "READY" | "DEGRADED" | "UNAVAILABLE";
export type BrowserRuntimeActionKind = "navigate" | "click" | "fill" | "submit" | "wait";

export interface BrowserRuntimeCapabilities {
  readonly actions: readonly BrowserRuntimeActionKind[];
  readonly maxResponseBytes: number;
  readonly stableAcrossRestart: boolean;
}

export interface BrowserRuntimeHealthWireResponse {
  schemaVersion: typeof BROWSER_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "health";
  status: BrowserRuntimeHealthStatus;
  capabilities: BrowserRuntimeCapabilities;
  summary?: string;
}

export interface BrowserRuntimeHealthService {
  health(signal?: AbortSignal): Promise<Pick<BrowserRuntimeHealthWireResponse, "status" | "capabilities" | "summary">>;
}

export interface BrowserRuntimeHeartbeatWireRequest {
  schemaVersion: typeof BROWSER_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "heartbeat";
  resource: BrowserRuntimeWireResource;
}

export interface BrowserRuntimeHeartbeatWireResponse {
  schemaVersion: typeof BROWSER_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "heartbeat";
  state: "CONFIRMED" | "UNKNOWN";
  externalId?: string;
  expiresAt?: string;
  summary?: string;
}

export interface BrowserRuntimeHeartbeatService {
  heartbeat(resource: BrowserRuntimeWireResource, signal?: AbortSignal): Promise<Pick<BrowserRuntimeHeartbeatWireResponse, "state" | "externalId" | "expiresAt" | "summary">>;
}

/** Immutable, non-secret input for an idempotent remote browser create/open. */
export interface BrowserRuntimeCreateRequest {
  runId: string;
  generation: number;
  /** Browser contexts are created only for the verifier-owned replay lane. */
  ownerLane: "verifier";
  target: string;
  policyHash: string;
  recipeHash?: string;
  verificationKey: string;
  allowedHosts: readonly string[];
  allowedPorts: readonly number[];
  maxResponseBytes: number;
  scopeHash: string;
}

export interface BrowserRuntimeCreateWireRequest {
  schemaVersion: typeof BROWSER_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "create";
  /** Stable hash of the complete create request; retries must be no-ops. */
  idempotencyKey: string;
  request: BrowserRuntimeCreateRequest;
}

export interface BrowserRuntimeCreateWireResponse {
  schemaVersion: typeof BROWSER_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "create";
  state: "CREATED" | "EXISTING" | "UNKNOWN";
  sessionId?: string;
  externalId?: string;
  initialUrl?: string;
  stateHash?: string;
  summary?: string;
}

/** Service-side create/open implementation behind the browser wire. */
export interface BrowserRuntimeCreateService {
  create(request: BrowserRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<Pick<BrowserRuntimeCreateWireResponse, "state" | "sessionId" | "externalId" | "initialUrl" | "stateHash" | "summary">>;
}

/** Service-side implementation behind the versioned browser wire. */
export interface BrowserRuntimeBrokerService {
  inspect(resource: BrowserRuntimeWireResource, signal?: AbortSignal): Promise<ExternalResourceInspection>;
  adopt(resource: BrowserRuntimeWireResource, signal?: AbortSignal): Promise<Pick<BrowserRuntimeAdoptWireResponse, "state" | "externalId" | "summary">>;
  release(resource: BrowserRuntimeWireResource, reason: string, signal?: AbortSignal): Promise<Pick<BrowserRuntimeReleaseWireResponse, "released" | "summary">>;
  /** Persist the Control Store handoff marker in the broker's own ledger. */
  bind?(resource: BrowserRuntimeWireResource, signal?: AbortSignal): Promise<Pick<BrowserRuntimeBindWireResponse, "state" | "externalId" | "summary">>;
}

/** Dispatch a health/capability probe without exposing runtime internals. */
export async function dispatchBrowserRuntimeHealthWire(
  service: BrowserRuntimeHealthService,
  signal?: AbortSignal,
): Promise<BrowserRuntimeHealthWireResponse> {
  const result = await service.health(signal);
  return validateHealthWireResponse({
    schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
    operation: "health",
    status: result.status,
    capabilities: result.capabilities,
    ...(result.summary ? { summary: result.summary } : {}),
  });
}

/** Dispatch one exact-resource lease heartbeat. */
export async function dispatchBrowserRuntimeHeartbeatWire(
  value: unknown,
  service: BrowserRuntimeHeartbeatService,
  signal?: AbortSignal,
): Promise<BrowserRuntimeHeartbeatWireResponse> {
  let request: BrowserRuntimeHeartbeatWireRequest;
  try {
    request = parseHeartbeatWireRequest(value);
  } catch (error) {
    throw new BrowserRuntimeWireRequestError(error instanceof Error ? error.message : String(error));
  }
  const result = await service.heartbeat(request.resource, signal);
  return validateHeartbeatWireResponse({
    schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
    operation: "heartbeat",
    state: result.state,
    ...(result.externalId ? { externalId: result.externalId } : {}),
    ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
    ...(result.summary ? { summary: result.summary } : {}),
  });
}

/**
 * Dispatch one decoded create/open request. The service must use the
 * idempotency key as its durable create key and return EXISTING for a retry of
 * an already-created context with the same immutable request binding.
 */
export async function dispatchBrowserRuntimeCreateWire(
  value: unknown,
  service: BrowserRuntimeCreateService,
  signal?: AbortSignal,
): Promise<BrowserRuntimeCreateWireResponse> {
  let request: BrowserRuntimeCreateWireRequest;
  try {
    request = parseCreateWireRequest(value);
  } catch (error) {
    throw new BrowserRuntimeWireRequestError(error instanceof Error ? error.message : String(error));
  }
  const result = await service.create(request.request, request.idempotencyKey, signal);
  return validateCreateWireResponse({
    schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
    operation: "create",
    state: result.state,
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    ...(result.externalId ? { externalId: result.externalId } : {}),
    ...(result.initialUrl ? { initialUrl: result.initialUrl } : {}),
    ...(result.stateHash ? { stateHash: result.stateHash } : {}),
    ...(result.summary ? { summary: result.summary } : {}),
  });
}

/**
 * Dispatch one decoded HTTP request at the broker service boundary.
 *
 * The transport adapter (Node, Fastify, or another server) is responsible for
 * bounded body reading and HTTP status mapping. This function owns the stable
 * schema, strict resource-field allowlist, and response validation so every
 * transport applies the same fail-closed rules.
 */
export async function dispatchBrowserRuntimeWire(
  value: unknown,
  service: BrowserRuntimeBrokerService,
  signal?: AbortSignal,
): Promise<BrowserRuntimeInspectWireResponse | BrowserRuntimeAdoptWireResponse | BrowserRuntimeReleaseWireResponse | BrowserRuntimeBindWireResponse> {
  let request: BrowserRuntimeWireRequest;
  try {
    request = parseWireRequest(value);
  } catch (error) {
    throw new BrowserRuntimeWireRequestError(error instanceof Error ? error.message : String(error));
  }
  switch (request.operation) {
    case "inspect": {
      const result = await service.inspect(request.resource, signal);
      return validateWireResponse<BrowserRuntimeInspectWireResponse>({
        schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
        operation: "inspect",
        status: result.status,
        binding: result.binding,
        ...(result.externalId ? { externalId: result.externalId } : {}),
        ...(result.summary ? { summary: result.summary } : {}),
      }, "inspect");
    }
    case "adopt": {
      const result = await service.adopt(request.resource, signal);
      return validateWireResponse<BrowserRuntimeAdoptWireResponse>({
        schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
        operation: "adopt",
        state: result.state,
        ...(result.externalId ? { externalId: result.externalId } : {}),
        ...(result.summary ? { summary: result.summary } : {}),
      }, "adopt");
    }
    case "release": {
      const result = await service.release(request.resource, request.reason ?? "unspecified release", signal);
      return validateWireResponse<BrowserRuntimeReleaseWireResponse>({
        schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
        operation: "release",
        released: result.released,
        ...(result.summary ? { summary: result.summary } : {}),
      }, "release");
    }
    case "bind": {
      if (!service.bind) throw new BrowserRuntimeWireRequestError("Browser runtime bind is not available");
      const result = await service.bind(request.resource, signal);
      return validateWireResponse<BrowserRuntimeBindWireResponse>({
        schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
        operation: "bind",
        state: result.state,
        ...(result.externalId ? { externalId: result.externalId } : {}),
        ...(result.summary ? { summary: result.summary } : {}),
      }, "bind");
    }
  }
}

/**
 * HTTP wire client for a durable browser broker.
 *
 * The broker service owns the browser process and validates immutable resource
 * bindings. This client never transports cookies, page content, screenshots or
 * a driver object. After an exact `adopt` response, the application-provided
 * connector supplies a current-process context port for the opaque handle.
 */
export class HttpBrowserRuntimeBroker implements BrowserRuntimeBroker {
  public readonly name: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly connectContext: BrowserRuntimeContextConnector;

  public constructor(options: HttpBrowserRuntimeBrokerOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.name = (options.name ?? "http-browser-broker").trim();
    if (!this.name) throw new Error("Browser runtime broker requires a stable name");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
    this.headers = normalizeHeaders(options.headers);
    this.connectContext = options.connectContext;
    if (typeof this.connectContext !== "function") throw new Error("Browser runtime broker requires a context connector");
  }

  /** Clean broker endpoint used by an action-port factory in the same process. */
  public get endpoint(): string {
    return this.baseUrl;
  }

  /** Transport settings shared with a context port; values contain no driver state. */
  public get transport(): { fetchImpl: typeof fetch; timeoutMs: number; headers: Readonly<Record<string, string>> } {
    return { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, headers: this.headers };
  }

  public async inspect(record: ExternalResourceRecord, signal?: AbortSignal): Promise<ExternalResourceInspection> {
    const response = await this.request<BrowserRuntimeInspectWireResponse>("inspect", record, signal);
    if (response.status === "PRESENT" && response.binding === "MATCH" && response.externalId !== record.externalId) {
      return { status: "PRESENT", binding: "MISMATCH", ...(response.externalId ? { externalId: response.externalId } : {}), summary: "Browser broker returned a different opaque handle" };
    }
    if (response.status === "PRESENT" && response.binding === "MATCH" && !response.externalId) {
      return { status: "UNKNOWN", binding: "UNKNOWN", summary: "Browser broker did not echo the inspected opaque handle" };
    }
    return {
      status: response.status,
      binding: response.binding,
      ...(response.externalId ? { externalId: response.externalId } : {}),
      ...(response.summary ? { summary: response.summary } : {}),
    };
  }

  public async adopt(record: ExternalResourceRecord, inspection: ExternalResourceInspection, signal?: AbortSignal): Promise<BrowserRuntimeAdoptResult> {
    if (inspection.status !== "PRESENT" || inspection.binding !== "MATCH" || inspection.externalId !== record.externalId || !record.externalId) {
      return { state: "UNKNOWN", summary: inspection.summary ?? "Browser broker did not confirm the exact opaque handle" };
    }
    const response = await this.request<BrowserRuntimeAdoptWireResponse>("adopt", record, signal);
    if (response.state !== "CONFIRMED") return { state: "UNKNOWN", ...(response.summary ? { summary: response.summary } : {}) };
    if (response.externalId !== record.externalId) return { state: "UNKNOWN", summary: "Browser broker confirmed a different opaque handle" };
    try {
      const context = await this.connectContext({ externalId: record.externalId, record, signal: signal ?? new AbortController().signal });
      return { state: "CONFIRMED", ...(response.summary ? { summary: response.summary } : {}), binding: { kind: "browser-context", externalId: record.externalId, context } };
    } catch (error) {
      return { state: "UNKNOWN", summary: `Browser context connector failed: ${boundedSummary(error instanceof Error ? error.message : String(error))}` };
    }
  }

  public async release(record: ExternalResourceRecord, reason: string, signal?: AbortSignal): Promise<{ released: boolean; summary?: string }> {
    const response = await this.request<BrowserRuntimeReleaseWireResponse>("release", record, signal, reason);
    return { released: response.released, ...(response.summary ? { summary: response.summary } : {}) };
  }

  /** Persist the exact Control Store handoff marker in the remote broker. */
  public async bind(record: ExternalResourceRecord, signal?: AbortSignal): Promise<BrowserRuntimeBindWireResponse> {
    if (record.kind !== "browser-context" || !record.externalId) throw new Error("Browser runtime broker requires a browser resource with an opaque handle");
    return await this.bindWireResource(browserRuntimeWireResource(record), signal);
  }

  /** Persist a binding marker for a resource that is not projected locally yet. */
  public async bindWireResource(resource: BrowserRuntimeWireResource, signal?: AbortSignal): Promise<BrowserRuntimeBindWireResponse> {
    const response = await this.requestWire<BrowserRuntimeBindWireResponse>("bind", resource, signal);
    return response;
  }

  /** Release a newly-created handle before it has a durable ledger record. */
  public async releaseWireResource(resource: BrowserRuntimeWireResource, reason: string, signal?: AbortSignal): Promise<{ released: boolean; summary?: string }> {
    const response = await this.requestWire<BrowserRuntimeReleaseWireResponse>("release", resource, signal, reason);
    return { released: response.released, ...(response.summary ? { summary: response.summary } : {}) };
  }

  /**
   * Request an idempotent remote browser create/open. This method only
   * returns the broker-owned identity; constructing a local context port and
   * registering it in the resource ledger remain application responsibilities.
   */
  public async create(
    request: BrowserRuntimeCreateRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<BrowserRuntimeCreateWireResponse> {
    const wireRequest: BrowserRuntimeCreateWireRequest = {
      schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
      operation: "create",
      idempotencyKey,
      request,
    };
    parseCreateWireRequest(wireRequest);
    const controller = new AbortController();
    const mergedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error(`Browser broker ${this.name} create timed out`)), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/browser/create`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", ...this.headers },
        body: JSON.stringify(wireRequest),
        redirect: "manual",
        signal: mergedSignal,
      });
      if (!response.ok) throw new Error(`Browser broker ${this.name} create failed with HTTP ${response.status}`);
      const body = await readBoundedBody(response, mergedSignal);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error(`Browser broker ${this.name} create returned invalid JSON`);
      }
      return validateCreateWireResponse(parsed);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Probe runtime availability and the bounded capabilities it can honor. */
  public async health(signal?: AbortSignal): Promise<BrowserRuntimeHealthWireResponse> {
    const controller = new AbortController();
    const mergedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error(`Browser broker ${this.name} health timed out`)), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/browser/health`, {
        method: "GET",
        headers: { accept: "application/json", ...this.headers },
        redirect: "manual",
        signal: mergedSignal,
      });
      if (!response.ok) throw new Error(`Browser broker ${this.name} health failed with HTTP ${response.status}`);
      const body = await readBoundedBody(response, mergedSignal);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error(`Browser broker ${this.name} health returned invalid JSON`);
      }
      return validateHealthWireResponse(parsed);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Refresh a durable lease after the exact resource binding is revalidated. */
  public async heartbeat(record: ExternalResourceRecord, signal?: AbortSignal): Promise<BrowserRuntimeHeartbeatWireResponse> {
    if (record.kind !== "browser-context" || !record.externalId) throw new Error("Browser runtime broker requires a browser resource with an opaque handle");
    return await this.heartbeatWireResource(browserRuntimeWireResource(record), signal);
  }

  /** Refresh a lease for a wire resource that has not yet been projected locally. */
  public async heartbeatWireResource(resource: BrowserRuntimeWireResource, signal?: AbortSignal): Promise<BrowserRuntimeHeartbeatWireResponse> {
    const controller = new AbortController();
    const mergedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error(`Browser broker ${this.name} heartbeat timed out`)), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/browser/heartbeat`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", ...this.headers },
        body: JSON.stringify({ schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION, operation: "heartbeat", resource } satisfies BrowserRuntimeHeartbeatWireRequest),
        redirect: "manual",
        signal: mergedSignal,
      });
      if (!response.ok) throw new Error(`Browser broker ${this.name} heartbeat failed with HTTP ${response.status}`);
      const body = await readBoundedBody(response, mergedSignal);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error(`Browser broker ${this.name} heartbeat returned invalid JSON`);
      }
      return validateHeartbeatWireResponse(parsed);
    } finally {
      clearTimeout(timer);
    }
  }

  private async request<T extends { schemaVersion: typeof BROWSER_RUNTIME_WIRE_SCHEMA_VERSION; operation: BrowserRuntimeWireRequest["operation"] }>(operation: BrowserRuntimeWireRequest["operation"], record: ExternalResourceRecord, signal?: AbortSignal, reason?: string): Promise<T> {
    if (record.kind !== "browser-context" || !record.externalId) throw new Error("Browser runtime broker requires a browser resource with an opaque handle");
    return await this.requestWire(operation, browserRuntimeWireResource(record), signal, reason);
  }

  private async requestWire<T extends { schemaVersion: typeof BROWSER_RUNTIME_WIRE_SCHEMA_VERSION; operation: BrowserRuntimeWireRequest["operation"] }>(operation: BrowserRuntimeWireRequest["operation"], resource: BrowserRuntimeWireResource, signal?: AbortSignal, reason?: string): Promise<T> {
    const controller = new AbortController();
    const mergedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error(`Browser broker ${this.name} ${operation} timed out`)), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/browser/${operation}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", ...this.headers },
        body: JSON.stringify({ schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION, operation, resource, ...(reason ? { reason: boundedSummary(reason) } : {}) } satisfies BrowserRuntimeWireRequest),
        redirect: "manual",
        signal: mergedSignal,
      });
      if (!response.ok) throw new Error(`Browser broker ${this.name} ${operation} failed with HTTP ${response.status}`);
      const body = await readBoundedBody(response, mergedSignal);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error(`Browser broker ${this.name} ${operation} returned invalid JSON`);
      }
      return validateWireResponse<T>(parsed, operation);
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Browser runtime broker baseUrl must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Browser runtime broker baseUrl must use HTTP or HTTPS");
  if (parsed.username || parsed.password) throw new Error("Browser runtime broker baseUrl must not contain URL userinfo");
  return trimmed;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 100 || value > 120_000) throw new Error("Browser runtime broker timeoutMs must be an integer between 100 and 120000");
  return value;
}

function normalizeHeaders(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  if (!value) return {};
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof headerValue !== "string" || headerValue.length > 4_096 || /[\u0000-\u001f\u007f]/.test(headerValue)) throw new Error("Browser runtime broker headers contain an invalid name or value");
    headers[name] = headerValue;
  }
  return headers;
}

/** Convert a durable resource record to the redacted lifecycle/action wire form. */
export function browserRuntimeWireResource(record: ExternalResourceRecord): BrowserRuntimeWireResource {
  return {
    schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
    id: record.id,
    kind: "browser-context",
    runId: record.runId,
    generation: record.generation,
    ownerLane: record.ownerLane,
    externalId: record.externalId!,
    ...(record.effectId ? { effectId: record.effectId } : {}),
    ...(record.requestKey ? { requestKey: record.requestKey } : {}),
    ...(record.policyHash ? { policyHash: record.policyHash } : {}),
    ...(record.recipeHash ? { recipeHash: record.recipeHash } : {}),
    ...(record.scopeHash ? { scopeHash: record.scopeHash } : {}),
    ...(record.bindingTxnId ? { bindingTxnId: record.bindingTxnId } : {}),
  };
}

function parseWireRequest(value: unknown): BrowserRuntimeWireRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser broker request must be an object");
  const input = value as Record<string, unknown>;
  assertKeys(input, ["schemaVersion", "operation", "resource", "reason"], "request");
  if (input.schemaVersion !== BROWSER_RUNTIME_WIRE_SCHEMA_VERSION || !isOperation(input.operation)) throw new Error("Browser broker request has an unsupported schema or operation");
  const resource = parseBrowserRuntimeWireResource(input.resource);
  if (input.reason !== undefined && (!isSafeText(input.reason, MAX_SUMMARY_LENGTH) || input.operation !== "release")) throw new Error("Browser broker release reason is invalid");
  return {
    schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
    operation: input.operation,
    resource,
    ...(input.reason !== undefined ? { reason: input.reason as string } : {}),
  };
}

function parseCreateWireRequest(value: unknown): BrowserRuntimeCreateWireRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser create request must be an object");
  const input = value as Record<string, unknown>;
  assertKeys(input, ["schemaVersion", "operation", "idempotencyKey", "request"], "create request");
  if (input.schemaVersion !== BROWSER_RUNTIME_WIRE_SCHEMA_VERSION || input.operation !== "create") throw new Error("Browser create request has an unsupported schema or operation");
  if (!isHash(input.idempotencyKey)) throw new Error("Browser create request idempotency key is invalid");
  return {
    schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
    operation: "create",
    idempotencyKey: input.idempotencyKey as string,
    request: parseBrowserRuntimeCreateRequest(input.request),
  };
}

/** Parse the immutable create payload shared by wire and durable ledgers. */
export function parseBrowserRuntimeCreateRequest(value: unknown): BrowserRuntimeCreateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser create request payload must be an object");
  const request = value as Record<string, unknown>;
  assertKeys(request, ["runId", "generation", "ownerLane", "target", "policyHash", "recipeHash", "verificationKey", "allowedHosts", "allowedPorts", "maxResponseBytes", "scopeHash"], "create payload");
  if (!isSafeText(request.runId) || request.ownerLane !== "verifier" || !isHttpUrl(request.target)) throw new Error("Browser create request has an invalid run, owner, or target");
  if (!Number.isSafeInteger(request.generation) || (request.generation as number) < 0) throw new Error("Browser create request generation is invalid");
  if (!isHash(request.policyHash) || !isOptionalHash(request.recipeHash) || !isSafeText(request.verificationKey) || !isHash(request.scopeHash)) throw new Error("Browser create request binding is invalid");
  if (!Array.isArray(request.allowedHosts) || request.allowedHosts.length > 128 || request.allowedHosts.some((host) => !isSafeText(host, 253))) throw new Error("Browser create request host scope is invalid");
  if (!Array.isArray(request.allowedPorts) || request.allowedPorts.length > 128 || request.allowedPorts.some((port) => !Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65_535)) throw new Error("Browser create request port scope is invalid");
  if (!Number.isSafeInteger(request.maxResponseBytes) || (request.maxResponseBytes as number) < 1 || (request.maxResponseBytes as number) > 8 * 1_048_576) throw new Error("Browser create request response limit is invalid");
  return {
    runId: request.runId as string,
    generation: request.generation as number,
    ownerLane: "verifier",
    target: request.target as string,
    policyHash: request.policyHash as string,
    ...(request.recipeHash !== undefined ? { recipeHash: request.recipeHash as string } : {}),
    verificationKey: request.verificationKey as string,
    allowedHosts: request.allowedHosts as string[],
    allowedPorts: request.allowedPorts as number[],
    maxResponseBytes: request.maxResponseBytes as number,
    scopeHash: request.scopeHash as string,
  };
}

function parseHeartbeatWireRequest(value: unknown): BrowserRuntimeHeartbeatWireRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser heartbeat request must be an object");
  const input = value as Record<string, unknown>;
  assertKeys(input, ["schemaVersion", "operation", "resource"], "heartbeat request");
  if (input.schemaVersion !== BROWSER_RUNTIME_WIRE_SCHEMA_VERSION || input.operation !== "heartbeat") throw new Error("Browser heartbeat request has an unsupported schema or operation");
  return { schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION, operation: "heartbeat", resource: parseBrowserRuntimeWireResource(input.resource) };
}

/** Parse and validate the redacted resource binding shared by lifecycle/action wires. */
export function parseBrowserRuntimeWireResource(value: unknown): BrowserRuntimeWireResource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser broker resource must be an object");
  const input = value as Record<string, unknown>;
  assertKeys(input, ["schemaVersion", "id", "kind", "runId", "generation", "ownerLane", "externalId", "effectId", "requestKey", "policyHash", "recipeHash", "scopeHash", "bindingTxnId"], "resource");
  if (input.schemaVersion !== BROWSER_RUNTIME_WIRE_SCHEMA_VERSION || input.kind !== "browser-context") throw new Error("Browser broker resource has an unsupported schema or kind");
  if (!isSafeText(input.id) || !isSafeText(input.runId) || !isSafeOpaqueHandle(input.externalId)) throw new Error("Browser broker resource identity is invalid");
  if (!Number.isSafeInteger(input.generation) || (input.generation as number) < 0) throw new Error("Browser broker resource generation is invalid");
  if (!isOwnerLane(input.ownerLane)) throw new Error("Browser broker resource owner lane is invalid");
  if (!isOptionalText(input.effectId) || !isOptionalText(input.requestKey) || !isOptionalHash(input.policyHash) || !isOptionalHash(input.recipeHash) || !isOptionalHash(input.scopeHash) || !isOptionalHash(input.bindingTxnId)) throw new Error("Browser broker resource binding is invalid");
  return {
    schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
    id: input.id as string,
    kind: "browser-context",
    runId: input.runId as string,
    generation: input.generation as number,
    ownerLane: input.ownerLane as ExternalResourceRecord["ownerLane"],
    externalId: input.externalId as string,
    ...(input.effectId !== undefined ? { effectId: input.effectId as string } : {}),
    ...(input.requestKey !== undefined ? { requestKey: input.requestKey as string } : {}),
    ...(input.policyHash !== undefined ? { policyHash: input.policyHash as string } : {}),
    ...(input.recipeHash !== undefined ? { recipeHash: input.recipeHash as string } : {}),
    ...(input.scopeHash !== undefined ? { scopeHash: input.scopeHash as string } : {}),
    ...(input.bindingTxnId !== undefined ? { bindingTxnId: input.bindingTxnId as string } : {}),
  };
}

function assertKeys(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (unexpected) throw new Error(`Browser broker ${label} contains an unsupported field: ${unexpected}`);
}

function isOperation(value: unknown): value is BrowserRuntimeWireRequest["operation"] {
  return value === "inspect" || value === "adopt" || value === "release" || value === "bind";
}

function isHealthStatus(value: unknown): value is BrowserRuntimeHealthStatus {
  return value === "READY" || value === "DEGRADED" || value === "UNAVAILABLE";
}

function isActionKind(value: unknown): value is BrowserRuntimeActionKind {
  return value === "navigate" || value === "click" || value === "fill" || value === "submit" || value === "wait";
}

function isOwnerLane(value: unknown): value is ExternalResourceRecord["ownerLane"] {
  return value === "main" || value === "planner" || value === "executor" || value === "verifier" || value === "system";
}

function isSafeText(value: unknown, maxLength = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || isSafeText(value);
}

function isOptionalHash(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && /^[a-f0-9]{64}$/i.test(value));
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isHttpUrl(value: unknown): value is string {
  if (!isSafeText(value, 2_048)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validateWireResponse<T extends { schemaVersion: typeof BROWSER_RUNTIME_WIRE_SCHEMA_VERSION; operation: BrowserRuntimeWireRequest["operation"] }>(value: unknown, operation: BrowserRuntimeWireRequest["operation"]): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Browser broker ${operation} returned a non-object response`);
  const input = value as Record<string, unknown>;
  assertKeys(input, operation === "inspect"
    ? ["schemaVersion", "operation", "status", "binding", "externalId", "summary"]
    : operation === "adopt"
      ? ["schemaVersion", "operation", "state", "externalId", "summary"]
      : operation === "release"
        ? ["schemaVersion", "operation", "released", "summary"]
        : ["schemaVersion", "operation", "state", "externalId", "summary"], `${operation} response`);
  if (input.schemaVersion !== BROWSER_RUNTIME_WIRE_SCHEMA_VERSION || input.operation !== operation) throw new Error(`Browser broker ${operation} returned an unsupported wire response`);
  if (operation === "inspect" && (!isStatus(input.status) || !isBinding(input.binding))) throw new Error("Browser broker inspect returned an invalid status");
  if (operation === "adopt" && input.state !== "CONFIRMED" && input.state !== "UNKNOWN") throw new Error("Browser broker adopt returned an invalid state");
  if (operation === "release" && typeof input.released !== "boolean") throw new Error("Browser broker release returned an invalid result");
  if (operation === "bind" && input.state !== "BOUND" && input.state !== "UNKNOWN") throw new Error("Browser broker bind returned an invalid state");
  if (input.externalId !== undefined && (typeof input.externalId !== "string" || !isSafeOpaqueHandle(input.externalId))) throw new Error("Browser broker returned an invalid opaque handle");
  if (input.summary !== undefined && !isSafeText(input.summary, MAX_SUMMARY_LENGTH)) throw new Error("Browser broker returned an invalid summary");
  return {
    ...value,
    ...(input.summary === undefined ? {} : { summary: boundedSummary(input.summary as string) }),
  } as T;
}

function validateCreateWireResponse(value: unknown): BrowserRuntimeCreateWireResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser broker create returned a non-object response");
  const input = value as Record<string, unknown>;
  assertKeys(input, ["schemaVersion", "operation", "state", "sessionId", "externalId", "initialUrl", "stateHash", "summary"], "create response");
  if (input.schemaVersion !== BROWSER_RUNTIME_WIRE_SCHEMA_VERSION || input.operation !== "create") throw new Error("Browser broker create returned an unsupported wire response");
  if (input.state !== "CREATED" && input.state !== "EXISTING" && input.state !== "UNKNOWN") throw new Error("Browser broker create returned an invalid state");
  if (input.summary !== undefined && !isSafeText(input.summary, MAX_SUMMARY_LENGTH)) throw new Error("Browser broker create returned an invalid summary");
  const hasIdentity = input.sessionId !== undefined || input.externalId !== undefined || input.initialUrl !== undefined || input.stateHash !== undefined;
  if (input.state === "UNKNOWN") {
    if (hasIdentity) throw new Error("Browser broker create UNKNOWN response must not expose a context identity");
  } else {
    if (!isSafeOpaqueHandle(input.sessionId) || !isSafeOpaqueHandle(input.externalId) || !isHttpUrl(input.initialUrl) || !isHash(input.stateHash)) throw new Error("Browser broker create response identity is invalid");
  }
  return {
    schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
    operation: "create",
    state: input.state as BrowserRuntimeCreateWireResponse["state"],
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId as string } : {}),
    ...(input.externalId !== undefined ? { externalId: input.externalId as string } : {}),
    ...(input.initialUrl !== undefined ? { initialUrl: input.initialUrl as string } : {}),
    ...(input.stateHash !== undefined ? { stateHash: input.stateHash as string } : {}),
    ...(input.summary !== undefined ? { summary: boundedSummary(input.summary as string) } : {}),
  };
}

function validateHealthWireResponse(value: unknown): BrowserRuntimeHealthWireResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser broker health returned a non-object response");
  const input = value as Record<string, unknown>;
  assertKeys(input, ["schemaVersion", "operation", "status", "capabilities", "summary"], "health response");
  if (input.schemaVersion !== BROWSER_RUNTIME_WIRE_SCHEMA_VERSION || input.operation !== "health" || !isHealthStatus(input.status)) throw new Error("Browser broker health returned an unsupported response");
  if (!input.capabilities || typeof input.capabilities !== "object" || Array.isArray(input.capabilities)) throw new Error("Browser broker health capabilities are invalid");
  const capabilities = input.capabilities as Record<string, unknown>;
  assertKeys(capabilities, ["actions", "maxResponseBytes", "stableAcrossRestart"], "health capabilities");
  if (!Array.isArray(capabilities.actions) || capabilities.actions.length > 5 || capabilities.actions.some((action) => !isActionKind(action)) || new Set(capabilities.actions).size !== capabilities.actions.length) throw new Error("Browser broker health actions are invalid");
  if (!Number.isSafeInteger(capabilities.maxResponseBytes) || (capabilities.maxResponseBytes as number) < 1 || (capabilities.maxResponseBytes as number) > 8 * 1_048_576 || typeof capabilities.stableAcrossRestart !== "boolean") throw new Error("Browser broker health capability limits are invalid");
  if (input.summary !== undefined && !isSafeText(input.summary, MAX_SUMMARY_LENGTH)) throw new Error("Browser broker health summary is invalid");
  return {
    schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
    operation: "health",
    status: input.status as BrowserRuntimeHealthStatus,
    capabilities: {
      actions: [...capabilities.actions] as BrowserRuntimeActionKind[],
      maxResponseBytes: capabilities.maxResponseBytes as number,
      stableAcrossRestart: capabilities.stableAcrossRestart as boolean,
    },
    ...(input.summary === undefined ? {} : { summary: boundedSummary(input.summary as string) }),
  };
}

function validateHeartbeatWireResponse(value: unknown): BrowserRuntimeHeartbeatWireResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser broker heartbeat returned a non-object response");
  const input = value as Record<string, unknown>;
  assertKeys(input, ["schemaVersion", "operation", "state", "externalId", "expiresAt", "summary"], "heartbeat response");
  if (input.schemaVersion !== BROWSER_RUNTIME_WIRE_SCHEMA_VERSION || input.operation !== "heartbeat" || (input.state !== "CONFIRMED" && input.state !== "UNKNOWN")) throw new Error("Browser broker heartbeat returned an unsupported response");
  if (input.externalId !== undefined && !isSafeOpaqueHandle(input.externalId)) throw new Error("Browser broker heartbeat returned an invalid opaque handle");
  if (input.expiresAt !== undefined && !isSafeText(input.expiresAt, 64)) throw new Error("Browser broker heartbeat returned an invalid expiry");
  if (input.state === "CONFIRMED" && (!input.externalId || !input.expiresAt)) throw new Error("Browser broker confirmed heartbeat is missing identity or expiry");
  if (input.state === "UNKNOWN" && (input.externalId !== undefined || input.expiresAt !== undefined)) throw new Error("Browser broker unknown heartbeat must not expose lease identity");
  if (input.summary !== undefined && !isSafeText(input.summary, MAX_SUMMARY_LENGTH)) throw new Error("Browser broker heartbeat summary is invalid");
  return {
    schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
    operation: "heartbeat",
    state: input.state as BrowserRuntimeHeartbeatWireResponse["state"],
    ...(input.externalId === undefined ? {} : { externalId: input.externalId as string }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt as string }),
    ...(input.summary === undefined ? {} : { summary: boundedSummary(input.summary as string) }),
  };
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  let oversized = false;
  try {
    while (bytesRead < MAX_WIRE_RESPONSE_BYTES) {
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = MAX_WIRE_RESPONSE_BYTES - bytesRead;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      text += decoder.decode(chunk, { stream: true });
      bytesRead += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) {
        oversized = true;
        throw new Error(`Browser broker response exceeds ${MAX_WIRE_RESPONSE_BYTES} bytes`);
      }
    }
    return text + decoder.decode();
  } finally {
    if (oversized || bytesRead >= MAX_WIRE_RESPONSE_BYTES) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Browser broker request aborted");
}

function isStatus(value: unknown): value is BrowserRuntimeInspectWireResponse["status"] {
  return value === "PRESENT" || value === "ABSENT" || value === "UNKNOWN";
}

function isBinding(value: unknown): value is BrowserRuntimeInspectWireResponse["binding"] {
  return value === "MATCH" || value === "MISMATCH" || value === "UNKNOWN";
}

function isSafeOpaqueHandle(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function boundedSummary(value: string): string {
  return value.trim().slice(0, MAX_SUMMARY_LENGTH);
}
