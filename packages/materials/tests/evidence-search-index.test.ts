import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "../src/config.js";
import { createServices, demoTask } from "../src/app/demo.js";
import { createInitialSnapshot } from "../src/control/reducer.js";
import type { RunSnapshot } from "../src/domain/types.js";
import { CodingEvidenceGraph } from "../src/knowledge/evidence-graph.js";

const config = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: { executor: { thinkingLevel: "off" } },
} as unknown as ProofBladeConfig;

test("evidence search indexes Artifact text once per content hash within a generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-evidence-index-"));
  try {
    const services = createServices(root, config);
    const runId = "EVIDENCE-INDEX-001";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const artifact = await services.artifacts.putText(runId, "entrypoint verify_magic reveal_marker", { filename: "analysis.txt", mime: "text/plain" });
    const originalRead = services.artifacts.readText.bind(services.artifacts);
    let reads = 0;
    services.artifacts.readText = async (...args: Parameters<typeof services.artifacts.readText>) => { reads += 1; return await originalRead(...args); };
    const graph = new CodingEvidenceGraph(runId, services.control, services.artifacts);
    const firstSearch = await graph.searchWithTrace("reveal_marker");
    assert.equal(firstSearch.results.some((item) => item.id === artifact.id), true);
    assert.equal(firstSearch.trace.runId, runId);
    assert.equal(firstSearch.trace.mode, "keyword");
    assert.equal(firstSearch.trace.selectedRefs.includes(artifact.id), true);
    assert.equal(firstSearch.trace.injectedRefs.includes(artifact.id), true);
    assert.equal(firstSearch.trace.modelUsedRecall, false);
    assert.ok(firstSearch.trace.latencyMs >= 0);
    assert.equal(reads, 1);
    assert.equal((await graph.search("verify_magic")).some((item) => item.id === artifact.id), true);
    assert.equal(reads, 1);
    const next = await services.artifacts.putText(runId, "entrypoint different_marker", { filename: "analysis-2.txt", mime: "text/plain" });
    assert.equal((await graph.search("different_marker")).some((item) => item.id === next.id), true);
    assert.equal(reads, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("evidence search bounds large metadata while preserving a retrieval path", async () => {
  const runId = "EVIDENCE-LARGE-001";
  const task = demoTask(runId, ".", config);
  const snapshot = createInitialSnapshot(runId, task);
  const artifactId = "A-LARGE-RESULT";
  const artifact = {
    id: artifactId,
    runId,
    generation: snapshot.generation,
    path: "artifacts/large-analysis.json",
    sha256: "a".repeat(64),
    bytes: 32_000,
    mime: "application/json",
    sensitivity: "public" as const,
    origin: { schemaVersion: 1 as const, registeredBy: "agent" as const, tags: [] },
    semantic: {
      name: "large-name-" + "N".repeat(4_000),
      summary: "needle " + "S".repeat(8_000),
      tags: Array.from({ length: 100 }, (_, index) => `tag-${index}-${"T".repeat(100)}`),
      role: "supporting" as const,
      relatedIds: Array.from({ length: 100 }, (_, index) => `A-related-${index}-${"R".repeat(100)}`),
      annotatedBy: "agent" as const,
      updatedSeq: 1,
    },
  } satisfies RunSnapshot["artifacts"][string];
  snapshot.artifacts[artifactId] = artifact;
  const controlStore = { snapshot: async () => snapshot };
  const artifactStore = { readText: async () => "needle\n" + "payload\n".repeat(2_000) };
  const graph = new CodingEvidenceGraph(runId, controlStore as never, artifactStore as never);
  const result = await graph.searchWithTrace("needle");
  const row = result.results.find((item) => item.id === artifactId);
  assert.ok(row);
  assert.ok(String(row.name).length <= 1_024);
  assert.ok(String(row.summary).length <= 1_024);
  assert.ok(Array.isArray(row.tags) && row.tags.length <= 32);
  assert.ok(Array.isArray(row.relatedIds) && row.relatedIds.length <= 32);
  assert.match(String(row.summary), /…|\.\.\./);
  assert.ok(JSON.stringify(result).length < 100_000, "large retrieval metadata must not flood the model result");
  const artifactView = await graph.readArtifact(artifactId, 256);
  assert.equal(artifactView.artifactId, artifactId);
  assert.equal(artifactView.truncated, true);
  assert.ok(String(artifactView.output).length <= 257);
});
