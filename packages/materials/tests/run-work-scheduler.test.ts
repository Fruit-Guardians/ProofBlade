import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices, demoTask } from "../src/app/demo.js";
import { claimCompetitionWorkItem } from "../src/competition/loop.js";
import type { ProofBladeConfig } from "../src/config.js";
import type { Intent as SchedulerIntent } from "../src/domain/intent.js";
import { projectionHash } from "../src/control/reducer.js";
import { RunWorkScheduler } from "../src/orchestration/run-work-scheduler.js";
import { phaseBudget } from "../src/domain/phase-budget.js";
import { ExperimentGate } from "../src/competition/experiment-gate.js";
import { canonicalJson, sha256 } from "../src/domain/utils.js";

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

function intent(runId: string): SchedulerIntent {
  return {
    id: "SI-SHARED-001",
    status: "CLAIMED",
    priority: "high",
    createdAt: new Date().toISOString(),
    knowledgeVersion: 0,
    fixtureGeneration: 0,
    phase: "reconnaissance",
    objective: "Inspect the bounded target and preserve one durable observation.",
    startFromFacts: [],
    expectedEvidence: { kind: "observation", description: "A target observation", minimumConfidence: "medium" },
    suggestedTools: ["read"],
    estimatedCost: 100,
    estimatedDuration: 1000,
    resourceKeys: [],
    dependencies: [],
    claimedBy: "executor",
    attempts: 1,
  };
}

test("the shared scheduler links policy intent to one replayable executor work item", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-shared-work-"));
  try {
    const services = createServices(root, config);
    const runId = "SHARED-WORK-001";
    const task = demoTask(runId, root, config);
    await services.control.createRun(runId, task);
    const scheduler = new RunWorkScheduler(services.control);
    const selected = intent(runId);
    const claimed = await scheduler.claim(runId, task, 1, selected);

    assert.equal(claimed.schedulerIntentId, selected.id);
    assert.equal(claimed.status, "RUNNING");
    assert.equal(claimed.attempt, 1);

    await scheduler.complete(runId, claimed.id);
    const snapshot = await services.control.snapshot(runId);
    const replayed = await services.control.replay(runId);
    assert.equal(snapshot.workItems[claimed.id]?.status, "SUCCEEDED");
    assert.equal(projectionHash(replayed), projectionHash(snapshot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("competition compatibility entrypoint shares recovery and does not create a duplicate item", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-shared-recovery-"));
  try {
    const services = createServices(root, config);
    const runId = "SHARED-WORK-002";
    const task = demoTask(runId, root, config);
    await services.control.createRun(runId, task);
    const scheduler = new RunWorkScheduler(services.control);
    const claimed = await scheduler.claim(runId, task, 1);
    await services.control.dispatch(runId, {
      type: "work_item_failed",
      workItemId: claimed.id,
      reason: "test failure",
      lane: "executor",
    });

    const compatibilityClaim = await claimCompetitionWorkItem(services.control, runId, task, 2);
    const snapshot = await services.control.snapshot(runId);
    const recovered = snapshot.workItems[compatibilityClaim];
    assert.equal(recovered?.status, "RUNNING");
    assert.equal(recovered?.parentId, claimed.id);
    assert.equal(Object.keys(snapshot.workItems).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replans are atomically linked to the blocked item and survive replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-replan-ledger-"));
  try {
    const services = createServices(root, config);
    const runId = "REPLAN-LEDGER-001";
    const task = { ...demoTask(runId, root, config), target_kind: "pwn" as const };
    await services.control.createRun(runId, task);
    const scheduler = new RunWorkScheduler(services.control);
    const first = await scheduler.claim(runId, task, 1);
    await scheduler.blockAndQueue(runId, task, first.id, "repeated tool failure", "bad_tool_args");

    const snapshot = await services.control.snapshot(runId);
    const record = Object.values(snapshot.replans)[0];
    assert.equal(snapshot.replanCount, 1);
    assert.equal(record?.sourceWorkItemId, first.id);
    assert.equal(snapshot.workItems[first.id]?.status, "BLOCKED");
    assert.equal(snapshot.workItems[record?.nextWorkItemId ?? ""]?.status, "READY");
    assert.equal(phaseBudget(snapshot).replansRemaining, 1);
    assert.equal(projectionHash(snapshot), projectionHash(await services.control.replay(runId)));
    assert.equal((await services.control.events(runId)).filter((event) => event.type === "replan_requested").length, 1);

    const next = await scheduler.claim(runId, task, 2);
    await scheduler.blockAndQueue(runId, task, next.id, "second repeated tool failure", "bad_tool_args");
    const final = await scheduler.claim(runId, task, 3);
    await scheduler.blockAndQueue(runId, task, final.id, "third repeated tool failure", "bad_tool_args");
    const exhausted = await services.control.snapshot(runId);
    assert.equal(exhausted.status, "EXHAUSTED");
    assert.equal(exhausted.replanCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("phase action bundles retain over-budget experiments as planning telemetry", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-phase-budget-"));
  try {
    const services = createServices(root, config);
    const runId = "PHASE-BUDGET-001";
    const task = { ...demoTask(runId, root, config), target_kind: "web" as const };
    await services.control.createRun(runId, task);
    await services.control.dispatch(runId, { type: "set_domain_phase", domainPhase: "EXPERIMENT", lane: "executor" });
    const unsigned = {
      schemaVersion: 1 as const,
      generation: 0,
      profileId: "web",
      targetKind: "web" as const,
      runtime: "host" as const,
      runtimeKey: "host",
      cacheKey: "phase-budget-test",
      toolCatalogHash: "tools",
      mcpCatalogHash: "mcp",
      checkedAt: Date.now(),
      health: "ready" as const,
      tools: [],
      mcpServers: [],
      missingRequiredTools: [],
      missingOptionalTools: [],
      fallbackStrategies: [],
      actionBundles: [{ id: "experiment", domainPhase: "EXPERIMENT" as const, objective: "one probe", toolNames: ["web_request"], capabilityIds: ["web.http-session"], preconditions: ["target scoped"], successCriteria: ["response recorded"], failureCriteria: ["timeout"], maxCalls: 1 }],
    };
    await services.control.dispatch(runId, { type: "record_tool_preparation", preparation: { ...unsigned, hash: sha256(canonicalJson(unsigned)) }, lane: "executor" });
    const gate = new ExperimentGate(services.control);
    await gate.record({ runId, action: "one", input: { id: 1 }, outcome: "failure", summary: "one probe" });
    await gate.record({ runId, action: "two", input: { id: 2 }, outcome: "failure", summary: "second probe" });
    const snapshot = await services.control.snapshot(runId);
    assert.equal(phaseBudget(snapshot).phaseActionsUsed, 2);
    assert.equal(phaseBudget(snapshot).phaseActionsRemaining, 0);
    assert.equal(phaseBudget(snapshot).exhausted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
