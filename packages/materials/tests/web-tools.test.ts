import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices, demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { WebToolHandler, type WebScope } from "../src/web/web-tools.js";
import { createWebSessionTools } from "../src/runtime/web-coding-tools.js";
import type { CodingResourceContext } from "../src/runtime/coding-resources.js";
import type { SessionRuntimeCreateBroker } from "../src/recovery/session-resource-adapter.js";
import type { ExternalResourceRecord } from "../src/recovery/external-resource-registry.js";

const config = { schemaVersion: 1, runtime: { piVersion: "0.83.0" }, storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" }, modelProfiles: { executor: { thinkingLevel: "off" } } } as unknown as ProofBladeConfig;

/**
 * Real local HTTP target (same style as web-session.test.ts): /login sets a
 * cookie, /flag returns the flag ONLY when that cookie is present, /big returns
 * a large body. This exercises the real HttpSessionBackend end-to-end through
 * the model-facing WebToolHandler.
 */
function startTarget(flag: string): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    if (request.url === "/login") {
      response.setHeader("set-cookie", "sid=abc; Path=/");
      response.end("logged in");
      return;
    }
    if (request.url === "/big") { response.end("B".repeat(9000)); return; }
    if (request.url === "/flag") {
      const authed = request.headers.cookie === "sid=abc";
      response.statusCode = authed ? 200 : 403;
      response.end(authed ? `your flag is ${flag}` : "login first");
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/` });
  }));
}

async function makeHandler(root: string, runId: string, scope?: WebScope): Promise<WebToolHandler> {
  const services = createServices(root, config);
  await services.control.createRun(runId, demoTask(runId, root, config));
  return new WebToolHandler({ runId, controlStore: services.control, artifactStore: services.artifacts, ownerLane: "main", ...(scope ? { scope } : {}) });
}

test("handler opens, requests, lists and closes a session; cookies persist across requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-web-tool-"));
  const { server, baseUrl } = await startTarget("flag{stateful}");
  try {
    const runId = "WEB-TOOL";
    const services = createServices(root, config);
    await services.control.createRun(runId, demoTask(runId, root, config));
    const handler = new WebToolHandler({ runId, controlStore: services.control, artifactStore: services.artifacts, ownerLane: "main" });

    const opened = await handler.open({ baseUrl });
    assert.ok(opened.sessionId.startsWith("HTTP"));

    const before = await handler.request({ sessionId: opened.sessionId, path: "/flag" });
    assert.equal(before.status, 403);
    await handler.request({ sessionId: opened.sessionId, path: "/login", method: "POST" });
    const after = await handler.request({ sessionId: opened.sessionId, path: "/flag" });
    assert.equal(after.status, 200);
    assert.match(after.bodyViewport, /flag\{stateful\}/);

    assert.deepEqual(handler.list().map((s) => s.sessionId), [opened.sessionId]);
    const snap = await services.control.replay(runId);
    assert.equal(snap.sessions[opened.sessionId]?.kind, "http");

    await handler.close(opened.sessionId);
    assert.equal(handler.list().length, 0);
    assert.equal((await services.control.replay(runId)).sessions[opened.sessionId]?.status, "CLOSED");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("handler opens an HTTP session through a durable broker binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-web-tool-broker-"));
  try {
    const runId = "WEB-BROKER";
    const services = createServices(root, config);
    await services.control.createRun(runId, { ...demoTask(runId, root, config), target_kind: "web", target: "http://target.test/" });
    let creates = 0;
    const broker: SessionRuntimeCreateBroker = {
      name: "test-http-broker",
      kind: "http-session",
      async create(request) {
        creates += 1;
        assert.equal(request.kind, "http-session");
        assert.equal(request.http?.baseUrl, "http://target.test/");
        return { schemaVersion: 1, operation: "create", state: "CREATED", sessionId: "HTTP-BROKER-1", externalId: "opaque-http-1", stateHash: "b".repeat(64) };
      },
      async createBinding(record: ExternalResourceRecord) {
        return { kind: "http-session" as const, externalId: record.externalId!, fetchImpl: async () => new Response("broker response", { status: 200 }) };
      },
      async inspect(record) { return { status: "PRESENT" as const, binding: "MATCH" as const, externalId: record.externalId }; },
      async adopt(record) { return { state: "CONFIRMED" as const, externalId: record.externalId }; },
      async release() { return { released: true }; },
    };
    const handler = new WebToolHandler({ runId, controlStore: services.control, artifactStore: services.artifacts, ownerLane: "main", sessionBroker: broker });
    const opened = await handler.open({ baseUrl: "http://target.test/" });
    assert.equal(opened.sessionId, "HTTP-BROKER-1");
    assert.equal(creates, 1);
    const response = await handler.request({ sessionId: opened.sessionId, path: "/status" });
    assert.equal(response.status, 200);
    assert.equal(response.bodyViewport, "broker response");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("web exchanges create replayable baseline and request domain records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-web-domain-records-"));
  const { server, baseUrl } = await startTarget("flag{recorded}");
  try {
    const runId = "WEB-DOMAIN-RECORDS";
    const services = createServices(root, config);
    await services.control.createRun(runId, { ...demoTask(runId, root, config), target_kind: "web", target: baseUrl });
    const handler = new WebToolHandler({ runId, controlStore: services.control, artifactStore: services.artifacts, ownerLane: "main" });
    const opened = await handler.open({ baseUrl });
    const response = await handler.request({ sessionId: opened.sessionId, path: "/login", method: "POST" });
    assert.equal(response.status, 200);
    const snapshot = await services.control.replay(runId);
    const records = Object.values(snapshot.domainRecords);
    assert.equal(records.filter((record) => record.kind === "web_baseline").length, 1);
    const endpoint = records.find((record) => record.kind === "web_endpoint");
    assert.ok(endpoint);
    assert.equal(endpoint.method, "POST");
    assert.deepEqual(endpoint.sourceRecordIds, [records.find((record) => record.kind === "web_baseline")!.id]);
    const request = records.find((record) => record.kind === "web_request");
    assert.ok(request);
    assert.deepEqual(request.artifactIds, [response.artifactId]);
    assert.deepEqual(request.evidenceIds, [response.evidenceId]);
    const chain = records.find((record) => record.kind === "web_exploit_chain");
    assert.ok(chain);
    assert.equal(chain.status, "observed");
    assert.deepEqual(chain.stepRecordIds, [request.id]);
    assert.equal((await services.control.replay(runId)).domainRecords[request.id]?.summary, request.summary);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("handler rejects operations on an unknown session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-web-tool-unk-"));
  try {
    const handler = await makeHandler(root, "WEB-TOOL-UNK");
    await assert.rejects(handler.request({ sessionId: "HTTP-missing", path: "/" }), /Unknown web session/);
    await assert.rejects(handler.close("HTTP-missing"), /Unknown web session/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handler bounds the body viewport so a chatty response cannot flood context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-web-tool-bound-"));
  const { server, baseUrl } = await startTarget("flag{x}");
  try {
    const handler = await makeHandler(root, "WEB-TOOL-BOUND");
    const opened = await handler.open({ baseUrl });
    const view = await handler.request({ sessionId: opened.sessionId, path: "/big" });
    assert.equal(view.truncated, true);
    assert.ok(view.bodyViewport.length <= 4_001);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("web_request reports sent-but-unrecorded requests without encouraging blind retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-web-tool-sent-unknown-"));
  let received = 0;
  const server = createServer((_request, response) => { received += 1; response.end("accepted"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    const runId = "WEB-TOOL-SENT-UNKNOWN";
    const services = createServices(root, config);
    await services.control.createRun(runId, { ...demoTask(runId, root, config), target_kind: "web" });
    const originalPutText = services.artifacts.putText.bind(services.artifacts);
    services.artifacts.putText = async (...args: Parameters<typeof services.artifacts.putText>) => {
      if (String(args[1]).includes("http_exchange")) throw new Error("artifact disk unavailable");
      return await originalPutText(...args);
    };
    const handler = new WebToolHandler({ runId, controlStore: services.control, artifactStore: services.artifacts, ownerLane: "main" });
    const opened = await handler.open({ baseUrl: `http://127.0.0.1:${address.port}/` });
    const tool = createWebSessionTools().find((item) => item.name === "web_request")!;
    const result = await tool.execute!("sent-unknown", { sessionId: opened.sessionId, path: "/submit", method: "POST", body: "value=1" }, new AbortController().signal, () => {}, { webSession: handler } as unknown as CodingResourceContext);
    assert.equal(received, 1);
    assert.equal(result.isError, true);
    const text = result.content.filter((item): item is { type: "text"; text: string } => item.type === "text").map((item) => item.text).join("\n");
    assert.match(text, /request_sent_result_unknown/);
    assert.match(text, /do not blindly retry/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("replay uses a fresh cookie jar: a login-gated route is denied without prior auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-web-tool-replay-"));
  const { server, baseUrl } = await startTarget("flag{r}");
  try {
    const handler = await makeHandler(root, "WEB-TOOL-REPLAY");
    const opened = await handler.open({ baseUrl });
    await handler.request({ sessionId: opened.sessionId, path: "/login", method: "POST" });
    const live = await handler.request({ sessionId: opened.sessionId, path: "/flag" });
    assert.equal(live.status, 200);
    const replayed = await handler.replay({ sessionId: opened.sessionId, path: "/flag" });
    assert.equal(replayed.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("url outside task scope is rejected before connecting (host, port, scheme)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-web-tool-scope-"));
  try {
    const handler = await makeHandler(root, "WEB-TOOL-SCOPE", { allowedHosts: ["1.14.76.59"], allowedPorts: [80] });
    // In-scope host+port passes the app-layer check (connection may fail later, but scope is fine).
    await assert.rejects(handler.open({ baseUrl: "http://8.8.8.8:80/" }), /outside the task scope/);
    await assert.rejects(handler.open({ baseUrl: "http://1.14.76.59:9999/" }), /outside the task scope/);
    await assert.rejects(handler.open({ baseUrl: "file:///etc/passwd" }), /scheme .* is not allowed|not a valid URL/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
