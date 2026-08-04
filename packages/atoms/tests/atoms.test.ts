import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, KeyedOperationQueue, sha256, type ToolAtom } from "../src/index.js";

test("atoms are deterministic and independently usable", async () => {
  const tool: ToolAtom = { name: "read", description: "read data", parameters: { type: "object" } };
  assert.equal(tool.name, "read");
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(sha256("proofblade").length, 64);

  const queue = new KeyedOperationQueue();
  const order: number[] = [];
  await Promise.all([1, 2, 3].map((value) => queue.run("stream", async () => { order.push(value); })));
  assert.deepEqual(order, [1, 2, 3]);
});
