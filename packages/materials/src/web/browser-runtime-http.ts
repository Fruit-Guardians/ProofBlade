import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import {
  BrowserRuntimeWireRequestError,
  dispatchBrowserRuntimeCreateWire,
  dispatchBrowserRuntimeHealthWire,
  dispatchBrowserRuntimeHeartbeatWire,
  dispatchBrowserRuntimeWire,
  type BrowserRuntimeCreateService,
  type BrowserRuntimeBrokerService,
  type BrowserRuntimeHealthService,
  type BrowserRuntimeHeartbeatService,
  type BrowserRuntimeWireRequest,
} from "./browser-runtime-broker.js";
import {
  BrowserRuntimeActionRequestError,
  dispatchBrowserRuntimeActionWire,
  type BrowserRuntimeActionService,
} from "./browser-runtime-actions.js";

const DEFAULT_MAX_WIRE_REQUEST_BYTES = 64 * 1024;

export interface BrowserRuntimeHttpHandlerOptions {
  /** Maximum encoded JSON request size accepted by the broker endpoint. */
  readonly maxRequestBytes?: number;
  /** Optional service for the action wire; absent means action is disabled. */
  readonly actionService?: BrowserRuntimeActionService;
  /** Optional service for idempotent browser create/open; absent means disabled. */
  readonly createService?: BrowserRuntimeCreateService;
  /** Optional service for runtime health/capability probing; absent means disabled. */
  readonly healthService?: BrowserRuntimeHealthService;
  /** Optional service for durable lease heartbeats; absent means disabled. */
  readonly heartbeatService?: BrowserRuntimeHeartbeatService;
  /** Optional request authorizer used by a deployed runtime service. */
  readonly authorize?: (request: IncomingMessage) => boolean | Promise<boolean>;
}

/**
 * Create a Node HTTP listener for the versioned browser broker lifecycle wire.
 *
 * The listener is deliberately transport-only: it does not own a browser or
 * interpret opaque handles. A service implementation is injected for those
 * operations, while request size, routing, content type, abort propagation,
 * status mapping, and error redaction stay identical across deployments.
 */
export function createBrowserRuntimeHttpHandler(
  service: BrowserRuntimeBrokerService,
  options: BrowserRuntimeHttpHandlerOptions = {},
): RequestListener {
  if (!service || typeof service.inspect !== "function" || typeof service.adopt !== "function" || typeof service.release !== "function") {
    throw new Error("Browser runtime HTTP handler requires a complete broker service");
  }
  const maxRequestBytes = normalizeRequestLimit(options.maxRequestBytes);
  return (request, response) => {
    void handleBrowserRuntimeHttpRequest(request, response, service, options.actionService, options.createService, options.healthService, options.heartbeatService, options.authorize, maxRequestBytes);
  };
}

async function handleBrowserRuntimeHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: BrowserRuntimeBrokerService,
  actionService: BrowserRuntimeActionService | undefined,
  createService: BrowserRuntimeCreateService | undefined,
  healthService: BrowserRuntimeHealthService | undefined,
  heartbeatService: BrowserRuntimeHeartbeatService | undefined,
  authorize: BrowserRuntimeHttpHandlerOptions["authorize"],
  maxRequestBytes: number,
): Promise<void> {
  const controller = new AbortController();
  const onAborted = (): void => controller.abort(new Error("Browser broker request aborted"));
  request.once("aborted", onAborted);
  try {
    if (authorize && !(await authorize(request))) {
      sendJson(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }
    const route = parseBrowserRuntimeRoute(request);
    if (route === "health") {
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "method_not_allowed" }, { allow: "GET" });
        return;
      }
      if (!healthService) {
        sendJson(response, 404, { error: "health_not_available" });
        return;
      }
      try {
        sendJson(response, 200, await dispatchBrowserRuntimeHealthWire(healthService, controller.signal));
      } catch (error) {
        if (controller.signal.aborted || response.destroyed) return;
        sendJson(response, 503, { error: "browser_runtime_unavailable" });
      }
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method_not_allowed" }, { allow: "POST" });
      return;
    }
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
      sendJson(response, 415, { error: "unsupported_media_type" });
      return;
    }
    let body: string;
    try {
      body = await readBoundedRequestBody(request, maxRequestBytes, controller.signal);
    } catch (error) {
      if (error instanceof BrowserRuntimeRequestTooLargeError) {
        sendJson(response, 413, { error: "request_too_large" });
        return;
      }
      if (controller.signal.aborted) return;
      sendJson(response, 400, { error: "request_body_unreadable" });
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      sendJson(response, 400, { error: "invalid_json" });
      return;
    }
    if (!isObject(value) || value.operation !== route) {
      sendJson(response, 400, { error: "route_operation_mismatch" });
      return;
    }
    if (route === "create") {
      if (!createService) {
        sendJson(response, 404, { error: "create_not_available" });
        return;
      }
      try {
        const result = await dispatchBrowserRuntimeCreateWire(value, createService, controller.signal);
        sendJson(response, 200, result);
      } catch (error) {
        if (controller.signal.aborted || response.destroyed) return;
        if (error instanceof BrowserRuntimeWireRequestError) {
          sendJson(response, 400, { error: "invalid_browser_create_request" });
          return;
        }
        sendJson(response, 503, { error: "browser_runtime_unavailable" });
      }
      return;
    }
    if (route === "action") {
      if (!actionService) {
        sendJson(response, 404, { error: "action_not_available" });
        return;
      }
      try {
        const result = await dispatchBrowserRuntimeActionWire(value, actionService, controller.signal);
        sendJson(response, 200, result);
      } catch (error) {
        if (controller.signal.aborted || response.destroyed) return;
        if (error instanceof BrowserRuntimeActionRequestError) {
          sendJson(response, 400, { error: "invalid_browser_action_request" });
          return;
        }
        sendJson(response, 503, { error: "browser_runtime_unavailable" });
      }
      return;
    }
    if (route === "heartbeat") {
      if (!heartbeatService) {
        sendJson(response, 404, { error: "heartbeat_not_available" });
        return;
      }
      try {
        sendJson(response, 200, await dispatchBrowserRuntimeHeartbeatWire(value, heartbeatService, controller.signal));
      } catch (error) {
        if (controller.signal.aborted || response.destroyed) return;
        if (error instanceof BrowserRuntimeWireRequestError) {
          sendJson(response, 400, { error: "invalid_browser_heartbeat_request" });
          return;
        }
        sendJson(response, 503, { error: "browser_runtime_unavailable" });
      }
      return;
    }
    if (route === "bind" && !service.bind) {
      sendJson(response, 404, { error: "bind_not_available" });
      return;
    }
    try {
      const result = await dispatchBrowserRuntimeWire(value, service, controller.signal);
      sendJson(response, 200, result);
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return;
      if (error instanceof BrowserRuntimeWireRequestError) {
        sendJson(response, 400, { error: "invalid_browser_broker_request" });
        return;
      }
      sendJson(response, 503, { error: "browser_runtime_unavailable" });
    }
  } catch (error) {
    if (controller.signal.aborted || response.destroyed) return;
    if (error instanceof BrowserRuntimeRouteError) {
      sendJson(response, error.statusCode, { error: error.code });
      return;
    }
    sendJson(response, 400, { error: "invalid_browser_broker_route" });
  } finally {
    request.removeListener("aborted", onAborted);
  }
}

type BrowserRuntimeHttpRoute = BrowserRuntimeWireRequest["operation"] | "action" | "create" | "health" | "heartbeat";

function parseBrowserRuntimeRoute(request: IncomingMessage): BrowserRuntimeHttpRoute {
  let url: URL;
  try {
    url = new URL(request.url ?? "/", "http://browser-runtime.invalid");
  } catch {
    throw new BrowserRuntimeRouteError(400, "invalid_route", "Browser broker request URL is invalid");
  }
  if (url.search || url.hash) throw new BrowserRuntimeRouteError(404, "not_found", "Browser broker routes do not accept query or hash components");
  const match = /^\/v1\/browser\/(inspect|adopt|release|bind|action|create|health|heartbeat)$/.exec(url.pathname);
  if (!match) throw new BrowserRuntimeRouteError(404, "not_found", "Browser broker route is not available");
  return match[1] as BrowserRuntimeHttpRoute;
}

async function readBoundedRequestBody(request: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  for await (const chunk of request) {
    if (signal.aborted) throw abortReason(signal);
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytesRead += buffer.byteLength;
    if (bytesRead > maxBytes) throw new BrowserRuntimeRequestTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytesRead).toString("utf8");
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function normalizeRequestLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_WIRE_REQUEST_BYTES;
  if (!Number.isInteger(value) || value < 1_024 || value > 1_024 * 1_024) throw new Error("Browser runtime HTTP maxRequestBytes must be an integer between 1024 and 1048576");
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

class BrowserRuntimeRequestTooLargeError extends Error {
  public constructor() {
    super("Browser broker request exceeds its byte limit");
    this.name = "BrowserRuntimeRequestTooLargeError";
  }
}

class BrowserRuntimeRouteError extends Error {
  public constructor(public readonly statusCode: 400 | 404, public readonly code: string, message: string) {
    super(message);
    this.name = "BrowserRuntimeRouteError";
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Browser broker request aborted");
}
