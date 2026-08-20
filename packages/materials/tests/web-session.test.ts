import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices, demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { HttpSessionBackend } from "../src/web/http-session.js";
import { BrowserContextBackend, type BrowserContextPort } from "../src/web/browser-session.js";
import { WebReproducer } from "../src/verification/web-reproducer.js";

const config = { schemaVersion: 1, runtime: { piVersion: "0.83.0" }, storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" }, modelProfiles: { executor: { thinkingLevel: "off" } } } as unknown as ProofBladeConfig;

test("HTTP session reuses Cookie/CSRF within one run and WebReproducer uses a clean session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-http-session-"));
  const server = createServer((request, response) => {
    if (request.url === "/login") {
      response.setHeader("set-cookie", "sid=abc; HttpOnly; Path=/");
      response.end('<meta name="csrf-token" content="token-123">logged in');
      return;
    }
    const authenticated = request.headers.cookie === "sid=abc" && request.headers["x-csrf-token"] === "token-123";
    response.statusCode = authenticated ? 200 : 403;
    response.end(authenticated ? "flag{web-clean}" : "forbidden");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const services = createServices(root, config);
    const runId = "WEB-SESSION";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const session = await HttpSessionBackend.open({ runId, baseUrl, ownerLane: "executor", controlStore: services.control, artifactStore: services.artifacts, allowedHosts: ["127.0.0.1"] });
    await session.request("/login");
    const flag = await session.request("/flag");
    assert.equal(flag.status, 200);
    assert.match(flag.body, /flag\{web-clean\}/);
    await session.close();

    const otherRun = "WEB-OTHER";
    await services.control.createRun(otherRun, demoTask(otherRun, root, config));
    const isolated = await HttpSessionBackend.open({ runId: otherRun, baseUrl, ownerLane: "executor", controlStore: services.control, artifactStore: services.artifacts });
    assert.equal((await isolated.request("/flag")).status, 403, "cookies must not cross runs");
    await isolated.close();

    const reproducer = new WebReproducer(services.control);
    const result = await reproducer.reproduce(runId, { steps: [{ path: "/login", expectStatus: 200 }, { path: "/flag", expectStatus: 200 }], flagPattern: "flag\\{[^}]+\\}" }, async () => await HttpSessionBackend.open({ runId, baseUrl, ownerLane: "verifier", controlStore: services.control, artifactStore: services.artifacts }));
    assert.equal(result.reproduced, true);
    assert.equal(result.flag, "flag{web-clean}");
    const snapshot = await services.control.replay(runId);
    assert.equal(snapshot.evidence[result.evidenceId]?.kind, "reproduction");
    assert.ok(Object.values(snapshot.sessions).some((item) => item.kind === "http" && item.stateHash));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("browser context records storage state and response artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-browser-session-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-SESSION";
    await services.control.createRun(runId, demoTask(runId, root, config));
    let closed = false;
    const driver: BrowserContextPort = {
      async goto() { return { status: 200, content: "<html>dashboard</html>" }; },
      async storageState() { return { cookies: [{ name: "sid", value: "abc" }] }; },
      async close() { closed = true; },
    };
    const browser = new BrowserContextBackend(runId, "executor", "https://target.test/", driver, services.control, services.artifacts);
    await browser.open();
    const page = await browser.navigate("https://target.test/dashboard");
    assert.match(page.content, /dashboard/);
    assert.ok(page.stateHash);
    await browser.close();
    assert.equal(closed, true);
    assert.equal((await services.control.snapshot(runId)).sessions[browser.sessionId]?.status, "CLOSED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
