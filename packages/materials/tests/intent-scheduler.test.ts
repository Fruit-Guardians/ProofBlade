import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createServices, demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { IntentScheduler } from "../src/orchestration/intent-scheduler.js";
import { LeaseManager } from "../src/control/lease-manager.js";
import type { SchedulingContext } from "../src/domain/intent.js";

const config = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: { executor: { thinkingLevel: "off" } },
} as unknown as ProofBladeConfig;

function context(runId: string, overrides: Partial<SchedulingContext> = {}): SchedulingContext {
  return {
    runId,
    phase: "reconnaissance",
    knowledgeVersion: 0,
    currentGeneration: 0,
    facts: [],
    hypotheses: [],
    evidence: [],
    openIntents: 0,
    newHighValueFacts: 0,
    consecutiveFailures: 0,
    phaseBudgetUsed: 0,
    newHints: [],
    verifierRejected: false,
    remainingBudget: { tokens: 100_000, costUsd: 10, timeMs: 600_000 },
    occupiedResources: [],
    ...overrides,
  };
}

async function setup(prefix: string) {
  const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), prefix));
  const services = createServices(root, config);
  const runId = `INTENT-${prefix.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}`;
  await services.control.createRun(runId, demoTask(runId, root, config));
  return { root, services, runId, scheduler: new IntentScheduler(services.control, new LeaseManager(services.control)) };
}

test("fresh run schedules one claimed exploration intent and persists its leases", async () => {
  const { root, services, runId, scheduler } = await setup("pb-intent-fresh-");
  try {
    const claimed = await scheduler.schedule(context(runId));
    assert.ok(claimed);
    assert.equal(claimed.status, "CLAIMED");
    const snapshot = await services.control.snapshot(runId);
    assert.equal(snapshot.schedulerIntents[claimed.id]?.status, "CLAIMED");
    assert.equal(Object.keys(snapshot.leases).length, claimed.resourceKeys.length);
    assert.deepEqual(Object.keys((await services.control.replay(runId)).schedulerIntents), Object.keys(snapshot.schedulerIntents));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completed intent releases only its matching lease epoch", async () => {
  const { root, services, runId, scheduler } = await setup("pb-intent-complete-");
  try {
    const claimed = await scheduler.schedule(context(runId));
    assert.ok(claimed);
    await scheduler.completeIntent(runId, claimed.id, { producedObservations: ["O-1"] });
    const snapshot = await services.control.snapshot(runId);
    assert.equal(snapshot.schedulerIntents[claimed.id]?.status, "COMPLETED");
    assert.deepEqual(snapshot.leases, {});
    await scheduler.completeIntent(runId, claimed.id, {});
    assert.equal((await services.control.snapshot(runId)).schedulerIntents[claimed.id]?.status, "COMPLETED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture reset stales old scheduler intents and permits a new generation", async () => {
  const { root, services, runId, scheduler } = await setup("pb-intent-reset-");
  try {
    const claimed = await scheduler.schedule(context(runId));
    assert.ok(claimed);
    await services.fixtureControl.reset(runId, 1);
    const afterReset = await services.control.snapshot(runId);
    assert.equal(afterReset.schedulerIntents[claimed.id]?.status, "STALE");
    assert.deepEqual(afterReset.leases, {});
    const next = await scheduler.schedule(context(runId, { currentGeneration: 1 }));
    assert.ok(next);
    assert.equal(next.fixtureGeneration, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scheduler config changes scoring weights without changing the durable control schema", async () => {
  const { root, services, runId } = await setup("pb-intent-config-");
  try {
    const scheduler = new IntentScheduler(services.control, new LeaseManager(services.control), {
      maxOpenIntents: 2,
      maxAttemptsPerIntent: 2,
      scoringWeights: { novelty: 2.5, cost: -3 },
    });
    assert.equal(scheduler.getScoringWeights().novelty, 2.5);
    assert.equal(scheduler.getScoringWeights().cost, -3);
    const first = await scheduler.schedule(context(runId, { newHighValueFacts: 1, facts: ["F-1"] }));
    assert.ok(first);
    const snapshot = await services.control.snapshot(runId);
    assert.equal(Object.values(snapshot.schedulerIntents).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
