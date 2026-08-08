import assert from "node:assert/strict";
import test from "node:test";
import { RepeatedToolFailureBreaker, repeatedToolFailureMessage } from "../src/runtime/tool-repeat-breaker.js";

const failed = (input: Record<string, unknown>, text = "tool rejected the arguments") => ({
  toolName: "evidence",
  input,
  isError: true,
  content: [{ type: "text", text }],
});

test("[contract:evidence-repeat-breaker] repeated tool failures terminate after a bounded number of identical calls", () => {
  const breaker = new RepeatedToolFailureBreaker(3);
  assert.equal(breaker.observe(failed({ operation: "inspect_forest", maxChars: 12000 })).terminate, false);
  assert.equal(breaker.observe(failed({ operation: "inspect_forest", maxChars: 12000 })).terminate, false);
  const decision = breaker.observe(failed({ operation: "inspect_forest", maxChars: 12000 }));
  assert.equal(decision.count, 3);
  assert.equal(decision.terminate, true);
  assert.match(repeatedToolFailureMessage("evidence", decision.count), /infinite loop/);
});

test("successful or different tool calls reset the repeated failure sequence", () => {
  const breaker = new RepeatedToolFailureBreaker(3);
  breaker.observe(failed({ operation: "inspect_forest" }));
  breaker.observe(failed({ operation: "inspect_tree", treeId: "TREE-1" }));
  assert.equal(breaker.observe(failed({ operation: "inspect_forest" })).count, 1);
  assert.equal(breaker.observe({ toolName: "evidence", input: { operation: "record" }, isError: false, content: [{ type: "text", text: "ok" }] }).count, 0);
  assert.equal(breaker.observe(failed({ operation: "inspect_forest" })).count, 1);
});
