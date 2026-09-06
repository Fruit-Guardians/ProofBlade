import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("GUI keeps one general task entry instead of a CTF-specific top-level action", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "src", "App.tsx"), "utf8");
  assert.doesNotMatch(source, /CTF 解题/);
  assert.doesNotMatch(source, /CtfSolveModal|startCtfSolve|ctfOpen/);
  assert.match(source, /新建对话/);
  assert.match(source, /安全任务模板/);
  assert.doesNotMatch(source, /startSolve|createFixtureConversation|\/api\/solve|\/api\/fixture-conversations/);
});

test("evidence Artifact panels toggle closed and use bounded preview loading", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "src", "App.tsx"), "utf8");
  assert.match(source, /if \(open\) \{ setOpen\(false\); return; \}/);
  assert.match(source, /继续加载/);
  assert.match(source, /appendArtifactPreview/);
  assert.match(source, /nextArtifactPreviewOffset/);
});
