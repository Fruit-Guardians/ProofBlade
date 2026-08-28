import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CompetitionEnvironmentIdentityCapabilities, CompetitionEnvironmentInspection } from "../src/competition/api.js";
import { CompetitionEnvironmentJanitor, CompetitionEnvironmentResourceAdapter } from "../src/competition/environment-janitor.js";
import type { ExternalResourceRecord } from "../src/recovery/external-resource-registry.js";
import { ExternalResourceRegistry } from "../src/recovery/external-resource-registry.js";

class RemoteMatrixApi {
  public environmentIdentity?: CompetitionEnvironmentIdentityCapabilities = { strategy: "idempotency-key", stableAcrossRestart: true };
  public inspection: CompetitionEnvironmentInspection = {
    status: "ACTIVE",
    challengeId: "CH-MATRIX",
    instanceId: "INST-MATRIX",
    idempotencyKey: "proofblade-env-matrix",
  };
  public readonly stopped: Array<{ challengeId: string; instanceId?: string }> = [];

  public async inspectEnvironment(challengeId: string, instanceId?: string, _options: { idempotencyKey?: string } = {}): Promise<CompetitionEnvironmentInspection> {
    void challengeId;
    void instanceId;
    return structuredClone(this.inspection);
  }

  public async stopEnvironment(challengeId: string, instanceId?: string): Promise<void> {
    this.stopped.push({ challengeId, ...(instanceId ? { instanceId } : {}) });
  }
}

function resource(leaseId: string, requestKey = "proofblade-env-matrix"): ExternalResourceRecord {
  return {
    schemaVersion: 1,
    id: `platform:${leaseId}`,
    kind: "platform-environment",
    runId: "RUN-MATRIX",
    generation: 0,
    ownerLane: "executor",
    state: "CONFIRMED",
    externalId: "INST-MATRIX",
    requestKey,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    inspectCount: 0,
  };
}

async function createManaged(
  root: string,
  api: RemoteMatrixApi,
  options: { requireRemoteInspectionForSweep?: boolean } = {},
): Promise<{ janitor: CompetitionEnvironmentJanitor; adapter: CompetitionEnvironmentResourceAdapter; leaseId: string }> {
  const janitor = new CompetitionEnvironmentJanitor({
    api,
    ledgerPath: join(root, "environment-ledger.json"),
    pollMs: 10,
    ...options,
  });
  const reservation = await janitor.acquireForChallenge("RUN-MATRIX", "CH-MATRIX");
  if (api.inspection.idempotencyKey === "proofblade-env-matrix") api.inspection.idempotencyKey = reservation.idempotencyKey;
  const record = await janitor.register(reservation, "CH-MATRIX", {
    instanceId: "INST-MATRIX",
    idempotencyKey: reservation.idempotencyKey,
    connectionInfo: "nc target 9001",
    expiresAt: 10,
  });
  assert.ok(record);
  return { janitor, adapter: new CompetitionEnvironmentResourceAdapter(janitor), leaseId: record.leaseId };
}

test("[contract:platform-remote-query-matrix] maps exact, absent, unknown, and mismatched identities fail-closed", async () => {
  const cases: Array<{ name: string; inspection: CompetitionEnvironmentInspection; status: "PRESENT" | "ABSENT" | "UNKNOWN"; binding: "MATCH" | "MISMATCH" | "UNKNOWN" }> = [
    { name: "exact", inspection: { status: "ACTIVE", challengeId: "CH-MATRIX", instanceId: "INST-MATRIX", idempotencyKey: "proofblade-env-matrix" }, status: "PRESENT", binding: "MATCH" },
    { name: "absent", inspection: { status: "ABSENT", challengeId: "CH-MATRIX" }, status: "ABSENT", binding: "UNKNOWN" },
    { name: "pending", inspection: { status: "UNKNOWN", challengeId: "CH-MATRIX", summary: "building" }, status: "UNKNOWN", binding: "UNKNOWN" },
    { name: "missing challenge", inspection: { status: "ACTIVE", instanceId: "INST-MATRIX", idempotencyKey: "proofblade-env-matrix" }, status: "UNKNOWN", binding: "UNKNOWN" },
    { name: "foreign challenge", inspection: { status: "ACTIVE", challengeId: "CH-FOREIGN", instanceId: "INST-MATRIX", idempotencyKey: "proofblade-env-matrix" }, status: "PRESENT", binding: "MISMATCH" },
    { name: "foreign instance", inspection: { status: "ACTIVE", challengeId: "CH-MATRIX", instanceId: "INST-FOREIGN", idempotencyKey: "proofblade-env-matrix" }, status: "PRESENT", binding: "MISMATCH" },
    { name: "missing instance", inspection: { status: "ACTIVE", challengeId: "CH-MATRIX", idempotencyKey: "proofblade-env-matrix" }, status: "PRESENT", binding: "MATCH" },
    { name: "foreign key", inspection: { status: "ACTIVE", challengeId: "CH-MATRIX", instanceId: "INST-MATRIX", idempotencyKey: "foreign-key" }, status: "PRESENT", binding: "MISMATCH" },
    { name: "missing key", inspection: { status: "ACTIVE", challengeId: "CH-MATRIX", instanceId: "INST-MATRIX" }, status: "UNKNOWN", binding: "UNKNOWN" },
  ];

  for (const item of cases) {
    const root = await mkdtemp(join(tmpdir(), `proofblade-remote-query-${item.name.replaceAll(" ", "-")}-`));
    try {
      const api = new RemoteMatrixApi();
      api.inspection = item.inspection;
      const { adapter, leaseId } = await createManaged(root, api);
      const observed = await adapter.inspect(resource(leaseId));
      assert.equal(observed.status, item.status, item.name);
      assert.equal(observed.binding, item.binding, item.name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("[contract:platform-remote-query-sweep] automatic expiry stops only exact remote matches", async () => {
  const exactRoot = await mkdtemp(join(tmpdir(), "proofblade-remote-sweep-exact-"));
  const absentRoot = await mkdtemp(join(tmpdir(), "proofblade-remote-sweep-absent-"));
  const unknownRoot = await mkdtemp(join(tmpdir(), "proofblade-remote-sweep-unknown-"));
  try {
    const exactApi = new RemoteMatrixApi();
    const exact = await createManaged(exactRoot, exactApi, { requireRemoteInspectionForSweep: true });
    assert.deepEqual(await exact.janitor.sweepExpired(10), { examined: 1, stopped: 1, failed: 0, retained: 0 });
    assert.deepEqual(exactApi.stopped, [{ challengeId: "CH-MATRIX", instanceId: "INST-MATRIX" }]);

    const absentApi = new RemoteMatrixApi();
    absentApi.inspection = { status: "ABSENT", challengeId: "CH-MATRIX" };
    const absent = await createManaged(absentRoot, absentApi, { requireRemoteInspectionForSweep: true });
    assert.deepEqual(await absent.janitor.sweepExpired(10), { examined: 1, stopped: 1, failed: 0, retained: 0 });
    assert.deepEqual(absentApi.stopped, []);

    const unknownApi = new RemoteMatrixApi();
    unknownApi.inspection = { status: "UNKNOWN", challengeId: "CH-MATRIX", summary: "query timeout" };
    const unknown = await createManaged(unknownRoot, unknownApi, { requireRemoteInspectionForSweep: true });
    const unknownKey = (await unknown.janitor.active())[0]?.idempotencyKey;
    assert.deepEqual(await unknown.janitor.sweepExpired(10), { examined: 1, stopped: 0, failed: 1, retained: 1 });
    assert.deepEqual(unknownApi.stopped, []);
    unknownApi.inspection = { status: "ACTIVE", challengeId: "CH-MATRIX", instanceId: "INST-MATRIX", idempotencyKey: unknownKey };
    assert.deepEqual(await unknown.janitor.sweepExpired(10), { examined: 1, stopped: 1, failed: 0, retained: 0 });
    assert.deepEqual(unknownApi.stopped, [{ challengeId: "CH-MATRIX", instanceId: "INST-MATRIX" }]);
  } finally {
    await Promise.all([exactRoot, absentRoot, unknownRoot].map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("[contract:platform-identity-capability] only a declared stable remote identity can be adopted", async () => {
  const instanceRoot = await mkdtemp(join(tmpdir(), "proofblade-identity-instance-"));
  const keyRoot = await mkdtemp(join(tmpdir(), "proofblade-identity-key-"));
  const challengeRoot = await mkdtemp(join(tmpdir(), "proofblade-identity-challenge-"));
  try {
    const instanceApi = new RemoteMatrixApi();
    instanceApi.environmentIdentity = { strategy: "instance-id", stableAcrossRestart: true };
    instanceApi.inspection = { status: "ACTIVE", challengeId: "CH-MATRIX", instanceId: "INST-MATRIX" };
    const instance = await createManaged(instanceRoot, instanceApi);
    assert.equal((await instance.adapter.inspect(resource(instance.leaseId))).binding, "MATCH");

    const keyApi = new RemoteMatrixApi();
    keyApi.environmentIdentity = { strategy: "idempotency-key", stableAcrossRestart: true };
    keyApi.inspection = { status: "ACTIVE", challengeId: "CH-MATRIX", idempotencyKey: "proofblade-env-matrix" };
    const key = await createManaged(keyRoot, keyApi);
    assert.equal((await key.adapter.inspect(resource(key.leaseId))).binding, "MATCH");

    const challengeApi = new RemoteMatrixApi();
    challengeApi.environmentIdentity = { strategy: "challenge-only", stableAcrossRestart: false };
    const challenge = await createManaged(challengeRoot, challengeApi);
    const observation = await challenge.adapter.inspect(resource(challenge.leaseId));
    assert.deepEqual(observation, {
      status: "UNKNOWN",
      binding: "UNKNOWN",
      summary: "platform query did not prove the recorded stable environment identity",
    });
  } finally {
    await Promise.all([instanceRoot, keyRoot, challengeRoot].map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("[contract:platform-identity-capability] undocumented remote fields remain unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-identity-undocumented-"));
  try {
    const api = new RemoteMatrixApi();
    api.environmentIdentity = undefined;
    const { adapter, leaseId } = await createManaged(root, api);
    const observation = await adapter.inspect(resource(leaseId));
    assert.deepEqual(observation, { status: "UNKNOWN", binding: "UNKNOWN", summary: "platform query did not prove the recorded stable environment identity" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:platform-remote-query-recovery] STARTING adoption requires both exact key and challenge", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-remote-recovery-"));
  try {
    const ledgerPath = join(root, "environment-ledger.json");
    const api = new RemoteMatrixApi();
    const first = new CompetitionEnvironmentJanitor({ api, ledgerPath, pollMs: 10 });
    const reservation = await first.acquireForChallenge("RUN-MATRIX", "CH-MATRIX");
    await first.markStarting(reservation);

    api.inspection = { status: "ACTIVE", instanceId: "INST-MATRIX", idempotencyKey: reservation.idempotencyKey };
    const missingChallenge = new CompetitionEnvironmentJanitor({ api, ledgerPath, pollMs: 10 });
    assert.deepEqual(await missingChallenge.reconcilePending(), { examined: 1, adopted: 0, unknown: 1 });
    assert.deepEqual(await missingChallenge.active(), []);

    api.inspection = { status: "ACTIVE", challengeId: "CH-FOREIGN", instanceId: "INST-MATRIX", idempotencyKey: reservation.idempotencyKey };
    const foreignChallenge = new CompetitionEnvironmentJanitor({ api, ledgerPath, pollMs: 10 });
    assert.deepEqual(await foreignChallenge.reconcilePending(), { examined: 1, adopted: 0, unknown: 1 });
    assert.deepEqual(await foreignChallenge.active(), []);

    api.inspection = { status: "ACTIVE", challengeId: "CH-MATRIX", instanceId: "INST-MATRIX", idempotencyKey: reservation.idempotencyKey, connectionInfo: "nc target 9001" };
    const exact = new CompetitionEnvironmentJanitor({ api, ledgerPath, pollMs: 10 });
    assert.deepEqual(await exact.reconcilePending(), { examined: 1, adopted: 1, unknown: 0 });
    assert.equal((await exact.active())[0]?.idempotencyKey, reservation.idempotencyKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:platform-remote-query-release] remote absence releases both ledgers without a second stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-remote-release-"));
  try {
    const api = new RemoteMatrixApi();
    api.inspection = { status: "ABSENT", challengeId: "CH-MATRIX" };
    const { janitor, adapter, leaseId } = await createManaged(root, api);
    const external = new ExternalResourceRegistry(join(root, "external-resources.json"));
    await external.register({ id: `platform:${leaseId}`, kind: "platform-environment", runId: "RUN-MATRIX", generation: 0, ownerLane: "executor", externalId: "INST-MATRIX", requestKey: "proofblade-env-matrix" });
    await external.markStarted(`platform:${leaseId}`, "INST-MATRIX");
    await external.markConfirmed(`platform:${leaseId}`, "ready");
    assert.equal(await external.release(`platform:${leaseId}`, adapter, "remote absent"), true);
    assert.deepEqual(api.stopped, []);
    assert.deepEqual(await janitor.active(), []);
    assert.equal((await external.get(`platform:${leaseId}`))?.state, "RELEASED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
