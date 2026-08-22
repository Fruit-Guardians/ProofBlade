import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices, demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { WebToolHandler, type WebScope } from "../src/web/web-tools.js";

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
