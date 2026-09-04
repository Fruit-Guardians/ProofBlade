import assert from "node:assert/strict";
import test from "node:test";
import { boundModelText } from "../src/domain/text-bounds.js";

test("UTF-8 text bounds honor low token budgets for multibyte content", () => {
  const bounded = boundModelText("中".repeat(100), 1_000, 16);
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(bounded.text, "utf8") <= 16);
  assert.ok(Buffer.byteLength(bounded.text, "utf8") <= 16);
});

test("UTF-8 text bounds do not split surrogate pairs", () => {
  const bounded = boundModelText("🙂".repeat(100), 1_000, 16);
  assert.ok(Buffer.byteLength(bounded.text, "utf8") <= 16);
  assert.doesNotMatch(bounded.text, /[\uD800-\uDFFF]/u);
});
