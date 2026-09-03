import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core/node";
import { createServices, demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { buildReasoningForest, CodingEvidenceGraph, formatReasoningForestContext } from "../src/knowledge/evidence-graph.js";
import { injectReasoningForestContext } from "../src/runtime/coding-lane.js";
import { estimateTokens, sha256 } from "../src/domain/utils.js";

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
    const orphanArtifact = await services.artifacts.putText(runId, "orphan source", { filename: "orphan.txt", mime: "text/plain", sensitivity: "public" });
    const orphan = await graph.recordEvidence({ name: "近期孤立证据", summary: "尚未并入任何推理树，但下一轮仍需看到其语义摘要。", artifactIds: [orphanArtifact.id], tags: ["orphan"] });
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
    assert.ok(forest.orphanNodes.some((node) => node.id === orphan.evidenceId && node.name === "近期孤立证据"));
    assert.equal(forest.orphanNodeCount, forest.orphanNodeIds.length);
    assert.match(formatReasoningForestContext(forest), /reasoning-forest/);
    assert.match(formatReasoningForestContext(forest), /近期孤立证据/);
    assert.match(formatReasoningForestContext({ ...forest, trees: [], sharedNodes: [] }), /近期孤立证据/);
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
      /Raw append is restricted to telemetry events/,
    );

    const firstHash = (await services.control.replay(runId)).projectionHash;
    const secondHash = (await services.control.replay(runId)).projectionHash;
    assert.equal(firstHash, secondHash);
    const currentSnapshot = await services.control.snapshot(runId);
    assert.equal(buildReasoningForest(currentSnapshot).hash, buildReasoningForest({ ...currentSnapshot, lastSeq: currentSnapshot.lastSeq + 1 }).hash);
    assert.equal(formatReasoningForestContext(buildReasoningForest(currentSnapshot)), formatReasoningForestContext(buildReasoningForest({ ...currentSnapshot, lastSeq: currentSnapshot.lastSeq + 100 })), "unrelated event sequence must not change visible forest context");
    const oversizedForest = buildReasoningForest(currentSnapshot);
    if (oversizedForest.trees[0]) {
      oversizedForest.trees[0] = {
        ...oversizedForest.trees[0],
        name: "N".repeat(2_000),
        summary: "S".repeat(2_000),
        tags: ["T".repeat(2_000)],
        relatedTreeIds: Array.from({ length: 100 }, (_, index) => `TREE-${index}-${"R".repeat(100)}`),
      };
    }
    assert.ok(estimateTokens(formatReasoningForestContext(oversizedForest)) <= 2_048, "forest context must stay within its model-facing bound");
    const clipped = formatReasoningForestContext(oversizedForest);
    const match = clipped.match(/^<reasoning-forest hash="[a-f0-9]{64}" visible-hash="([a-f0-9]{64})">\n([\s\S]*)\n<\/reasoning-forest>$/);
    assert.ok(match, "forest envelope must expose a hash for the visible clipped body");
    assert.equal(match?.[1], sha256(match?.[2] ?? ""), "visible-hash must match the clipped forest body");
    assert.equal(formatReasoningForestContext(oversizedForest), clipped, "the clipped forest representation is deterministic");

    const longClaimArtifact = await services.artifacts.putText(runId, "long claim source", { filename: "long-claim.txt", mime: "text/plain", sensitivity: "public" });
    const longClaim = `完整权威主张：${"保持完整内容用于验证，展示标题应单独截断。".repeat(12)}`;
    const longRecord = await graph.recordEvidence({ name: "长主张证据", summary: "验证权威 Claim 与图展示标签具有不同长度边界。", artifactIds: [longClaimArtifact.id], claim: longClaim });
    const longSnapshot = await services.control.snapshot(runId);
    assert.equal(longSnapshot.facts[longRecord.factId!]?.statement, longClaim);
    assert.ok(longSnapshot.reasoningNodes[longRecord.factId!]!.name.length <= 160);
    assert.ok(longSnapshot.reasoningTrees[longRecord.treeId!]!.name.length <= 160);

    await services.fixtureControl.reset(runId, 1);
    await assert.rejects(
      graph.linkNodes({ from: shared.evidenceId, to: branchB.factId!, relation: "adopts" }),
      /crosses generations/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("forest context is hidden dynamic memory appended after the transcript", () => {
  const messages = [
    { role: "user", content: "old", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "answer" }], api: "openai-completions", provider: "test", model: "test", usage: zeroUsage(), stopReason: "stop", timestamp: 2 },
    { role: "user", content: "current", timestamp: 3 },
  ] as AgentMessage[];
  const injected = injectReasoningForestContext(messages, "<reasoning-forest>summary</reasoning-forest>");
  assert.equal(messages.length, 3);
  assert.equal(injected.length, 4);
  assert.equal(injected[2]!.role, "user");
  assert.equal(injected[3]!.role, "custom");
  assert.equal((injected[3] as { display: boolean }).display, false);
  assert.equal((injected[3] as { customType: string }).customType, "proofblade_reasoning_forest");
  assert.equal(injected[2], messages[2]);

  const refreshed = injectReasoningForestContext(messages, "<reasoning-forest>new summary</reasoning-forest>");
  assert.deepEqual(refreshed.slice(0, messages.length), messages);
  assert.notEqual((injected[3] as { content: string }).content, (refreshed[3] as { content: string }).content);
});

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
