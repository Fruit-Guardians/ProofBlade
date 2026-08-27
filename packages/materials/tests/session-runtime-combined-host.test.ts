import assert from "node:assert/strict";
import test from "node:test";
import { CombinedSessionRuntimeHost } from "../../../scripts/session-runtime-combined-host.ts";
import type {
  SessionRuntimeActionService,
  SessionRuntimeCreateRequest,
  SessionRuntimeHealthCapabilities,
  SessionRuntimeWireResource,
} from "../src/recovery/session-runtime-wire.js";
import type {
  SessionRuntimeCreatedSession,
  SessionRuntimeHost,
  SessionRuntimeHostInspection,
} from "../src/recovery/session-runtime-service.js";

const HASH = "a".repeat(64);

test("combined session host dispatches lifecycle and actions by immutable kind", async () => {
  const http = fakeHost("http-session", "http");
  const pwn = fakeHost("pwn-session", "pwn");
  const host = new CombinedSessionRuntimeHost(http, pwn);
  const httpRequest = createRequest("http-session");
  const pwnRequest = createRequest("pwn-session");

  assert.equal((await host.create(httpRequest, HASH)).externalId, "http-external");
  assert.equal((await host.create(pwnRequest, HASH)).externalId, "pwn-external");
  assert.deepEqual(await host.inspect("http-external", httpRequest), { status: "PRESENT", externalId: "http-external" });
  assert.deepEqual(await host.inspect("pwn-external", pwnRequest), { status: "PRESENT", externalId: "pwn-external" });
  assert.equal(await host.adopt("http-external", httpRequest), true);
  assert.equal(await host.release("pwn-external", pwnRequest, "test"), true);

  const httpResource = resource("http-session", "http-external");
  const pwnResource = resource("pwn-session", "pwn-external");
  assert.equal((await host.actions.httpRequest(httpResource, { method: "GET", url: "http://target.test", headers: {} })).body, "http");
  assert.equal((await host.actions.pwnRead(pwnResource)).delta, "pwn");
  await host.heartbeat("pwn-external", undefined, pwnRequest);
  assert.deepEqual(http.calls, ["create", "inspect", "adopt", "http_request"]);
  assert.deepEqual(pwn.calls, ["create", "inspect", "release", "pwn_read", "heartbeat"]);
  await assert.rejects(() => host.heartbeat("opaque", undefined), /requires the immutable session kind/);
});

test("combined health is READY only when both hosts are complete and restart-stable", async () => {
  const ready = new CombinedSessionRuntimeHost(fakeHost("http-session", "http"), fakeHost("pwn-session", "pwn"));
  assert.deepEqual(await ready.health(), {
    status: "READY",
    capabilities: { kinds: ["http-session", "pwn-session"], maxRequestBytes: 4096, maxResponseBytes: 4096, stableAcrossRestart: true },
    summary: "combined HTTP/Pwn session runtime is restart-stable",
  });

  const degradedPwn = fakeHost("pwn-session", "pwn", false);
  const degraded = new CombinedSessionRuntimeHost(fakeHost("http-session", "http"), degradedPwn);
  const report = await degraded.health();
  assert.equal(report.status, "DEGRADED");
  assert.deepEqual(report.capabilities.kinds, []);
  assert.equal(report.capabilities.stableAcrossRestart, false);
});

test("combined host rejects an incomplete underlying action surface", () => {
  const http = fakeHost("http-session", "http");
  assert.throws(() => new CombinedSessionRuntimeHost({ ...http, actions: undefined }, fakeHost("pwn-session", "pwn")), /HTTP action surface/);
  const pwn = fakeHost("pwn-session", "pwn");
  assert.throws(() => new CombinedSessionRuntimeHost(fakeHost("http-session", "http"), { ...pwn, actions: undefined }), /Pwn action surface/);
});

function fakeHost(kind: "http-session" | "pwn-session", label: string, stableAcrossRestart = true): SessionRuntimeHost & { calls: string[] } {
  const calls: string[] = [];
  const actions: SessionRuntimeActionService = {
    pwnWrite: async () => { calls.push("pwn_write"); return result(label); },
    pwnRead: async () => { calls.push("pwn_read"); return result(label); },
    pwnSignal: async () => { calls.push("pwn_signal"); return true; },
    pwnClose: async () => { calls.push("pwn_close"); return { exitCode: 0 }; },
    httpRequest: async () => { calls.push("http_request"); return { status: 200, headers: {}, body: label, stateHash: HASH }; },
  };
  const created: SessionRuntimeCreatedSession = { sessionId: `${label}-session`, externalId: `${label}-external`, stateHash: HASH };
  return {
    calls,
    actions,
    async create() { calls.push("create"); return created; },
    async inspect(externalId): Promise<SessionRuntimeHostInspection> { calls.push("inspect"); return { status: "PRESENT", externalId }; },
    async adopt() { calls.push("adopt"); return true; },
    async release() { calls.push("release"); return true; },
    async inspectByIdempotency() { calls.push("inspectByIdempotency"); return { status: "PRESENT", created }; },
    async heartbeat() { calls.push("heartbeat"); },
    async health() {
      const capabilities: SessionRuntimeHealthCapabilities = { kinds: [kind], maxRequestBytes: 4096, maxResponseBytes: 4096, stableAcrossRestart };
      return { status: stableAcrossRestart ? "READY" : "DEGRADED", capabilities };
    },
  };
}

function createRequest(kind: "http-session" | "pwn-session"): SessionRuntimeCreateRequest {
  return kind === "http-session"
    ? { kind, runId: "RUN-COMBINED", generation: 0, ownerLane: "executor", requestKey: HASH, http: { baseUrl: "http://target.test", allowedHosts: ["target.test"], allowedPorts: [] } }
    : { kind, runId: "RUN-COMBINED", generation: 0, ownerLane: "executor", requestKey: HASH, pwn: { mode: "local", command: ["/bin/sh"], cwd: "/" } };
}

function resource(kind: "http-session" | "pwn-session", externalId: string): SessionRuntimeWireResource {
  return { schemaVersion: 1, id: `session:${kind}`, kind, runId: "RUN-COMBINED", generation: 0, ownerLane: "executor", externalId };
}

function result(delta: string) {
  return { delta, waitReason: "idle" as const, exited: false, truncated: false };
}
