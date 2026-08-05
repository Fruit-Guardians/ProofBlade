import assert from "node:assert/strict";
import test from "node:test";
import { captureProviderPrefixShape, compareProviderPrefixShapes } from "../src/index.js";

test("provider prefix shape ignores dynamic turns but detects system and tool changes", () => {
  const first = captureProviderPrefixShape({
    messages: [
      { role: "system", content: "stable instructions" },
      { role: "user", content: "turn one secret text" },
    ],
    tools: [tool("read"), tool("bash")],
  });
  const dynamicOnly = captureProviderPrefixShape({
    messages: [
      { content: "stable instructions", role: "system" },
      { role: "user", content: "different turn text" },
      { role: "assistant", content: "different response" },
    ],
    tools: [tool("read"), tool("bash")],
  });
  assert.equal(first.prefixHash, dynamicOnly.prefixHash);
  assert.deepEqual(compareProviderPrefixShapes(first, dynamicOnly), { changed: false, reasons: [] });
  assert.equal(first.instructionMessageCount, 1);
  assert.equal(first.toolCount, 2);
  assert.ok(first.toolSchemaTokens > 0);

  const changedSystem = captureProviderPrefixShape({ messages: [{ role: "system", content: "changed" }], tools: [tool("read"), tool("bash")] });
  assert.deepEqual(compareProviderPrefixShapes(first, changedSystem), { changed: true, reasons: ["system"] });

  const reorderedTools = captureProviderPrefixShape({ messages: [{ role: "system", content: "stable instructions" }], tools: [tool("bash"), tool("read")] });
  assert.deepEqual(compareProviderPrefixShapes(first, reorderedTools), { changed: true, reasons: ["tools"] });
});

test("provider prefix shape records rewrite version without retaining prompt text", () => {
  const first = captureProviderPrefixShape({ messages: [{ role: "developer", content: "sensitive body" }], tools: [] }, 1);
  const second = captureProviderPrefixShape({ messages: [{ role: "developer", content: "sensitive body" }], tools: [] }, 2);
  assert.deepEqual(compareProviderPrefixShapes(first, second), { changed: true, reasons: ["rewrite"] });
  assert.doesNotMatch(JSON.stringify(first), /sensitive body/);
});

function tool(name: string): Record<string, unknown> {
  return { type: "function", function: { name, description: `${name} tool`, parameters: { type: "object", properties: {} } } };
}
