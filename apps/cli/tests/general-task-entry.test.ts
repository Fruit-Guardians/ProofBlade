import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("CLI exposes generic task lifecycle commands for security templates", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "src", "main.ts"), "utf8");
  assert.match(source, /case "task"/);
  assert.match(source, /task templates/);
  assert.match(source, /task create <task-id>/);
  assert.match(source, /task run <task-id>/);
  assert.match(source, /task status <task-id>/);
  assert.match(source, /task cancel <task-id>/);
  assert.doesNotMatch(source, /case "ctf"/);
  assert.doesNotMatch(source, /case "solve"/);
});
