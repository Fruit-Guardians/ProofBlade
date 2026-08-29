import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices, demoTask } from "../src/app/demo.js";
import { createProtocolReplay, createToolReplay, replayProtocol, replayStats, replayTool, compareReplayStats, shadowReplay } from "../src/evaluation/replay.js";
import type { HarnessEvent } from "../src/domain/types.js";

function event(seq: number, type: HarnessEvent["type"], payload: Record<string, unknown>): HarnessEvent {
  return {
    schemaVersion: 1,
    id: `RUN-E${String(seq).padStart(6, "0")}`,
    streamId: "RUN",
    runId: "RUN",
    lane: "executor",
    seq,
    ts: new Date(1_700_000_000_000 + seq * 1_000).toISOString(),
    correlationId: "test",
    actor: "tool",
    type,
    payload,
  };
}

test("protocol replay rebuilds the same projection without a ControlStore", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-replay-"));
  try {
    const services = createServices(root, { schemaVersion: 1, runtime: { piVersion: "0.83.0" }, storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" }, modelProfiles: { executor: { thinkingLevel: "off" } } } as never);
    const task = demoTask("RUN", root, { schemaVersion: 1, runtime: { piVersion: "0.83.0" }, storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" }, modelProfiles: { executor: { thinkingLevel: "off" } } } as never);
    await services.control.createRun("RUN", task);
    const snapshot = await services.control.snapshot("RUN");
    const tape = createProtocolReplay(await services.control.events("RUN"), snapshot);
    assert.deepEqual(replayProtocol(tape, task), snapshot);
    assert.throws(() => replayProtocol({ ...tape, hash: "0".repeat(64) }, task), /hash mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Tool Replay preserves pair order, pending calls, references, and errors", () => {
  const tape = createToolReplay([
    event(1, "tool_call_recorded", { toolCallId: "call-1", toolName: "read" }),
    event(2, "tool_result_recorded", { toolCallId: "call-1", toolName: "read", isError: false, artifactId: "A-1", evidenceIds: ["E-1"] }),
    event(3, "tool_call_recorded", { toolCallId: "call-2", toolName: "grep" }),
    event(4, "tool_result_recorded", { toolCallId: "call-2", toolName: "grep", isError: true, artifactId: "A-2" }),
    event(5, "tool_call_recorded", { toolCallId: "call-3", toolName: "read" }),
  ]);
  const replay = replayTool(tape);
  assert.equal(replay.completed, 2);
  assert.deepEqual(replay.pending, ["call-3"]);
  assert.equal(replay.errors, 1);
  assert.deepEqual(replay.artifactIds, ["A-1", "A-2"]);
  assert.deepEqual(replay.evidenceIds, ["E-1"]);
  assert.throws(() => replayTool({ ...tape, hash: "0".repeat(64) }), /hash mismatch/);
});

test("replay stats counts plaintext leaks, not hash-bound candidate references", () => {
  const safe = [event(1, "effect_proposed", {
    candidateHash: "a".repeat(64),
    candidateArtifactId: "A-1",
    candidatePath: "D:\\\\runs\\\\A-1-candidate.txt",
  })];
  const leaked = event(2, "tool_result_recorded", { toolCallId: "call-1", content: "PB{plaintext-leak}" });
  assert.equal(replayStats([...safe, leaked]).candidateLeakCount, 1);
  assert.equal(replayStats(safe).candidateLeakCount, 0);
});

test("shadow and ablation comparisons are pure and expose operational deltas", () => {
  const events = [
    event(1, "run_finished", { status: "SUCCEEDED" }),
    event(2, "provider_request_started", { requestId: "R-1" }),
    event(3, "model_usage", { usage: { cacheRead: 7, cost: { total: 0.02 } } }),
    event(4, "tool_call_recorded", { toolCallId: "call-1", toolName: "read" }),
    event(5, "tool_result_recorded", { toolCallId: "call-1", toolName: "read", isError: true }),
    event(6, "evidence_added", { evidenceId: "E-1" }),
  ];
  const before = JSON.stringify(events);
  const baseline = replayStats(events);
  const candidate = shadowReplay(events, ["tool_result_recorded"]);
  const comparison = compareReplayStats(baseline, candidate, "ablation");
  assert.equal(comparison.sideEffectFree, true);
  assert.equal(comparison.candidate.toolErrorCount, 0);
  assert.equal(comparison.baseline.costUsd, 0.02);
  assert.equal(comparison.baseline.cacheReadTokens, 7);
  assert.equal(JSON.stringify(events), before);
});
