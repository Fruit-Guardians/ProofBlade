import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "../src/config.js";
import { createServices } from "../src/app/demo.js";
import { fixtureTask } from "../src/app/fixture-task.js";
import { ContextCompiler, contextText } from "../src/context/compiler.js";
import { PlannerCoordinator } from "../src/orchestration/planner.js";
import { RefinerCoordinator, applyHandoffDelta } from "../src/orchestration/refiner.js";
import { handoffKnowledgeVersion } from "../src/domain/handoff.js";

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

test("planner handoffs are lane-gated, versioned, and context-visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-handoff-"));
  try {
    const services = createServices(root, config);
    const runId = "HANDOFF-001";
    const task = fixtureTask(runId, "web-source-1", root, config);
    await services.control.createRun(runId, task);
    await services.control.dispatch(runId, { type: "start_phase", phase: "reconnaissance" });
    const planner = new PlannerCoordinator(services.control);
    const first = await planner.prepare(runId);
    assert.equal(first.sourceLane, "planner");
    assert.equal(first.targetLane, "executor");
    assert.equal(first.status, "ACCEPTED");
    assert.equal(first.knowledgeVersion, handoffKnowledgeVersion(await services.control.snapshot(runId)));
    assert.ok(first.nextActions.length > 0);
    assert.ok(first.nextActions.some((action) => action.workItemId));
    const plannedWorkItem = Object.values((await services.control.snapshot(runId)).workItems)[0];
    assert.equal(plannedWorkItem?.status, "READY");
    assert.ok(first.hash.length === 64);
    assert.match(contextText(new ContextCompiler().build({
      runId,
      lane: "executor",
      phase: "reconnaissance",
      task,
      snapshot: await services.control.snapshot(runId),
      contextWindow: 4096,
    })), /<planner-handoff/);

    await assert.rejects(
      services.control.dispatch(runId, { type: "handoff_accepted", handoffId: first.id, lane: "planner" }),
      /executor lane/,
    );
    await services.control.dispatch(runId, {
      type: "observation",
      observation: {
        id: "OBS-HANDOFF",
        summary: "A new observation invalidates the previous planner view.",
        source: { operation: "fixture_list", effectId: "EF-HANDOFF", artifactId: "A-HANDOFF", generation: 0 },
        candidateKinds: [],
      },
      lane: "executor",
    });
    await assert.rejects(
      services.control.dispatch(runId, { type: "handoff_accepted", handoffId: first.id, lane: "executor" }),
      /stale/,
    );
    const second = await planner.prepare(runId);
    assert.notEqual(second.id, first.id);
    assert.equal((await services.control.snapshot(runId)).handoffs[first.id]?.status, "SUPERSEDED");
    assert.equal(second.status, "ACCEPTED");
    assert.equal(second.knowledgeVersion, handoffKnowledgeVersion(await services.control.snapshot(runId)));
    const replayed = await services.control.replay(runId);
    assert.equal(replayed.handoffs[second.id]?.hash, (await services.control.snapshot(runId)).handoffs[second.id]?.hash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refiner applies add/modify/remove/reorder deltas and supersedes the old handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-refiner-"));
  try {
    const services = createServices(root, config);
    const runId = "REFINER-001";
    await services.control.createRun(runId, fixtureTask(runId, "web-source-1", root, config));
    const first = await new PlannerCoordinator(services.control).prepare(runId);
    const rootAction = first.nextActions[0]!;
    const added = { id: "ACTION-ALT", title: "Try alternate primitive", description: "Use a different evidenced route.", expectedEvidence: ["artifact"], resourceKeys: ["target"], estimatedToolCalls: 2 };
    const preview = applyHandoffDelta(first.nextActions, [
      { op: "add", action: added, afterId: rootAction.id },
      { op: "modify", id: rootAction.id, patch: { estimatedToolCalls: 3 } },
      { op: "reorder", id: "ACTION-ALT" },
    ]);
    assert.equal(preview[0]?.id, "ACTION-ALT");
    assert.equal(preview.find((item) => item.id === rootAction.id)?.estimatedToolCalls, 3);
    const refined = await new RefinerCoordinator(services.control).refine(runId, [
      { op: "add", action: added, afterId: rootAction.id },
      { op: "modify", id: rootAction.id, patch: { description: "Changed after negative evidence." } },
    ], rootAction.id);
    assert.equal(refined.status, "ACCEPTED");
    assert.ok(refined.nextActions.some((item) => item.id === "ACTION-ALT"));
    assert.ok(refined.prohibitedRepeats.includes(rootAction.id));
    assert.equal((await services.control.snapshot(runId)).handoffs[first.id]?.status, "SUPERSEDED");
    assert.throws(() => applyHandoffDelta([rootAction], [{ op: "remove", id: rootAction.id }]), /requires 1-16/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
