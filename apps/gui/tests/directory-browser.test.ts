import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { listDirectories, requireDirectory } from "../src/directory-browser.js";

test("lists and validates selectable working directories", async () => {
  const tempRoot = join(resolve(import.meta.dirname, "../../.."), "tmp");
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, "directory-browser-"));
  const child = join(root, "child");
  const file = join(root, "file.txt");
  await mkdir(child);
  await writeFile(file, "fixture");
  try {
    assert.equal(await requireDirectory(child), child);
    const listing = await listDirectories(root, root);
    assert.equal(listing.path, root);
    assert.deepEqual(listing.directories, [{ name: "child", path: child }]);
    await assert.rejects(() => requireDirectory(file), /不是文件夹/);
    await assert.rejects(() => requireDirectory("relative/path"), /绝对路径/);
    await assert.rejects(() => requireDirectory(join(root, "missing")), /不存在/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
