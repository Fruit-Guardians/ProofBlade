import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserRuntimeStatus, resolveBrowserRuntimeHostModule, startBrowserRuntimeService } from "../browser-runtime-service.ts";

const STATE_HASH = "a".repeat(64);

test("browser runtime process status does not hide a degraded host", () => {
  assert.equal(browserRuntimeStatus("READY"), "ready");
  assert.equal(browserRuntimeStatus("READY", false), "degraded");
  assert.equal(browserRuntimeStatus("DEGRADED"), "degraded");
  assert.equal(browserRuntimeStatus("UNAVAILABLE"), "degraded");
});

test("browser runtime host resolution prefers explicit, then environment, then bundled persistent host", () => {
  assert.equal(resolveBrowserRuntimeHostModule("custom-host.mjs", { PROOFBLADE_BROWSER_RUNTIME_HOST_MODULE: "env-host.mjs" }), "custom-host.mjs");
  assert.equal(resolveBrowserRuntimeHostModule(undefined, { PROOFBLADE_BROWSER_RUNTIME_HOST_MODULE: "env-host.mjs" }), "env-host.mjs");
  assert.equal(resolveBrowserRuntimeHostModule(undefined, {}), "scripts/browser-runtime-playwright-host.ts");
});

test("browser runtime service loads an injected host and protects health/create with auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-service-"));
  const hostPath = join(root, "host.mjs");
  const ledgerPath = join(root, "runtime.json");
  await writeFile(hostPath, browserHostModule({ status: "READY", stableAcrossRestart: true }), "utf8");
  const running = await startBrowserRuntimeService({ hostModule: hostPath, ledgerPath, port: 0, authToken: "browser-service-token" });
  try {
    const unauthenticated = await fetch(`http://${running.host}:${running.port}/v1/browser/health`);
    assert.equal(unauthenticated.status, 401);
    const headers = { authorization: "Bearer browser-service-token", "content-type": "application/json" };
    const health = await fetch(`http://${running.host}:${running.port}/v1/browser/health`, { headers });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).capabilities.stableAcrossRestart, true);
    const created = await fetch(`http://${running.host}:${running.port}/v1/browser/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        operation: "create",
        idempotencyKey: "b".repeat(64),
        request: browserRequest(),
      }),
    });
    assert.equal(created.status, 200);
    const value = await created.json();
    assert.equal(value.externalId, "browser-opaque");
    assert.equal(value.sessionId, "browser-session");
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser runtime service validates auth before loading the host or touching the ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-service-auth-first-"));
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

test("browser runtime required mode rejects a degraded host before binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-service-required-"));
  const hostPath = join(root, "host.mjs");
  await writeFile(hostPath, browserHostModule({ status: "DEGRADED", stableAcrossRestart: false, summary: "browser driver unavailable", inspectByIdempotency: "throw new Error('reconciliation must not run before readiness')" }), "utf8");
  await writeFile(join(root, "runtime.json"), JSON.stringify({
    schemaVersion: 1,
    records: [{
      schemaVersion: 1,
      idempotencyKey: "f".repeat(64),
      request: browserRequest(),
      state: "STARTING",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  }), "utf8");
  try {
    await assert.rejects(
      startBrowserRuntimeService({ hostModule: hostPath, ledgerPath: join(root, "runtime.json"), port: 0, authToken: "browser-service-token", requireReady: true }),
      /health is DEGRADED; --require-ready needs READY/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser runtime required mode rejects READY without restart stability", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-service-unstable-"));
  const hostPath = join(root, "host.mjs");
  await writeFile(hostPath, browserHostModule({ status: "READY", stableAcrossRestart: false, summary: "process local only" }), "utf8");
  try {
    await assert.rejects(
      startBrowserRuntimeService({ hostModule: hostPath, ledgerPath: join(root, "runtime.json"), port: 0, authToken: "browser-service-token", requireReady: true }),
      /stableAcrossRestart=false; --require-ready needs stableAcrossRestart=true/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function browserRequest() {
  return {
    runId: "RUN-BROWSER-SERVICE",
    generation: 1,
    ownerLane: "verifier",
    target: "https://target.test/",
    policyHash: "c".repeat(64),
    verificationKey: "d".repeat(64),
    allowedHosts: ["target.test"],
    allowedPorts: [],
    maxResponseBytes: 65_536,
    scopeHash: "e".repeat(64),
  };
}

function browserHostModule({ status, stableAcrossRestart, summary = "ready", inspectByIdempotency = "return { status: 'ABSENT' };" }) {
  return `
    export function createBrowserRuntimeHost() {
      return {
        async create() { return { sessionId: 'browser-session', externalId: 'browser-opaque', initialUrl: 'https://target.test/', stateHash: '${STATE_HASH}' }; },
        async inspect() { return 'PRESENT'; },
        async inspectByIdempotency() { ${inspectByIdempotency} },
        async adopt() { return true; },
        async resolve() { return undefined; },
        async release() { return true; },
        async health() { return { status: '${status}', capabilities: { actions: ['navigate', 'click', 'fill', 'submit', 'wait'], maxResponseBytes: 8388608, stableAcrossRestart: ${stableAcrossRestart} }, summary: '${summary}' }; },
      };
    }
  `;
}
