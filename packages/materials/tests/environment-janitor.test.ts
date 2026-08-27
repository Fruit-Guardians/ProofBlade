import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompetitionEnvironmentJanitor, CompetitionEnvironmentResourceAdapter } from "../src/competition/environment-janitor.js";
import type { CompetitionEnvironmentInspection } from "../src/competition/api.js";
import { ExternalResourceRegistry } from "../src/recovery/external-resource-registry.js";

class FakeStopApi {
  public readonly stopped: Array<{ challengeId: string; instanceId?: string }> = [];
  public fail = false;

  public async stopEnvironment(challengeId: string, instanceId?: string): Promise<void> {
    if (this.fail) throw new Error("platform stop unavailable");
    this.stopped.push({ challengeId, ...(instanceId ? { instanceId } : {}) });
  }
}

class FakeInspectApi extends FakeStopApi {
  public environmentIdentity?: { strategy: "instance-id" | "idempotency-key"; stableAcrossRestart: boolean };
  public inspection: CompetitionEnvironmentInspection = { status: "ACTIVE", challengeId: "CH-QUERY", instanceId: "INST-QUERY" };
  public inspectCalls: Array<{ challengeId: string; instanceId?: string }> = [];

  public async inspectEnvironment(challengeId: string, instanceId?: string): Promise<CompetitionEnvironmentInspection> {
    this.inspectCalls.push({ challengeId, ...(instanceId ? { instanceId } : {}) });
    return this.inspection;
  }
}

test("environment ledger survives a fresh janitor and sweeps expired records", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-env-janitor-"));
  try {
    let now = 1_000;
    const api = new FakeStopApi();
    const ledgerPath = join(root, "runs", "competition-environments.json");
    const first = new CompetitionEnvironmentJanitor({ api, ledgerPath, now: () => now, pollMs: 10 });
    const reservation = await first.acquire("RUN-1");
    await first.register(reservation, "CH-1", { instanceId: "INST-1", connectionInfo: "nc host 1", expiresAt: 2_000 });
    const recovered = new CompetitionEnvironmentJanitor({ api, ledgerPath, now: () => now, pollMs: 10 });
    assert.equal((await recovered.active()).length, 1);
    now = 2_000;
    assert.deepEqual(await recovered.sweepExpired(), { examined: 1, stopped: 1, failed: 0, retained: 0 });
    assert.deepEqual(api.stopped, [{ challengeId: "CH-1", instanceId: "INST-1" }]);
    assert.equal((await recovered.records())[0]?.stopReason, "expired lease sweep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capacity reservations serialize fleet environment starts and release after stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-env-capacity-"));
  try {
    const api = new FakeStopApi();
    const janitor = new CompetitionEnvironmentJanitor({ api, ledgerPath: join(root, "ledger.json"), maxActive: 1, pollMs: 10 });
    const firstReservation = await janitor.acquire("RUN-1");
    const first = await janitor.register(firstReservation, "CH-1", { instanceId: "INST-1", connectionInfo: "nc host 1" });
    assert.ok(first);
    const controller = new AbortController();
    const waiting = janitor.acquire("RUN-2", controller.signal);
    await delay(30);
    assert.equal((await janitor.active()).length, 1);
    assert.equal(await janitor.release(first!.leaseId), true);
    const secondReservation = await waiting;
    await janitor.releaseReservation(secondReservation);
    assert.deepEqual(api.stopped, [{ challengeId: "CH-1", instanceId: "INST-1" }]);
    controller.abort();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed cleanup remains active for a later retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-env-retry-"));
  try {
    const api = new FakeStopApi();
    const janitor = new CompetitionEnvironmentJanitor({ api, ledgerPath: join(root, "ledger.json") });
    const reservation = await janitor.acquire("RUN-1");
    const record = await janitor.register(reservation, "CH-1", { instanceId: "INST-1", expiresAt: 1 });
    assert.ok(record);
    api.fail = true;
    assert.equal(await janitor.release(record!.leaseId), false);
    assert.equal((await janitor.active())[0]?.lastError, "platform stop unavailable");
    api.fail = false;
    assert.equal(await janitor.sweepExpired(1).then((result) => result.stopped), 1);
    assert.equal((await janitor.active()).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed cleanup without a platform expiry is retried on the next reconcile", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-env-retry-no-expiry-"));
  try {
    const api = new FakeStopApi();
    const ledgerPath = join(root, "ledger.json");
    const janitor = new CompetitionEnvironmentJanitor({ api, ledgerPath });
    const reservation = await janitor.acquire("RUN-1");
    const record = await janitor.register(reservation, "CH-1", { instanceId: "INST-1" });
    assert.ok(record);
    api.fail = true;
    assert.equal(await janitor.release(record!.leaseId), false);
    api.fail = false;
    assert.deepEqual(await janitor.sweepExpired(), { examined: 1, stopped: 1, failed: 0, retained: 0 });
    assert.deepEqual(api.stopped, [{ challengeId: "CH-1", instanceId: "INST-1" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema-1 ledgers migrate on the next mutation without losing active records", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-env-migration-"));
  try {
    const ledgerPath = join(root, "ledger.json");
    await writeFile(ledgerPath, JSON.stringify({
      schemaVersion: 1,
      records: [{
        schemaVersion: 1,
        leaseId: "ENV-LEGACY",
        ownerId: "RUN-LEGACY",
        challengeId: "CH-LEGACY",
        instanceId: "INST-LEGACY",
        registeredAt: new Date(1_000).toISOString(),
        status: "ACTIVE",
      }],
    }), "utf8");
    const janitor = new CompetitionEnvironmentJanitor({ api: new FakeStopApi(), ledgerPath, maxActive: 2, pollMs: 10 });
    assert.equal((await janitor.active()).length, 1);
    const reservation = await janitor.acquire("RUN-NEW");
    await janitor.releaseReservation(reservation);
    const migrated = JSON.parse(await readFile(ledgerPath, "utf8")) as { schemaVersion: number; reservations: unknown[]; records: unknown[] };
    assert.equal(migrated.schemaVersion, 2);
    assert.deepEqual(migrated.reservations, []);
    assert.equal(migrated.records.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("separate janitors sharing one ledger cannot exceed capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-env-lock-"));
  try {
    const ledgerPath = join(root, "ledger.json");
    const api = new FakeStopApi();
    const first = new CompetitionEnvironmentJanitor({ api, ledgerPath, maxActive: 1, pollMs: 10, lockTimeoutMs: 2_000 });
    const second = new CompetitionEnvironmentJanitor({ api, ledgerPath, maxActive: 1, pollMs: 10, lockTimeoutMs: 2_000 });
    const firstReservation = await first.acquire("RUN-1");
    const waiting = second.acquire("RUN-2");
    await delay(40);
    const controller = new AbortController();
    const secondAttempt = second.acquire("RUN-3", controller.signal);
    controller.abort(new Error("stop waiting"));
    await assert.rejects(secondAttempt, /stop waiting/);
    await first.register(firstReservation, "CH-1", { instanceId: "INST-1" });
    assert.equal((await second.active()).length, 1);
    await first.release("ENV-missing");
    const firstRecords = await first.records();
    assert.equal(firstRecords.length, 1);
    await first.release(firstRecords[0]!.leaseId);
    const secondReservation = await waiting;
    await second.releaseReservation(secondReservation);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted pre-start reservation expires and does not starve a restarted fleet", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-env-crash-"));
  try {
    let now = 10_000;
    const ledgerPath = join(root, "ledger.json");
    const api = new FakeStopApi();
    const crashed = new CompetitionEnvironmentJanitor({ api, ledgerPath, maxActive: 1, reservationTtlMs: 1_000, now: () => now, pollMs: 10 });
    await crashed.acquire("RUN-CRASHED");

    now += 1_001;
    const restarted = new CompetitionEnvironmentJanitor({ api, ledgerPath, maxActive: 1, reservationTtlMs: 1_000, now: () => now, pollMs: 10 });
    const recovered = await restarted.acquire("RUN-RECOVERED");
    assert.ok(recovered.leaseId);
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as { reservations: Array<{ ownerId: string }> };
    assert.deepEqual(ledger.reservations.map((item) => item.ownerId), ["RUN-RECOVERED"]);
    await restarted.releaseReservation(recovered);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("platform environments share the external registry and adopt only janitor-owned records", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-env-resource-registry-"));
  try {
    const api = new FakeStopApi();
    const external = new ExternalResourceRegistry(join(root, "external-resources.json"));
    const janitor = new CompetitionEnvironmentJanitor({ api, ledgerPath: join(root, "ledger.json"), externalResources: external, pollMs: 10, allowLedgerOnlyRecovery: true });
    const reservation = await janitor.acquire("RUN-PLATFORM");
    const record = await janitor.register(reservation, "CH-PLATFORM", { instanceId: "INST-PLATFORM", connectionInfo: "nc host 1" });
    assert.ok(record);
    const adapter = new CompetitionEnvironmentResourceAdapter(janitor);
    const reconciled = await external.reconcileRun("RUN-PLATFORM", 0, [adapter]);
    assert.deepEqual(reconciled, { examined: 1, adopted: ["platform:" + record!.leaseId], released: [], unknown: [], failed: [] });
    assert.equal((await external.get("platform:" + record!.leaseId))?.state, "CONFIRMED");
    assert.equal(await external.release("platform:" + record!.leaseId, adapter, "test release"), true);
    assert.equal((await external.get("platform:" + record!.leaseId))?.state, "RELEASED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("platform adapter requires an optional remote query to agree on the exact instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-env-remote-inspect-"));
  try {
    const api = new FakeInspectApi();
    api.environmentIdentity = { strategy: "instance-id", stableAcrossRestart: true };
    const janitor = new CompetitionEnvironmentJanitor({ api, ledgerPath: join(root, "ledger.json"), pollMs: 10 });
    const reservation = await janitor.acquire("RUN-QUERY");
    const managed = await janitor.register(reservation, "CH-QUERY", { instanceId: "INST-QUERY", connectionInfo: "nc host 1" });
    assert.ok(managed);
    const adapter = new CompetitionEnvironmentResourceAdapter(janitor);
    const match = await adapter.inspect({
      schemaVersion: 1,
      id: `platform:${managed!.leaseId}`,
      kind: "platform-environment",
      runId: "RUN-QUERY",
      generation: 0,
      ownerLane: "executor",
      state: "CONFIRMED",
      externalId: "INST-QUERY",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      inspectCount: 0,
    });
    assert.deepEqual(match.binding, "MATCH");
    assert.deepEqual(api.inspectCalls, [{ challengeId: "CH-QUERY", instanceId: "INST-QUERY" }]);

    api.inspection = { status: "ACTIVE", challengeId: "CH-QUERY", instanceId: "INST-FOREIGN" };
    const mismatch = await adapter.inspect({
      schemaVersion: 1,
      id: `platform:${managed!.leaseId}`,
      kind: "platform-environment",
      runId: "RUN-QUERY",
      generation: 0,
      ownerLane: "executor",
      state: "CONFIRMED",
      externalId: "INST-QUERY",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      inspectCount: 0,
    });
    assert.equal(mismatch.binding, "MISMATCH");
    assert.equal((await adapter.release({
      schemaVersion: 1,
      id: `platform:${managed!.leaseId}`,
      kind: "platform-environment",
      runId: "RUN-QUERY",
      generation: 0,
      ownerLane: "executor",
      state: "CONFIRMED",
      externalId: "INST-QUERY",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      inspectCount: 0,
    }, "foreign cleanup")).released, false);
    assert.deepEqual(api.stopped, []);

    api.inspection = { status: "UNKNOWN", challengeId: "CH-QUERY", summary: "query timed out" };
    const unknown = await adapter.inspect({
      schemaVersion: 1,
      id: `platform:${managed!.leaseId}`,
      kind: "platform-environment",
      runId: "RUN-QUERY",
      generation: 0,
      ownerLane: "executor",
      state: "CONFIRMED",
      externalId: "INST-QUERY",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      inspectCount: 0,
    });
    assert.equal(unknown.status, "UNKNOWN");
    assert.equal((await adapter.release({
      schemaVersion: 1,
      id: `platform:${managed!.leaseId}`,
      kind: "platform-environment",
      runId: "RUN-QUERY",
      generation: 0,
      ownerLane: "executor",
      state: "CONFIRMED",
      externalId: "INST-QUERY",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      inspectCount: 0,
    }, "unknown cleanup")).released, false);
    assert.deepEqual(api.stopped, []);

    api.inspection = { status: "ABSENT", challengeId: "CH-QUERY", summary: "gone" };
    const absent = await adapter.inspect({
      schemaVersion: 1,
      id: `platform:${managed!.leaseId}`,
      kind: "platform-environment",
      runId: "RUN-QUERY",
      generation: 0,
      ownerLane: "executor",
      state: "CONFIRMED",
      externalId: "INST-QUERY",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      inspectCount: 0,
    });
    assert.equal(absent.status, "ABSENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("platform adapter fails closed when no remote identity query exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-env-no-remote-query-"));
  try {
    const api = new FakeStopApi();
    const janitor = new CompetitionEnvironmentJanitor({ api, ledgerPath: join(root, "ledger.json"), pollMs: 10 });
    const reservation = await janitor.acquire("RUN-NO-QUERY");
    const managed = await janitor.register(reservation, "CH-NO-QUERY", { instanceId: "INST-NO-QUERY", connectionInfo: "nc host 1" });
    const adapter = new CompetitionEnvironmentResourceAdapter(janitor);
    const inspection = await adapter.inspect({
      schemaVersion: 1,
      id: `platform:${managed!.leaseId}`,
      kind: "platform-environment",
      runId: "RUN-NO-QUERY",
      generation: 0,
      ownerLane: "executor",
      state: "CONFIRMED",
      externalId: "INST-NO-QUERY",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      inspectCount: 0,
    });
    assert.deepEqual(inspection, { status: "UNKNOWN", binding: "UNKNOWN", externalId: "INST-NO-QUERY", summary: "platform has no remote identity query; ledger-only recovery is disabled" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a crashed STARTING reservation is adopted only after an exact remote idempotency match", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-env-idempotency-recovery-"));
  try {
    const ledgerPath = join(root, "ledger.json");
    const api = new FakeInspectApi();
    const first = new CompetitionEnvironmentJanitor({ api, ledgerPath, pollMs: 10 });
    const reservation = await first.acquireForChallenge("RUN-START", "CH-START");
    assert.match(reservation.idempotencyKey ?? "", /^proofblade-env-/);
    await first.markStarting(reservation);
    api.environmentIdentity = { strategy: "idempotency-key", stableAcrossRestart: true };

    api.inspection = {
      status: "ACTIVE",
      challengeId: "CH-START",
      instanceId: "INST-START",
      idempotencyKey: reservation.idempotencyKey,
      connectionInfo: "nc target 9001",
      expiresAt: 9_999,
    };
    const restarted = new CompetitionEnvironmentJanitor({ api, ledgerPath, pollMs: 10 });
    assert.deepEqual(await restarted.reconcilePending(), { examined: 1, adopted: 1, unknown: 0 });
    const [record] = await restarted.active();
    assert.equal(record?.challengeId, "CH-START");
    assert.equal(record?.idempotencyKey, reservation.idempotencyKey);
    assert.equal(record?.instanceId, "INST-START");

    api.inspection = { status: "ACTIVE", challengeId: "CH-START", instanceId: "INST-FOREIGN", idempotencyKey: "different-key" };
    const foreign = new CompetitionEnvironmentJanitor({ api, ledgerPath, pollMs: 10 });
    const foreignAdapter = new CompetitionEnvironmentResourceAdapter(foreign);
    const inspection = await foreignAdapter.inspect({
      schemaVersion: 1,
      id: `platform:${record!.leaseId}`,
      kind: "platform-environment",
      runId: "RUN-START",
      generation: 0,
      ownerLane: "executor",
      state: "CONFIRMED",
      externalId: "INST-START",
      requestKey: reservation.idempotencyKey,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      inspectCount: 0,
    });
    assert.equal(inspection.binding, "MISMATCH");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("challenge environment idempotency is stable and duplicate reservations fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-env-stable-key-"));
  try {
    const ledgerPath = join(root, "ledger.json");
    const api = new FakeStopApi();
    const janitor = new CompetitionEnvironmentJanitor({ api, ledgerPath, pollMs: 10 });
    const first = await janitor.acquireForChallenge("RUN-STABLE", "CH-STABLE");
    assert.match(first.idempotencyKey ?? "", /^proofblade-env-[a-f0-9]{48}$/);
    await assert.rejects(
      janitor.acquireForChallenge("RUN-STABLE", "CH-STABLE"),
      /Environment reservation already exists for owner RUN-STABLE and challenge CH-STABLE/,
    );
    await janitor.releaseReservation(first);

    const restarted = new CompetitionEnvironmentJanitor({ api, ledgerPath, pollMs: 10 });
    const retry = await restarted.acquireForChallenge("RUN-STABLE", "CH-STABLE");
    assert.equal(retry.idempotencyKey, first.idempotencyKey);
    await restarted.register(retry, "CH-STABLE", { instanceId: "INST-STABLE", connectionInfo: "nc target 9001" });
    await assert.rejects(
      restarted.acquireForChallenge("RUN-STABLE", "CH-STABLE"),
      /Active environment already exists for owner RUN-STABLE and challenge CH-STABLE/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
