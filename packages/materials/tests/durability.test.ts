import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "../src/config.js";
import { createServices, demoTask } from "../src/app/demo.js";
import { LeaseManager } from "../src/control/lease-manager.js";
import { LocalFixtureSandbox } from "../src/sandbox/fixture.js";
import type { EffectFaultPoint } from "../src/effects/effect-journal.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "TEST_API_KEY",
      contextWindow: 4096,
      maxTokens: 512,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      input: ["text"],
    },
  },
};

test("concurrent commands receive contiguous event sequences", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-writer-"));
  try {
    const runId = "WRITER-001";
    const services = createServices(root, config);
    await services.control.createRun(runId, demoTask(runId, root, config));
    await Promise.all(Array.from({ length: 16 }, (_, index) => services.control.dispatch(runId, {
      type: "intent",
      intent: { id: `I-${index}`, title: `Intent ${index}`, description: "concurrency test", phase: "intake", status: "OPEN", priority: index },
    })));
    const events = await services.control.events(runId);
    assert.deepEqual(events.map((event) => event.seq), Array.from({ length: 17 }, (_, index) => index + 1));
    assert.equal(Object.keys((await services.control.snapshot(runId)).intents).length, 16);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pure in-flight effect is rerun under the same effect id", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-reconcile-"));
  try {
    const runId = "RECOVER-001";
    const services = createServices(root, config);
    const task = demoTask(runId, root, config);
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.control.dispatch(runId, { type: "fixture_reset", generation });
    const effectId = "EF-RECOVER";
    await services.control.dispatch(runId, {
      type: "effect_proposed",
      effect: {
        id: effectId,
        idempotencyKey: "recover-key",
        replayPolicy: "pure",
        operation: "fixture_read",
        args: { path: "challenge.txt" },
        command: process.platform === "win32" ? "type challenge.txt" : "cat challenge.txt",
        cwd: fixture.path,
        status: "PROPOSED",
      },
      lane: "executor",
    });
    await services.control.dispatch(runId, { type: "effect_started", effectId, lane: "executor" });
    assert.deepEqual(await services.journal.reconcile(runId), [effectId]);
    const snapshot = await services.control.snapshot(runId);
    assert.equal(snapshot.effects[effectId]?.status, "FINISHED");
    assert.equal(snapshot.effects[effectId]?.outcome, "success");
    assert.ok(snapshot.effects[effectId]?.artifactId);
    assert.equal(Object.keys(snapshot.effects).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leases enforce ownership and fixture generation survives process state", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-lease-"));
  try {
    const runId = "LEASE-001";
    const services = createServices(root, config);
    const task = demoTask(runId, root, config);
    await services.control.createRun(runId, task);
    const leases = new LeaseManager(services.control);
    const lease = await leases.acquire(runId, "target:LEASE-001", "executor", 30_000);
    await assert.rejects(leases.acquire(runId, "target:LEASE-001", "main", 30_000), /leased by executor/);
    const heartbeat = await leases.heartbeat(runId, lease, 30_000);
    assert.equal(heartbeat.ownerLane, "executor");
    await leases.release(runId, heartbeat);
    assert.equal(Object.keys((await services.control.snapshot(runId)).leases).length, 0);

    const expired = await leases.acquire(runId, "workspace:epoch", "executor", 1);
    await leases.reapExpired(runId, Date.now() + 1_000);
    const replacement = await leases.acquire(runId, "workspace:epoch", "executor", 30_000);
    assert.equal(replacement.generation, expired.generation + 1);
    await assert.rejects(leases.release(runId, expired), /Lease ownership mismatch/);
    await leases.release(runId, replacement);

    const firstSandbox = new LocalFixtureSandbox(join(root, config.storage.fixturesDir));
    const fixture = await firstSandbox.build(task);
    const firstGeneration = await firstSandbox.reset(fixture);
    const secondSandbox = new LocalFixtureSandbox(join(root, config.storage.fixturesDir));
    const reopened = await secondSandbox.build(task);
    assert.equal(reopened.generation, firstGeneration);
    assert.equal(await secondSandbox.reset(reopened), firstGeneration + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const faultPoint of ["after_proposed", "after_started", "after_execute", "after_artifact"] as const satisfies readonly EffectFaultPoint[]) {
  test(`effect recovery converges after fault point ${faultPoint}`, async () => {
    const root = await mkdtemp(join(tmpdir(), `proofblade-${faultPoint}-`));
    try {
      let injected = false;
      const services = createServices(root, config, (point) => {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`injected:${point}`);
        }
      });
      const runId = `FAULT-${faultPoint}`;
      const task = demoTask(runId, root, config);
      await services.control.createRun(runId, task);
      const fixture = await services.sandbox.build(task);
      const generation = await services.sandbox.reset(fixture);
      await services.control.dispatch(runId, { type: "fixture_reset", generation });
      await assert.rejects(services.journal.execute(runId, {
        operation: "fixture_read",
        args: { path: "challenge.txt", faultPoint },
        replayPolicy: "pure",
        command: process.platform === "win32" ? "type challenge.txt" : "cat challenge.txt",
        cwd: fixture.path,
      }), new RegExp(`injected:${faultPoint}`));
      const before = await services.control.snapshot(runId);
      assert.equal(Object.keys(before.effects).length, 1);
      const effectId = Object.keys(before.effects)[0]!;
      assert.deepEqual(await services.journal.reconcile(runId), [effectId]);
      const after = await services.control.snapshot(runId);
      assert.equal(after.effects[effectId]?.status, "FINISHED");
      assert.equal(after.effects[effectId]?.outcome, "success");
      assert.equal(Object.keys(after.effects).length, 1);
      assert.equal(Object.values(after.artifacts).filter((artifact) => artifact.sourceEffectId === effectId).length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
