import assert from "node:assert/strict";
import test from "node:test";
import { compileContextLayers, EventProjector, snipText, type AgentTool } from "../src/index.js";

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
