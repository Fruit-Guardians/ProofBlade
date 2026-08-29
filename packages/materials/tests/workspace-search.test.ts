import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { globWorkspace, grepWorkspace } from "../src/runtime/workspace-search.js";

test("workspace glob is deterministic, recursive, bounded, and scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-search-"));
  try {
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, "src", "main.ts"), "export const main = true;\n");
    await writeFile(join(root, "src", "nested", "util.ts"), "export const util = true;\n");
    await writeFile(join(root, "README.md"), "readme\n");
    await writeFile(join(root, ".git", "ignored.ts"), "ignored\n");

    assert.deepEqual((await globWorkspace({ cwd: root, pattern: "**/*.ts" })).matches, ["src/main.ts", "src/nested/util.ts"]);
    assert.deepEqual((await globWorkspace({ cwd: root, pattern: "src/*.ts" })).matches, ["src/main.ts"]);
    assert.deepEqual((await globWorkspace({ cwd: root, pattern: "**/*", maxResults: 1 })).matches, ["README.md"]);
    await assert.rejects(() => globWorkspace({ cwd: root, pattern: "../**/*" }), /inside the workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace grep returns line indexes and skips binary or oversized files", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-grep-"));
  try {
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "a.txt"), "Alpha\nneedle here\nalpha again\n");
    await writeFile(join(root, "nested", "b.txt"), "NEEDLE nested\n");
    await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, "large.txt"), "needle\n".repeat(2_000));
    const result = await grepWorkspace({ cwd: root, query: "needle", caseSensitive: false, maxFileBytes: 6_000 });
    assert.deepEqual(result.matches.map((match) => [match.path, match.line]), [["a.txt", 2], ["nested/b.txt", 1]]);
    assert.equal(result.filesSkipped, 2);
    assert.equal(result.truncated, false);

    const exactLimit = await grepWorkspace({ cwd: root, pattern: "a.txt", query: "alpha", caseSensitive: false, maxResults: 2 });
    assert.deepEqual(exactLimit.matches.map((match) => match.line), [1, 3]);
    assert.equal(exactLimit.totalMatches, 2);
    assert.equal(exactLimit.truncated, false);

    const bounded = await grepWorkspace({ cwd: root, pattern: "a.txt", query: "alpha", caseSensitive: false, maxResults: 1 });
    assert.deepEqual(bounded.matches.map((match) => match.line), [1]);
    assert.equal(bounded.totalMatches, 2);
    assert.equal(bounded.truncated, true);

    await assert.rejects(() => grepWorkspace({ cwd: root, query: "   " }), /non-empty/);
    await assert.rejects(() => grepWorkspace({ cwd: root, query: "needle", maxResults: 0 }), /maxResults/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
