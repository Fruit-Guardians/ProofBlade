import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DurableSessionRuntimeService,
  type SessionRuntimeHost,
  type SessionRuntimeHostInspection,
} from "../src/recovery/session-runtime-service.js";
import type { SessionRuntimeActionService, SessionRuntimeCreateRequest, SessionRuntimeWireResource } from "../src/recovery/session-runtime-wire.js";
import type { ContainerSessionResult } from "../src/container/contracts.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const KEY = "d".repeat(64);

test("durable session runtime creates once, survives a new service instance, and enforces exact binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-session-runtime-"));
  const ledgerPath = join(root, "runtime.json");
  let creates = 0;
  let present = true;
  const actions = fakeActions();
  const host: SessionRuntimeHost = {
    async create() { creates += 1; return { sessionId: "pwn-1", externalId: "opaque-1", stateHash: HASH_C }; },
    async inspect(externalId): Promise<SessionRuntimeHostInspection> { return present ? { status: "PRESENT", externalId } : { status: "ABSENT", externalId }; },
    async adopt() { return true; },
    async release() { present = false; return true; },
    actions,
    async inspectByIdempotency(_request, _idempotencyKey) { return { status: present ? "PRESENT" as const : "ABSENT" as const }; },
    async health() { return { status: "READY", capabilities: { kinds: ["pwn-session", "http-session"] as const, maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576, stableAcrossRestart: true } }; },
  };
  const request = createRequest();
  try {
    const first = new DurableSessionRuntimeService(ledgerPath, host);
    assert.deepEqual(await first.create(request, KEY), { state: "CREATED", sessionId: "pwn-1", externalId: "opaque-1", stateHash: HASH_C });
    assert.deepEqual(await first.create(request, KEY), { state: "EXISTING", sessionId: "pwn-1", externalId: "opaque-1", stateHash: HASH_C });
    assert.equal(creates, 1);
    await assert.rejects(first.create({ ...request, runId: "RUN-OTHER" }, KEY), /different immutable request/);

    const resource = resourceFor(request, "pwn-1", "opaque-1");
    const restarted = new DurableSessionRuntimeService(ledgerPath, host);
    assert.deepEqual(await restarted.inspect(resource), { status: "PRESENT", binding: "MATCH", externalId: "opaque-1" });
    assert.deepEqual(await restarted.adopt(resource), { state: "CONFIRMED", externalId: "opaque-1" });
    const write = await restarted.actionService.pwnWrite(resource, "hello");
    assert.equal(write.delta, "ok");
    const mismatched = { ...resource, runId: "RUN-OTHER" };
    assert.deepEqual(await restarted.inspect(mismatched), { status: "PRESENT", binding: "MISMATCH", externalId: "opaque-1", summary: "Session runtime resource binding does not match the durable create request" });
    assert.deepEqual(await restarted.release(mismatched, "wrong owner"), { released: false, summary: "Session runtime release binding is ambiguous" });
    assert.deepEqual(await restarted.release(resource, "done"), { released: true, summary: "Session released: done" });
    assert.deepEqual(await restarted.release(resource, "retry"), { released: true, summary: "Session was already absent" });
    assert.equal((await restarted.health()).capabilities.stableAcrossRestart, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable session runtime downgrades a host that claims stability without idempotency reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-session-runtime-unstable-"));
  const host: SessionRuntimeHost = {
    async create() { return { sessionId: "pwn-unstable", externalId: "opaque-unstable", stateHash: HASH_A }; },
    async inspect(externalId) { return { status: "PRESENT", externalId }; },
    async adopt() { return true; },
    async release() { return true; },
    actions: fakeActions(),
    async health() { return { status: "READY", capabilities: { kinds: ["pwn-session"] as const, maxRequestBytes: 1_024, maxResponseBytes: 1_024, stableAcrossRestart: true } }; },
  };
  try {
    const health = await new DurableSessionRuntimeService(join(root, "runtime.json"), host).health();
    assert.deepEqual(health, {
      status: "DEGRADED",
      capabilities: { kinds: ["pwn-session"], maxRequestBytes: 1_024, maxResponseBytes: 1_024, stableAcrossRestart: false },
      summary: "Session runtime host cannot reconcile an interrupted create by idempotency key",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable session runtime downgrades READY when declared kinds lack action capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-session-runtime-capabilities-"));
  const host: SessionRuntimeHost = {
    async create() { return { sessionId: "pwn-capability", externalId: "opaque-capability", stateHash: HASH_A }; },
    async inspect(externalId) { return { status: "PRESENT", externalId }; },
    async adopt() { return true; },
    async release() { return true; },
    async inspectByIdempotency() { return { status: "ABSENT" as const }; },
    async health() { return { status: "READY", capabilities: { kinds: ["pwn-session"] as const, maxRequestBytes: 1_024, maxResponseBytes: 1_024, stableAcrossRestart: true } }; },
  };
  try {
    assert.deepEqual(await new DurableSessionRuntimeService(join(root, "runtime.json"), host).health(), {
      status: "DEGRADED",
      capabilities: { kinds: ["pwn-session"], maxRequestBytes: 1_024, maxResponseBytes: 1_024, stableAcrossRestart: false },
      summary: "Session runtime host does not expose actions for pwn-session",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable session runtime preserves an explicit unavailable host status", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-session-runtime-unavailable-"));
  const host: SessionRuntimeHost = {
    async create() { return { sessionId: "unavailable", externalId: "opaque-unavailable", stateHash: HASH_A }; },
    async inspect(externalId) { return { status: "ABSENT", externalId }; },
    async adopt() { return false; },
    async release() { return true; },
    async health() { return { status: "UNAVAILABLE", capabilities: { kinds: ["pwn-session"] as const, maxRequestBytes: 1_024, maxResponseBytes: 1_024, stableAcrossRestart: false }, summary: "host is offline" }; },
  };
  try {
    assert.deepEqual(await new DurableSessionRuntimeService(join(root, "runtime.json"), host).health(), {
      status: "UNAVAILABLE",
      capabilities: { kinds: ["pwn-session"], maxRequestBytes: 1_024, maxResponseBytes: 1_024, stableAcrossRestart: false },
      summary: "host is offline",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable session runtime reconciles an interrupted create without issuing a second host create", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-session-runtime-reconcile-"));
  const ledgerPath = join(root, "runtime.json");
  let creates = 0;
  const created = { sessionId: "http-1", externalId: "opaque-http-1", stateHash: HASH_A };
  const host: SessionRuntimeHost = {
    async create() { creates += 1; throw new Error("connection dropped after remote create"); },
    async inspect(externalId) { return { status: "PRESENT", externalId }; },
    async adopt() { return true; },
    async release() { return true; },
    async inspectByIdempotency() { return { status: "PRESENT", created }; },
  };
  try {
    const request = { ...createRequest(), kind: "http-session" as const };
    const first = new DurableSessionRuntimeService(ledgerPath, host);
    await assert.rejects(first.create(request, KEY), /connection dropped/);
    const restarted = new DurableSessionRuntimeService(ledgerPath, host);
    assert.deepEqual(await restarted.create(request, KEY), { state: "EXISTING", ...created });
    assert.equal(creates, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable session runtime scans STARTING reservations on startup and stays fail-closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-session-runtime-startup-reconcile-"));
  const ledgerPath = join(root, "runtime.json");
  const absentKey = "e".repeat(64);
  const pendingKey = "f".repeat(64);
  const created = { sessionId: "startup-session", externalId: "startup-opaque", stateHash: HASH_A };
  const timestamp = "2026-01-01T00:00:00.000Z";
  const request = createRequest();
  await writeFile(ledgerPath, JSON.stringify({
    schemaVersion: 1,
    records: [
      { schemaVersion: 1, idempotencyKey: KEY, request, state: "STARTING", createdAt: timestamp, updatedAt: timestamp },
      { schemaVersion: 1, idempotencyKey: absentKey, request, state: "STARTING", createdAt: timestamp, updatedAt: timestamp },
      { schemaVersion: 1, idempotencyKey: pendingKey, request, state: "STARTING", createdAt: timestamp, updatedAt: timestamp },
    ],
  }), "utf8");
  let creates = 0;
  const host: SessionRuntimeHost = {
    async create() { creates += 1; throw new Error("startup reconciliation must not create"); },
    async inspect(externalId) { return { status: "PRESENT", externalId }; },
    async adopt() { return true; },
    async release() { return true; },
    async inspectByIdempotency(_request, idempotencyKey) {
      if (idempotencyKey === KEY) return { status: "PRESENT" as const, created };
      if (idempotencyKey === absentKey) return { status: "ABSENT" as const };
      return { status: "UNKNOWN" as const };
    },
  };
  try {
    const service = new DurableSessionRuntimeService(ledgerPath, host);
    assert.deepEqual(await service.reconcile(), { recovered: [KEY], unknown: [absentKey], pending: [pendingKey] });
    assert.equal(creates, 0);
    assert.deepEqual(await service.create(request, KEY), { state: "EXISTING", ...created });
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as { records: Array<{ idempotencyKey: string; state: string; sessionId?: string; externalId?: string }> };
    assert.deepEqual(ledger.records.map((record) => ({ idempotencyKey: record.idempotencyKey, state: record.state, sessionId: record.sessionId, externalId: record.externalId })), [
      { idempotencyKey: KEY, state: "ACTIVE", sessionId: created.sessionId, externalId: created.externalId },
      { idempotencyKey: absentKey, state: "UNKNOWN", sessionId: undefined, externalId: undefined },
      { idempotencyKey: pendingKey, state: "STARTING", sessionId: undefined, externalId: undefined },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable session runtime never resurrects a reservation released during host reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-session-runtime-release-race-"));
  const ledgerPath = join(root, "runtime.json");
  const request = createRequest();
  const created = { sessionId: "released-race-session", externalId: "released-race-opaque", stateHash: HASH_A };
  await writeFile(ledgerPath, JSON.stringify({
    schemaVersion: 1,
    records: [{ schemaVersion: 1, idempotencyKey: KEY, request, state: "STARTING", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
  }), "utf8");
  let lookupStarted!: () => void;
  let releaseLookup!: () => void;
  const lookupStartedPromise = new Promise<void>((resolve) => { lookupStarted = resolve; });
  const releaseLookupPromise = new Promise<void>((resolve) => { releaseLookup = resolve; });
  const host: SessionRuntimeHost = {
    async create() { throw new Error("reconciliation must never create a replacement"); },
    async inspect(externalId) { return { status: "PRESENT", externalId }; },
    async adopt() { return true; },
    async release() { return true; },
    async inspectByIdempotency() {
      lookupStarted();
      await releaseLookupPromise;
      return { status: "PRESENT" as const, created };
    },
  };
  try {
    const service = new DurableSessionRuntimeService(ledgerPath, host);
    const reconciliation = service.reconcile();
    await lookupStartedPromise;
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as { records: Array<Record<string, unknown>> };
    ledger.records[0]!.state = "RELEASED";
    await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`, "utf8");
    releaseLookup();
    assert.deepEqual(await reconciliation, { recovered: [], unknown: [], pending: [KEY] });
    const finalLedger = JSON.parse(await readFile(ledgerPath, "utf8")) as { records: Array<Record<string, unknown>> };
    assert.equal(finalLedger.records[0]!.state, "RELEASED");
    assert.equal(finalLedger.records[0]!.externalId, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable session runtime refuses action kind confusion and reports degraded hosts without health", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-session-runtime-actions-"));
  const ledgerPath = join(root, "runtime.json");
  const host: SessionRuntimeHost = {
    async create(request) { return { sessionId: "http-2", externalId: "opaque-http-2", stateHash: HASH_B }; },
    async inspect(externalId) { return { status: "PRESENT", externalId }; },
    async adopt() { return true; },
    async release() { return true; },
    actions: fakeActions(),
  };
  try {
    const service = new DurableSessionRuntimeService(ledgerPath, host);
    const request = { ...createRequest(), kind: "http-session" as const };
    await service.create(request, KEY);
    const resource = resourceFor(request, "http-2", "opaque-http-2");
    await assert.rejects(service.actionService.pwnRead(resource), /cannot use http-session/);
    assert.equal((await service.health()).status, "DEGRADED");
    assert.equal((await service.health()).capabilities.stableAcrossRestart, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable session runtime refreshes exact leases and rejects expired actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-session-runtime-lease-"));
  const ledgerPath = join(root, "runtime.json");
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  let heartbeats = 0;
  const host: SessionRuntimeHost = {
    async create() { return { sessionId: "lease-session", externalId: "lease-opaque", stateHash: HASH_A }; },
    async inspect(externalId) { return { status: "PRESENT", externalId }; },
    async adopt() { return true; },
    async release() { return true; },
    async heartbeat() { heartbeats += 1; },
    actions: fakeActions(),
  };
  try {
    const service = new DurableSessionRuntimeService(ledgerPath, host, { leaseMs: 1_000, now: () => now });
    const request = createRequest();
    await service.create(request, KEY);
    const resource = resourceFor(request, "lease-session", "lease-opaque");
    assert.deepEqual(await service.heartbeat(resource), {
      state: "CONFIRMED",
      externalId: "lease-opaque",
      expiresAt: "2026-01-01T00:00:01.000Z",
    });
    assert.equal(heartbeats, 1);
    assert.equal((await service.actionService.pwnRead(resource)).delta, "ok");
    now += 1_001;
    await assert.rejects(service.heartbeat(resource), /heartbeat binding is not active/);
    await assert.rejects(service.actionService.pwnRead(resource), /action binding is not active/);
    assert.deepEqual(await service.inspect(resource), {
      status: "UNKNOWN",
      binding: "UNKNOWN",
      externalId: "lease-opaque",
      summary: "Session runtime lease is not active",
    });
    assert.deepEqual(await service.release(resource, "expired cleanup"), { released: true, summary: "Session released: expired cleanup" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable session runtime uses exact inspect as the heartbeat fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-session-runtime-heartbeat-fallback-"));
  const ledgerPath = join(root, "runtime.json");
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  let present = true;
  const host: SessionRuntimeHost = {
    async create() { return { sessionId: "inspect-heartbeat", externalId: "inspect-opaque", stateHash: HASH_A }; },
    async inspect(externalId) { return present ? { status: "PRESENT", externalId } : { status: "ABSENT", externalId }; },
    async adopt() { return true; },
    async release() { return true; },
    actions: fakeActions(),
  };
  try {
    const service = new DurableSessionRuntimeService(ledgerPath, host, { now: () => now });
    const request = createRequest();
    await service.create(request, KEY);
    const resource = resourceFor(request, "inspect-heartbeat", "inspect-opaque");
    assert.deepEqual(await service.heartbeat(resource), { state: "CONFIRMED", externalId: "inspect-opaque", expiresAt: "2026-01-01T00:02:00.000Z" });
    present = false;
    await assert.rejects(service.heartbeat(resource), /could not confirm the exact host resource/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createRequest(): SessionRuntimeCreateRequest {
  return { kind: "pwn-session", runId: "RUN-SESSION", generation: 3, ownerLane: "executor", requestKey: "challenge-request", policyHash: HASH_A, recipeHash: HASH_B, scopeHash: HASH_C };
}

function resourceFor(request: SessionRuntimeCreateRequest, sessionId: string, externalId: string): SessionRuntimeWireResource {
  return { schemaVersion: 1, id: `session:${sessionId}`, kind: request.kind, runId: request.runId, generation: request.generation, ownerLane: request.ownerLane, externalId, requestKey: request.requestKey, policyHash: request.policyHash, recipeHash: request.recipeHash, scopeHash: request.scopeHash };
}

function fakeActions(): SessionRuntimeActionService {
  const result = (): ContainerSessionResult => ({ delta: "ok", waitReason: "idle", exited: false, truncated: false });
  return {
    async pwnWrite() { return result(); },
    async pwnRead() { return result(); },
    async pwnSignal() { return true; },
    async pwnClose() { return { exitCode: 0 }; },
    async httpRequest() { return { status: 200, headers: {}, body: "ok", stateHash: HASH_A }; },
  };
}
