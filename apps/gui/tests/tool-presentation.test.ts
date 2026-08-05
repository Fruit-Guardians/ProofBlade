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
  assert.equal(verification.summary, "复现最终结论");
  assert.equal(verification.inputLabel, "复现指令");
  assert.match(verification.input, /node solve\.mjs/);
  assert.match(verification.input, /flag\{derived\}/);
  assert.equal(verification.outputLabel, "验证记录");

  const evidence = toolPresentation("evidence", {
    operation: "record",
    name: "EF01 受保护记录",
    artifactIds: ["A-1"],
  }, { details: { evidenceId: "EV-1", factId: "F-1" } });
  assert.equal(evidence.inputLabel, "记录证据");
  assert.equal(evidence.summary, "记录证据 · EF01 受保护记录");
  assert.equal(evidence.outputLabel, "证据图更新");
  assert.match(evidence.output, /F-1/);

  assert.equal(resultText({ result: { content: [{ type: "text", text: "nested" }] } }), "nested");
});
