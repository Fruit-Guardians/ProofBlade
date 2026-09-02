import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "../src/config.js";
import { createServices, demoTask } from "../src/app/demo.js";
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
