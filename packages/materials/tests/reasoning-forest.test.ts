import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core/node";
import { createServices, demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { CodingEvidenceGraph, formatReasoningForestContext } from "../src/knowledge/evidence-graph.js";
import { injectReasoningForestContext } from "../src/runtime/coding-lane.js";

test("reasoning forest reuses evidence across trees and rejects invalid graph edges", async () => {
  const root = resolve(import.meta.dirname, "../../..", "tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "reasoning-forest-"));
  const config = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: { thinkingLevel: "off" } },
  } as unknown as ProofBladeConfig;
  const services = createServices(dir, config);
  const runId = "REASONING-FOREST-TEST";
  try {
    await services.control.createRun(runId, demoTask(runId, dir, config));
    const graph = new CodingEvidenceGraph(runId, services.control, services.artifacts);
    const sharedArtifact = await services.artifacts.putText(runId, "shared observation", { filename: "shared.txt", mime: "text/plain", sensitivity: "public" });
    const branchAArtifact = await services.artifacts.putText(runId, "branch a", { filename: "branch-a.txt", mime: "text/plain", sensitivity: "public" });
    const branchBArtifact = await services.artifacts.putText(runId, "branch b", { filename: "branch-b.txt", mime: "text/plain", sensitivity: "public" });
    const shared = await graph.recordEvidence({ name: "共享观察", summary: "两个推理方向共同采用的离散观察。", artifactIds: [sharedArtifact.id], tags: ["shared"] });
    const branchA = await graph.recordEvidence({ name: "方向 A", summary: "共享观察与 A 产物共同支撑主张 A。", artifactIds: [branchAArtifact.id], dependsOn: [shared.evidenceId], claim: "主张 A 成立", tags: ["branch-a"] });
    const branchB = await graph.recordEvidence({ name: "方向 B", summary: "共享观察与 B 产物共同支撑主张 B。", artifactIds: [branchBArtifact.id], dependsOn: [shared.evidenceId], claim: "主张 B 成立", tags: ["branch-b"] });

    assert.ok(branchA.treeId);
    assert.ok(branchB.treeId);
    const forest = await graph.inspectForest();
    assert.equal(forest.trees.length, 2);
    assert.deepEqual(forest.sharedNodes.find((item) => item.nodeId === shared.evidenceId)?.treeIds.sort(), [branchA.treeId!, branchB.treeId!].sort());
    assert.deepEqual(forest.sharedNodes.find((item) => item.nodeId === sharedArtifact.id)?.treeIds.sort(), [branchA.treeId!, branchB.treeId!].sort());
    assert.ok(forest.trees.find((tree) => tree.id === branchA.treeId)?.relatedTreeIds.includes(branchB.treeId!));
    assert.ok(forest.trees.find((tree) => tree.id === branchB.treeId)?.relatedTreeIds.includes(branchA.treeId!));
    assert.match(formatReasoningForestContext(forest), /reasoning-forest/);
    const tree = await graph.inspectTree(branchA.treeId!);
    assert.equal((tree.tree as { rootNodeId: string }).rootNodeId, branchA.factId);
    assert.ok((tree.nodes as Array<{ id: string }>).some((node) => node.id === shared.evidenceId));
    assert.ok((tree.nodes as Array<{ id: string }>).some((node) => node.id === sharedArtifact.id));

    await assert.rejects(
      graph.linkNodes({ from: shared.evidenceId, to: branchA.evidenceId, relation: "depends_on" }),
      /Duplicate reasoning edge/,
    );
    await assert.rejects(
      graph.linkNodes({ from: branchA.factId!, to: shared.evidenceId, relation: "supports" }),
      /create a cycle/,
    );
    await assert.rejects(
      graph.createTree({ name: "坏树", summary: "引用未知节点。", purpose: "测试校验。", explanation: "应拒绝未知节点。", rootNodeId: "UNKNOWN", nodeIds: ["UNKNOWN"] }),
      /Unknown graph node/,
    );
    await assert.rejects(
      services.control.append(runId, [{
        schemaVersion: 1,
        lane: "main",
        actor: "orchestrator",
        type: "reasoning_edge_added",
        payload: { edge: { id: "RE-CORRUPT", from: "UNKNOWN-A", to: "UNKNOWN-B", relation: "supports", explanation: "corrupt event", confidence: 1, generation: 0 } },
      }]),
      /unknown nodes/,
    );

    const firstHash = (await services.control.replay(runId)).projectionHash;
    const secondHash = (await services.control.replay(runId)).projectionHash;
    assert.equal(firstHash, secondHash);

    await services.control.dispatch(runId, { type: "fixture_reset", generation: 1 });
    await assert.rejects(
      graph.linkNodes({ from: shared.evidenceId, to: branchB.factId!, relation: "adopts" }),
      /crosses generations/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("forest context is hidden dynamic memory immediately before the latest user message", () => {
  const messages = [
    { role: "user", content: "old", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "answer" }], api: "openai-completions", provider: "test", model: "test", usage: zeroUsage(), stopReason: "stop", timestamp: 2 },
    { role: "user", content: "current", timestamp: 3 },
  ] as AgentMessage[];
  const injected = injectReasoningForestContext(messages, "<reasoning-forest>summary</reasoning-forest>");
  assert.equal(messages.length, 3);
  assert.equal(injected.length, 4);
  assert.equal(injected[2]!.role, "custom");
  assert.equal(injected[3]!.role, "user");
  assert.equal((injected[2] as { display: boolean }).display, false);
});

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
