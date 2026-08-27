import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import {
  BrowserContextResourceAdapter,
} from "../src/web/browser-resource-adapter.js";
import {
  BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
  dispatchBrowserRuntimeCreateWire,
  dispatchBrowserRuntimeWire,
  HttpBrowserRuntimeBroker,
  type BrowserRuntimeCreateRequest,
  type BrowserRuntimeCreateService,
  type BrowserRuntimeBrokerService,
} from "../src/web/browser-runtime-broker.js";
import { createBrowserRuntimeHttpHandler } from "../src/web/browser-runtime-http.js";
import {
  BrowserRuntimeContextActionService,
  dispatchBrowserRuntimeActionWire,
  HttpBrowserRuntimeContextPort,
  type BrowserRuntimeActionService,
} from "../src/web/browser-runtime-actions.js";
import { HttpBrowserVerifierFactory } from "../src/web/browser-runtime-factory.js";
import { tryCreateConfiguredBrowserVerifierFactory } from "../src/web/browser-verifier-composition.js";
import { DurableBrowserRuntimeService, type BrowserRuntimeCreatedContext, type BrowserRuntimeHost } from "../src/web/browser-runtime-service.js";
import { probeBrowserVerifierFactory, type BrowserContextPort, type BrowserVerifierFactory } from "../src/web/browser-session.js";
import {
  ExternalResourceRegistry,
  externalResourceBindingTransactionId,
  type ExternalResourceRecord,
} from "../src/recovery/external-resource-registry.js";
import { canonicalJson, sha256 } from "../src/domain/utils.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("configured browser composition does not fall back to local Playwright", () => {
  const config = {
    runtime: {
      piVersion: "0.83.0",
      browserBroker: { baseUrl: "http://127.0.0.1:43121", tokenEnv: "PROOFBLADE_TEST_BROWSER_TOKEN" },
    },
  } as const;
  assert.equal(tryCreateConfiguredBrowserVerifierFactory(config, {}), undefined);
  const factory = tryCreateConfiguredBrowserVerifierFactory(config, { PROOFBLADE_TEST_BROWSER_TOKEN: "secret" });
  assert.ok(factory);
  assert.equal(factory?.runtimeBroker?.name, "http-browser-broker");
  const defaultTokenFactory = tryCreateConfiguredBrowserVerifierFactory({ runtime: { piVersion: "0.83.0", browserBroker: { baseUrl: "http://127.0.0.1:43121" } } }, { PROOFBLADE_BROWSER_RUNTIME_TOKEN: "secret" });
  assert.ok(defaultTokenFactory, "configured broker uses the service's default token environment");
});

test("browser runtime downgrades a host that claims stability without idempotency reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-runtime-unstable-"));
  const host: BrowserRuntimeHost = {
    async create(request) { return { sessionId: "session-unstable", externalId: "browser-unstable", initialUrl: request.target, stateHash: sha256("empty") }; },
    async inspect() { return "PRESENT"; },
    async adopt() { return true; },
    async resolve() { return undefined; },
    async release() { return true; },
    async health() { return { status: "READY", capabilities: { actions: ["navigate", "click", "fill", "submit", "wait"] as const, maxResponseBytes: 1_024, stableAcrossRestart: true } }; },
  };
  try {
    const health = await new DurableBrowserRuntimeService(join(root, "runtime.json"), host).health();
    assert.deepEqual(health, {
      status: "DEGRADED",
      capabilities: { actions: ["navigate", "click", "fill", "submit", "wait"], maxResponseBytes: 1_024, stableAcrossRestart: false },
      summary: "Browser runtime host cannot reconcile an interrupted create by idempotency key",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser create/open wire requires a verifier binding and preserves idempotent retries", async () => {
  const calls: Array<{ key: string; request: BrowserRuntimeCreateRequest }> = [];
  const service: BrowserRuntimeCreateService = {
    async create(request, idempotencyKey) {
      calls.push({ key: idempotencyKey, request });
      return calls.length === 1
        ? { state: "CREATED", sessionId: "session-1", externalId: "browser-1", initialUrl: request.target, stateHash: sha256("empty") }
        : { state: "EXISTING", sessionId: "session-1", externalId: "browser-1", initialUrl: request.target, stateHash: sha256("empty") };
    },
  };
  const request = createRequest();
  const wire = { schemaVersion: 1, operation: "create", idempotencyKey: sha256("create-key"), request } as const;
  assert.deepEqual(await dispatchBrowserRuntimeCreateWire(wire, service), {
    schemaVersion: 1,
    operation: "create",
    state: "CREATED",
    sessionId: "session-1",
    externalId: "browser-1",
    initialUrl: request.target,
    stateHash: sha256("empty"),
  });
  assert.deepEqual(await dispatchBrowserRuntimeCreateWire(wire, service), {
    schemaVersion: 1,
    operation: "create",
    state: "EXISTING",
    sessionId: "session-1",
    externalId: "browser-1",
    initialUrl: request.target,
    stateHash: sha256("empty"),
  });
  assert.deepEqual(calls, [
    { key: sha256("create-key"), request },
    { key: sha256("create-key"), request },
  ]);
  await assert.rejects(() => dispatchBrowserRuntimeCreateWire({ ...wire, idempotencyKey: "not-a-hash" }, service), /idempotency key is invalid/);
  await assert.rejects(() => dispatchBrowserRuntimeCreateWire({ ...wire, request: { ...request, ownerLane: "executor" } }, service), /invalid run, owner, or target/);
  await assert.rejects(() => dispatchBrowserRuntimeCreateWire({ ...wire, request: { ...request, extra: true } }, service), /unsupported field: extra/);
  await assert.rejects(() => dispatchBrowserRuntimeCreateWire({ ...wire, request: { ...request, target: "file:///secret" } }, service), /invalid run, owner, or target/);
});

test("browser create/open HTTP route is optional and bounded", async () => {
  const service: BrowserRuntimeBrokerService = {
    async inspect() { return { status: "ABSENT", binding: "UNKNOWN" }; },
    async adopt() { return { state: "UNKNOWN" }; },
    async release() { return { released: true }; },
  };
  const createService: BrowserRuntimeCreateService = {
    async create(request) {
      return { state: "CREATED", sessionId: "session-http", externalId: "browser-http", initialUrl: request.target, stateHash: sha256("empty") };
    },
  };
  const server = createServer(createBrowserRuntimeHttpHandler(service, { createService }));
  const port = await listen(server);
  try {
    const request = createRequest();
    const response = await fetch(`http://127.0.0.1:${port}/v1/browser/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, operation: "create", idempotencyKey: sha256("http-create"), request }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      schemaVersion: 1,
      operation: "create",
      state: "CREATED",
      sessionId: "session-http",
      externalId: "browser-http",
      initialUrl: request.target,
      stateHash: sha256("empty"),
    });
  } finally {
    await close(server);
  }

  const unavailableServer = createServer(createBrowserRuntimeHttpHandler(service));
  const unavailablePort = await listen(unavailableServer);
  try {
    const request = createRequest();
    const response = await fetch(`http://127.0.0.1:${unavailablePort}/v1/browser/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, operation: "create", idempotencyKey: sha256("unavailable-create"), request }),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "create_not_available" });
  } finally {
    await close(unavailableServer);
  }
});

test("HTTP browser verifier factory binds create identity to action and release wires", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    requests.push({ path: request.url ?? "", body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/browser/create") {
      response.end(JSON.stringify({ schemaVersion: 1, operation: "create", state: "CREATED", sessionId: "session-created", externalId: "browser-created", initialUrl: "https://target.test/start", stateHash: sha256("empty") }));
      return;
    }
    if (request.url === "/v1/browser/action") {
      response.end(JSON.stringify({ schemaVersion: 1, operation: "action", action: (body.action as { kind: string }).kind, status: 200, content: "ok", currentUrl: "https://target.test/next", stateHash: sha256("next") }));
      return;
    }
    if (request.url === "/v1/browser/heartbeat") {
      response.end(JSON.stringify({ schemaVersion: 1, operation: "heartbeat", state: "CONFIRMED", externalId: "browser-created", expiresAt: new Date(Date.now() + 60_000).toISOString() }));
      return;
    }
    if (request.url === "/v1/browser/bind") {
      response.end(JSON.stringify({ schemaVersion: 1, operation: "bind", state: "BOUND", externalId: "browser-created" }));
      return;
    }
    response.end(JSON.stringify({ schemaVersion: 1, operation: "release", released: true }));
  });
  const port = await listen(server);
  try {
    const broker = new HttpBrowserRuntimeBroker({ baseUrl: `http://127.0.0.1:${port}`, connectContext: async () => browserContext() });
    const factory = new HttpBrowserVerifierFactory({ broker });
    const request = {
      runId: "RUN-BROWSER-FACTORY",
      generation: 4,
      target: "https://target.test/start",
      policyHash: sha256("policy"),
      recipeHash: sha256("recipe"),
      verificationKey: "VR-browser-factory",
      allowedHosts: ["target.test"],
      allowedPorts: [],
      maxResponseBytes: 1_024,
    };
    const first = await factory.createContext(request);
    const second = await factory.createContext(request);
    assert.equal(first.externalId, "browser-created");
    assert.equal(first.sessionId, "session-created");
    assert.equal(await first.context.currentUrl(), "https://target.test/start");
    assert.equal(await first.context.storageStateHash(), sha256("empty"));
    const createBody = requests.find((entry) => entry.path === "/v1/browser/create")?.body.request as BrowserRuntimeCreateRequest;
    const bindingTxnId = externalResourceBindingTransactionId({
      id: "session:session-created",
      kind: "browser-context",
      runId: createBody.runId,
      generation: createBody.generation,
      ownerLane: "verifier",
      requestKey: createBody.verificationKey,
      policyHash: createBody.policyHash,
      recipeHash: createBody.recipeHash,
      scopeHash: createBody.scopeHash,
    });
    await first.context.bind?.({ bindingTxnId, controlSessionId: "session-created" });
    await first.context.goto("https://target.test/next");
    await first.context.close();
    await second.context.close();
    const creates = requests.filter((entry) => entry.path === "/v1/browser/create");
    assert.equal(creates.length, 2);
    assert.equal(creates[0]?.body.idempotencyKey, creates[1]?.body.idempotencyKey, "the same immutable request must use one create key");
    assert.deepEqual((creates[0]?.body.request as Record<string, unknown>).ownerLane, "verifier");
    assert.equal(requests.filter((entry) => entry.path === "/v1/browser/action").length, 1);
    assert.equal(requests.filter((entry) => entry.path === "/v1/browser/heartbeat").length, 1, "remote actions refresh the durable lease");
    assert.equal(requests.filter((entry) => entry.path === "/v1/browser/bind").length, 1, "the Control Store handoff marker is persisted once");
    assert.equal(requests.filter((entry) => entry.path === "/v1/browser/release").length, 2);
    const actionResource = requests.find((entry) => entry.path === "/v1/browser/action")?.body.resource as Record<string, unknown>;
    assert.equal(actionResource.id, "session:session-created");
    assert.equal(actionResource.externalId, "browser-created");
  } finally {
    await close(server);
  }
});

test("durable browser runtime service persists create identity, leases, action resolution, and release", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-service-"));
  try {
    const request = createRequest({ runId: "RUN-DURABLE-BROWSER", generation: 1 });
    const key = sha256("durable-browser-create");
    const context = browserContext();
    const live = new Set<string>();
    let createCount = 0;
    let releaseCount = 0;
    let heartbeatCount = 0;
    const host: BrowserRuntimeHost = {
      async create(input, idempotencyKey) {
        createCount += 1;
        live.add("browser-durable");
        return { sessionId: "session-durable", externalId: "browser-durable", initialUrl: input.target, stateHash: sha256("empty"), context };
      },
      async inspect(externalId) { return live.has(externalId) ? "PRESENT" : "ABSENT"; },
      async adopt(externalId) { return live.has(externalId); },
      async resolve(externalId) { return live.has(externalId) ? context : undefined; },
      async release(externalId) { releaseCount += 1; live.delete(externalId); return true; },
      async heartbeat(externalId) { if (!live.has(externalId)) throw new Error("missing browser"); heartbeatCount += 1; },
    };
    const service = new DurableBrowserRuntimeService(join(root, "browser-runtime.json"), host);
    assert.equal((await service.health()).status, "DEGRADED", "a host without a health probe must not claim READY");
    assert.equal((await service.create(request, key)).state, "CREATED");
    assert.equal((await service.create(request, key)).state, "EXISTING");
    assert.equal(createCount, 1, "a retry must not invoke host.create twice");
    const resource = serviceResource(request);
    assert.deepEqual(await service.inspect(resource), { status: "PRESENT", binding: "MATCH", externalId: "browser-durable" });
    assert.deepEqual(await service.adopt(resource), { state: "CONFIRMED", externalId: "browser-durable" });
    assert.deepEqual(await service.actionService.action(resource, { kind: "navigate", url: request.target }), { status: 200, content: "browser", currentUrl: "https://target.test/", stateHash: sha256(canonicalJson({ cookies: [], origins: [] })) });
    assert.equal((await service.heartbeat(resource)).expiresAt.length > 0, true);
    assert.equal(heartbeatCount, 1);
    assert.deepEqual(await service.release(resource, "test cleanup"), { released: true, summary: "Browser context released: test cleanup" });
    assert.equal(releaseCount, 1);
    assert.deepEqual(await service.inspect(resource), { status: "UNKNOWN", binding: "UNKNOWN", externalId: "browser-durable", summary: "Browser runtime lease is not active" });

    let restartedCreates = 0;
    const restartedHost: BrowserRuntimeHost = {
      ...host,
      async create() { restartedCreates += 1; throw new Error("must not create a released handle"); },
    };
    const restarted = new DurableBrowserRuntimeService(join(root, "browser-runtime.json"), restartedHost);
    assert.deepEqual(await restarted.create(request, key), { state: "UNKNOWN", summary: "Browser create key was already released" });
    assert.equal(restartedCreates, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable browser runtime persists the Control Store binding marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-service-binding-"));
  try {
    const request = createRequest({ runId: "RUN-DURABLE-BROWSER-BIND", generation: 7 });
    const key = sha256("durable-browser-binding");
    const context = browserContext();
    const host: BrowserRuntimeHost = {
      async create(input) { return { sessionId: "session-binding", externalId: "browser-binding", initialUrl: input.target, stateHash: sha256("empty"), context }; },
      async inspect() { return "PRESENT"; },
      async adopt() { return true; },
      async resolve() { return context; },
      async release() { return true; },
    };
    const service = new DurableBrowserRuntimeService(join(root, "browser-runtime.json"), host);
    await service.create(request, key);
    const resource = serviceResource(request, "session-binding", "browser-binding");
    const bindingTxnId = externalResourceBindingTransactionId({
      id: resource.id,
      kind: "browser-context",
      runId: resource.runId,
      generation: resource.generation,
      ownerLane: resource.ownerLane,
      requestKey: resource.requestKey,
      policyHash: resource.policyHash,
      recipeHash: resource.recipeHash,
      scopeHash: resource.scopeHash,
    });
    const marked = { ...resource, bindingTxnId };
    await assert.rejects(() => service.actionService.action(marked, { kind: "navigate", url: request.target }), /no currently bound context/);
    await assert.rejects(() => service.heartbeat(marked), /binding marker is not persisted/);
    assert.deepEqual(await service.bind(marked), { state: "BOUND", externalId: resource.externalId });
    assert.deepEqual(await service.bind(marked), { state: "BOUND", externalId: resource.externalId }, "binding marker writes must be idempotent");
    assert.deepEqual(await service.bind({ ...marked, bindingTxnId: sha256("wrong-binding") }), { state: "UNKNOWN", summary: "Browser runtime binding marker does not match the immutable resource" });
    assert.deepEqual(await service.actionService.action(marked, { kind: "navigate", url: request.target }), { status: 200, content: "browser", currentUrl: "https://target.test/", stateHash: sha256(canonicalJson({ cookies: [], origins: [] })) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable browser runtime service reconciles an interrupted create without a duplicate", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-service-reconcile-"));
  try {
    const request = createRequest({ runId: "RUN-DURABLE-RECONCILE", generation: 2 });
    const key = sha256("durable-browser-reconcile");
    const firstHost: BrowserRuntimeHost = {
      async create() { throw new Error("simulated crash after reservation"); },
      async inspect() { return "UNKNOWN"; },
      async adopt() { return false; },
      async resolve() { return undefined; },
      async release() { return false; },
    };
    const ledger = join(root, "browser-runtime.json");
    const first = new DurableBrowserRuntimeService(ledger, firstHost);
    await assert.rejects(() => first.create(request, key), /simulated crash/);
    let createCount = 0;
    const recovered: BrowserRuntimeCreatedContext = { sessionId: "session-recovered", externalId: "browser-recovered", initialUrl: request.target, stateHash: sha256("empty") };
    const secondHost: BrowserRuntimeHost = {
      async create() { createCount += 1; throw new Error("duplicate create"); },
      async inspect() { return "PRESENT"; },
      async inspectByIdempotency() { return { status: "PRESENT", created: recovered }; },
      async adopt() { return true; },
      async resolve() { return undefined; },
      async release() { return true; },
    };
    const second = new DurableBrowserRuntimeService(ledger, secondHost);
    assert.deepEqual(await second.create(request, key), { state: "EXISTING", sessionId: "session-recovered", externalId: "browser-recovered", initialUrl: request.target, stateHash: sha256("empty") });
    assert.equal(createCount, 0, "restart reconciliation must query the exact key instead of creating a replacement");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable browser runtime service scans STARTING reservations on startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-service-startup-reconcile-"));
  try {
    const request = createRequest({ runId: "RUN-DURABLE-STARTUP-RECONCILE", generation: 3 });
    const key = sha256("durable-browser-startup-reconcile");
    const ledger = join(root, "browser-runtime.json");
    await writeFile(ledger, JSON.stringify({
      schemaVersion: 1,
      records: [{ schemaVersion: 1, idempotencyKey: key, request, state: "STARTING", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    }));
    const recovered: BrowserRuntimeCreatedContext = { sessionId: "session-startup", externalId: "browser-startup", initialUrl: request.target, stateHash: sha256("empty") };
    let inspectCount = 0;
    const host: BrowserRuntimeHost = {
      async create() { throw new Error("must not create during startup reconciliation"); },
      async inspect() { return "PRESENT"; },
      async inspectByIdempotency(input, idempotencyKey) { inspectCount += 1; assert.deepEqual(input, request); assert.equal(idempotencyKey, key); return { status: "PRESENT", created: recovered }; },
      async adopt() { return true; },
      async resolve() { return undefined; },
      async release() { return true; },
    };
    const service = new DurableBrowserRuntimeService(ledger, host);
    assert.deepEqual(await service.reconcile(), { recovered: [key], unknown: [], pending: [] });
    assert.equal(inspectCount, 1);
    assert.deepEqual(await service.create(request, key), { state: "EXISTING", sessionId: recovered.sessionId, externalId: recovered.externalId, initialUrl: recovered.initialUrl, stateHash: recovered.stateHash });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable browser runtime service serializes cross-process create reservations", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-service-race-"));
  try {
    const request = createRequest({ runId: "RUN-DURABLE-RACE", generation: 5 });
    const key = sha256("durable-browser-race");
    let createCount = 0;
    const host: BrowserRuntimeHost = {
      async create(input) {
        createCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { sessionId: "session-race", externalId: "browser-race", initialUrl: input.target, stateHash: sha256("empty") };
      },
      async inspect() { return "PRESENT"; },
      async adopt() { return true; },
      async resolve() { return undefined; },
      async release() { return true; },
    };
    const ledger = join(root, "browser-runtime.json");
    const left = new DurableBrowserRuntimeService(ledger, host);
    const right = new DurableBrowserRuntimeService(ledger, host);
    const outcomes = await Promise.all([left.create(request, key), right.create(request, key)]);
    assert.equal(createCount, 1, "the atomic STARTING reservation must prevent a second host create");
    assert.equal(outcomes.some((outcome) => outcome.state === "CREATED"), true);
    assert.equal(outcomes.every((outcome) => outcome.state === "CREATED" || outcome.state === "EXISTING" || outcome.state === "UNKNOWN"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable browser runtime service does not revive an expired lease without host reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-service-expiry-"));
  try {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const request = createRequest({ runId: "RUN-DURABLE-EXPIRY", generation: 6 });
    const key = sha256("durable-browser-expiry");
    let createCount = 0;
    const host: BrowserRuntimeHost = {
      async create(input) { createCount += 1; return { sessionId: "session-expiry", externalId: "browser-expiry", initialUrl: input.target, stateHash: sha256("empty") }; },
      async inspect() { return "PRESENT"; },
      async adopt() { return true; },
      async resolve() { return undefined; },
      async release() { return true; },
    };
    const service = new DurableBrowserRuntimeService(join(root, "browser-runtime.json"), host, { leaseMs: 1_000, now: () => now });
    assert.equal((await service.create(request, key)).state, "CREATED");
    now += 2_000;
    assert.deepEqual(await service.create(request, key), { state: "UNKNOWN", summary: "Browser create is awaiting exact host reconciliation" });
    await assert.rejects(() => service.heartbeat(serviceResource(request, "session-expiry", "browser-expiry")), /not active/);
    assert.equal(createCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable browser runtime service rejects a ledger with an invalid immutable create request", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-service-corrupt-"));
  try {
    const request = createRequest({ runId: "RUN-DURABLE-CORRUPT" });
    const key = sha256("durable-browser-corrupt");
    await writeFile(join(root, "browser-runtime.json"), JSON.stringify({
      schemaVersion: 1,
      records: [{
        schemaVersion: 1,
        idempotencyKey: key,
        request: { ...request, target: "file:///secret" },
        state: "STARTING",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }],
    }));
    const host: BrowserRuntimeHost = {
      async create() { throw new Error("must not reach host"); },
      async inspect() { return "UNKNOWN"; },
      async adopt() { return false; },
      async resolve() { return undefined; },
      async release() { return false; },
    };
    const service = new DurableBrowserRuntimeService(join(root, "browser-runtime.json"), host);
    await assert.rejects(() => service.create(request, key), /invalid run, owner, or target/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP browser broker uses a versioned redacted wire and connects an exact adopted handle", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    requests.push({ path: request.url ?? "", body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/browser/inspect") {
      response.end(JSON.stringify({ schemaVersion: 1, operation: "inspect", status: "PRESENT", binding: "MATCH", externalId: "browser-wire-1", summary: "exact broker match" }));
      return;
    }
    if (request.url === "/v1/browser/adopt") {
      response.end(JSON.stringify({ schemaVersion: 1, operation: "adopt", state: "CONFIRMED", externalId: "browser-wire-1", summary: "adopted" }));
      return;
    }
    response.end(JSON.stringify({ schemaVersion: 1, operation: "release", released: true, summary: "released" }));
  });
  const port = await listen(server);
  try {
    const record = browserRecord();
    const connectorInputs: string[] = [];
    const broker = new HttpBrowserRuntimeBroker({
      name: "wire-browser",
      baseUrl: `http://127.0.0.1:${port}/`,
      headers: { "x-broker-token": "test-only" },
      connectContext: async ({ externalId }) => {
        connectorInputs.push(externalId);
        return browserContext();
      },
    });
    const adapter = new BrowserContextResourceAdapter(broker, { timeoutMs: 1_000 });
    const inspection = await adapter.inspect(record);
    assert.deepEqual(inspection, { status: "PRESENT", binding: "MATCH", externalId: "browser-wire-1", summary: "exact broker match" });
    const adopted = await adapter.adopt(record, inspection);
    assert.equal(adopted.state, "CONFIRMED");
    assert.equal(adapter.takeBinding(record.id)?.externalId, "browser-wire-1");
    assert.deepEqual(connectorInputs, ["browser-wire-1"]);
    assert.deepEqual(await adapter.release(record, "test cleanup"), { released: true, summary: "released" });
    assert.deepEqual(requests.map(({ path }) => path), ["/v1/browser/inspect", "/v1/browser/adopt", "/v1/browser/inspect", "/v1/browser/release"]);
    const wireResource = requests[0]!.body.resource as Record<string, unknown>;
    assert.deepEqual(wireResource, {
      schemaVersion: 1,
      id: record.id,
      kind: "browser-context",
      runId: record.runId,
      generation: record.generation,
      ownerLane: record.ownerLane,
      externalId: record.externalId,
      effectId: record.effectId,
      requestKey: record.requestKey,
      policyHash: record.policyHash,
      recipeHash: record.recipeHash,
      scopeHash: record.scopeHash,
    });
    assert.equal(JSON.stringify(requests[0]!.body).includes("test-only"), false, "headers must not be copied into the durable resource payload");
    assert.equal(JSON.stringify(requests[0]!.body).includes("lastError"), false);
    assert.equal(JSON.stringify(requests[0]!.body).includes("createdAt"), false);
  } finally {
    await close(server);
  }
});

test("browser broker wire dispatcher validates redacted resources before calling the service", async () => {
  const calls: string[] = [];
  const service: BrowserRuntimeBrokerService = {
    async inspect(resource) {
      calls.push(`inspect:${resource.externalId}`);
      return { status: "PRESENT", binding: "MATCH", externalId: resource.externalId, summary: "service match" };
    },
    async adopt(resource) {
      calls.push(`adopt:${resource.externalId}`);
      return { state: "CONFIRMED", externalId: resource.externalId };
    },
    async release(resource, reason) {
      calls.push(`release:${resource.externalId}:${reason}`);
      return { released: true };
    },
    async bind(resource) {
      calls.push(`bind:${resource.externalId}`);
      return { state: "BOUND", externalId: resource.externalId };
    },
  };
  const resource = wireResource();
  assert.deepEqual(await dispatchBrowserRuntimeWire({ schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION, operation: "inspect", resource }, service), {
    schemaVersion: 1,
    operation: "inspect",
    status: "PRESENT",
    binding: "MATCH",
    externalId: resource.externalId,
    summary: "service match",
  });
  assert.deepEqual(await dispatchBrowserRuntimeWire({ schemaVersion: 1, operation: "adopt", resource }, service), {
    schemaVersion: 1,
    operation: "adopt",
    state: "CONFIRMED",
    externalId: resource.externalId,
  });
  assert.deepEqual(await dispatchBrowserRuntimeWire({ schemaVersion: 1, operation: "release", resource, reason: "operator cleanup" }, service), {
    schemaVersion: 1,
    operation: "release",
    released: true,
  });
  assert.deepEqual(await dispatchBrowserRuntimeWire({ schemaVersion: 1, operation: "bind", resource }, service), {
    schemaVersion: 1,
    operation: "bind",
    state: "BOUND",
    externalId: resource.externalId,
  });
  assert.deepEqual(calls, ["inspect:browser-wire-1", "adopt:browser-wire-1", "release:browser-wire-1:operator cleanup", "bind:browser-wire-1"]);
  await assert.rejects(() => dispatchBrowserRuntimeWire({ schemaVersion: 1, operation: "inspect", resource: { ...resource, driver: "must not cross the wire" } }, service), /unsupported field: driver/);
  await assert.rejects(() => dispatchBrowserRuntimeWire({ schemaVersion: 1, operation: "inspect", resource: { ...resource, policyHash: "not-a-hash" } }, service), /resource binding is invalid/);
});

test("browser broker HTTP handler binds routes, bounds requests, and redacts failures", async () => {
  const calls: string[] = [];
  const service: BrowserRuntimeBrokerService = {
    async inspect(resource) {
      calls.push(`inspect:${resource.externalId}`);
      return { status: "PRESENT", binding: "MATCH", externalId: resource.externalId };
    },
    async adopt() {
      throw new Error("driver cookie secret must not reach the client");
    },
    async release() {
      return { released: true };
    },
  };
  const server = createServer(createBrowserRuntimeHttpHandler(service));
  const port = await listen(server);
  try {
    const resource = wireResource();
    const inspect = await fetch(`http://127.0.0.1:${port}/v1/browser/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, operation: "inspect", resource }),
    });
    assert.equal(inspect.status, 200);
    assert.deepEqual(await inspect.json(), { schemaVersion: 1, operation: "inspect", status: "PRESENT", binding: "MATCH", externalId: resource.externalId });
    assert.deepEqual(calls, [`inspect:${resource.externalId}`]);

    const invalidField = await fetch(`http://127.0.0.1:${port}/v1/browser/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, operation: "inspect", resource: { ...resource, driver: "must not cross the wire" } }),
    });
    assert.equal(invalidField.status, 400);
    assert.deepEqual(calls, [`inspect:${resource.externalId}`]);

    const wrongMethod = await fetch(`http://127.0.0.1:${port}/v1/browser/inspect`, { method: "GET" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");

    const wrongContentType = await fetch(`http://127.0.0.1:${port}/v1/browser/inspect`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    assert.equal(wrongContentType.status, 415);

    const mismatch = await fetch(`http://127.0.0.1:${port}/v1/browser/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, operation: "release", resource }),
    });
    assert.equal(mismatch.status, 400);

    const oversized = await fetch(`http://127.0.0.1:${port}/v1/browser/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, operation: "inspect", resource, padding: "x".repeat(70 * 1024) }),
    });
    assert.equal(oversized.status, 413);

    const unavailable = await fetch(`http://127.0.0.1:${port}/v1/browser/adopt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, operation: "adopt", resource }),
    });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: "browser_runtime_unavailable" });
    const bindUnavailable = await fetch(`http://127.0.0.1:${port}/v1/browser/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, operation: "bind", resource }),
    });
    assert.equal(bindUnavailable.status, 404);
    assert.deepEqual(await bindUnavailable.json(), { error: "bind_not_available" });
  } finally {
    await close(server);
  }
});

test("browser broker HTTP handler can enforce deployment authentication before dispatch", async () => {
  let inspected = 0;
  const service: BrowserRuntimeBrokerService = {
    async inspect() {
      inspected += 1;
      return { status: "ABSENT", binding: "UNKNOWN" };
    },
    async adopt() { return { state: "UNKNOWN" }; },
    async release() { return { released: true }; },
  };
  const server = createServer(createBrowserRuntimeHttpHandler(service, {
    authorize: (request) => request.headers.authorization === "Bearer test-token",
  }));
  const port = await listen(server);
  try {
    const body = JSON.stringify({ schemaVersion: 1, operation: "inspect", resource: wireResource() });
    const denied = await fetch(`http://127.0.0.1:${port}/v1/browser/inspect`, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(denied.status, 401);
    const allowed = await fetch(`http://127.0.0.1:${port}/v1/browser/inspect`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-token" }, body });
    assert.equal(allowed.status, 200);
    assert.equal(inspected, 1);
  } finally {
    await close(server);
  }
});

test("browser action wire validates immutable bindings and forwards only bounded action results", async () => {
  const calls: Array<{ externalId: string; kind: string }> = [];
  const service: BrowserRuntimeActionService = {
    async action(resource, action) {
      calls.push({ externalId: resource.externalId, kind: action.kind });
      return { status: action.kind === "navigate" ? 200 : 204, content: "<p>bounded browser result</p>", currentUrl: "https://target.test/next", stateHash: sha256("state-1") };
    },
  };
  const resource = wireResource();
  const result = await dispatchBrowserRuntimeActionWire({ schemaVersion: 1, operation: "action", resource, action: { kind: "navigate", url: "https://target.test/start" } }, service);
  assert.deepEqual(result, { schemaVersion: 1, operation: "action", action: "navigate", status: 200, content: "<p>bounded browser result</p>", currentUrl: "https://target.test/next", stateHash: sha256("state-1") });
  assert.deepEqual(calls, [{ externalId: resource.externalId as string, kind: "navigate" }]);
  await assert.rejects(() => dispatchBrowserRuntimeActionWire({ schemaVersion: 1, operation: "action", resource, action: { kind: "navigate", url: "file:///etc/passwd" } }, service), /HTTP\(S\)/);
  await assert.rejects(() => dispatchBrowserRuntimeActionWire({ schemaVersion: 1, operation: "action", resource: { ...resource, scopeHash: "wrong" }, action: { kind: "wait", milliseconds: 1 } }, service), /resource binding is invalid/);
  await assert.rejects(() => dispatchBrowserRuntimeActionWire({ schemaVersion: 1, operation: "action", resource, action: { kind: "fill", selector: { kind: "css", value: "#secret", name: "not-allowed" }, value: "x" } }, service), /selector name is invalid/);
  await assert.rejects(() => dispatchBrowserRuntimeActionWire({ schemaVersion: 1, operation: "action", resource, action: { kind: "navigate", url: "https://target.test/start" }, extra: true }, service), /unsupported field: extra/);
  await assert.rejects(() => dispatchBrowserRuntimeActionWire({ schemaVersion: 1, operation: "action", resource, action: { kind: "navigate", url: "https://target.test/start" } }, { action: async () => ({ content: "x".repeat(1_048_577), currentUrl: "https://target.test/", stateHash: sha256("state") }) }), /exceeds its byte limit/);
  assert.deepEqual(calls, [{ externalId: resource.externalId as string, kind: "navigate" }]);
});

test("browser action service maps a resolver-owned context without reading storage", async () => {
  const resource = wireResource();
  let resolvedExternalId = "";
  const service = new BrowserRuntimeContextActionService(async (resolvedResource) => {
    resolvedExternalId = resolvedResource.externalId;
    return {
      async goto() { return { status: 201, content: "created" }; },
      async currentUrl() { return "https://target.test/next"; },
      async storageState() { throw new Error("storage must not be read when a redacted hash is available"); },
      async storageStateHash() { return sha256("remote-state"); },
      async close() {},
    };
  });
  assert.deepEqual(await service.action(resource, { kind: "navigate", url: "https://target.test/start" }), {
    status: 201,
    content: "created",
    currentUrl: "https://target.test/next",
    stateHash: sha256("remote-state"),
  });
  assert.equal(resolvedExternalId, resource.externalId);
});

test("HTTP browser context rejects a response for a different requested action", async () => {
  const resource = wireResource();
  const context = new HttpBrowserRuntimeContextPort({
    baseUrl: "https://broker.test",
    resource,
    fetchImpl: async () => new Response(JSON.stringify({ schemaVersion: 1, operation: "action", action: "fill", status: 200, content: "wrong action", currentUrl: "https://target.test/", stateHash: sha256("state") }), { status: 200, headers: { "content-type": "application/json" } }),
    release: async () => ({ released: true }),
  });
  await assert.rejects(() => context.goto("https://target.test/start"), /does not match the requested action/);
});

test("HTTP browser context refuses actions when the durable lease heartbeat is unknown", async () => {
  let actionCalled = false;
  const context = new HttpBrowserRuntimeContextPort({
    baseUrl: "https://broker.test",
    resource: wireResource(),
    heartbeat: async () => ({ state: "UNKNOWN", summary: "broker lease is unavailable" }),
    fetchImpl: async () => {
      actionCalled = true;
      return new Response("{}", { status: 200 });
    },
    release: async () => ({ released: true }),
  });
  await assert.rejects(() => context.goto("https://target.test/start"), /broker lease is unavailable/);
  assert.equal(actionCalled, false);
});

test("HTTP browser context proxy uses the action route, never exposes storage, and releases once", async () => {
  const actions: string[] = [];
  let releaseCount = 0;
  const service: BrowserRuntimeBrokerService = {
    async inspect(resource) { return { status: "PRESENT", binding: "MATCH", externalId: resource.externalId }; },
    async adopt(resource) { return { state: "CONFIRMED", externalId: resource.externalId }; },
    async release() { releaseCount += 1; return { released: true }; },
  };
  const actionService: BrowserRuntimeActionService = {
    async action(_resource, action) {
      actions.push(action.kind);
      return { status: 200, content: `result:${action.kind}`, currentUrl: "https://target.test/next", stateHash: sha256(action.kind) };
    },
  };
  const server = createServer(createBrowserRuntimeHttpHandler(service, { actionService }));
  const port = await listen(server);
  try {
    const resource = wireResource();
    const context = new HttpBrowserRuntimeContextPort({
      baseUrl: `http://127.0.0.1:${port}`,
      resource,
      initialUrl: "https://target.test/",
      release: async () => { releaseCount += 1; return { released: true }; },
    });
    assert.deepEqual(await context.goto("https://target.test/start"), { status: 200, content: "result:navigate" });
    assert.equal(await context.currentUrl(), "https://target.test/next");
    assert.deepEqual(await context.storageState(), { cookies: [], origins: [] });
    assert.equal(await context.storageStateHash(), sha256("navigate"));
    assert.deepEqual(await context.fill({ kind: "css", value: "#name" }, "proofblade"), { status: 200, content: "result:fill" });
    await Promise.all([context.close(), context.close()]);
    await context.close();
    assert.deepEqual(actions, ["navigate", "fill"]);
    assert.equal(releaseCount, 1);
  } finally {
    await close(server);
  }
});

test("HTTP browser context keeps a failed release retryable", async () => {
  let releaseCount = 0;
  const context = new HttpBrowserRuntimeContextPort({
    baseUrl: "https://broker.test",
    resource: wireResource(),
    release: async () => {
      releaseCount += 1;
      return releaseCount === 1 ? { released: false, summary: "broker unavailable" } : { released: true };
    },
  });
  await assert.rejects(() => context.close(), /broker unavailable/);
  await context.close();
  await context.close();
  assert.equal(releaseCount, 2);
  await assert.rejects(() => context.goto("https://target.test/"), /closed or closing/);
});

test("HTTP browser broker converts a foreign echo to MISMATCH and never connects it", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ schemaVersion: 1, operation: "inspect", status: "PRESENT", binding: "MATCH", externalId: "foreign-handle" }));
  });
  const port = await listen(server);
  try {
    let connected = false;
    const broker = new HttpBrowserRuntimeBroker({
      baseUrl: `http://127.0.0.1:${port}`,
      connectContext: async () => { connected = true; return browserContext(); },
    });
    const inspection = await broker.inspect(browserRecord());
    assert.deepEqual(inspection, { status: "PRESENT", binding: "MISMATCH", externalId: "foreign-handle", summary: "Browser broker returned a different opaque handle" });
    assert.deepEqual(await broker.adopt(browserRecord(), inspection), { state: "UNKNOWN", summary: "Browser broker returned a different opaque handle" });
    assert.equal(connected, false);
  } finally {
    await close(server);
  }
});

test("HTTP browser broker rejects response fields outside the redacted wire", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      schemaVersion: 1,
      operation: "inspect",
      status: "PRESENT",
      binding: "MATCH",
      externalId: "browser-wire-1",
      cookies: [{ name: "session", value: "must not cross the wire" }],
    }));
  });
  const port = await listen(server);
  try {
    const broker = new HttpBrowserRuntimeBroker({
      baseUrl: `http://127.0.0.1:${port}`,
      connectContext: async () => browserContext(),
    });
    await assert.rejects(() => broker.inspect(browserRecord()), /inspect response contains an unsupported field: cookies/);
  } finally {
    await close(server);
  }
});

test("HTTP browser broker rejects control characters in response summaries", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      schemaVersion: 1,
      operation: "inspect",
      status: "ABSENT",
      binding: "UNKNOWN",
      summary: "broker detail\nwith an unsafe control character",
    }));
  });
  const port = await listen(server);
  try {
    const broker = new HttpBrowserRuntimeBroker({
      baseUrl: `http://127.0.0.1:${port}`,
      connectContext: async () => browserContext(),
    });
    await assert.rejects(() => broker.inspect(browserRecord()), /returned an invalid summary/);
  } finally {
    await close(server);
  }
});

test("HTTP browser broker bounds response memory and aborts hanging streams", async () => {
  let mode: "oversized" | "exact-hang" | "hang" = "oversized";
  const server = createServer((_request, response) => {
    if (mode === "hang") return;
    response.setHeader("content-type", "application/json");
    if (mode === "exact-hang") {
      const body = JSON.stringify({ schemaVersion: 1, operation: "inspect", status: "ABSENT", binding: "UNKNOWN" });
      response.write(body + " ".repeat(65_536 - Buffer.byteLength(body)));
      return;
    }
    response.write("{" + "x".repeat(70 * 1024) + "}");
    response.end();
  });
  const port = await listen(server);
  try {
    const broker = new HttpBrowserRuntimeBroker({
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 100,
      connectContext: async () => browserContext(),
    });
    await assert.rejects(() => broker.inspect(browserRecord()), /exceeds 65536 bytes/);
    mode = "exact-hang";
    assert.deepEqual(await broker.inspect(browserRecord()), { status: "ABSENT", binding: "UNKNOWN" });
    mode = "hang";
    await assert.rejects(() => broker.inspect(browserRecord()), /timed out|aborted/i);
  } finally {
    await close(server);
  }
});

test("HTTP browser broker release false remains UNKNOWN and succeeds on the next retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-wire-retry-"));
  let releaseCount = 0;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    if (_request.url === "/v1/browser/inspect") {
      response.end(JSON.stringify({ schemaVersion: 1, operation: "inspect", status: "PRESENT", binding: "MATCH", externalId: "browser-wire-retry" }));
      return;
    }
    releaseCount += 1;
    response.end(JSON.stringify({ schemaVersion: 1, operation: "release", released: releaseCount > 1, summary: releaseCount > 1 ? "released" : "temporary broker failure" }));
  });
  const port = await listen(server);
  try {
    const registry = new ExternalResourceRegistry(join(root, "external-resources.json"));
    const record = browserRecord({ id: "session:BROWSER-WIRE-RETRY", externalId: "browser-wire-retry" });
    await registry.register({ id: record.id, kind: record.kind, runId: record.runId, generation: record.generation, ownerLane: record.ownerLane, externalId: record.externalId, effectId: record.effectId, requestKey: record.requestKey, policyHash: record.policyHash, recipeHash: record.recipeHash, scopeHash: record.scopeHash });
    await registry.markStarted(record.id, record.externalId);
    const broker = new HttpBrowserRuntimeBroker({ baseUrl: `http://127.0.0.1:${port}`, connectContext: async () => browserContext() });
    const adapter = new BrowserContextResourceAdapter(broker, { timeoutMs: 1_000 });
    assert.equal(await registry.release(record.id, adapter, "cleanup"), false);
    assert.equal((await registry.get(record.id))?.state, "UNKNOWN");
    assert.equal(await registry.release(record.id, adapter, "cleanup retry"), true);
    assert.equal((await registry.get(record.id))?.state, "RELEASED");
    assert.equal(releaseCount, 2);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("browser broker health probe declares bounded capabilities and heartbeat renews the exact resource", async () => {
  const paths: string[] = [];
  const service: BrowserRuntimeBrokerService = {
    async inspect() { return { status: "ABSENT", binding: "UNKNOWN" }; },
    async adopt() { return { state: "UNKNOWN" }; },
    async release() { return { released: true }; },
  };
  const server = createServer(createBrowserRuntimeHttpHandler(service, {
    healthService: {
      async health() {
        return { status: "READY", capabilities: { actions: ["navigate", "click", "fill", "submit", "wait"], maxResponseBytes: 1_048_576, stableAcrossRestart: true }, summary: "playwright broker ready" };
      },
    },
    heartbeatService: {
      async heartbeat(resource) {
        assert.equal(resource.externalId, "browser-wire-1");
        return { state: "CONFIRMED", externalId: resource.externalId, expiresAt: "2026-01-01T00:01:00.000Z" };
      },
    },
  }));
  const port = await listen(server);
  try {
    const broker = new HttpBrowserRuntimeBroker({
      baseUrl: `http://127.0.0.1:${port}`,
      connectContext: async () => browserContext(),
      fetchImpl: async (input, init) => {
        paths.push(new URL(String(input)).pathname);
        return await fetch(input, init);
      },
    });
    assert.deepEqual(await broker.health(), {
      schemaVersion: 1,
      operation: "health",
      status: "READY",
      capabilities: { actions: ["navigate", "click", "fill", "submit", "wait"], maxResponseBytes: 1_048_576, stableAcrossRestart: true },
      summary: "playwright broker ready",
    });
    assert.deepEqual(await broker.heartbeat(browserRecord()), {
      schemaVersion: 1,
      operation: "heartbeat",
      state: "CONFIRMED",
      externalId: "browser-wire-1",
      expiresAt: "2026-01-01T00:01:00.000Z",
    });
    assert.deepEqual(paths, ["/v1/browser/health", "/v1/browser/heartbeat"]);
  } finally {
    await close(server);
  }
});

test("browser factory probe gates replay registration without affecting unprobed local factories", async () => {
  const unprobed: BrowserVerifierFactory = { name: "local", async createContext() { return browserContext(); } };
  assert.equal(await probeBrowserVerifierFactory(unprobed), unprobed);
  let probeCount = 0;
  const unavailable: BrowserVerifierFactory = {
    name: "remote",
    async probe() { probeCount += 1; return { status: "DEGRADED", summary: "runtime warming" }; },
    async createContext() { return browserContext(); },
  };
  assert.equal(await probeBrowserVerifierFactory(unavailable), undefined);
  assert.equal(probeCount, 1);
  const controller = new AbortController();
  controller.abort(new Error("run aborted"));
  const aborted: BrowserVerifierFactory = {
    name: "aborted",
    async probe() { throw new Error("probe aborted"); },
    async createContext() { return browserContext(); },
  };
  await assert.rejects(() => probeBrowserVerifierFactory(aborted, controller.signal), /run aborted/);
  const unstableBroker: import("../src/web/browser-session.js").BrowserRuntimeBroker = {
    name: "unstable",
    async inspect() { return { status: "UNKNOWN", binding: "UNKNOWN" }; },
    async adopt() { return { state: "UNKNOWN" }; },
    async release() { return { released: false }; },
  };
  const unstable: BrowserVerifierFactory = {
    name: "unstable-remote",
    runtimeBroker: unstableBroker,
    async probe() { return { status: "READY", capabilities: { stableAcrossRestart: false } }; },
    async createContext() { return browserContext(); },
  };
  assert.equal(await probeBrowserVerifierFactory(unstable), undefined, "a non-durable broker must not register replay");
});

function browserRecord(overrides: Partial<Pick<ExternalResourceRecord, "id" | "externalId">> = {}): ExternalResourceRecord {
  return {
    schemaVersion: 1,
    id: overrides.id ?? "session:BROWSER-WIRE",
    kind: "browser-context",
    runId: "RUN-BROWSER-WIRE",
    generation: 2,
    ownerLane: "verifier",
    state: "STARTED",
    externalId: overrides.externalId ?? "browser-wire-1",
    effectId: "EF-BROWSER-WIRE",
    requestKey: "VR-browser-wire",
    policyHash: sha256("policy"),
    recipeHash: sha256("recipe"),
    scopeHash: sha256("scope"),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    inspectCount: 0,
  };
}

function createRequest(overrides: Partial<BrowserRuntimeCreateRequest> = {}): BrowserRuntimeCreateRequest {
  return {
    runId: "RUN-BROWSER-CREATE",
    generation: 3,
    ownerLane: "verifier",
    target: "https://target.test/start",
    policyHash: sha256("policy"),
    recipeHash: sha256("recipe"),
    verificationKey: "VR-browser-create",
    allowedHosts: ["target.test"],
    allowedPorts: [],
    maxResponseBytes: 1_024,
    scopeHash: sha256("scope"),
    ...overrides,
  };
}

function serviceResource(request: BrowserRuntimeCreateRequest, sessionId = "session-durable", externalId = "browser-durable"): import("../src/web/browser-runtime-broker.js").BrowserRuntimeWireResource {
  return {
    schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
    id: `session:${sessionId}`,
    kind: "browser-context",
    runId: request.runId,
    generation: request.generation,
    ownerLane: "verifier",
    externalId,
    requestKey: request.verificationKey,
    policyHash: request.policyHash,
    recipeHash: request.recipeHash,
    scopeHash: request.scopeHash,
  };
}

function wireResource(): Record<string, unknown> {
  const record = browserRecord();
  return {
    schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
    id: record.id,
    kind: "browser-context",
    runId: record.runId,
    generation: record.generation,
    ownerLane: record.ownerLane,
    externalId: record.externalId,
    effectId: record.effectId,
    requestKey: record.requestKey,
    policyHash: record.policyHash,
    recipeHash: record.recipeHash,
    scopeHash: record.scopeHash,
  };
}

function browserContext(): BrowserContextPort {
  return {
    async goto() { return { status: 200, content: "browser" }; },
    async currentUrl() { return "https://target.test/"; },
    async storageState() { return { cookies: [], origins: [] }; },
    async close() {},
  };
}

async function readJson(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return JSON.parse(body) as Record<string, unknown>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("wire fixture did not bind"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
