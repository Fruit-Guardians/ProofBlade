import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DurableHttpSessionRuntimeHost, HttpSessionRuntimeBroker } from "@proofblade/materials";
import { startSessionRuntimeService } from "../session-runtime-service.ts";

test("durable HTTP host encrypts state and adopts it after a host restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-http-host-"));
  const server = createServer((request, response) => {
    if (request.url === "/login") {
      response.writeHead(200, { "content-type": "text/html", "set-cookie": "sid=abc; Path=/" });
      response.end('<meta name="csrf-token" content="token-1">login');
      return;
    }
    if (request.url === "/private") {
      const ok = request.headers.cookie === "sid=abc" && request.headers["x-csrf-token"] === "token-1";
      response.writeHead(ok ? 200 : 403, { "content-type": "text/plain" });
      response.end(ok ? "private" : "denied");
      return;
    }
    response.writeHead(404);
    response.end("missing");
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = createRequest(baseUrl, address.port);
  const key = "a".repeat(64);
  const statePath = join(root, "http-host.json");
  try {
    const first = new DurableHttpSessionRuntimeHost({ statePath, stateKey: "host-state-secret-123" });
    assert.equal((await first.health()).status, "READY");
    const created = await first.create(request, key);
    const login = await first.actions.httpRequest(resource(created.externalId), { method: "GET", url: `${baseUrl}/login`, headers: {} });
    assert.equal(login.status, 200);
    assert.equal(login.body.includes("login"), true);
    const encrypted = await readFile(statePath, "utf8");
    assert.equal(encrypted.includes("sid=abc"), false);
    assert.equal(encrypted.includes("token-1"), false);

    const restarted = new DurableHttpSessionRuntimeHost({ statePath, stateKey: "host-state-secret-123" });
    assert.deepEqual(await restarted.inspect(created.externalId, request), { status: "PRESENT", externalId: created.externalId });
    assert.equal(await restarted.adopt(created.externalId, request), true);
    const privateResponse = await restarted.actions.httpRequest(resource(created.externalId), { method: "GET", url: `${baseUrl}/private`, headers: {} });
    assert.deepEqual({ status: privateResponse.status, body: privateResponse.body }, { status: 200, body: "private" });
    assert.equal(await restarted.release(created.externalId, request, "test cleanup"), true);
    assert.equal(await restarted.release(created.externalId, request, "idempotent cleanup"), true);
    assert.deepEqual(await restarted.inspect(created.externalId, request), { status: "ABSENT", externalId: created.externalId });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("durable HTTP host is fail-closed without a state key and bounds response streams", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-http-host-bounds-"));
  const server = createServer((request, response) => {
    if (request.url === "/large") {
      response.writeHead(200, { "content-type": "text/plain" });
      for (let index = 0; index < 256; index += 1) response.write("x".repeat(16_384));
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = createRequest(baseUrl, address.port);
  try {
    const unavailable = new DurableHttpSessionRuntimeHost({ statePath: join(root, "missing-key.json") });
    const health = await unavailable.health();
    assert.equal(health.status, "DEGRADED");
    assert.equal(health.capabilities.stableAcrossRestart, false);
    await assert.rejects(unavailable.create(request, "b".repeat(64)), /requires a state key/);

    const host = new DurableHttpSessionRuntimeHost({ statePath: join(root, "bounded.json"), stateKey: "host-state-secret-123" });
    const created = await host.create(request, "c".repeat(64));
    const response = await host.actions.httpRequest(resource(created.externalId), { method: "GET", url: `${baseUrl}/large`, headers: {} });
    assert.equal(Buffer.byteLength(response.body), 1_048_576);
    await assert.rejects(host.actions.httpRequest(resource(created.externalId), { method: "GET", url: "http://127.0.0.1:1/outside", headers: {} }), /outside scope/);
    await assert.rejects(host.create({ ...request, http: { ...request.http, baseUrl: `${baseUrl}/other` } }, "c".repeat(64)), /different request/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP runtime service preserves a broker session across service restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-http-service-restart-"));
  const target = createServer((request, response) => {
    if (request.url === "/login") {
      response.writeHead(200, { "content-type": "text/html", "set-cookie": "sid=service-cookie; Path=/" });
      response.end('<meta name="csrf-token" content="service-token">login');
      return;
    }
    if (request.url === "/private") {
      const authorized = request.headers.cookie === "sid=service-cookie" && request.headers["x-csrf-token"] === "service-token";
      response.writeHead(authorized ? 200 : 403, { "content-type": "text/plain" });
      response.end(authorized ? "service-private" : "denied");
      return;
    }
    response.writeHead(404);
    response.end("missing");
  });
  await listen(target);
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress !== "string");
  const targetBaseUrl = `http://127.0.0.1:${targetAddress.port}`;
  const request = createRequest(targetBaseUrl, targetAddress.port);
  const serviceToken = "session-service-token";
  const stateKey = "service-host-state-secret";
  const hostStatePath = join(root, "host-state.json");
  const serviceLedgerPath = join(root, "service-ledger.json");
  const hostModulePath = join(root, "host.mjs");
  const materialsModuleUrl = pathToFileURL(join(process.cwd(), "packages/materials/dist/index.js")).href;
  await writeFile(hostModulePath, [
    `import { DurableHttpSessionRuntimeHost } from ${JSON.stringify(materialsModuleUrl)};`,
    `export function createSessionRuntimeHost() { return new DurableHttpSessionRuntimeHost({ statePath: ${JSON.stringify(hostStatePath)}, stateKey: ${JSON.stringify(stateKey)} }); }`,
  ].join("\n"), "utf8");
  let running;
  try {
    running = await startSessionRuntimeService({ hostModule: hostModulePath, ledgerPath: serviceLedgerPath, port: 0, authToken: serviceToken });
    const broker = createHttpBroker(running, serviceToken);
    const idempotencyKey = "d".repeat(64);
    const created = await broker.create(request, idempotencyKey);
    assert.equal(created.state, "CREATED");
    const resource = createServiceResource(request, created);
    const binding = await broker.createBinding(resource);
    const login = await binding.fetchImpl(`${targetBaseUrl}/login`);
    assert.equal(await login.text(), "<meta name=\"csrf-token\" content=\"service-token\">login");
    await running.close();
    running = undefined;

    const restarted = await startSessionRuntimeService({ hostModule: hostModulePath, ledgerPath: serviceLedgerPath, port: 0, authToken: serviceToken });
    running = restarted;
    const restartedBroker = createHttpBroker(restarted, serviceToken);
    assert.deepEqual(await restartedBroker.inspect(resource), { status: "PRESENT", binding: "MATCH", externalId: created.externalId });
    const adopted = await restartedBroker.adopt(resource, { status: "PRESENT", binding: "MATCH", externalId: created.externalId });
    assert.equal(adopted.state, "CONFIRMED");
    assert.ok(adopted.binding && adopted.binding.kind === "http-session");
    const privateResponse = await adopted.binding.fetchImpl(`${targetBaseUrl}/private`);
    assert.deepEqual({ status: privateResponse.status, body: await privateResponse.text() }, { status: 200, body: "service-private" });
    assert.equal((await restartedBroker.release(resource, "test cleanup")).released, true);
    assert.equal((await restartedBroker.release(resource, "idempotent cleanup")).released, true);
  } finally {
    if (running) await running.close();
    await new Promise((resolve) => target.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

function createRequest(baseUrl, port) {
  return {
    kind: "http-session",
    runId: "HTTP-HOST-TEST",
    generation: 0,
    ownerLane: "main",
    requestKey: "http-host-test",
    http: { baseUrl, allowedHosts: ["127.0.0.1"], allowedPorts: [port] },
  };
}

function resource(externalId) {
  return { schemaVersion: 1, id: "session:HTTP-HOST-SESSION", kind: "http-session", runId: "HTTP-HOST-TEST", generation: 0, ownerLane: "main", externalId };
}

function createServiceResource(request, created) {
  return {
    schemaVersion: 1,
    id: `session:${created.sessionId}`,
    kind: "http-session",
    runId: request.runId,
    generation: request.generation,
    ownerLane: request.ownerLane,
    externalId: created.externalId,
    requestKey: request.requestKey,
  };
}

function createHttpBroker(running, token) {
  let broker;
  broker = new HttpSessionRuntimeBroker({
    baseUrl: `http://${running.host}:${running.port}`,
    kind: "http-session",
    headers: { authorization: `Bearer ${token}` },
    connectBinding: async (record) => ({ kind: "http-session", externalId: record.externalId, fetchImpl: broker.createHttpFetch(record) }),
  });
  return broker;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}
