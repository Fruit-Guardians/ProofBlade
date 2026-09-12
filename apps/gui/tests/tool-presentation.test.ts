import assert from "node:assert/strict";
import test from "node:test";
import { resultText, toolPresentation } from "../src/tool-presentation.js";

test("formats coding tool instructions and returned text for direct inspection", () => {
  const bash = toolPresentation("bash", { command: "npm test\n" }, { content: [{ type: "text", text: "64 tests passed" }] });
  assert.equal(bash.inputLabel, "执行指令");
  assert.equal(bash.summary, "npm test");
  assert.equal(bash.output, "64 tests passed");

  const read = toolPresentation("read", { path: "src/app.ts", offset: 10, limit: 20 }, { content: [{ type: "text", text: "source" }] });
  assert.equal(read.input, "src/app.ts\noffset: 10 · limit: 20");

  const edit = toolPresentation("edit", { path: "src/app.ts", oldText: "old", newText: "next" }, { details: { changed: true } });
  assert.equal(edit.summary, "src/app.ts");
  assert.match(edit.input, /查找:\nold/);
  assert.match(edit.input, /替换:\nnext/);
  assert.match(edit.output, /"changed": true/);

  const mcp = toolPresentation("mcp_call", { operation: "call", server: "local", tool: "search", arguments: { query: "proof" } }, undefined);
  assert.equal(mcp.summary, "call · local · search");
  assert.equal(mcp.output, "等待返回");

  const verification = toolPresentation("verify_claim", { candidate: "flag{derived}", command: "node solve.mjs" }, { details: { verified: true, evidenceId: "EV-1" } });
  assert.equal(verification.summary, "验证最终结果");
  assert.equal(verification.inputLabel, "验证指令");
  assert.match(verification.input, /node solve\.mjs/);
  assert.match(verification.input, /flag\{derived\}/);
  assert.equal(verification.outputLabel, "验证记录");

  const genericVerification = toolPresentation("verify_result", { result: "build passed", command: "npm test" }, { details: { verified: true } });
  assert.equal(genericVerification.summary, "验证最终结果");
  assert.match(genericVerification.input, /build passed/);
  assert.equal(genericVerification.outputLabel, "验证记录");

  const evidence = toolPresentation("evidence", {
    operation: "record",
    name: "EF01 受保护记录",
    artifactIds: ["A-1"],
  }, { details: { evidenceId: "EV-1", factId: "F-1" } });
  assert.equal(evidence.inputLabel, "记录证据");
  assert.equal(evidence.summary, "记录证据 · EF01 受保护记录");
  assert.equal(evidence.outputLabel, "证据图更新");
  assert.match(evidence.output, /F-1/);

  const forest = toolPresentation("evidence", { operation: "inspect_forest" }, { details: { trees: [] } });
  assert.equal(forest.inputLabel, "查看推理森林");
  assert.equal(forest.summary, "查看推理森林 · 摘要");

  const tree = toolPresentation("evidence", { operation: "inspect_tree", treeId: "TREE-1" }, { details: { nodes: [] } });
  assert.equal(tree.inputLabel, "展开推理树");
  assert.match(tree.summary, /TREE-1/);

  const link = toolPresentation("evidence", { operation: "link", from: "EV-1", to: "F-1", relation: "supports" }, { details: { edge: { id: "RE-1" } } });
  assert.equal(link.inputLabel, "连接推理节点");
  assert.match(link.summary, /EV-1 → F-1/);

  assert.equal(resultText({ result: { content: [{ type: "text", text: "nested" }] } }), "nested");
});
