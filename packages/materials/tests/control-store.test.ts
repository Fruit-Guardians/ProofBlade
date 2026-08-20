import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlStore } from "../src/control/control-store.js";
import { projectionHash } from "../src/control/reducer.js";
import { demoTask } from "../src/app/demo.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";
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
    const runId = "TEST-001";
    await control.createRun(runId, demoTask(runId, root, config));
    await control.dispatch(runId, { type: "start_phase", phase: "reconnaissance" });
    await control.dispatch(runId, { type: "start_phase", phase: "hypothesis" });
    await control.dispatch(runId, { type: "start_phase", phase: "experiment" });
    await control.dispatch(runId, { type: "start_phase", phase: "verification" });
    await assert.rejects(
      control.dispatch(runId, { type: "finish", verified: true, evidenceIds: [], reason: "missing evidence" }),
      /verifier lane/,
    );
    const before = await control.snapshot(runId);
    assert.equal(before.status, "VERIFYING");
    await control.dispatch(runId, {
      type: "evidence",
      evidence: { id: "EV-001", kind: "reproduction", summary: "verified", source: { generation: 1 }, confidence: 1, supports: ["F-001"], refutes: [] },
    });
    await control.dispatch(runId, {
      type: "evidence",
      evidence: { id: "EV-002", kind: "reproduction", summary: "verified again", source: { generation: 1 }, confidence: 1, supports: ["F-001"], refutes: [] },
      lane: "verifier",
    });
    await control.dispatch(runId, {
      type: "fact",
      fact: { id: "F-001", statement: "candidate verified", status: "CONFIRMED", evidenceIds: ["EV-001", "EV-002"] },
      lane: "verifier",
    });
    await control.dispatch(runId, {
      type: "artifact",
      artifact: {
        id: "A-001",
        path: "artifacts/candidate.txt",
        sha256: "candidate-hash",
        bytes: 4,
        mime: "text/plain",
        sensitivity: "flag_candidate",
        semantic: { name: "候选输出", summary: "待验证的候选输出。", tags: ["candidate"], role: "intermediate", relatedIds: [], annotatedBy: "harness", updatedSeq: 0 },
      },
    });
    const registeredSeq = (await control.snapshot(runId)).artifacts["A-001"]!.semantic!.updatedSeq;
    assert.ok(registeredSeq > 0);
    await control.dispatch(runId, {
      type: "artifact_annotation",
      artifactId: "A-001",
      semantic: { name: "已验证候选输出", summary: "候选已由复现证据确认。", tags: ["candidate", "verified"], role: "result", relatedIds: ["EV-001"], annotatedBy: "agent" },
    });
    const annotated = (await control.snapshot(runId)).artifacts["A-001"]!.semantic!;
    assert.equal(annotated.name, "已验证候选输出");
    assert.ok(annotated.updatedSeq > registeredSeq);
    await control.dispatch(runId, { type: "completion_proposed", completion: { id: "C-001", candidateHash: "candidate-hash", artifactId: "A-001" }, lane: "executor" });
    await control.dispatch(runId, { type: "completion_verified", completionId: "C-001", accepted: true, evidenceIds: ["EV-001", "EV-002"], lane: "verifier" });
    await control.dispatch(runId, { type: "finish", verified: true, evidenceIds: ["EV-001", "EV-002"], reason: "verified", lane: "verifier" });
    const replayed = await control.replay(runId);
    const persisted = await events.loadProjection(runId);
    assert.equal(replayed.status, "SUCCEEDED");
    assert.equal(replayed.artifacts["A-001"]?.semantic?.name, "已验证候选输出");
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
