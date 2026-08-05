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
