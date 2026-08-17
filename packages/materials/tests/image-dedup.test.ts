import assert from "node:assert/strict";
import test from "node:test";
import { dedupeImageRead, IMAGE_REINJECT_BUDGET } from "../src/runtime/coding-resources.js";

// A read result shaped like the framework's image read: a text placeholder plus
// the image content block. `as never`-free by using the minimal shape the tool
// returns; dedupeImageRead only inspects/rebuilds `content`.
function imageResult() {
  return {
    content: [
      { type: "text" as const, text: "Read image file [image/jpeg]" },
      { type: "image" as const, data: "BASE64DATA", mimeType: "image/jpeg" },
    ],
  } as Awaited<ReturnType<Parameters<typeof dedupeImageRead>[1] extends infer _ ? never : never>> extends never
    ? Parameters<typeof dedupeImageRead>[1]
    : never;
}

const hasImage = (r: { content: Array<{ type: string }> }) => r.content.some((c) => c.type === "image");
const nudged = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.length === 1 && r.content[0]!.type === "text" && /already loaded this image/.test(r.content[0]!.text ?? "");

test(`the first ${IMAGE_REINJECT_BUDGET} reads of an image pass the pixels through, then the wrapper nudges`, () => {
  const seen = new Map<string, number>();
  const path = "work/flag.jpg";
  for (let i = 0; i < IMAGE_REINJECT_BUDGET; i += 1) {
    const out = dedupeImageRead(path, imageResult(), seen);
    assert.equal(hasImage(out), true, `read #${i + 1} should still deliver the image`);
    assert.equal(nudged(out), false);
  }
  // The (budget+1)-th read drops the image and returns the guidance text instead.
  const over = dedupeImageRead(path, imageResult(), seen);
  assert.equal(hasImage(over), false, "over-budget read must NOT re-inject the image");
  assert.equal(nudged(over), true, "over-budget read must return the nudge");
  assert.match(over.content[0]!.text ?? "", /crop|POSITION|INDEX/);
});

test("the nudge keeps firing on every read past the budget (the loop stays broken)", () => {
  const seen = new Map<string, number>();
  const path = "work/flag.jpg";
  for (let i = 0; i < IMAGE_REINJECT_BUDGET; i += 1) dedupeImageRead(path, imageResult(), seen);
  for (let i = 0; i < 5; i += 1) {
    const out = dedupeImageRead(path, imageResult(), seen);
    assert.equal(hasImage(out), false);
    assert.equal(nudged(out), true);
  }
  assert.equal(seen.get(path), IMAGE_REINJECT_BUDGET + 5);
});

test("distinct image files are counted independently", () => {
  const seen = new Map<string, number>();
  // Exhaust the budget for A.
  for (let i = 0; i < IMAGE_REINJECT_BUDGET + 1; i += 1) dedupeImageRead("a.jpg", imageResult(), seen);
  // B is still fresh — its first read must deliver the image.
  const b = dedupeImageRead("b.jpg", imageResult(), seen);
  assert.equal(hasImage(b), true);
  assert.equal(nudged(b), false);
});

test("without a per-run counter, dedup is a no-op (image always passes through)", () => {
  const out = dedupeImageRead("x.jpg", imageResult(), undefined);
  assert.equal(hasImage(out), true);
});
