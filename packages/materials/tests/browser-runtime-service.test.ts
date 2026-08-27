import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserRuntimeStatus, startBrowserRuntimeService } from "../../../scripts/browser-runtime-service.ts";

test("browser runtime process status does not hide a degraded host", () => {
  assert.equal(browserRuntimeStatus("READY"), "ready");
  assert.equal(browserRuntimeStatus("READY", false), "degraded");
  assert.equal(browserRuntimeStatus("DEGRADED"), "degraded");
  assert.equal(browserRuntimeStatus("UNAVAILABLE"), "degraded");
});

test("browser runtime service starts from an injected host module and enforces auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-runtime-service-"));
  const hostPath = join(root, "host.mjs");
  const ledgerPath = join(root, "runtime.json");
  await writeFile(hostPath, [
    "export function createBrowserRuntimeHost() {",
    "  return {",
    "    async create(request) { return { sessionId: 'session-service', externalId: 'browser-service', initialUrl: request.target, stateHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }; },",
    "    async inspectByIdempotency() { return { status: 'PRESENT' }; },",
    "    async inspect() { return 'PRESENT'; },",
    "    async adopt() { return true; },",
    "    async resolve() { return undefined; },",
    "    async release() { return true; },",
    "    async health() { return { status: 'READY', capabilities: { actions: ['navigate', 'click', 'fill', 'submit', 'wait'], maxResponseBytes: 65536, stableAcrossRestart: true } }; },",
    "  };",
    "}",
  ].join("\n"), "utf8");
  const running = await startBrowserRuntimeService({ hostModule: hostPath, ledgerPath, port: 0, authToken: "service-test-token" });
  try {
    const unauthenticated = await fetch(`http://${running.host}:${running.port}/v1/browser/health`);
    assert.equal(unauthenticated.status, 401);
    const health = await fetch(`http://${running.host}:${running.port}/v1/browser/health`, { headers: { authorization: "Bearer service-test-token" } });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      schemaVersion: 1,
      operation: "health",
      status: "READY",
      capabilities: { actions: ["navigate", "click", "fill", "submit", "wait"], maxResponseBytes: 65536, stableAcrossRestart: true },
    });
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser runtime required mode rejects a degraded host before binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-runtime-required-"));
  const hostPath = join(root, "host.mjs");
  const ledgerPath = join(root, "runtime.json");
  await writeFile(hostPath, [
    "export function createBrowserRuntimeHost() {",
    "  return {",
    "    async create() { throw new Error('not expected'); },",
    "    async inspect() { return 'ABSENT'; },",
    "    async adopt() { return false; },",
    "    async resolve() { return undefined; },",
    "    async release() { return true; },",
    "    async health() { return { status: 'DEGRADED', capabilities: { actions: ['navigate', 'click', 'fill', 'submit', 'wait'], maxResponseBytes: 65536, stableAcrossRestart: false }, summary: 'driver unavailable' }; },",
    "  };",
    "}",
  ].join("\n"), "utf8");
  await assert.rejects(
    startBrowserRuntimeService({ hostModule: hostPath, ledgerPath, port: 0, authToken: "service-test-token", requireReady: true }),
    /health is DEGRADED; --require-ready needs READY/,
  );
  await rm(root, { recursive: true, force: true });
});

test("browser runtime required mode rejects READY without restart stability", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-runtime-unstable-"));
  const hostPath = join(root, "host.mjs");
  const ledgerPath = join(root, "runtime.json");
  await writeFile(hostPath, [
    "export function createBrowserRuntimeHost() {",
    "  return {",
    "    async create() { throw new Error('not expected'); },",
    "    async inspect() { return 'ABSENT'; },",
    "    async adopt() { return false; },",
    "    async resolve() { return undefined; },",
    "    async release() { return true; },",
    "    async health() { return { status: 'READY', capabilities: { actions: ['navigate', 'click', 'fill', 'submit', 'wait'], maxResponseBytes: 65536, stableAcrossRestart: false }, summary: 'process local only' }; },",
    "  };",
    "}",
  ].join("\n"), "utf8");
  try {
    await assert.rejects(
      startBrowserRuntimeService({ hostModule: hostPath, ledgerPath, port: 0, authToken: "service-test-token", requireReady: true }),
      /stableAcrossRestart=false; --require-ready needs stableAcrossRestart=true/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser runtime service validates auth before loading the host or touching the ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-runtime-auth-first-"));
  const hostPath = join(root, "host.mjs");
  const ledgerPath = join(root, "nested", "runtime.json");
  await writeFile(hostPath, "throw new Error('host module must not load');\n", "utf8");
  try {
    await assert.rejects(
      startBrowserRuntimeService({ hostModule: hostPath, ledgerPath, port: 0, authToken: "too-short" }),
      /auth token with at least 16 characters/,
    );
    await assert.rejects(access(ledgerPath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
