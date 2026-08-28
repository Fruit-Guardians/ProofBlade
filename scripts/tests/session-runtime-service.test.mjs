import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionRuntimeStatus, startSessionRuntimeService } from "../session-runtime-service.ts";

test("session runtime process status does not hide a degraded host", () => {
  assert.equal(sessionRuntimeStatus("READY"), "ready");
  assert.equal(sessionRuntimeStatus("READY", false), "degraded");
  assert.equal(sessionRuntimeStatus("DEGRADED"), "degraded");
  assert.equal(sessionRuntimeStatus("UNAVAILABLE"), "degraded");
});

test("session runtime service loads an injected host and protects health/create with auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-session-service-"));
  const hostPath = join(root, "host.mjs");
  const ledgerPath = join(root, "runtime.json");
  const startupKey = "c".repeat(64);
  await writeFile(ledgerPath, JSON.stringify({
    schemaVersion: 1,
    records: [{
      schemaVersion: 1,
      idempotencyKey: startupKey,
      request: { kind: "pwn-session", runId: "RUN-STARTUP", generation: 1, ownerLane: "executor", requestKey: "startup-request" },
      state: "STARTING",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  }), "utf8");
  await writeFile(hostPath, [
    "export function createSessionRuntimeHost() {",
    "  return {",
    "    async create() { return { sessionId: 'session-script', externalId: 'opaque-script', stateHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }; },",
    "    async inspect(externalId) { return { status: 'PRESENT', externalId }; },",
    "    async inspectByIdempotency() { return { status: 'PRESENT', created: { sessionId: 'startup-session', externalId: 'startup-opaque', stateHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }; },",
    "    async adopt() { return true; },",
    "    async release() { return true; },",
    "    actions: { async pwnWrite() { return { delta: '', waitReason: 'idle', exited: false, truncated: false }; }, async pwnRead() { return { delta: '', waitReason: 'idle', exited: false, truncated: false }; }, async pwnSignal() { return true; }, async pwnClose() { return { exitCode: 0 }; }, async httpRequest() { return { status: 200, headers: {}, body: '', stateHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }; } },",
    "    async health() { return { status: 'READY', capabilities: { kinds: ['pwn-session', 'http-session'], maxRequestBytes: 1048576, maxResponseBytes: 1048576, stableAcrossRestart: true } }; },",
    "  };",
    "}",
  ].join("\n"), "utf8");
  const running = await startSessionRuntimeService({ hostModule: hostPath, ledgerPath, port: 0, authToken: "session-service-token" });
  try {
    assert.deepEqual(running.reconciliation, { recovered: [startupKey], unknown: [], pending: [] });
    const unauthenticated = await fetch(`http://${running.host}:${running.port}/v1/session/health`);
    assert.equal(unauthenticated.status, 401);
    const headers = { authorization: "Bearer session-service-token", "content-type": "application/json" };
    const health = await fetch(`http://${running.host}:${running.port}/v1/session/health`, { headers });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "READY");
    const created = await fetch(`http://${running.host}:${running.port}/v1/session/create`, { method: "POST", headers, body: JSON.stringify({ schemaVersion: 1, operation: "create", idempotencyKey: "b".repeat(64), request: { kind: "pwn-session", runId: "RUN-SCRIPT", generation: 1, ownerLane: "executor", requestKey: "script-request" } }) });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).externalId, "opaque-script");
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("session runtime service validates auth before loading the host or touching the ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-session-service-auth-first-"));
  const hostPath = join(root, "host.mjs");
  const ledgerPath = join(root, "nested", "runtime.json");
  await writeFile(hostPath, "throw new Error('host module must not load');\n", "utf8");
  try {
    await assert.rejects(
      startSessionRuntimeService({ hostModule: hostPath, ledgerPath, port: 0, authToken: "too-short" }),
      /auth token with at least 16 characters/,
    );
    await assert.rejects(access(ledgerPath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session runtime service can require restart-stable READY before binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-session-service-required-"));
  const hostPath = join(root, "host.mjs");
  await writeFile(hostPath, [
    "export function createSessionRuntimeHost() {",
    "  return {",
    "    async create() { return { sessionId: 'degraded-session', externalId: 'degraded-opaque', stateHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }; },",
    "    async inspect(externalId) { return { status: 'PRESENT', externalId }; },",
    "    async inspectByIdempotency() { return { status: 'ABSENT' }; },",
    "    async adopt() { return true; },",
    "    async release() { return true; },",
    "    actions: { async pwnWrite() { return { delta: '', waitReason: 'idle', exited: false, truncated: false }; }, async pwnRead() { return { delta: '', waitReason: 'idle', exited: false, truncated: false }; }, async pwnSignal() { return true; }, async pwnClose() { return { exitCode: 0 }; }, async httpRequest() { return { status: 200, headers: {}, body: '', stateHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }; } },",
    "    async health() { return { status: 'DEGRADED', capabilities: { kinds: ['pwn-session', 'http-session'], maxRequestBytes: 1048576, maxResponseBytes: 1048576, stableAcrossRestart: false }, summary: 'deployment is not restart stable' }; },",
    "  };",
    "}",
  ].join("\n"), "utf8");
  try {
    await assert.rejects(
      startSessionRuntimeService({ hostModule: hostPath, ledgerPath: join(root, "runtime.json"), port: 0, authToken: "session-service-token", requireReady: true }),
      /health is DEGRADED; --require-ready needs READY/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session runtime required mode rejects READY without restart stability", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-session-service-unstable-"));
  const hostPath = join(root, "host.mjs");
  await writeFile(hostPath, [
    "export function createSessionRuntimeHost() {",
    "  return {",
    "    async create() { throw new Error('not expected'); },",
    "    async inspect() { return { status: 'ABSENT' }; },",
    "    async inspectByIdempotency() { return { status: 'ABSENT' }; },",
    "    async adopt() { return false; },",
    "    async release() { return true; },",
    "    actions: { async pwnWrite() { throw new Error('not expected'); }, async pwnRead() { throw new Error('not expected'); }, async pwnSignal() { throw new Error('not expected'); }, async pwnClose() { throw new Error('not expected'); }, async httpRequest() { throw new Error('not expected'); } },",
    "    async health() { return { status: 'READY', capabilities: { kinds: ['pwn-session', 'http-session'], maxRequestBytes: 1048576, maxResponseBytes: 1048576, stableAcrossRestart: false }, summary: 'process local only' }; },",
    "  };",
    "}",
  ].join("\n"), "utf8");
  try {
    await assert.rejects(
      startSessionRuntimeService({ hostModule: hostPath, ledgerPath: join(root, "runtime.json"), port: 0, authToken: "session-service-token", requireReady: true }),
      /stableAcrossRestart=false; --require-ready needs stableAcrossRestart=true/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
