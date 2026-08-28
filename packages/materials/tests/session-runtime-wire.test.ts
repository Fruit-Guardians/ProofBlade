import assert from "node:assert/strict";
import { createServer, request as createHttpRequest, type Server } from "node:http";
import test from "node:test";
import {
  HttpSessionRuntimeBroker,
  SESSION_RUNTIME_WIRE_SCHEMA_VERSION,
  createSessionRuntimeHttpHandler,
  sessionRuntimeWireResource,
  type SessionRuntimeActionService,
  type SessionRuntimeBrokerService,
  type SessionRuntimeCreateRequest,
} from "../src/recovery/session-runtime-wire.js";
import type { ContainerRef, ContainerSessionHandle } from "../src/container/contracts.js";
import type { ExternalResourceRecord } from "../src/recovery/external-resource-registry.js";

test("session runtime wire carries exact lifecycle identity and bounded Pwn actions", async () => {
  const externalId = "pwn-opaque-1";
  const record = sessionRecord(externalId, "pwn-session");
  let seenResource: unknown;
  let released = 0;
  let heartbeats = 0;
  const lifecycle: SessionRuntimeBrokerService = {
    async inspect(resource) {
      seenResource = resource;
      return { status: "PRESENT", binding: "MATCH", externalId: resource.externalId, summary: "exact" };
    },
    async adopt(resource) { return { state: "CONFIRMED", externalId: resource.externalId }; },
    async release(resource) { released += 1; return { released: true, summary: `released ${resource.externalId}` }; },
  };
  const actions: SessionRuntimeActionService = {
    async pwnWrite() { return { delta: "ready\n", waitReason: "idle", exited: false, truncated: false }; },
    async pwnRead() { return { delta: "flag?", waitReason: "idle", exited: false, truncated: false }; },
    async pwnSignal() { return true; },
    async pwnClose() { return { exitCode: 0 }; },
    async httpRequest(_resource, request) {
      assert.equal(request.headers.authorization, "[REDACTED]");
      return { status: 200, headers: { "content-type": "text/plain" }, body: "ok", stateHash: "a".repeat(64) };
    },
  };
  const server = createServer(createSessionRuntimeHttpHandler(lifecycle, actions, {
    heartbeatService: { async heartbeat(resource) { heartbeats += 1; return { state: "CONFIRMED" as const, externalId: resource.externalId, expiresAt: "2026-01-01T00:10:00.000Z" }; } },
  }));
  const baseUrl = await listen(server);
  try {
    const broker = new HttpSessionRuntimeBroker({
      baseUrl,
      kind: "pwn-session",
      connectBinding: async (input) => ({ kind: "pwn-session", externalId: input.externalId!, handle: pwnHandle(input.externalId!), runtime: pwnRuntime() }),
    });
    const inspected = await broker.inspect(record);
    assert.deepEqual(inspected, { status: "PRESENT", binding: "MATCH", externalId, summary: "exact" });
    assert.deepEqual(seenResource, sessionRuntimeWireResource(record));
    const adopted = await broker.adopt(record, inspected);
    assert.equal(adopted.state, "CONFIRMED");
    assert.equal(adopted.binding?.kind, "pwn-session");
    const write = await broker.action({ operation: "pwn_write", resource: sessionRuntimeWireResource(record), data: "echo", encoding: "utf8" });
    assert.deepEqual(write, { schemaVersion: SESSION_RUNTIME_WIRE_SCHEMA_VERSION, operation: "pwn_write", delta: "ready\n", waitReason: "idle", exited: false, truncated: false });
    const runtime = broker.createPwnRuntime(pwnHandle(externalId), record);
    assert.deepEqual(await runtime.closeSession(pwnHandle(externalId)), { exitCode: 0 });
    assert.equal(heartbeats, 1);
    assert.equal(released, 1, "closing a broker Pwn runtime must release its durable lease");
    assert.deepEqual(await broker.release(record, "test"), { released: true, summary: "released pwn-opaque-1" });
  } finally {
    await close(server);
  }
});

test("session runtime wire exposes idempotent create and health routes", async () => {
  const lifecycle: SessionRuntimeBrokerService = {
    async inspect() { return { status: "ABSENT", binding: "UNKNOWN" }; },
    async adopt() { return { state: "UNKNOWN" }; },
    async release() { return { released: false }; },
  };
  const key = "d".repeat(64);
  const createService = {
    async create(request: SessionRuntimeCreateRequest, idempotencyKey: string) {
      assert.equal(request.kind, "pwn-session");
      assert.deepEqual(request.pwn, { mode: "remote", command: ["tube"], endpoint: "target.test:31337" });
      assert.equal(idempotencyKey, key);
      return { state: "CREATED" as const, sessionId: "session-created", externalId: "opaque-created", stateHash: "e".repeat(64) };
    },
  };
  const server = createServer(createSessionRuntimeHttpHandler(lifecycle, undefined, {
    createService,
    healthService: { async health() { return { status: "READY" as const, capabilities: { kinds: ["pwn-session", "http-session"] as const, maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576, stableAcrossRestart: true } }; } },
  }));
  const baseUrl = await listen(server);
  try {
    const createResponse = await fetch(`${baseUrl}/v1/session/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, operation: "create", idempotencyKey: key, request: { kind: "pwn-session", runId: "RUN-CREATE", generation: 1, ownerLane: "executor", requestKey: "request-key", policyHash: "a".repeat(64), pwn: { mode: "remote", command: ["tube"], endpoint: "target.test:31337" } } }) });
    assert.equal(createResponse.status, 200);
    assert.deepEqual(await createResponse.json(), { schemaVersion: 1, operation: "create", state: "CREATED", sessionId: "session-created", externalId: "opaque-created", stateHash: "e".repeat(64) });
    const healthResponse = await fetch(`${baseUrl}/v1/session/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { schemaVersion: 1, operation: "health", status: "READY", capabilities: { kinds: ["pwn-session", "http-session"], maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576, stableAcrossRestart: true } });
  } finally {
    await close(server);
  }
});

test("session runtime HTTP fetch translates safe requests and redacts secret headers", async () => {
  const record = sessionRecord("http-opaque-1", "http-session");
  const actions: SessionRuntimeActionService = {
    async pwnWrite() { return { delta: "", waitReason: "idle", exited: false, truncated: false }; },
    async pwnRead() { return { delta: "", waitReason: "idle", exited: false, truncated: false }; },
    async pwnSignal() { return true; },
    async pwnClose() { return { exitCode: null }; },
    async httpRequest(_resource, request) {
      assert.equal(request.url, "https://target.test/api");
      assert.equal(request.headers.authorization, "[REDACTED]");
      assert.equal(request.headers["content-type"], "application/json");
      return { status: 201, headers: { "x-state": "ok", "set-cookie": "session-secret" }, body: "created", stateHash: "b".repeat(64) };
    },
  };
  const lifecycle: SessionRuntimeBrokerService = {
    async inspect(resource) { return { status: "PRESENT", binding: "MATCH", externalId: resource.externalId }; },
    async adopt(resource) { return { state: "CONFIRMED", externalId: resource.externalId }; },
    async release() { return { released: true }; },
  };
  const server = createServer(createSessionRuntimeHttpHandler(lifecycle, actions, {
    heartbeatService: { async heartbeat(resource) { return { state: "CONFIRMED" as const, externalId: resource.externalId, expiresAt: "2026-01-01T00:10:00.000Z" }; } },
  }));
  const baseUrl = await listen(server);
  try {
    const broker = new HttpSessionRuntimeBroker({ baseUrl, kind: "http-session", connectBinding: async () => { throw new Error("not needed"); } });
    const fetchImpl = broker.createHttpFetch(record);
    const response = await fetchImpl("https://target.test/api", { method: "POST", headers: { Authorization: "secret", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 201);
    assert.equal(await response.text(), "created");
    assert.equal(response.headers.get("set-cookie"), "[REDACTED]");
  } finally {
    await close(server);
  }
});

test("session runtime HTTP fetch refuses an action when the lease heartbeat is unknown", async () => {
  const record = sessionRecord("http-unknown", "http-session");
  let actionsCalled = 0;
  const actions: SessionRuntimeActionService = {
    async pwnWrite() { return { delta: "", waitReason: "idle", exited: false, truncated: false }; },
    async pwnRead() { return { delta: "", waitReason: "idle", exited: false, truncated: false }; },
    async pwnSignal() { return true; },
    async pwnClose() { return { exitCode: null }; },
    async httpRequest() { actionsCalled += 1; return { status: 200, headers: {}, body: "should-not-run", stateHash: "b".repeat(64) }; },
  };
  const lifecycle: SessionRuntimeBrokerService = {
    async inspect(resource) { return { status: "PRESENT", binding: "MATCH", externalId: resource.externalId }; },
    async adopt(resource) { return { state: "CONFIRMED", externalId: resource.externalId }; },
    async release() { return { released: true }; },
  };
  const server = createServer(createSessionRuntimeHttpHandler(lifecycle, actions, {
    heartbeatService: { async heartbeat() { return { state: "UNKNOWN" as const, summary: "lease expired" }; } },
  }));
  const baseUrl = await listen(server);
  try {
    const broker = new HttpSessionRuntimeBroker({ baseUrl, kind: "http-session", connectBinding: async () => { throw new Error("not needed"); } });
    await assert.rejects(broker.createHttpFetch(record)("https://target.test/api"), /lease expired/);
    assert.equal(actionsCalled, 0);
  } finally {
    await close(server);
  }
});

test("session runtime wire rejects route/operation mismatch", async () => {
  const lifecycle: SessionRuntimeBrokerService = {
    async inspect() { return { status: "ABSENT", binding: "UNKNOWN" }; },
    async adopt() { return { state: "UNKNOWN" }; },
    async release() { return { released: false }; },
  };
  const server = createServer(createSessionRuntimeHttpHandler(lifecycle));
  const baseUrl = await listen(server);
  try {
    const response = await fetch(`${baseUrl}/v1/session/inspect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, operation: "release", resource: sessionRuntimeWireResource(sessionRecord("opaque", "pwn-session")) }) });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_session_runtime_request" });
  } finally {
    await close(server);
  }
});

test("session runtime broker cancels an oversized streaming response before buffering it", async () => {
  let cancelled = false;
  const chunk = new TextEncoder().encode("x".repeat(256 * 1024));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  const broker = new HttpSessionRuntimeBroker({
    baseUrl: "http://session-runtime.test",
    kind: "pwn-session",
    fetchImpl: async () => new Response(stream, { status: 200 }),
    connectBinding: async () => { throw new Error("not needed"); },
  });
  await assert.rejects(
    broker.action({ operation: "pwn_read", resource: sessionRuntimeWireResource(sessionRecord("stream", "pwn-session")) }),
    /response exceeds its byte limit/,
  );
  assert.equal(cancelled, true);
});

test("session runtime HTTP handler aborts a long-running action when the client disconnects", async () => {
  let actionStartedResolve!: () => void;
  const actionStarted = new Promise<void>((resolve) => { actionStartedResolve = resolve; });
  let aborted = false;
  const actions: SessionRuntimeActionService = {
    async pwnWrite() { return { delta: "", waitReason: "idle", exited: false, truncated: false }; },
    async pwnRead(_resource, _options, signal) {
      actionStartedResolve();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          aborted = true;
          resolve();
          return;
        }
        signal?.addEventListener("abort", () => {
          aborted = true;
          resolve();
        }, { once: true });
      });
      throw new Error("client disconnected");
    },
    async pwnSignal() { return true; },
    async pwnClose() { return { exitCode: null }; },
    async httpRequest() { return { status: 200, headers: {}, body: "", stateHash: "c".repeat(64) }; },
  };
  const lifecycle: SessionRuntimeBrokerService = {
    async inspect() { return { status: "ABSENT", binding: "UNKNOWN" }; },
    async adopt() { return { state: "UNKNOWN" }; },
    async release() { return { released: false }; },
  };
  const server = createServer(createSessionRuntimeHttpHandler(lifecycle, actions));
  const baseUrl = await listen(server);
  const request = createHttpRequest(`${baseUrl}/v1/session/action`, { method: "POST", headers: { "content-type": "application/json" } });
  request.on("error", () => undefined);
  request.end(JSON.stringify({ schemaVersion: 1, operation: "pwn_read", resource: sessionRuntimeWireResource(sessionRecord("abort", "pwn-session")) }));
  try {
    await actionStarted;
    request.destroy();
    await waitFor(() => aborted, 2_000);
    assert.equal(aborted, true);
  } finally {
    await close(server);
  }
});

function sessionRecord(externalId: string, kind: "pwn-session" | "http-session"): ExternalResourceRecord {
  return { schemaVersion: 1, id: `session:${externalId}`, kind, runId: "RUN-WIRE", generation: 2, ownerLane: "executor", state: "CONFIRMED", externalId, requestKey: "request-key", policyHash: "a".repeat(64), recipeHash: "b".repeat(64), scopeHash: "c".repeat(64), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", inspectCount: 0 };
}

function pwnHandle(externalId: string): ContainerSessionHandle {
  const ref: ContainerRef = { runId: "RUN-WIRE", generation: 2, containerId: "container", name: "wire", profile: "pwn", image: "image", imageDigest: "d".repeat(64), workspaceHostPath: "D:/wire", workspaceContainerPath: "/workspace", networkPolicy: "none" };
  return { sessionId: "session", externalId, ref };
}

function pwnRuntime() {
  return { async sessionWrite() { return { delta: "", waitReason: "idle" as const, exited: false, truncated: false }; }, async sessionRead() { return { delta: "", waitReason: "idle" as const, exited: false, truncated: false }; }, async sessionSignal() { return true; }, async closeSession() { return { exitCode: 0 }; } };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> { await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())); }

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true before timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
