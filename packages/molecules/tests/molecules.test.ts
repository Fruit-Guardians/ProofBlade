import assert from "node:assert/strict";
import test from "node:test";
import { buildPromptCacheMetadata, cacheHitRate, capabilityCatalogHash, compileContextLayers, EventProjector, planContextMaintenance, snipText, type AgentTool, withCapabilityHash } from "../src/index.js";

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

test("context maintenance escalates deterministically", () => {
  assert.equal(planContextMaintenance(400, 1_000).stage, "stable");
  assert.equal(planContextMaintenance(520, 1_000).stage, "notice");
  assert.equal(planContextMaintenance(650, 1_000).stage, "snip");
  assert.equal(planContextMaintenance(820, 1_000).stage, "prune");
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
