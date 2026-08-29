import assert from "node:assert/strict";
import test from "node:test";
import { createInitialSnapshot } from "../src/control/reducer.js";
import type { ArtifactRef, ReasoningTree, TaskContract } from "../src/domain/types.js";
import type { ArtifactStore } from "../src/effects/artifact-store.js";
import { readKnowledge, readProjectKnowledge, type ProjectKnowledgeSource } from "../src/knowledge/projection.js";
import type { ProofBladeSkillRegistry, SkillCatalogEntry } from "../src/skills/registry.js";

const ARRAY_LIMIT = 64;
const runId = "KNOWLEDGE-READ-BOUNDS";
const task: TaskContract = {
  schema_version: 1,
  task_id: runId,
  mode: "coding_assistant",
  target_kind: "misc",
  target: "LOCAL_WORKSPACE",
  objective: "Bound knowledge read projections",
  inputs: [],
  success_criteria: ["Knowledge reads remain bounded"],
  verification: { kind: "reproduction", required_reproductions: 1 },
  scope: { allowed_hosts: [], allowed_ports: [], external_network: false, allowed_workspace: "." },
  pause_policy: [],
  constraints: { deadline_ms: 1_000, max_cost_usd: 0, max_tool_calls: 1, max_submissions: 1 },
};

test("readKnowledge bounds source IDs and both link directions", async () => {
  const snapshot = createInitialSnapshot(runId, task);
  const targetId = "TREE-TARGET";
  const relatedIds = Array.from({ length: 200 }, (_, index) => `TREE-${String(index).padStart(3, "0")}`);
  const sourceIds = [...relatedIds].reverse();
  snapshot.reasoningTrees[targetId] = reasoningTree(targetId, sourceIds);
  for (const [index, id] of relatedIds.entries()) {
    snapshot.reasoningTrees[id] = reasoningTree(id);
    snapshot.reasoningEdges[`EDGE-${String(index).padStart(3, "0")}`] = {
      id: `EDGE-${String(index).padStart(3, "0")}`,
      from: id,
      to: targetId,
      relation: "supports",
      explanation: "Bulk backlink",
      confidence: 1,
      generation: snapshot.generation,
      createdSeq: index + 1,
    };
  }

  const result = await readKnowledge(
    snapshot,
    {} as ArtifactStore,
    `pb://run/${runId}/tree/${targetId}`,
    "L0",
    256,
  );
  const expectedLinks = relatedIds.map((id) => `pb://run/${runId}/tree/${id}`);

  assert.deepEqual(result.projection.sourceIds, sourceIds.slice(0, ARRAY_LIMIT));
  assert.deepEqual(result.projection.links.forward, expectedLinks.slice(0, ARRAY_LIMIT));
  assert.deepEqual(result.projection.links.backlinks, expectedLinks.slice(0, ARRAY_LIMIT));
  assert.equal(result.projection.truncated, true);
  assert.ok(result.projection.levels.L0.length <= 512);
  assert.ok(result.projection.levels.L1.length <= 1_024);
  assert.ok(JSON.stringify(result.projection).length < 16_000);
});

test("readProjectKnowledge keeps large skill, tool, and MCP catalogs bounded", () => {
  const skills = Array.from({ length: 400 }, (_, index): SkillCatalogEntry => ({
    name: `skill-${String(index).padStart(3, "0")}`,
    description: `Skill ${index} ${"description ".repeat(8)}`,
    path: `/skills/${index}/SKILL.md`,
    contentHash: String(index).padStart(64, "0"),
    disableModelInvocation: false,
  }));
  const registry = {
    list: () => skills,
    loadForModel: () => undefined,
  } as unknown as ProofBladeSkillRegistry;
  const source: ProjectKnowledgeSource = {
    skills: registry,
    skillCatalogHash: "s".repeat(64),
    tools: Array.from({ length: 400 }, (_, index) => ({ id: `tool-${index}`, description: `Tool ${index} ${"details ".repeat(8)}`, version: "1" })),
    toolCatalogHash: "t".repeat(64),
    mcpServers: Array.from({ length: 400 }, (_, index) => ({ name: `mcp-${index}`, description: `MCP ${index} ${"details ".repeat(8)}`, configHash: String(index).padStart(64, "0"), status: "configured" })),
    mcpCatalogHash: "m".repeat(64),
  };

  const first = readProjectKnowledge(source, "pb://project/index", "L0", 256);
  const second = readProjectKnowledge(source, "pb://project/index", "L0", 256);
  const expectedForward = skills.slice(0, ARRAY_LIMIT).map((skill) => `pb://project/skills/${skill.name}`);

  assert.deepEqual(first, second);
  assert.deepEqual(first.projection.links.forward, expectedForward);
  assert.equal(first.projection.links.backlinks.length, 0);
  assert.equal(first.projection.truncated, true);
  assert.ok(first.projection.levels.L1.length <= 1_024);
  assert.ok(JSON.stringify(first.projection).length < 12_000);
  assert.ok(JSON.stringify(first).length < 14_000);
});

test("bounded projection metadata does not change artifact L2 content reads", async () => {
  const snapshot = createInitialSnapshot(runId, task);
  const content = "artifact-content\n".repeat(100);
  const artifact: ArtifactRef = {
    id: "A-L2",
    runId,
    generation: snapshot.generation,
    origin: { schemaVersion: 1, registeredBy: "agent", tags: [] },
    path: "artifacts/A-L2.txt",
    sha256: "a".repeat(64),
    bytes: Buffer.byteLength(content),
    mime: "text/plain",
    sensitivity: "public",
  };
  snapshot.artifacts[artifact.id] = artifact;
  const artifactStore = {
    readText: async (requestedRunId: string, requestedArtifact: ArtifactRef) => {
      assert.equal(requestedRunId, runId);
      assert.equal(requestedArtifact, artifact);
      return content;
    },
  } as ArtifactStore;

  const result = await readKnowledge(snapshot, artifactStore, `pb://run/${runId}/artifact/${artifact.id}`, "L2", 256);

  assert.equal(result.artifactId, artifact.id);
  assert.equal(result.content, content.slice(0, 256));
  assert.equal(result.truncated, true);
  assert.equal(result.projection.levels.L2?.bytes, artifact.bytes);
  assert.equal(result.projection.levels.L2?.truncated, true);
});

function reasoningTree(id: string, nodeIds: string[] = []): ReasoningTree {
  return {
    id,
    name: id,
    summary: "Bulk projection fixture",
    tags: [],
    purpose: "Exercise knowledge read bounds",
    explanation: "Test fixture",
    rootNodeId: nodeIds[0] ?? id,
    nodeIds,
    relatedTreeIds: [],
    status: "ACTIVE",
    generation: 0,
    explainedBy: "agent",
    createdSeq: 0,
    updatedSeq: 0,
  };
}
