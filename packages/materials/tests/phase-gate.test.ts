import assert from "node:assert/strict";
import test from "node:test";
import { createInitialSnapshot } from "../src/control/reducer.js";
import { evaluatePhaseGate } from "../src/domain/phase-gate.js";
import type { ArtifactRef, CompletionProposal, Effect, Evidence, WorkItem } from "../src/domain/types.js";
import { demoTask } from "../src/app/demo.js";

function snapshot() {
  return createInitialSnapshot("PHASE-GATE-001", demoTask("PHASE-GATE-001", "/workspace", { schemaVersion: 1, runtime: { piVersion: "0.83.0" }, storage: { runsDir: "runs", fixturesDir: "fixtures" }, modelProfiles: {} } as never));
}

test("phase gates report bounded missing requirements and do not trust old-generation observations", () => {
  const run = snapshot();
  run.observations["OBS-OLD"] = { id: "OBS-OLD", runId: run.runId, generation: 0, summary: "old observation", source: { operation: "read", artifactId: "A-OLD", generation: 0 }, candidateKinds: [], createdSeq: 1 };
  run.generation = 1;
  const gate = evaluatePhaseGate(run, "RECON");
  assert.equal(gate.status, "blocked");
  assert.ok(gate.missing.includes("current-generation-observation"));
  assert.ok(gate.stale.includes("current-generation-observation"));
});

test("SUBMIT gate requires accepted verifier evidence and a completed executor WorkItem", () => {
  const run = snapshot();
  const artifact = { id: "A-CANDIDATE", runId: run.runId, generation: run.generation, path: "candidate.txt", sha256: "candidate-hash", bytes: 10, mime: "text/plain", sensitivity: "flag_candidate", origin: { schemaVersion: 1, registeredBy: "agent", tags: [] } } as ArtifactRef;
  const completion = { id: "C-ACCEPTED", runId: run.runId, generation: run.generation, purpose: "submission", candidateHash: artifact.sha256, artifactId: artifact.id, status: "ACCEPTED", evidenceIds: ["EV-ACCEPTED"], createdSeq: 2 } as CompletionProposal;
  const effect = { id: "EF-SCORE", runId: run.runId, generation: run.generation, producerLane: "verifier", operation: "fixture_score", status: "FINISHED", outcome: "success", verification: { accepted: true, valid: true } } as Effect;
  const evidence = { id: "EV-ACCEPTED", runId: run.runId, generation: run.generation, kind: "reproduction", summary: "accepted", source: { tool: "fixture_score", effectId: effect.id, artifactId: "A-RESULT", generation: run.generation }, provenance: { schemaVersion: 1, runId: run.runId, generation: run.generation, recordedBy: "verifier", artifactIds: ["A-RESULT"], effect: { id: effect.id, operation: "fixture_score", status: "FINISHED", outcome: "success", exitCode: 0 } }, confidence: 1, supports: [completion.id], refutes: [], createdSeq: 3 } as Evidence;
  const workItem = { id: "WI-DONE", runId: run.runId, title: "reproduce", objective: "reproduce", role: "executor", status: "SUCCEEDED", ownerLane: "executor", dependsOn: [], evidenceIds: [evidence.id], artifactIds: [artifact.id], attempt: 1, maxAttempts: 3, createdSeq: 1, updatedSeq: 4 } as WorkItem;
  run.artifacts[artifact.id] = artifact;
  run.completions[completion.id] = completion;
  run.effects[effect.id] = effect;
  run.evidence[evidence.id] = evidence;
  run.workItems[workItem.id] = workItem;
  const beforeWorkItem = structuredClone(run);
  delete beforeWorkItem.workItems[workItem.id];
  assert.equal(evaluatePhaseGate(beforeWorkItem, "SUBMIT").status, "blocked");
  assert.equal(evaluatePhaseGate(run, "SUBMIT").status, "pass");
});
