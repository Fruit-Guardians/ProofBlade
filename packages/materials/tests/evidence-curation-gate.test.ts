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

test("evidence curation gate keeps agent annotations pending and clears only trusted reviews or promotions", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-curation-"));
  try {
    const { control, verifier } = ControlStore.create(new JsonlControlStore(join(root, "runs")));
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
    const required = await gate.inspect();
    assert.equal(required.stage, "required");
    assert.equal(required.pendingCount, 8);
    assert.equal(required.viewedCount, 0);
    assert.equal(required.reviewedCount, 0);
    assert.equal(required.promotedCount, 0);
    assert.equal(required.unviewedCount, 8);
    // Advisory now: returns the nudge string instead of throwing, so a required
    // backlog no longer hard-stops the next read/bash.
    const requiredNotice = await gate.assertInvestigationAllowed();
    assert.match(requiredNotice ?? "", /Further read\/bash calls are paused/);

    for (const artifactId of ids) {
      await graph.annotateArtifact({
        artifactId,
        name: "普通目录输出",
        summary: "Agent 已查看，但不能把自身 annotation 提升为可信审阅。",
        role: "debug",
        tags: ["read", "reviewed-routine"],
      });
    }
    const viewed = await gate.inspect();
    assert.equal(viewed.stage, "required");
    assert.equal(viewed.pendingCount, 8);
    assert.equal(viewed.viewedCount, 8);
    assert.equal(viewed.reviewedCount, 0);
    assert.equal(viewed.promotedCount, 0);
    assert.equal(viewed.unviewedCount, 0);
    assert.ok(viewed.pendingArtifacts.every((item) => item.curationState === "viewed"));
    const viewedNotice = await gate.assertInvestigationAllowed();
    assert.match(viewedNotice ?? "", /Agent annotation marks an artifact viewed but does not clear this gate/);

    await verifier.dispatch(runId, {
      type: "artifact_annotation",
      artifactId: ids[0]!,
      semantic: {
        name: "Harness 审阅的普通输出",
        summary: "受信 harness 已确认该输出无需提升为 Evidence。",
        tags: ["read", "reviewed-routine"],
        role: "debug",
        relatedIds: [],
        annotatedBy: "harness",
      },
    });
    const harnessReviewed = await gate.inspect();
    assert.equal(harnessReviewed.stage, "checkpoint");
    assert.equal(harnessReviewed.pendingCount, 7);
    assert.equal(harnessReviewed.viewedCount, 7);
    assert.equal(harnessReviewed.reviewedCount, 1);
    assert.equal(harnessReviewed.promotedCount, 0);
    await gate.assertInvestigationAllowed();

    await verifier.dispatch(runId, {
      type: "artifact_annotation",
      artifactId: ids[1]!,
      semantic: {
        name: "User 审阅的普通输出",
        summary: "受信 user 已确认该输出无需提升为 Evidence。",
        tags: ["read", "reviewed-routine"],
        role: "debug",
        relatedIds: [],
        annotatedBy: "user",
      },
    });
    const userReviewed = await gate.inspect();
    assert.equal(userReviewed.pendingCount, 6);
    assert.equal(userReviewed.viewedCount, 6);
    assert.equal(userReviewed.reviewedCount, 2);

    await graph.recordEvidence({
      name: "有效发现",
      summary: "第三个离散观察能够支撑当前方向。",
      artifactIds: [ids[2]!],
      claim: "当前方向具有可验证依据。",
    });
    const promoted = await gate.inspect();
    assert.equal(promoted.pendingCount, 5);
    assert.equal(promoted.viewedCount, 5);
    assert.equal(promoted.reviewedCount, 2);
    assert.equal(promoted.promotedCount, 1);
    assert.equal(promoted.pendingArtifacts.some((item) => item.id === ids[2]), false);

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
    const duplicate = await gate.inspect();
    assert.equal(duplicate.pendingCount, 5);
    assert.equal(duplicate.reviewedCount, 2);
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
    const renamedAnnotation = await graph.annotateArtifact({ artifactId: artifact.id, name: "Renamed review", summary: "Different wording for the same reviewed bytes.", role: "debug", tags: ["renamed"] });
    assert.equal(renamedAnnotation.reused, false);
    assert.equal(renamedAnnotation.durableProgress, false);
    assert.equal(renamedAnnotation.progressKey, annotation.progressKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:duplicate-artifact-progress] identical artifact content cannot manufacture durable progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-curation-duplicate-content-"));
  try {
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const runId = "CURATION-DUPLICATE-CONTENT-001";
    await control.createRun(runId, task(runId, root));
    const artifacts = new ArtifactStore(join(root, "runs"), control);
    const graph = new CodingEvidenceGraph(runId, control, artifacts);
    const copies = await Promise.all(Array.from({ length: 3 }, (_, index) => artifacts.putText(runId, "same solver source", {
      filename: "solver-copy-" + index + ".txt",
      mime: "text/plain",
      sensitivity: "public",
    })));

    assert.equal(new Set(copies.map((artifact) => artifact.id)).size, 3);
    assert.equal(new Set(copies.map((artifact) => artifact.sha256)).size, 1);

    const results = [];
    for (const [index, artifact] of copies.entries()) {
      results.push(await graph.recordEvidence({
        name: "Solver source inspection " + (index + 1),
        summary: "Wording variant " + (index + 1) + " describes the same underlying solver source.",
        artifactIds: [artifact.id],
      }));
    }

    assert.deepEqual(results.map((result) => result.durableProgress), [true, false, false]);
    assert.equal(new Set(results.map((result) => result.progressKey)).size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate artifact annotations share one durable content review", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-curation-duplicate-annotations-"));
  try {
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const runId = "CURATION-DUPLICATE-ANNOTATIONS-001";
    await control.createRun(runId, task(runId, root));
    const artifacts = new ArtifactStore(join(root, "runs"), control);
    const graph = new CodingEvidenceGraph(runId, control, artifacts);
    const first = await artifacts.putText(runId, "same command output", { filename: "first.txt", mime: "text/plain", sensitivity: "public" });
    const second = await artifacts.putText(runId, "same command output", { filename: "second.txt", mime: "text/plain", sensitivity: "public" });

    const firstReview = await graph.annotateArtifact({ artifactId: first.id, name: "Reviewed output", summary: "Routine output reviewed.", role: "debug" });
    const secondReview = await graph.annotateArtifact({ artifactId: second.id, name: "Renamed duplicate", summary: "Different wording reviews the same bytes.", role: "intermediate" });

    assert.equal(firstReview.durableProgress, true);
    assert.equal(secondReview.durableProgress, false);
    assert.equal(secondReview.progressKey, firstReview.progressKey);
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
