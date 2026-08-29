import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices } from "../src/app/demo.js";
import { fixtureTask } from "../src/app/fixture-task.js";
import { projectKnowledge, readKnowledge, searchKnowledge } from "../src/knowledge/projection.js";
import { EvidenceConsolidator } from "../src/knowledge/consolidation.js";
import type { ProofBladeConfig } from "../src/config.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", model: "test-model",
      modelDiscoveryPath: "/models", apiKeyEnv: "TEST_API_KEY", contextWindow: 4096, maxTokens: 512,
      requestTimeoutMs: 1000, maxRetries: 0, input: ["text"],
    },
  },
};

test("knowledge projections use canonical pb URIs and bounded artifact L2", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-knowledge-"));
  try {
    const services = createServices(root, config);
    const runId = "KNOWLEDGE-001";
    const task = fixtureTask(runId, "web-source-1", root, config);
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);
    const artifact = await services.artifacts.putText(runId, "sensitive-looking raw observation\n".repeat(100), { filename: "raw.txt", mime: "text/plain", sensitivity: "public" });
    const snapshot = await services.control.snapshot(runId);

    const taskProjection = projectKnowledge(snapshot, `pb://run/${runId}/task/current`);
    assert.equal(taskProjection.uri, `pb://run/${runId}/task/current`);
    assert.equal(taskProjection.kind, "task");
    assert.equal(taskProjection.trust, "verified");
    assert.match(taskProjection.levels.L0, /KNOWLEDGE-001/);
    assert.deepEqual(taskProjection.links.forward, [`pb://run/${runId}/forest`]);

    const artifactProjection = projectKnowledge(snapshot, `pb://run/${runId}/artifact/${artifact.id}`);
    assert.equal(artifactProjection.levels.L2?.uri, `pb://run/${runId}/artifact/${artifact.id}/content`);
    const l2 = await readKnowledge(snapshot, services.artifacts, artifactProjection.uri, "L2", 256);
    assert.equal(l2.artifactId, artifact.id);
    assert.equal(l2.truncated, true);
    assert.equal(l2.content.length, 256);

    snapshot.artifacts[artifact.id] = { ...snapshot.artifacts[artifact.id]!, sourceEffectId: "EF-NOT-A-KNOWLEDGE-TARGET" };
    const artifactWithEffectReference = projectKnowledge(snapshot, artifactProjection.uri);
    assert.deepEqual(artifactWithEffectReference.links.forward, []);

    assert.equal(searchKnowledge(snapshot, "raw.txt").some((item) => item.uri === artifactProjection.uri), true);
    const consolidator = new EvidenceConsolidator(services.control, services.artifacts);
    const consolidated = await consolidator.consolidate(runId, { artifactIds: [artifact.id], policy: "summarize" });
    assert.equal(consolidated.status, "FINISHED");
    assert.deepEqual(await consolidator.orphanOperations(runId), []);
    const replayed = await consolidator.consolidate(runId, { artifactIds: [artifact.id], policy: "summarize" });
    assert.equal(replayed.status, "REPLAYED");
    assert.equal(replayed.artifactId, consolidated.artifactId);
    const [concurrentOne, concurrentTwo] = await Promise.all([
      new EvidenceConsolidator(services.control, services.artifacts).consolidate(runId, { artifactIds: [artifact.id], policy: "all" }),
      new EvidenceConsolidator(services.control, services.artifacts).consolidate(runId, { artifactIds: [artifact.id], policy: "all" }),
    ]);
    assert.deepEqual(new Set([concurrentOne.status, concurrentTwo.status]), new Set(["FINISHED", "REPLAYED"]));
    assert.equal(concurrentOne.artifactId, concurrentTwo.artifactId);
    const afterConcurrent = await services.control.snapshot(runId);
    assert.equal(Object.values(afterConcurrent.artifacts).filter((item) => item.semantic?.tags.includes("consolidation")).length, 2);
    const eventTypes = (await services.control.events(runId)).map((event) => event.type);
    assert.equal(eventTypes.includes("consolidate_started"), true);
    assert.equal(eventTypes.includes("consolidate_summary"), true);
    assert.equal(eventTypes.includes("consolidate_finished"), true);
    assert.throws(() => projectKnowledge(snapshot, "pb://run/OTHER/artifact/A-1"), /another run/);
    assert.throws(() => projectKnowledge(snapshot, `pb://run/${runId}/artifact/../content`), /Unsupported knowledge URI|scope/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
