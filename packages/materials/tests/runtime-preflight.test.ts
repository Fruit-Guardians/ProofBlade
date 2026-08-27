import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { preflightConfiguredRuntimes } from "../src/recovery/runtime-preflight.js";
import type { ProofBladeConfig } from "../src/config.js";

const baseConfig = (runtime: ProofBladeConfig["runtime"]): ProofBladeConfig => ({
  schemaVersion: 1,
  runtime,
  storage: { runsDir: "runs", fixturesDir: "fixtures" },
  modelProfiles: { executor: { thinkingLevel: "off" } },
} as unknown as ProofBladeConfig);

test("runtime preflight keeps omitted brokers explicitly optional", async () => {
  const report = await preflightConfiguredRuntimes(baseConfig({ piVersion: "0.83.0" }), {});
  assert.equal(report.ready, true);
  assert.equal(report.browser.status, "NOT_CONFIGURED");
  assert.equal(report.sessions["http-session"].status, "NOT_CONFIGURED");
  assert.equal(report.sessions["pwn-session"].status, "NOT_CONFIGURED");
});

test("runtime preflight fails closed when configured broker credentials are absent", async () => {
  const report = await preflightConfiguredRuntimes(baseConfig({
    piVersion: "0.83.0",
    browserBroker: { baseUrl: "http://127.0.0.1:43121", tokenEnv: "TEST_BROWSER_RUNTIME_TOKEN" },
    sessionBroker: { baseUrl: "http://127.0.0.1:43122", tokenEnv: "TEST_SESSION_RUNTIME_TOKEN" },
  }), {});
  assert.equal(report.ready, false);
  assert.deepEqual(report.browser, {
    configured: true,
    tokenAvailable: false,
    status: "UNAVAILABLE",
    reason: "missing TEST_BROWSER_RUNTIME_TOKEN",
  });
  assert.equal(report.sessions["http-session"].status, "UNAVAILABLE");
  assert.equal(report.sessions["pwn-session"].status, "UNAVAILABLE");
});

test("runtime preflight requires both broker health and restart-stable capabilities", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/browser/health") {
      response.end(JSON.stringify({
        schemaVersion: 1,
        operation: "health",
        status: "READY",
        capabilities: {
          actions: ["navigate", "click", "fill", "submit", "wait"],
          maxResponseBytes: 8 * 1_048_576,
          stableAcrossRestart: true,
        },
      }));
      return;
    }
    if (request.url === "/v1/session/health") {
      response.end(JSON.stringify({
        schemaVersion: 1,
        operation: "health",
        status: "READY",
        capabilities: {
          kinds: ["pwn-session", "http-session"],
          maxRequestBytes: 4 * 1_048_576,
          maxResponseBytes: 8 * 1_048_576,
          stableAcrossRestart: true,
        },
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const report = await preflightConfiguredRuntimes(baseConfig({
      piVersion: "0.83.0",
      browserBroker: { baseUrl: `http://127.0.0.1:${address.port}`, tokenEnv: "TEST_BROWSER_RUNTIME_TOKEN" },
      sessionBroker: { baseUrl: `http://127.0.0.1:${address.port}`, tokenEnv: "TEST_SESSION_RUNTIME_TOKEN" },
    }), {
      TEST_BROWSER_RUNTIME_TOKEN: "browser-secret",
      TEST_SESSION_RUNTIME_TOKEN: "session-secret",
    });
    assert.equal(report.ready, true);
    assert.equal(report.browser.status, "READY");
    assert.equal(report.browser.stableAcrossRestart, true);
    assert.equal(report.sessions["http-session"].status, "READY");
    assert.equal(report.sessions["pwn-session"].status, "READY");
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
