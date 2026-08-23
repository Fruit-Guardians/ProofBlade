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
