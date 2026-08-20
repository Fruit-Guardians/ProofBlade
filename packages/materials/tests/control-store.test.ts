import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlStore } from "../src/control/control-store.js";
import { projectionHash } from "../src/control/reducer.js";
import { demoTask, runDemo } from "../src/app/demo.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";
import { claimCompetitionWorkItem } from "../src/competition/loop.js";
import type { ProofBladeConfig } from "../src/config.js";

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

test("control store replay is deterministic and verifier gated", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-control-"));
  try {
    const events = new JsonlControlStore(join(root, "runs"));
    const control = new ControlStore(events);
    const forgedRunId = "TEST-FORGED";
    await control.createRun(forgedRunId, demoTask(forgedRunId, root, config));
    await assert.rejects(
      control.dispatch(forgedRunId, {
        type: "evidence",
        evidence: { id: "EV-FORGED", kind: "reproduction", summary: "forged", source: { generation: 0 }, confidence: 1, supports: [], refutes: [] },
        lane: "verifier",
      }),
      /trusted verifier service/,
    );
    assert.equal(Object.keys((await control.snapshot(forgedRunId)).evidence).length, 0);

    const runId = "TEST-001";
    await runDemo(root, runId, config);
    const replayed = await control.replay(runId);
    const persisted = await events.loadProjection(runId);
    assert.equal(replayed.status, "SUCCEEDED");
    assert.equal(replayed.finalResult?.completionId, "C-001");
    assert.equal(replayed.finalResult?.evidenceIds.length, 2);
    assert.equal(replayed.finalResult?.candidateHash, replayed.completions["C-001"]?.candidateHash);
    assert.equal(projectionHash(replayed), projectionHash(persisted!));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("phase transitions do not implicitly resume a paused run", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-paused-phase-"));
  try {
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const runId = "PAUSED-PHASE-001";
    await control.createRun(runId, demoTask(runId, root, config));
    await control.dispatch(runId, { type: "start_phase", phase: "reconnaissance" });
    await control.dispatch(runId, { type: "pause", reason: "test pause" });
    await control.dispatch(runId, { type: "start_phase", phase: "hypothesis" });
    assert.equal((await control.snapshot(runId)).status, "PAUSED");
    await control.dispatch(runId, { type: "resume" });
    assert.equal((await control.snapshot(runId)).status, "RUNNING");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("paused runs reject every terminal command until explicitly resumed", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-paused-terminal-"));
  try {
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const runId = "PAUSED-TERMINAL-001";
    await control.createRun(runId, demoTask(runId, root, config));
    await control.dispatch(runId, { type: "pause", reason: "test terminal policy" });
    await assert.rejects(control.dispatch(runId, { type: "exhaust", reason: "late budget result" }), /paused run; resume it first/);
    await assert.rejects(control.dispatch(runId, { type: "fail", reason: "late failure", category: "unknown" }), /paused run; resume it first/);
    await assert.rejects(control.dispatch(runId, { type: "finish", verified: false, evidenceIds: [], reason: "late finish" }), /paused run; resume it first/);
    assert.equal((await control.snapshot(runId)).status, "PAUSED");
    await control.dispatch(runId, { type: "resume" });
    await control.dispatch(runId, { type: "exhaust", reason: "explicitly resumed" });
    assert.equal((await control.snapshot(runId)).status, "EXHAUSTED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("work graph lifecycle is durable, lease-gated, and replayable", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-work-graph-"));
  try {
    const events = new JsonlControlStore(join(root, "runs"));
    const control = new ControlStore(events);
    const runId = "WORK-GRAPH-001";
    await control.createRun(runId, demoTask(runId, root, config));
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await control.dispatch(runId, {
      type: "work_item_created",
      workItem: { id: "WI-ROOT", runId, title: "Capture target", objective: "Collect one bounded target observation.", role: "executor", status: "READY", dependsOn: [], evidenceIds: [], artifactIds: [], attempt: 0, maxAttempts: 3 },
      lane: "planner",
    });
    await control.dispatch(runId, { type: "work_item_claimed", workItemId: "WI-ROOT", ownerLane: "executor", leaseExpiresAt: expiresAt, lane: "executor" });
    await assert.rejects(
      control.dispatch(runId, { type: "work_item_claimed", workItemId: "WI-ROOT", ownerLane: "verifier", leaseExpiresAt: expiresAt, lane: "verifier" }),
      /lease is still active|ownership mismatch/,
    );
    await control.dispatchBatch(runId, [
      { type: "work_item_blocked", workItemId: "WI-ROOT", reason: "The first probe made no progress.", lane: "executor" },
      { type: "work_item_created", workItem: { id: "WI-REPLAN", runId, parentId: "WI-ROOT", title: "Try an alternative probe", objective: "Use a different bounded observation.", role: "executor", status: "READY", dependsOn: [], evidenceIds: [], artifactIds: [], attempt: 0, maxAttempts: 2 }, lane: "executor" },
    ]);
    await control.dispatch(runId, { type: "work_item_claimed", workItemId: "WI-REPLAN", ownerLane: "executor", leaseExpiresAt: expiresAt, lane: "executor" });
    await control.dispatch(runId, { type: "work_item_completed", workItemId: "WI-REPLAN", lane: "executor" });
    const snapshot = await control.replay(runId);
    assert.equal(snapshot.workItems["WI-ROOT"]?.status, "BLOCKED");
    assert.equal(snapshot.workItems["WI-REPLAN"]?.status, "SUCCEEDED");
    assert.equal(snapshot.workItems["WI-REPLAN"]?.attempt, 1);
    assert.equal(projectionHash(snapshot), projectionHash((await events.loadProjection(runId))!));
    assert.ok((await control.events(runId)).some((event) => event.type === "work_item_blocked"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a crashed executor's expired RUNNING work item is reclaimed, not orphaned", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-expired-claim-"));
  try {
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const runId = "EXPIRED-CLAIM-001";
    const task = demoTask(runId, root, config);
    await control.createRun(runId, task);
    // A prior owner claimed WI-CRASH with a lease that has already expired, then
    // the process died leaving it RUNNING.
    await control.dispatch(runId, {
      type: "work_item_created",
      workItem: { id: "WI-CRASH", runId, title: "Investigate", objective: task.objective, role: "executor", status: "READY", dependsOn: [], evidenceIds: [], artifactIds: [], attempt: 0, maxAttempts: 3 },
      lane: "planner",
    });
    await control.dispatch(runId, { type: "work_item_claimed", workItemId: "WI-CRASH", ownerLane: "executor", leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(), lane: "executor" });
    const before = await control.snapshot(runId);
    assert.equal(before.workItems["WI-CRASH"]?.status, "RUNNING");
    assert.equal(before.workItems["WI-CRASH"]?.attempt, 1);

    // Recovery: the next turn must reuse the same item, not spawn a duplicate.
    const claimedId = await claimCompetitionWorkItem(control, runId, task, 2);
    assert.equal(claimedId, "WI-CRASH", "must reclaim the orphaned RUNNING item");
    const after = await control.snapshot(runId);
    assert.equal(Object.keys(after.workItems).length, 1, "no duplicate work item created");
    assert.equal(after.workItems["WI-CRASH"]?.status, "RUNNING");
    assert.equal(after.workItems["WI-CRASH"]?.attempt, 2, "re-claim increments attempt so maxAttempts still bounds retries");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an expired RUNNING item is reclaimed before a READY item, so it is never starved", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-expired-priority-"));
  try {
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const runId = "EXPIRED-PRIORITY-001";
    const task = demoTask(runId, root, config);
    await control.createRun(runId, task);
    // WI-OLD: RUNNING with an expired lease (crashed owner). WI-NEW: READY.
    await control.dispatchBatch(runId, [
      { type: "work_item_created", workItem: { id: "WI-OLD", runId, title: "Old", objective: task.objective, role: "executor", status: "READY", dependsOn: [], evidenceIds: [], artifactIds: [], attempt: 0, maxAttempts: 3 }, lane: "planner" },
      { type: "work_item_created", workItem: { id: "WI-NEW", runId, title: "New", objective: task.objective, role: "executor", status: "READY", dependsOn: [], evidenceIds: [], artifactIds: [], attempt: 0, maxAttempts: 3 }, lane: "planner" },
    ]);
    await control.dispatch(runId, { type: "work_item_claimed", workItemId: "WI-OLD", ownerLane: "executor", leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(), lane: "executor" });

    // With both an expired RUNNING and a READY present, the expired one wins —
    // otherwise READY would be claimed and become active, permanently starving
    // WI-OLD (the active branch only ever returns valid-lease items).
    const claimed = await claimCompetitionWorkItem(control, runId, task, 2);
    assert.equal(claimed, "WI-OLD");
    const snap = await control.snapshot(runId);
    assert.equal(snap.workItems["WI-OLD"]?.status, "RUNNING");
    assert.equal(snap.workItems["WI-OLD"]?.attempt, 2);
    assert.equal(snap.workItems["WI-NEW"]?.status, "READY", "the READY item waits its turn, it is not lost");
    assert.equal(Object.keys(snap.workItems).length, 2, "no duplicate item created");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("multiple expired RUNNING items are recovered oldest-first across turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-expired-multi-"));
  try {
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const runId = "EXPIRED-MULTI-001";
    const task = demoTask(runId, root, config);
    await control.createRun(runId, task);
    const expired = new Date(Date.now() - 60_000).toISOString();
    for (const wid of ["WI-A", "WI-B"]) {
      await control.dispatch(runId, { type: "work_item_created", workItem: { id: wid, runId, title: wid, objective: task.objective, role: "executor", status: "READY", dependsOn: [], evidenceIds: [], artifactIds: [], attempt: 0, maxAttempts: 3 }, lane: "planner" });
      await control.dispatch(runId, { type: "work_item_claimed", workItemId: wid, ownerLane: "executor", leaseExpiresAt: expired, lane: "executor" });
    }
    // WI-A was claimed first (lower updatedSeq), so it is recovered first.
    const first = await claimCompetitionWorkItem(control, runId, task, 2);
    assert.equal(first, "WI-A");
    // Once WI-A finishes, the next turn must recover the other orphan, WI-B —
    // proving neither expired item is left stranded.
    await control.dispatch(runId, { type: "work_item_completed", workItemId: "WI-A", lane: "executor" });
    const second = await claimCompetitionWorkItem(control, runId, task, 3);
    assert.equal(second, "WI-B", "the second orphan is recovered, never stranded");
    assert.equal(Object.keys((await control.snapshot(runId)).workItems).length, 2, "no duplicates spawned");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("request epochs bind provider events and replay their context hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-request-epoch-"));
  try {
    const events = new JsonlControlStore(join(root, "runs"));
    const control = new ControlStore(events);
    const runId = "REQUEST-EPOCH-001";
    await control.createRun(runId, demoTask(runId, root, config));
    await control.dispatch(runId, {
      type: "request_epoch_started",
      epoch: {
        id: "RE-001",
        requestId: "PR-001",
        runId,
        lane: "executor",
        provider: "test-provider",
        model: "test-model",
        adapter: "openai-completions",
        contextWindow: 16_384,
        toolCatalogHash: "tools-v1",
        toolNames: ["inspect_target", "submit_candidate"],
        contextManifestHash: "context-v1",
        status: "STARTED",
        createdAt: new Date().toISOString(),
      },
      lane: "executor",
    });
    await control.append(runId, [{
      schemaVersion: 1,
      lane: "executor",
      correlationId: "provider-epoch",
      actor: "model",
      type: "request_epoch_context",
      payload: { requestEpochId: "RE-001", fields: { requestBodyHash: "body-v1", stablePrefixHash: "prefix-v1" } },
    }, {
      schemaVersion: 1,
      lane: "executor",
      correlationId: "provider-epoch",
      actor: "model",
      type: "provider_response_received",
      payload: { requestId: "PR-001", epochId: "RE-001", status: 200 },
    }, {
      schemaVersion: 1,
      lane: "executor",
      correlationId: "provider-epoch",
      actor: "model",
      type: "model_usage",
      payload: { requestId: "PR-001", epochId: "RE-001", finishReason: "stop" },
    }]);
    const snapshot = await control.replay(runId);
    const epoch = snapshot.requestEpochs["RE-001"]!;
    assert.equal(epoch.status, "COMPLETED");
    assert.equal(epoch.requestBodyHash, "body-v1");
    assert.equal(epoch.stablePrefixHash, "prefix-v1");
    assert.ok(epoch.createdSeq > 0);
    assert.ok(epoch.updatedSeq > epoch.createdSeq);
    assert.equal(projectionHash(snapshot), projectionHash((await events.loadProjection(runId))!));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatchBatch validates every command before persisting any event", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-atomic-batch-"));
  try {
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const runId = "ATOMIC-BATCH-001";
    await control.createRun(runId, demoTask(runId, root, config));
    const before = await control.snapshot(runId);
    const eventCount = (await control.events(runId)).length;
    await assert.rejects(control.dispatchBatch(runId, [
      {
        type: "artifact",
        generation: before.generation,
        artifact: { id: "A-BATCH", path: "artifacts/batch.txt", sha256: "batch-hash", bytes: 5, mime: "text/plain", sensitivity: "public" },
      },
      {
        type: "artifact_annotation",
        artifactId: "A-MISSING",
        semantic: { name: "invalid", summary: "must reject the entire batch", tags: [], role: "debug", relatedIds: [], annotatedBy: "agent" },
      },
    ]), /Unknown artifact A-MISSING/);
    const after = await control.snapshot(runId);
    assert.equal(after.artifacts["A-BATCH"], undefined);
    assert.equal(after.lastSeq, before.lastSeq);
    assert.equal((await control.events(runId)).length, eventCount);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
