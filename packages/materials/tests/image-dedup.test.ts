import assert from "node:assert/strict";
import test from "node:test";
import { dedupeImageRead, IMAGE_REINJECT_BUDGET } from "../src/runtime/coding-resources.js";

// A read result shaped like the framework's image read: a text placeholder plus
// the image content block. dedupeImageRead only inspects/rebuilds `content` and
// keys off the image block's `data`, so `data` is what varies across tests.
function imageResult(data = "BASE64DATA") {
  return {
    content: [
      { type: "text" as const, text: "Read image file [image/jpeg]" },
      { type: "image" as const, data, mimeType: "image/jpeg" },
    ],
  } as unknown as Parameters<typeof dedupeImageRead>[1];
}

const hasImage = (r: { content: Array<{ type: string }> }) => r.content.some((c) => c.type === "image");
const nudged = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.length === 1 && r.content[0]!.type === "text" && /already loaded this exact image/.test(r.content[0]!.text ?? "");

test(`the first ${IMAGE_REINJECT_BUDGET} reads of an image pass the pixels through, then the wrapper nudges`, () => {
  const seen = new Map<string, number>();
  for (let i = 0; i < IMAGE_REINJECT_BUDGET; i += 1) {
    const out = dedupeImageRead("work/flag.jpg", imageResult(), seen);
    assert.equal(hasImage(out), true, `read #${i + 1} should still deliver the image`);
    assert.equal(nudged(out), false);
  }
  const over = dedupeImageRead("work/flag.jpg", imageResult(), seen);
  assert.equal(hasImage(over), false, "over-budget read must NOT re-inject the image");
  assert.equal(nudged(over), true, "over-budget read must return the nudge");
  assert.match(over.content[0]!.text ?? "", /PIL|magick|POSITION|INDEX/);
});

test("changed file content RESETS the budget — a refreshed/cropped image is delivered again (P1)", () => {
  const seen = new Map<string, number>();
  const path = "work/shot.png";
  // Exhaust the budget on the original bytes.
  for (let i = 0; i < IMAGE_REINJECT_BUDGET + 1; i += 1) dedupeImageRead(path, imageResult("ORIGINAL"), seen);
  const blocked = dedupeImageRead(path, imageResult("ORIGINAL"), seen);
  assert.equal(hasImage(blocked), false, "same bytes past budget stay blocked");
  // Same path, DIFFERENT bytes (overwritten in place): must be delivered, not "unchanged".
  const refreshed = dedupeImageRead(path, imageResult("OVERWRITTEN-DIFFERENT-BYTES"), seen);
  assert.equal(hasImage(refreshed), true, "new content at the same path must be delivered");
  assert.equal(nudged(refreshed), false);
});

test("path aliases for the SAME bytes share one counter — no bypass by re-spelling the path (P2)", () => {
  const seen = new Map<string, number>();
  // Same content, different path spellings each read.
  const aliases = ["alias.png", "./alias.png", "../dir/alias.png", "/abs/alias.png"];
  const delivered = aliases.map((p) => hasImage(dedupeImageRead(p, imageResult("SAME"), seen)));
  // First two delivered (budget=2), third+ blocked — aliasing did not reset the count.
  assert.deepEqual(delivered, [true, true, false, false]);
});

test("distinct image CONTENT is counted independently", () => {
  const seen = new Map<string, number>();
  for (let i = 0; i < IMAGE_REINJECT_BUDGET + 1; i += 1) dedupeImageRead("a.jpg", imageResult("CONTENT-A"), seen);
  // Different bytes — fresh budget even though it is a different call.
  const b = dedupeImageRead("b.jpg", imageResult("CONTENT-B"), seen);
  assert.equal(hasImage(b), true);
  assert.equal(nudged(b), false);
});

test("the nudge keeps firing on every read past the budget (the loop stays broken)", () => {
  const seen = new Map<string, number>();
  for (let i = 0; i < IMAGE_REINJECT_BUDGET; i += 1) dedupeImageRead("work/flag.jpg", imageResult(), seen);
  for (let i = 0; i < 5; i += 1) {
    const out = dedupeImageRead("work/flag.jpg", imageResult(), seen);
    assert.equal(hasImage(out), false);
    assert.equal(nudged(out), true);
  }
});

test("without a per-run counter, dedup is a no-op (image always passes through)", () => {
  const out = dedupeImageRead("x.jpg", imageResult(), undefined);
  assert.equal(hasImage(out), true);
});
