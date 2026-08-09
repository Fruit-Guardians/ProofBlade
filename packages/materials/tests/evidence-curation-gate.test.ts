import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlStore } from "../src/control/control-store.js";
import type { TaskContract } from "../src/domain/types.js";
import { ArtifactStore } from "../src/effects/artifact-store.js";
import { EvidenceCurationGate } from "../src/knowledge/evidence-curation-gate.js";
import { CodingEvidenceGraph } from "../src/knowledge/evidence-graph.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";

test("evidence curation gate checkpoints exploration and clears reviewed artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-curation-"));
  try {
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const runId = "CURATION-001";
    await control.createRun(runId, task(runId, root));
    const artifacts = new ArtifactStore(join(root, "runs"), control);
    const graph = new CodingEvidenceGraph(runId, control, artifacts);
    const gate = new EvidenceCurationGate(runId, control);
    const ids: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const artifact = await artifacts.putText(runId, `observation ${index}`, {
        filename: `read-${index}.txt`,
        mime: "text/plain",
        sensitivity: "public",
        semantic: {
          name: `读取结果 ${index}`,
          summary: `尚未整理的离散观察 ${index}`,
          tags: ["read", "file-content"],
          role: "intermediate",
          relatedIds: [],
          annotatedBy: "harness",
        },
      });
      ids.push(artifact.id);
      const status = await gate.inspect();
      if (index < 3) assert.equal(status.stage, "clear");
      if (index >= 3 && index < 7) assert.equal(status.stage, "checkpoint");
    }
    assert.equal((await gate.inspect()).stage, "required");
    await assert.rejects(gate.assertInvestigationAllowed(), /Further read\/bash calls are paused/);

    await graph.recordEvidence({
      name: "有效发现",
      summary: "第一个离散观察能够支撑当前方向。",
      artifactIds: [ids[0]!],
      claim: "当前方向具有可验证依据。",
    });
    assert.equal((await gate.inspect()).pendingCount, 7);
    await gate.assertInvestigationAllowed();

    await graph.annotateArtifact({
      artifactId: ids[1]!,
      name: "普通目录输出",
      summary: "已审阅，对当前假设没有证据价值。",
      role: "debug",
      tags: ["read", "reviewed-routine"],
    });
    const reviewed = await gate.inspect();
    assert.equal(reviewed.pendingCount, 6);
    assert.equal(reviewed.pendingArtifacts.some((item) => item.id === ids[1]), false);

    await artifacts.putText(runId, "observation 1", {
      filename: "read-duplicate.txt",
      mime: "text/plain",
      sensitivity: "public",
      semantic: {
        name: "重复读取结果",
        summary: "与已经审阅的输出内容相同。",
        tags: ["read", "file-content"],
        role: "intermediate",
        relatedIds: [],
        annotatedBy: "harness",
      },
    });
    assert.equal((await gate.inspect()).pendingCount, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence recording is bounded and idempotent after an artifact reaches the tag limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-curation-idempotent-"));
  try {
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const runId = "CURATION-IDEMPOTENT-001";
    await control.createRun(runId, task(runId, root));
    const artifacts = new ArtifactStore(join(root, "runs"), control);
    const graph = new CodingEvidenceGraph(runId, control, artifacts);
    const artifact = await artifacts.putText(runId, "maze map", {
      filename: "maze.txt",
      mime: "text/plain",
      sensitivity: "public",
      semantic: {
        name: "Maze map",
        summary: "Extracted maze map awaiting review.",
        tags: ["read", "file-content", ...Array.from({ length: 14 }, (_, index) => `tag-${index}`)],
        role: "intermediate",
        relatedIds: [],
        annotatedBy: "harness",
      },
    });

    const first = await graph.recordEvidence({
      name: "Maze topology",
      summary: "The extracted map defines the traversable maze topology.",
      artifactIds: [artifact.id],
      tags: ["maze", "topology"],
      claim: "The map is sufficient to compute a path.",
    });
    assert.equal(first.reused, false);
    assert.equal(first.durableProgress, true);
    const afterFirst = await control.snapshot(runId);
    assert.equal(afterFirst.artifacts[artifact.id]!.semantic!.tags.length, 16);
    assert.equal(Object.keys(afterFirst.evidence).length, 1);

    const repeated = await graph.recordEvidence({
      name: "Different display name does not duplicate the finding",
      summary: "  The extracted map defines the traversable maze topology.  ",
      artifactIds: [artifact.id],
      tags: ["other"],
      claim: "The map is sufficient to compute a path.",
    });
    assert.equal(repeated.evidenceId, first.evidenceId);
    assert.equal(repeated.reused, true);
    assert.equal(repeated.durableProgress, false);
    assert.equal(Object.keys((await control.snapshot(runId)).evidence).length, 1);

    const annotation = await graph.annotateArtifact({ artifactId: artifact.id, name: "Reviewed maze", summary: "Reviewed topology source.", role: "supporting", tags: ["maze"] });
    const annotationAgain = await graph.annotateArtifact({ artifactId: artifact.id, name: "Reviewed maze", summary: "Reviewed topology source.", role: "supporting", tags: ["maze"] });
    assert.equal(annotation.reused, false);
    assert.equal(annotationAgain.reused, true);
    assert.equal(annotationAgain.durableProgress, false);
    assert.equal(annotationAgain.progressKey, annotation.progressKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent evidence recording commits one durable finding", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-curation-concurrent-evidence-"));
  try {
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const runId = "CURATION-CONCURRENT-EVIDENCE-001";
    await control.createRun(runId, task(runId, root));
    const artifacts = new ArtifactStore(join(root, "runs"), control);
    const graph = new CodingEvidenceGraph(runId, control, artifacts);
    const artifact = await artifacts.putText(runId, "maze map", {
      filename: "maze.txt",
      mime: "text/plain",
      sensitivity: "public",
    });
    const input = {
      name: "Maze topology",
      summary: "The extracted map defines the traversable maze topology.",
      artifactIds: [artifact.id],
      tags: ["maze", "topology"],
      claim: "The map is sufficient to compute a path.",
    };

    const results = await Promise.all([
      graph.recordEvidence(input),
      graph.recordEvidence(input),
    ]);

    assert.equal(results[0]!.evidenceId, results[1]!.evidenceId);
    assert.equal(results[0]!.factId, results[1]!.factId);
    assert.equal(results[0]!.treeId, results[1]!.treeId);
    assert.equal(results[0]!.progressKey, results[1]!.progressKey);
    assert.deepEqual(results.map((result) => result.reused).sort(), [false, true]);
    assert.deepEqual(results.map((result) => result.durableProgress).sort(), [false, true]);

    const snapshot = await control.snapshot(runId);
    assert.equal(Object.keys(snapshot.evidence).length, 1);
    assert.equal(Object.keys(snapshot.facts).length, 1);
    assert.equal(Object.keys(snapshot.reasoningTrees).length, 1);
    assert.equal(Object.keys(snapshot.reasoningNodes).length, 3);
    assert.equal(Object.keys(snapshot.reasoningEdges).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent artifact annotation commits one durable update", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-curation-concurrent-annotation-"));
  try {
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const runId = "CURATION-CONCURRENT-ANNOTATION-001";
    await control.createRun(runId, task(runId, root));
    const artifacts = new ArtifactStore(join(root, "runs"), control);
    const graph = new CodingEvidenceGraph(runId, control, artifacts);
    const artifact = await artifacts.putText(runId, "routine output", {
      filename: "routine.txt",
      mime: "text/plain",
      sensitivity: "public",
    });
    const input = {
      artifactId: artifact.id,
      name: "Reviewed routine output",
      summary: "Reviewed and classified as non-evidentiary output.",
      role: "debug" as const,
      tags: ["reviewed-routine"],
    };

    const results = await Promise.all([
      graph.annotateArtifact(input),
      graph.annotateArtifact(input),
    ]);

    assert.equal(results[0]!.progressKey, results[1]!.progressKey);
    assert.deepEqual(results.map((result) => result.reused).sort(), [false, true]);
    assert.deepEqual(results.map((result) => result.durableProgress).sort(), [false, true]);
    const annotationEvents = (await control.events(runId)).filter((event) =>
      event.type === "artifact_annotated" && event.payload.artifactId === artifact.id);
    assert.equal(annotationEvents.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function task(runId: string, root: string): TaskContract {
  return {
    schema_version: 1,
    task_id: runId,
    mode: "coding_assistant",
    target_kind: "unknown",
    target: root,
    objective: "curation test",
    inputs: [],
    success_criteria: [],
    verification: { kind: "reproduction", required_reproductions: 0 },
    scope: { allowed_hosts: ["*"], allowed_ports: [], external_network: false, allowed_workspace: root },
    pause_policy: [],
    constraints: { deadline_ms: 10_000, max_cost_usd: 1, max_tool_calls: 20, max_submissions: 0 },
  };
}
