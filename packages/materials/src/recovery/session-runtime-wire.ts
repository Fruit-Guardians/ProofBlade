import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type {
  ContainerSessionHandle,
  ContainerSessionReadOptions,
  ContainerSessionResult,
  ContainerRuntimePort,
} from "../container/contracts.js";
import type { ExternalResourceInspection, ExternalResourceRecord } from "./external-resource-registry.js";
import type {
  HttpSessionRuntimeBinding,
  PwnSessionRuntimeBinding,
  SessionRuntimeAdoptResult,
  SessionRuntimeCreateBroker,
} from "./session-resource-adapter.js";

export const SESSION_RUNTIME_WIRE_SCHEMA_VERSION = 1 as const;
const MAX_WIRE_BODY_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 1_048_576;
const SAFE_HEADERS = /^(?:accept|accept-language|cache-control|content-type|origin|referer|user-agent|x-[a-z0-9-]+)$/i;
const SECRET_HEADERS = /^(?:authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token)$/i;

export interface SessionRuntimeWireResource {
  schemaVersion: typeof SESSION_RUNTIME_WIRE_SCHEMA_VERSION;
  id: string;
  kind: "pwn-session" | "http-session";
  runId: string;
  generation: number;
  ownerLane: ExternalResourceRecord["ownerLane"];
  externalId: string;
  effectId?: string;
  requestKey?: string;
  policyHash?: string;
  recipeHash?: string;
  scopeHash?: string;
}

export type SessionRuntimeLifecycleOperation = "inspect" | "adopt" | "release" | "heartbeat";
export type SessionRuntimeActionOperation = "pwn_write" | "pwn_read" | "pwn_signal" | "pwn_close" | "http_request";
export type SessionRuntimeOperation = SessionRuntimeLifecycleOperation | SessionRuntimeActionOperation;
export type SessionRuntimeRoute = SessionRuntimeOperation | "action" | "create" | "health";

export interface SessionRuntimeWireRequest {
  schemaVersion: typeof SESSION_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: SessionRuntimeOperation;
  resource: SessionRuntimeWireResource;
  reason?: string;
  data?: string;
  encoding?: "utf8" | "base64";
  waitTimeoutMs?: number;
  idleSilenceMs?: number;
  signal?: NodeJS.Signals;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyEncoding?: "utf8" | "base64";
}

/** Immutable, non-secret identity used to create a broker-owned session. */
export interface SessionRuntimeCreateRequest {
  kind: "pwn-session" | "http-session";
  runId: string;
  generation: number;
  ownerLane: ExternalResourceRecord["ownerLane"];
  requestKey: string;
  policyHash?: string;
  recipeHash?: string;
  scopeHash?: string;
  /** Host-only creation inputs; never accepted for the opposite session kind. */
  pwn?: SessionRuntimePwnCreateSpec;
  http?: SessionRuntimeHttpCreateSpec;
}

export interface SessionRuntimeCreateWireRequest {
  schemaVersion: typeof SESSION_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "create";
  /** Stable hash of the complete create request; retries must be no-ops. */
  idempotencyKey: string;
  request: SessionRuntimeCreateRequest;
}

export interface SessionRuntimeCreateWireResponse {
  schemaVersion: typeof SESSION_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "create";
  state: "CREATED" | "EXISTING" | "UNKNOWN";
  sessionId?: string;
  externalId?: string;
  stateHash?: string;
  summary?: string;
}

/** Bounded, non-secret host inputs needed to create a Pwn session. */
export interface SessionRuntimePwnCreateSpec {
  mode: "local" | "remote";
  command: readonly string[];
  endpoint?: string;
  cwd?: string;
  waitTimeoutMs?: number;
  idleSilenceMs?: number;
}

/** Bounded HTTP target and scope needed to create a stateful HTTP session. */
export interface SessionRuntimeHttpCreateSpec {
  baseUrl: string;
  allowedHosts: readonly string[];
  allowedPorts: readonly number[];
}

export interface SessionRuntimeCreateService {
  create(request: SessionRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<Pick<SessionRuntimeCreateWireResponse, "state" | "sessionId" | "externalId" | "stateHash" | "summary">>;
}

export type SessionRuntimeHealthStatus = "READY" | "DEGRADED" | "UNAVAILABLE";

export interface SessionRuntimeHealthCapabilities {
  readonly kinds: readonly ("pwn-session" | "http-session")[];
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly stableAcrossRestart: boolean;
}

export interface SessionRuntimeHealthWireResponse {
  schemaVersion: typeof SESSION_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "health";
  status: SessionRuntimeHealthStatus;
  capabilities: SessionRuntimeHealthCapabilities;
  summary?: string;
}

export interface SessionRuntimeHealthService {
  health(signal?: AbortSignal): Promise<Pick<SessionRuntimeHealthWireResponse, "status" | "capabilities" | "summary">>;
}

export interface SessionRuntimeInspectWireResponse {
  schemaVersion: typeof SESSION_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "inspect";
  status: ExternalResourceInspection["status"];
  binding: ExternalResourceInspection["binding"];
  externalId?: string;
  summary?: string;
}

export interface SessionRuntimeAdoptWireResponse {
  schemaVersion: typeof SESSION_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "adopt";
  state: SessionRuntimeAdoptResult["state"];
  externalId?: string;
  summary?: string;
}

export interface SessionRuntimeReleaseWireResponse {
  schemaVersion: typeof SESSION_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "release";
  released: boolean;
  summary?: string;
}

export interface SessionRuntimeHeartbeatWireResponse {
  schemaVersion: typeof SESSION_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "heartbeat";
  state: "CONFIRMED" | "UNKNOWN";
  externalId?: string;
  expiresAt?: string;
  summary?: string;
}

export interface SessionRuntimePwnWireResponse {
  schemaVersion: typeof SESSION_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "pwn_write" | "pwn_read" | "pwn_signal" | "pwn_close";
  delta?: string;
  waitReason?: ContainerSessionResult["waitReason"];
  exited?: boolean;
  exitCode?: number | null;
  truncated?: boolean;
  delivered?: boolean;
}

export interface SessionRuntimeHttpWireResponse {
  schemaVersion: typeof SESSION_RUNTIME_WIRE_SCHEMA_VERSION;
  operation: "http_request";
  status: number;
  headers: Record<string, string>;
  body: string;
  stateHash: string;
}

export type SessionRuntimeWireResponse =
  | SessionRuntimeCreateWireResponse
  | SessionRuntimeHealthWireResponse
  | SessionRuntimeInspectWireResponse
  | SessionRuntimeAdoptWireResponse
  | SessionRuntimeReleaseWireResponse
  | SessionRuntimeHeartbeatWireResponse
  | SessionRuntimePwnWireResponse
  | SessionRuntimeHttpWireResponse;

export interface SessionRuntimeActionService {
  pwnWrite(resource: SessionRuntimeWireResource, data: string | Uint8Array, options?: ContainerSessionReadOptions, signal?: AbortSignal): Promise<ContainerSessionResult>;
  pwnRead(resource: SessionRuntimeWireResource, options?: ContainerSessionReadOptions, signal?: AbortSignal): Promise<ContainerSessionResult>;
  pwnSignal(resource: SessionRuntimeWireResource, signalName: NodeJS.Signals, signal?: AbortSignal): Promise<boolean>;
  pwnClose(resource: SessionRuntimeWireResource, signal?: AbortSignal): Promise<{ exitCode: number | null }>;
  httpRequest(resource: SessionRuntimeWireResource, request: { method: string; url: string; headers: Record<string, string>; body?: string; bodyEncoding?: "utf8" | "base64" }, signal?: AbortSignal): Promise<{ status: number; headers: Record<string, string>; body: string; stateHash: string }>;
}

export function sessionRuntimeWireResource(record: ExternalResourceRecord): SessionRuntimeWireResource {
  if ((record.kind !== "pwn-session" && record.kind !== "http-session") || !record.externalId) throw new Error("Session runtime broker requires a brokered session with an opaque handle");
  return {
    schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION,
    id: record.id,
    kind: record.kind,
    runId: record.runId,
    generation: record.generation,
    ownerLane: record.ownerLane,
    externalId: record.externalId,
    ...(record.effectId ? { effectId: record.effectId } : {}),
    ...(record.requestKey ? { requestKey: record.requestKey } : {}),
    ...(record.policyHash ? { policyHash: record.policyHash } : {}),
    ...(record.recipeHash ? { recipeHash: record.recipeHash } : {}),
    ...(record.scopeHash ? { scopeHash: record.scopeHash } : {}),
  };
}

/** A versioned HTTP broker for durable Pwn/HTTP sessions. */
export class HttpSessionRuntimeBroker implements SessionRuntimeCreateBroker {
  public readonly name: string;
  public readonly kind: "pwn-session" | "http-session";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly connectBinding: (record: ExternalResourceRecord, signal: AbortSignal) => Promise<SessionRuntimeWireBinding>;

  public constructor(options: HttpSessionRuntimeBrokerOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.name = options.name?.trim() || "http-session-runtime-broker";
    this.kind = options.kind;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
    this.headers = normalizeHeaders(options.headers);
    this.connectBinding = options.connectBinding;
    if (typeof this.connectBinding !== "function") throw new Error("Session runtime broker requires a binding connector");
  }

  public async inspect(record: ExternalResourceRecord, signal?: AbortSignal): Promise<ExternalResourceInspection> {
    const response = await this.request<SessionRuntimeInspectWireResponse>("inspect", record, signal);
    return { status: response.status, binding: response.binding, ...(response.externalId ? { externalId: response.externalId } : {}), ...(response.summary ? { summary: response.summary } : {}) };
  }

  public async adopt(record: ExternalResourceRecord, inspection: ExternalResourceInspection, signal?: AbortSignal): Promise<SessionRuntimeAdoptResult> {
    if (inspection.status !== "PRESENT" || inspection.binding !== "MATCH" || inspection.externalId !== record.externalId) return { state: "UNKNOWN", summary: inspection.summary ?? "Session broker did not confirm the exact opaque handle" };
    const response = await this.request<SessionRuntimeAdoptWireResponse>("adopt", record, signal);
    if (response.state !== "CONFIRMED" || response.externalId !== record.externalId) return { state: "UNKNOWN", summary: response.summary ?? "Session broker did not confirm adoption" };
    try {
      const binding = await this.connectBinding(record, signal ?? new AbortController().signal);
      return { state: "CONFIRMED", ...(response.summary ? { summary: response.summary } : {}), binding };
    } catch (error) {
      return { state: "UNKNOWN", summary: boundedSummary(error instanceof Error ? error.message : String(error)) };
    }
  }

  public async release(record: ExternalResourceRecord, reason: string, signal?: AbortSignal): Promise<{ released: boolean; summary?: string }> {
    const response = await this.request<SessionRuntimeReleaseWireResponse>("release", record, signal, reason);
    return { released: response.released, ...(response.summary ? { summary: response.summary } : {}) };
  }

  /** Refresh a durable session lease after the exact resource binding is revalidated. */
  public async heartbeat(record: ExternalResourceRecord, signal?: AbortSignal): Promise<SessionRuntimeHeartbeatWireResponse> {
    if ((record.kind !== "pwn-session" && record.kind !== "http-session") || this.kind !== record.kind) throw new Error("Session runtime broker heartbeat kind does not match the resource");
    return await this.heartbeatWireResource(sessionRuntimeWireResource(record), signal);
  }

  /** Refresh a lease for a wire resource that has not been projected locally. */
  public async heartbeatWireResource(resource: SessionRuntimeWireResource, signal?: AbortSignal): Promise<SessionRuntimeHeartbeatWireResponse> {
    if (resource.kind !== this.kind) throw new Error(`Session runtime broker ${this.name} cannot heartbeat ${resource.kind} with a ${this.kind} client`);
    return await this.requestWire<SessionRuntimeHeartbeatWireResponse>("heartbeat", resource, signal);
  }

  /** Request an idempotent remote Pwn/HTTP session create/open. */
  public async create(request: SessionRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<SessionRuntimeCreateWireResponse> {
    if (request.kind !== this.kind) throw new Error(`Session runtime broker ${this.name} cannot create ${request.kind} with a ${this.kind} client`);
    const wire: SessionRuntimeCreateWireRequest = { schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION, operation: "create", idempotencyKey, request };
    validateSessionRuntimeCreateRequest(wire);
    const response = await this.fetchWithTimeout(`${this.baseUrl}/v1/session/create`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...this.headers },
      body: JSON.stringify(wire),
      redirect: "manual",
    }, signal);
    return await parseResponse<SessionRuntimeCreateWireResponse>(response, "create");
  }

  public async createBinding(record: ExternalResourceRecord, signal?: AbortSignal): Promise<SessionRuntimeWireBinding> {
    return await this.connectBinding(record, signal ?? new AbortController().signal);
  }

  /** Probe runtime availability and the bounded capabilities it can honor. */
  public async health(signal?: AbortSignal): Promise<SessionRuntimeHealthWireResponse> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/v1/session/health`, {
      method: "GET",
      headers: { accept: "application/json", ...this.headers },
      redirect: "manual",
    }, signal);
    return await parseResponse<SessionRuntimeHealthWireResponse>(response, "health");
  }

  public async action<T extends SessionRuntimeWireResponse>(request: Omit<SessionRuntimeWireRequest, "schemaVersion">, signal?: AbortSignal): Promise<T> {
    const wire = { schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION, ...request };
    validateSessionRuntimeRequest(wire);
    const response = await this.fetchWithTimeout(`${this.baseUrl}/v1/session/action`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...this.headers },
      body: JSON.stringify(wire),
      redirect: "manual",
    }, signal);
    return await parseResponse<T>(response, request.operation);
  }

  public createHttpFetch(record: ExternalResourceRecord): typeof fetch {
    if (record.kind !== "http-session" || this.kind !== "http-session") throw new Error("HTTP session runtime requires an http-session broker and resource");
    const resource = sessionRuntimeWireResource(record);
    return async (input, init = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init.method ?? "GET").toString().toUpperCase();
      const headers = safeRequestHeaders(init.headers);
      const encodedBody = encodeFetchBody(init.body);
      const heartbeat = await this.heartbeat(record, init.signal ?? undefined);
      if (heartbeat.state !== "CONFIRMED") throw new Error(heartbeat.summary ?? "Session broker lease heartbeat was not confirmed");
      const response = await this.action<SessionRuntimeHttpWireResponse>({ operation: "http_request", resource, method, url, headers, ...(encodedBody === undefined ? {} : { body: encodedBody.value, bodyEncoding: encodedBody.encoding }) }, init.signal ?? undefined);
      return new Response(response.body, { status: response.status, headers: response.headers });
    };
  }

  public createPwnRuntime(handle: ContainerSessionHandle, record: ExternalResourceRecord): Pick<ContainerRuntimePort, "sessionWrite" | "sessionRead" | "sessionSignal" | "closeSession"> {
    if (record.kind !== "pwn-session" || this.kind !== "pwn-session") throw new Error("Pwn session runtime requires a pwn-session broker and resource");
    const resource = sessionRuntimeWireResource(record);
    return {
      sessionWrite: async (_handle, data, options) => await this.pwnAction(resource, "pwn_write", data, options),
      sessionRead: async (_handle, options) => await this.pwnAction(resource, "pwn_read", undefined, options),
      sessionSignal: async (_handle, signalName) => {
        const heartbeat = await this.heartbeat(record);
        if (heartbeat.state !== "CONFIRMED") throw new Error(heartbeat.summary ?? "Session broker lease heartbeat was not confirmed");
        return (await this.action<SessionRuntimePwnWireResponse>({ operation: "pwn_signal", resource, signal: signalName })).delivered ?? false;
      },
      closeSession: async (_handle) => {
        let response: SessionRuntimePwnWireResponse | undefined;
        try {
          const heartbeat = await this.heartbeat(record);
          if (heartbeat.state !== "CONFIRMED") throw new Error(heartbeat.summary ?? "Session broker lease heartbeat was not confirmed");
          response = await this.action<SessionRuntimePwnWireResponse>({ operation: "pwn_close", resource });
        } finally {
          // pwn_close terminates the host process; release the durable broker
          // lease as a separate idempotent lifecycle operation so a later
          // reproduction cannot receive the dead session for the same key.
          const released = await this.release(record, "Pwn session closed");
          if (!released.released) throw new Error(released.summary ?? "Pwn session broker did not confirm release");
        }
        return { exitCode: response?.exitCode ?? null };
      },
    };
  }

  private async pwnAction(resource: SessionRuntimeWireResource, operation: "pwn_write" | "pwn_read", data?: string | Uint8Array, options?: ContainerSessionReadOptions): Promise<ContainerSessionResult> {
    const heartbeat = await this.heartbeatWireResource(resource);
    if (heartbeat.state !== "CONFIRMED") throw new Error(heartbeat.summary ?? "Session broker lease heartbeat was not confirmed");
    const encoded = data === undefined ? undefined : typeof data === "string" ? data : Buffer.from(data).toString("base64");
    const response = await this.action<SessionRuntimePwnWireResponse>({ operation, resource, ...(encoded === undefined ? {} : { data: encoded, encoding: typeof data === "string" ? "utf8" : "base64" }), ...(options?.waitTimeoutMs === undefined ? {} : { waitTimeoutMs: options.waitTimeoutMs }), ...(options?.idleSilenceMs === undefined ? {} : { idleSilenceMs: options.idleSilenceMs }) });
    return { delta: response.delta ?? "", waitReason: response.waitReason ?? "idle", exited: response.exited ?? false, ...(response.exitCode === undefined ? {} : { exitCode: response.exitCode }), truncated: response.truncated ?? false };
  }

  private async request<T extends SessionRuntimeWireResponse>(operation: SessionRuntimeLifecycleOperation, record: ExternalResourceRecord, signal?: AbortSignal, reason?: string): Promise<T> {
    return await this.requestWire(operation, sessionRuntimeWireResource(record), signal, reason);
  }

  private async requestWire<T extends SessionRuntimeWireResponse>(operation: SessionRuntimeLifecycleOperation, resource: SessionRuntimeWireResource, signal?: AbortSignal, reason?: string): Promise<T> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/v1/session/${operation}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...this.headers },
      body: JSON.stringify({ schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION, operation, resource, ...(reason ? { reason } : {}) }),
      redirect: "manual",
    }, signal);
    return await parseResponse<T>(response, operation);
  }

  private async fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const mergedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error(`Session broker ${this.name} timed out`)), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: mergedSignal });
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface HttpSessionRuntimeBrokerOptions {
  readonly baseUrl: string;
  readonly kind: "pwn-session" | "http-session";
  readonly name?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly connectBinding: (record: ExternalResourceRecord, signal: AbortSignal) => Promise<SessionRuntimeWireBinding>;
}

export type SessionRuntimeWireBinding = PwnSessionRuntimeBinding | HttpSessionRuntimeBinding;

/** Build a Node listener for the session lifecycle and action wire. */
export function createSessionRuntimeHttpHandler(
  lifecycle: SessionRuntimeBrokerService,
  actions?: SessionRuntimeActionService,
  options: SessionRuntimeHttpHandlerOptions = {},
): RequestListener {
  const maxRequestBytes = options.maxRequestBytes ?? 2 * 1024 * 1024;
  if (!Number.isInteger(maxRequestBytes) || maxRequestBytes < 1_024 || maxRequestBytes > 4 * 1024 * 1024) throw new Error("Session runtime HTTP maxRequestBytes must be between 1024 and 4194304");
  return (request, response) => {
    void handleSessionRuntimeRequest(request, response, lifecycle, actions, options, maxRequestBytes).catch((error: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      sendJson(response, error instanceof SessionRuntimeWireRequestError ? 400 : 503, { error: error instanceof SessionRuntimeWireRequestError ? "invalid_session_runtime_request" : "session_runtime_unavailable" });
    });
  };
}

export interface SessionRuntimeBrokerService {
  inspect(resource: SessionRuntimeWireResource, signal?: AbortSignal): Promise<ExternalResourceInspection>;
  adopt(resource: SessionRuntimeWireResource, signal?: AbortSignal): Promise<{ state: "CONFIRMED" | "UNKNOWN"; externalId?: string; summary?: string }>;
  release(resource: SessionRuntimeWireResource, reason: string, signal?: AbortSignal): Promise<{ released: boolean; summary?: string }>;
}

export interface SessionRuntimeHeartbeatService {
  heartbeat(resource: SessionRuntimeWireResource, signal?: AbortSignal): Promise<Pick<SessionRuntimeHeartbeatWireResponse, "state" | "externalId" | "expiresAt" | "summary">>;
}

export interface SessionRuntimeHttpHandlerOptions {
  readonly maxRequestBytes?: number;
  readonly authorize?: (request: IncomingMessage) => boolean | Promise<boolean>;
  readonly createService?: SessionRuntimeCreateService;
  readonly healthService?: SessionRuntimeHealthService;
  readonly heartbeatService?: SessionRuntimeHeartbeatService;
}

async function handleSessionRuntimeRequest(request: IncomingMessage, response: ServerResponse, lifecycle: SessionRuntimeBrokerService, actions: SessionRuntimeActionService | undefined, options: SessionRuntimeHttpHandlerOptions, maxRequestBytes: number): Promise<void> {
  const controller = new AbortController();
  const onAborted = (): void => controller.abort(new Error("Session runtime request aborted"));
  const onResponseClosed = (): void => {
    if (!response.writableEnded) controller.abort(new Error("Session runtime connection closed"));
  };
  request.once("aborted", onAborted);
  response.once("close", onResponseClosed);
  try {
    if (options.authorize && !(await options.authorize(request))) {
      sendJson(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }
    const route = parseRoute(request);
    if (route === "health") {
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "method_not_allowed" }, { allow: "GET" });
        return;
      }
      if (!options.healthService) {
        sendJson(response, 404, { error: "health_not_available" });
        return;
      }
      const health = await options.healthService.health(controller.signal);
      sendJson(response, 200, validateHealthWireResponse({ schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION, operation: "health", ...health }));
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method_not_allowed" }, { allow: "POST" });
      return;
    }
    const body = await readBody(request, maxRequestBytes, controller.signal);
    let value: unknown;
    try {
      value = JSON.parse(body) as unknown;
    } catch {
      throw new SessionRuntimeWireRequestError("session runtime request is not valid JSON");
    }
    if (route === "create") {
      if (!options.createService) {
        sendJson(response, 404, { error: "create_not_available" });
        return;
      }
      const parsed = validateSessionRuntimeCreateRequest(value);
      const created = await options.createService.create(parsed.request, parsed.idempotencyKey, controller.signal);
      sendJson(response, 200, validateCreateWireResponse({ schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION, operation: "create", ...created }));
      return;
    }
    const parsed = validateSessionRuntimeRequest(value);
    if (parsed.operation === "heartbeat") {
      if (route !== "heartbeat") throw new SessionRuntimeWireRequestError("route operation mismatch");
      if (!options.heartbeatService) {
        sendJson(response, 404, { error: "heartbeat_not_available" });
        return;
      }
      const heartbeat = await options.heartbeatService.heartbeat(parsed.resource, controller.signal);
      sendJson(response, 200, validateHeartbeatWireResponse({ schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION, operation: "heartbeat", ...heartbeat }));
      return;
    }
    if (parsed.operation === "inspect" || parsed.operation === "adopt" || parsed.operation === "release") {
      if (parsed.operation !== route) throw new SessionRuntimeWireRequestError("route operation mismatch");
      if (parsed.operation === "inspect") {
        const inspected = await lifecycle.inspect(parsed.resource, controller.signal);
        sendJson(response, 200, { schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION, operation: "inspect", ...inspected });
      }
      else if (parsed.operation === "adopt") sendJson(response, 200, { schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION, operation: "adopt", ...(await lifecycle.adopt(parsed.resource, controller.signal)) });
      else sendJson(response, 200, { schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION, operation: "release", ...(await lifecycle.release(parsed.resource, parsed.reason ?? "unspecified release", controller.signal)) });
      return;
    }
    if (route !== "action") throw new SessionRuntimeWireRequestError("route operation mismatch");
    if (!actions) {
      sendJson(response, 404, { error: "action_not_available" });
      return;
    }
    if (parsed.operation === "pwn_write") {
      const data = decodeData(parsed.data ?? "", parsed.encoding ?? "utf8");
      sendJson(response, 200, pwnResponse(parsed.operation, await actions.pwnWrite(parsed.resource, data, readOptions(parsed), controller.signal)));
    } else if (parsed.operation === "pwn_read") {
      sendJson(response, 200, pwnResponse(parsed.operation, await actions.pwnRead(parsed.resource, readOptions(parsed), controller.signal)));
    } else if (parsed.operation === "pwn_signal") {
      sendJson(response, 200, { schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION, operation: parsed.operation, delivered: await actions.pwnSignal(parsed.resource, parsed.signal!, controller.signal) });
    } else if (parsed.operation === "pwn_close") {
      const closed = await actions.pwnClose(parsed.resource, controller.signal);
      sendJson(response, 200, { schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION, operation: parsed.operation, exitCode: closed.exitCode });
    } else {
      const result = await actions.httpRequest(parsed.resource, { method: parsed.method!, url: parsed.url!, headers: parsed.headers ?? {}, ...(parsed.body === undefined ? {} : { body: parsed.body }), ...(parsed.bodyEncoding ? { bodyEncoding: parsed.bodyEncoding } : {}) }, controller.signal);
      sendJson(response, 200, { schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION, operation: parsed.operation, ...result });
    }
  } catch (error) {
    if (controller.signal.aborted || response.destroyed) return;
    const invalid = error instanceof SessionRuntimeWireRequestError;
    sendJson(response, invalid ? 400 : 503, { error: invalid ? "invalid_session_runtime_request" : "session_runtime_unavailable", ...(invalid ? {} : { summary: boundedSummary(error instanceof Error ? error.message : String(error)) }) });
  } finally {
    request.removeListener("aborted", onAborted);
    response.removeListener("close", onResponseClosed);
  }
}

function parseRoute(request: IncomingMessage): SessionRuntimeRoute {
  let path: string;
  try {
    path = new URL(request.url ?? "/", "http://session-runtime.invalid").pathname;
  } catch {
    throw new SessionRuntimeWireRequestError("session runtime route is invalid");
  }
  const match = /^\/v1\/session\/(inspect|adopt|release|heartbeat|action|create|health)$/.exec(path);
  if (!match) throw new SessionRuntimeWireRequestError("session runtime route is not available");
  return match[1] as SessionRuntimeRoute;
}

async function readBody(request: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Session runtime request aborted");
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new SessionRuntimeWireRequestError("request body exceeds its byte limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function validateSessionRuntimeRequest(value: unknown): SessionRuntimeWireRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionRuntimeWireRequestError("session runtime request must be an object");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== SESSION_RUNTIME_WIRE_SCHEMA_VERSION || typeof input.operation !== "string" || !isOperation(input.operation)) throw new SessionRuntimeWireRequestError("session runtime request has an invalid operation");
  const resource = parseResource(input.resource);
  if (input.operation === "pwn_signal" && !isSignal(input.signal)) throw new SessionRuntimeWireRequestError("pwn_signal requires a valid signal");
  if (input.operation === "http_request" && (typeof input.method !== "string" || typeof input.url !== "string" || !isSafeHttpUrl(input.url))) throw new SessionRuntimeWireRequestError("http_request requires a safe URL and method");
  if (input.data !== undefined && typeof input.data !== "string") throw new SessionRuntimeWireRequestError("session action data must be a string");
  if (typeof input.data === "string" && Buffer.byteLength(input.data, "utf8") > MAX_WIRE_BODY_BYTES * 4 / 3) throw new SessionRuntimeWireRequestError("session action data exceeds its byte limit");
  return { schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION, operation: input.operation, resource, ...(typeof input.reason === "string" ? { reason: input.reason.slice(0, 512) } : {}), ...(typeof input.data === "string" ? { data: input.data } : {}), ...(input.encoding === "utf8" || input.encoding === "base64" ? { encoding: input.encoding } : {}), ...(integerOption(input.waitTimeoutMs) ? { waitTimeoutMs: input.waitTimeoutMs as number } : {}), ...(integerOption(input.idleSilenceMs) ? { idleSilenceMs: input.idleSilenceMs as number } : {}), ...(isSignal(input.signal) ? { signal: input.signal } : {}), ...(typeof input.method === "string" ? { method: input.method.toUpperCase() } : {}), ...(typeof input.url === "string" ? { url: input.url } : {}), ...(input.headers && typeof input.headers === "object" && !Array.isArray(input.headers) ? { headers: safeRequestHeaders(input.headers as Record<string, string>) } : {}), ...(typeof input.body === "string" ? { body: input.body.slice(0, MAX_WIRE_BODY_BYTES) } : {}), ...(input.bodyEncoding === "utf8" || input.bodyEncoding === "base64" ? { bodyEncoding: input.bodyEncoding } : {}) };
}

function validateSessionRuntimeCreateRequest(value: unknown): SessionRuntimeCreateWireRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionRuntimeWireRequestError("session runtime create request must be an object");
  const input = value as Record<string, unknown>;
  assertKeys(input, ["schemaVersion", "operation", "idempotencyKey", "request"], "create request");
  if (input.schemaVersion !== SESSION_RUNTIME_WIRE_SCHEMA_VERSION || input.operation !== "create" || !isHash(input.idempotencyKey)) throw new SessionRuntimeWireRequestError("session runtime create request has an invalid idempotency key");
  const request = normalizeSessionRuntimeCreateRequest(input.request);
  return {
    schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION,
    operation: "create",
    idempotencyKey: input.idempotencyKey,
    request,
  };
}

/** Normalize and validate the immutable, non-secret inputs for session creation. */
export function normalizeSessionRuntimeCreateRequest(value: unknown): SessionRuntimeCreateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionRuntimeWireRequestError("session runtime create request identity is invalid");
  const input = value as Record<string, unknown>;
  assertKeys(input, ["kind", "runId", "generation", "ownerLane", "requestKey", "policyHash", "recipeHash", "scopeHash", "pwn", "http"], "create identity");
  if ((input.kind !== "pwn-session" && input.kind !== "http-session") || !isSafeText(input.runId) || !Number.isSafeInteger(input.generation) || (input.generation as number) < 0 || !isOwnerLane(input.ownerLane) || !isSafeText(input.requestKey)) throw new SessionRuntimeWireRequestError("session runtime create request identity is invalid");
  if (!["policyHash", "recipeHash", "scopeHash"].every((key) => input[key] === undefined || isHash(input[key]))) throw new SessionRuntimeWireRequestError("session runtime create request binding hash is invalid");
  if (input.kind === "pwn-session" && input.http !== undefined) throw new SessionRuntimeWireRequestError("pwn session create request cannot include HTTP inputs");
  if (input.kind === "http-session" && input.pwn !== undefined) throw new SessionRuntimeWireRequestError("HTTP session create request cannot include Pwn inputs");
  const pwn = input.pwn === undefined ? undefined : parsePwnCreateSpec(input.pwn);
  const http = input.http === undefined ? undefined : parseHttpCreateSpec(input.http);
  if (input.kind === "pwn-session" && http !== undefined) throw new SessionRuntimeWireRequestError("pwn session create request cannot include HTTP inputs");
  if (input.kind === "http-session" && pwn !== undefined) throw new SessionRuntimeWireRequestError("HTTP session create request cannot include Pwn inputs");
  return {
    kind: input.kind,
    runId: input.runId,
    generation: input.generation as number,
    ownerLane: input.ownerLane as ExternalResourceRecord["ownerLane"],
    requestKey: input.requestKey,
    ...(typeof input.policyHash === "string" ? { policyHash: input.policyHash } : {}),
    ...(typeof input.recipeHash === "string" ? { recipeHash: input.recipeHash } : {}),
    ...(typeof input.scopeHash === "string" ? { scopeHash: input.scopeHash } : {}),
    ...(pwn ? { pwn } : {}),
    ...(http ? { http } : {}),
  };
}

function parsePwnCreateSpec(value: unknown): SessionRuntimePwnCreateSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionRuntimeWireRequestError("Pwn session create inputs are invalid");
  const input = value as Record<string, unknown>;
  assertKeys(input, ["mode", "command", "endpoint", "cwd", "waitTimeoutMs", "idleSilenceMs"], "Pwn create inputs");
  if (input.mode !== "local" && input.mode !== "remote") throw new SessionRuntimeWireRequestError("Pwn session create mode is invalid");
  if (!Array.isArray(input.command) || input.command.length === 0 || input.command.length > 32 || input.command.some((part) => !isSafeText(part, 512))) throw new SessionRuntimeWireRequestError("Pwn session create command is invalid");
  if (input.mode === "remote" && !isSafeText(input.endpoint, 512)) throw new SessionRuntimeWireRequestError("Remote Pwn session create requires an endpoint");
  if (input.mode === "local" && input.endpoint !== undefined) throw new SessionRuntimeWireRequestError("Local Pwn session create cannot include an endpoint");
  if (input.cwd !== undefined && !isSafeText(input.cwd, 1_024)) throw new SessionRuntimeWireRequestError("Pwn session create cwd is invalid");
  if (!integerOption(input.waitTimeoutMs) || !integerOption(input.idleSilenceMs)) throw new SessionRuntimeWireRequestError("Pwn session create timeout is invalid");
  return {
    mode: input.mode,
    command: [...input.command] as string[],
    ...(typeof input.endpoint === "string" ? { endpoint: input.endpoint } : {}),
    ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
    ...(typeof input.waitTimeoutMs === "number" ? { waitTimeoutMs: input.waitTimeoutMs } : {}),
    ...(typeof input.idleSilenceMs === "number" ? { idleSilenceMs: input.idleSilenceMs } : {}),
  };
}

function parseHttpCreateSpec(value: unknown): SessionRuntimeHttpCreateSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionRuntimeWireRequestError("HTTP session create inputs are invalid");
  const input = value as Record<string, unknown>;
  assertKeys(input, ["baseUrl", "allowedHosts", "allowedPorts"], "HTTP create inputs");
  if (typeof input.baseUrl !== "string" || !isSafeHttpUrl(input.baseUrl)) throw new SessionRuntimeWireRequestError("HTTP session create baseUrl is invalid");
  if (!Array.isArray(input.allowedHosts) || input.allowedHosts.length > 128 || input.allowedHosts.some((host) => !isSafeText(host, 253))) throw new SessionRuntimeWireRequestError("HTTP session create allowedHosts is invalid");
  if (!Array.isArray(input.allowedPorts) || input.allowedPorts.length > 128 || input.allowedPorts.some((port) => !Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65_535)) throw new SessionRuntimeWireRequestError("HTTP session create allowedPorts is invalid");
  return { baseUrl: input.baseUrl, allowedHosts: [...input.allowedHosts] as string[], allowedPorts: [...input.allowedPorts] as number[] };
}

function parseResource(value: unknown): SessionRuntimeWireResource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionRuntimeWireRequestError("session runtime resource is invalid");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== SESSION_RUNTIME_WIRE_SCHEMA_VERSION || typeof input.id !== "string" || typeof input.kind !== "string" || (input.kind !== "pwn-session" && input.kind !== "http-session") || typeof input.runId !== "string" || !Number.isInteger(input.generation) || typeof input.ownerLane !== "string" || typeof input.externalId !== "string" || !input.externalId.trim()) throw new SessionRuntimeWireRequestError("session runtime resource is invalid");
  if (!isOwnerLane(input.ownerLane)) throw new SessionRuntimeWireRequestError("session runtime resource owner lane is invalid");
  return { schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION, id: input.id, kind: input.kind, runId: input.runId, generation: input.generation as number, ownerLane: input.ownerLane as ExternalResourceRecord["ownerLane"], externalId: input.externalId, ...optionalString(input, "effectId"), ...optionalString(input, "requestKey"), ...optionalString(input, "policyHash"), ...optionalString(input, "recipeHash"), ...optionalString(input, "scopeHash") };
}

function pwnResponse(operation: SessionRuntimePwnWireResponse["operation"], result: ContainerSessionResult): SessionRuntimePwnWireResponse {
  return { schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION, operation, delta: result.delta.slice(0, MAX_RESPONSE_BYTES), waitReason: result.waitReason, exited: result.exited, ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }), truncated: result.truncated || Buffer.byteLength(result.delta, "utf8") > MAX_RESPONSE_BYTES };
}

function readOptions(value: SessionRuntimeWireRequest): ContainerSessionReadOptions {
  return { ...(value.waitTimeoutMs === undefined ? {} : { waitTimeoutMs: value.waitTimeoutMs }), ...(value.idleSilenceMs === undefined ? {} : { idleSilenceMs: value.idleSilenceMs }) };
}

function decodeData(data: string, encoding: "utf8" | "base64"): string | Uint8Array {
  if (encoding === "utf8") return data;
  const decoded = Buffer.from(data, "base64");
  if (decoded.byteLength > MAX_WIRE_BODY_BYTES) throw new SessionRuntimeWireRequestError("session action data exceeds its byte limit");
  return decoded;
}

function encodeFetchBody(value: BodyInit | null | undefined): { value: string; encoding: "utf8" | "base64" } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return { value, encoding: "utf8" };
  if (value instanceof Uint8Array) return { value: Buffer.from(value).toString("base64"), encoding: "base64" };
  if (value instanceof ArrayBuffer) return { value: Buffer.from(new Uint8Array(value)).toString("base64"), encoding: "base64" };
  throw new Error("Remote HTTP session only supports string or byte-array request bodies");
}

async function parseResponse<T>(response: Response, operation: string): Promise<T> {
  const body = await readBoundedResponseText(response);
  if (!response.ok) throw new Error(`Session broker ${operation} failed with HTTP ${response.status}`);
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new Error(`Session broker ${operation} returned invalid JSON`); }
  return validateSessionRuntimeResponse(parsed, operation) as T;
}

/** Read a broker response incrementally so a peer cannot allocate an unbounded body. */
async function readBoundedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Session broker response exceeds its byte limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let body = "";
  let overflow = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (value.byteLength > MAX_RESPONSE_BYTES - bytesRead) {
        overflow = true;
        throw new Error("Session broker response exceeds its byte limit");
      }
      bytesRead += value.byteLength;
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    if (overflow || bytesRead >= MAX_RESPONSE_BYTES) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function validateSessionRuntimeResponse(value: unknown, operation: string): SessionRuntimeWireResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Session broker ${operation} returned an invalid response`);
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== SESSION_RUNTIME_WIRE_SCHEMA_VERSION || input.operation !== operation) throw new Error(`Session broker ${operation} returned a mismatched response`);
  if (operation === "create") return validateCreateWireResponse(value);
  if (operation === "health") return validateHealthWireResponse(value);
  if (operation === "inspect") {
    if (!["PRESENT", "ABSENT", "UNKNOWN"].includes(input.status as string) || !["MATCH", "MISMATCH", "UNKNOWN"].includes(input.binding as string)) throw new Error("Session broker inspect response is invalid");
    return input as unknown as SessionRuntimeInspectWireResponse;
  }
  if (operation === "adopt") {
    if (input.state !== "CONFIRMED" && input.state !== "UNKNOWN") throw new Error("Session broker adopt response is invalid");
    return input as unknown as SessionRuntimeAdoptWireResponse;
  }
  if (operation === "release") {
    if (typeof input.released !== "boolean") throw new Error("Session broker release response is invalid");
    return input as unknown as SessionRuntimeReleaseWireResponse;
  }
  if (operation === "heartbeat") return validateHeartbeatWireResponse(value);
  if (operation === "http_request") {
    const headers = safeResponseHeaders(input.headers);
    if (!Number.isInteger(input.status) || (input.status as number) < 100 || (input.status as number) > 599 || typeof input.body !== "string" || Buffer.byteLength(input.body, "utf8") > MAX_RESPONSE_BYTES || !/^[a-f0-9]{64}$/i.test(String(input.stateHash))) throw new Error("Session broker HTTP response is invalid");
    return { schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION, operation: "http_request", status: input.status as number, headers, body: input.body, stateHash: input.stateHash as string };
  }
  if (input.operation === "pwn_signal") {
    if (typeof input.delivered !== "boolean") throw new Error("Session broker signal response is invalid");
  } else if (input.operation === "pwn_close") {
    if (input.exitCode !== null && !Number.isInteger(input.exitCode)) throw new Error("Session broker close response is invalid");
  } else if (typeof input.delta !== "string" || Buffer.byteLength(input.delta, "utf8") > MAX_RESPONSE_BYTES || typeof input.waitReason !== "string" || typeof input.exited !== "boolean" || typeof input.truncated !== "boolean") {
    throw new Error("Session broker Pwn response is invalid");
  }
  return input as unknown as SessionRuntimePwnWireResponse;
}

function validateCreateWireResponse(value: unknown): SessionRuntimeCreateWireResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Session broker create response is invalid");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== SESSION_RUNTIME_WIRE_SCHEMA_VERSION || input.operation !== "create" || !["CREATED", "EXISTING", "UNKNOWN"].includes(input.state as string)) throw new Error("Session broker create response is invalid");
  const state = input.state as SessionRuntimeCreateWireResponse["state"];
  const hasIdentity = input.sessionId !== undefined || input.externalId !== undefined || input.stateHash !== undefined;
  if (state === "UNKNOWN") {
    if (hasIdentity) throw new Error("Session broker create UNKNOWN response must not expose identity");
  } else if (!isSafeText(input.sessionId) || !isSafeText(input.externalId) || !isHash(input.stateHash)) {
    throw new Error("Session broker create response identity is invalid");
  }
  if (input.summary !== undefined && !isSafeText(input.summary)) throw new Error("Session broker create response summary is invalid");
  return {
    schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION,
    operation: "create",
    state,
    ...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
    ...(typeof input.externalId === "string" ? { externalId: input.externalId } : {}),
    ...(typeof input.stateHash === "string" ? { stateHash: input.stateHash } : {}),
    ...(typeof input.summary === "string" ? { summary: boundedSummary(input.summary) } : {}),
  };
}

function validateHealthWireResponse(value: unknown): SessionRuntimeHealthWireResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Session broker health response is invalid");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== SESSION_RUNTIME_WIRE_SCHEMA_VERSION || input.operation !== "health" || !["READY", "DEGRADED", "UNAVAILABLE"].includes(input.status as string)) throw new Error("Session broker health response is invalid");
  if (!input.capabilities || typeof input.capabilities !== "object" || Array.isArray(input.capabilities)) throw new Error("Session broker health capabilities are invalid");
  const capabilities = input.capabilities as Record<string, unknown>;
  if (!Array.isArray(capabilities.kinds) || capabilities.kinds.length > 2 || capabilities.kinds.some((kind) => kind !== "pwn-session" && kind !== "http-session") || new Set(capabilities.kinds).size !== capabilities.kinds.length || !Number.isSafeInteger(capabilities.maxRequestBytes) || (capabilities.maxRequestBytes as number) < 1 || (capabilities.maxRequestBytes as number) > 4 * MAX_WIRE_BODY_BYTES || !Number.isSafeInteger(capabilities.maxResponseBytes) || (capabilities.maxResponseBytes as number) < 1 || (capabilities.maxResponseBytes as number) > 8 * MAX_RESPONSE_BYTES || typeof capabilities.stableAcrossRestart !== "boolean") throw new Error("Session broker health capability limits are invalid");
  if (input.summary !== undefined && !isSafeText(input.summary)) throw new Error("Session broker health summary is invalid");
  return {
    schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION,
    operation: "health",
    status: input.status as SessionRuntimeHealthStatus,
    capabilities: {
      kinds: [...capabilities.kinds] as SessionRuntimeHealthCapabilities["kinds"],
      maxRequestBytes: capabilities.maxRequestBytes as number,
      maxResponseBytes: capabilities.maxResponseBytes as number,
      stableAcrossRestart: capabilities.stableAcrossRestart as boolean,
    },
    ...(typeof input.summary === "string" ? { summary: boundedSummary(input.summary) } : {}),
  };
}

function validateHeartbeatWireResponse(value: unknown): SessionRuntimeHeartbeatWireResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Session broker heartbeat response is invalid");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== SESSION_RUNTIME_WIRE_SCHEMA_VERSION || input.operation !== "heartbeat" || (input.state !== "CONFIRMED" && input.state !== "UNKNOWN")) throw new Error("Session broker heartbeat response is invalid");
  if (input.externalId !== undefined && !isSafeText(input.externalId)) throw new Error("Session broker heartbeat returned an invalid opaque handle");
  if (input.expiresAt !== undefined && !isSafeText(input.expiresAt, 64)) throw new Error("Session broker heartbeat returned an invalid expiry");
  if (input.state === "CONFIRMED" && (!input.externalId || !input.expiresAt)) throw new Error("Session broker confirmed heartbeat is missing identity or expiry");
  if (input.state === "UNKNOWN" && (input.externalId !== undefined || input.expiresAt !== undefined)) throw new Error("Session broker unknown heartbeat must not expose lease identity");
  if (input.summary !== undefined && !isSafeText(input.summary)) throw new Error("Session broker heartbeat summary is invalid");
  return {
    schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION,
    operation: "heartbeat",
    state: input.state as SessionRuntimeHeartbeatWireResponse["state"],
    ...(typeof input.externalId === "string" ? { externalId: input.externalId } : {}),
    ...(typeof input.expiresAt === "string" ? { expiresAt: input.expiresAt } : {}),
    ...(typeof input.summary === "string" ? { summary: boundedSummary(input.summary) } : {}),
  };
}

function safeRequestHeaders(value: HeadersInit | Record<string, string> | undefined): Record<string, string> {
  const entries = value instanceof Headers ? [...value.entries()] : Array.isArray(value) ? value : Object.entries(value ?? {});
  return Object.fromEntries(entries.slice(0, 64).map(([name, content]) => [name.toLowerCase(), SECRET_HEADERS.test(name) ? "[REDACTED]" : SAFE_HEADERS.test(name) ? String(content).slice(0, 8_192) : "[REDACTED]"]));
}

function safeResponseHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Session broker HTTP response headers are invalid");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) throw new Error("Session broker HTTP response has too many headers");
  return Object.fromEntries(entries.map(([name, content]) => {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof content !== "string" || content.length > 8_192 || /[\u0000-\u001f\u007f]/.test(content)) throw new Error("Session broker HTTP response header is invalid");
    return [name.toLowerCase(), SECRET_HEADERS.test(name) ? "[REDACTED]" : SAFE_HEADERS.test(name) ? content : "[REDACTED]"];
  }));
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Session runtime broker baseUrl must be an http(s) origin without credentials");
  return url.toString().replace(/\/$/, "");
}

function normalizeTimeout(value: number | undefined): number {
  const timeout = value ?? 15_000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120_000) throw new Error("Session runtime broker timeoutMs must be between 100 and 120000");
  return timeout;
}

function normalizeHeaders(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(value ?? {}).slice(0, 32).map(([name, content]) => [name, content.slice(0, 8_192)]));
}

function isOperation(value: string): value is SessionRuntimeOperation { return ["inspect", "adopt", "release", "heartbeat", "pwn_write", "pwn_read", "pwn_signal", "pwn_close", "http_request"].includes(value); }
function isHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }
function isOwnerLane(value: unknown): value is ExternalResourceRecord["ownerLane"] { return value === "main" || value === "planner" || value === "executor" || value === "verifier" || value === "system"; }
function isSignal(value: unknown): value is NodeJS.Signals { return typeof value === "string" && ["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP", "SIGUSR1", "SIGUSR2"].includes(value); }
function isSafeHttpUrl(value: string): boolean { try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password && value.length <= 2_048; } catch { return false; } }
function integerOption(value: unknown): value is number { return value === undefined || (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 600_000); }
function isSafeText(value: unknown, maxLength = 512): value is string { return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value); }
function assertKeys(input: Record<string, unknown>, allowed: readonly string[], label: string): void { const allowedKeys = new Set(allowed); const unexpected = Object.keys(input).find((key) => !allowedKeys.has(key)); if (unexpected) throw new SessionRuntimeWireRequestError(`session runtime ${label} contains an unsupported field: ${unexpected}`); }
function optionalString(input: Record<string, unknown>, key: string): Record<string, string> { return typeof input[key] === "string" ? { [key]: (input[key] as string).slice(0, 512) } : {}; }
function boundedSummary(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 512); }
function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void { if (response.destroyed || response.writableEnded) return; const body = JSON.stringify(value); response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), ...headers }); response.end(body); }

export class SessionRuntimeWireRequestError extends Error {
  public constructor(message: string) { super(message); this.name = "SessionRuntimeWireRequestError"; }
}
