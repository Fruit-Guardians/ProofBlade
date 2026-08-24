import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompetitionEnvironmentJanitor } from "../src/competition/environment-janitor.js";

class FakeStopApi {
  public readonly stopped: Array<{ challengeId: string; instanceId?: string }> = [];
  public fail = false;

  public async stopEnvironment(challengeId: string, instanceId?: string): Promise<void> {
    if (this.fail) throw new Error("platform stop unavailable");
    this.stopped.push({ challengeId, ...(instanceId ? { instanceId } : {}) });
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
