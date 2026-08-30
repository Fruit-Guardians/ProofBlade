import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildPromptCacheMetadata, cacheHitRate, capabilityCatalogHash, compileContextLayers, EventProjector, FileArtifactRepository, planContextMaintenance, snipText, type AgentTool, withCapabilityHash } from "../src/index.js";

test("molecules extend atoms without application knowledge", async () => {
  const tool: AgentTool<object, { value: number }, number, undefined> = {
    name: "double",
    description: "double a value",
    parameters: {},
    execute: async ({ value }) => value * 2,
  };
  assert.equal(await tool.execute({ value: 3 }, undefined), 6);

  const projector = new EventProjector(() => 0, (state, event: { seq: number; amount: number }) => state + event.amount);
  assert.equal(projector.replay([{ seq: 1, amount: 2 }, { seq: 2, amount: 3 }]), 5);
  const context = compileContextLayers([{ id: "base", content: "stable", required: true }]);
  assert.equal(context.messages[0]?.content, "stable");
  const snipped = snipText("A".repeat(200), 80);
  assert.equal(snipped.truncated, true);
  assert.equal(snipped.text.length <= 80, true);
  assert.equal(snipped.originalChars, 200);
});

test("file artifact ranges enforce bounded byte-oriented reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-molecule-artifact-"));
  try {
    const repository = new FileArtifactRepository(root);
    const artifact = await repository.put("artifact.txt", "A\u4f60B\u597dC", "text/plain");
    const expected = Buffer.from("A\u4f60B\u597dC").subarray(2, 6);

    const range = await repository.readRange(artifact, 2, 4);
    assert.deepEqual(Buffer.from(range.content), expected);
    assert.equal(range.totalBytes, artifact.bytes);
    assert.equal(range.truncated, true);

    const beyondEnd = await repository.readRange(artifact, artifact.bytes + 10, 4);
    assert.equal(beyondEnd.content.byteLength, 0);
    assert.equal(beyondEnd.truncated, false);
    await assert.rejects(repository.readRange(artifact, -1, 4), /offset/);
    await assert.rejects(repository.readRange(artifact, 0, 10_000_001), /maxBytes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context maintenance escalates deterministically", () => {
  assert.equal(planContextMaintenance(400, 1_000).stage, "stable");
  assert.equal(planContextMaintenance(570, 1_000).stage, "notice");
  const snip = planContextMaintenance(650, 1_000);
  assert.equal(snip.stage, "snip");
  assert.equal(snip.shouldPrune, false);
  assert.equal(planContextMaintenance(760, 1_000).stage, "prune");
  assert.equal(planContextMaintenance(820, 1_000).stage, "compact");
  const forced = planContextMaintenance(950, 1_000);
  assert.equal(forced.stage, "compact");
  assert.equal(forced.forceCompact, true);
});

test("capability manifest hashes are independent of operation insertion order", () => {
  const first = withCapabilityHash({
    id: "sample",
    version: "1.0.0",
    description: "sample",
    trust: "bundled",
    operations: [
      { name: "b", description: "b", parameters: {}, readOnly: true, sideEffect: "none", replay: "pure", outputPolicy: "inline", executionMode: "sequential" },
      { name: "a", description: "a", parameters: {}, readOnly: true, sideEffect: "none", replay: "pure", outputPolicy: "inline", executionMode: "sequential" },
    ],
  });
  const second = withCapabilityHash({ ...first, operations: [...first.operations].reverse() });
  assert.equal(first.hash, second.hash);
  assert.equal(capabilityCatalogHash([first]), capabilityCatalogHash([second]));
});

test("prompt cache metadata keeps the stable prefix independent from dynamic turns", () => {
  const first = buildPromptCacheMetadata([
    { id: "L0", content: "standing instructions", stablePrefix: true },
    { id: "L1", content: "task contract", stablePrefix: true },
    { id: "L2", content: "phase: reconnaissance", stablePrefix: false },
    { id: "L4", content: "turn one", stablePrefix: false },
  ]);
  const second = buildPromptCacheMetadata([
    { id: "L0", content: "standing instructions", stablePrefix: true },
    { id: "L1", content: "task contract", stablePrefix: true },
    { id: "L2", content: "phase: experiment", stablePrefix: false },
    { id: "L4", content: "turn two", stablePrefix: false },
  ]);
  assert.equal(first.prefixHash, second.prefixHash);
  assert.notEqual(first.dynamicHash, second.dynamicHash);
  assert.deepEqual(first.prefixLayerIds, ["L0", "L1"]);
  assert.deepEqual(first.dynamicLayerIds, ["L2", "L4"]);
  assert.equal(cacheHitRate({ input: 80, cacheRead: 20, cacheWrite: 0 }), 0.2);
});
