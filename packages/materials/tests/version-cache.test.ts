import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProofBladeConfig } from "../src/config.js";
import { createCachedRunVersionSnapshot, createRunVersionSnapshot, skillInputFiles } from "../src/runtime/version.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "TEST_API_KEY",
      contextWindow: 4096,
      maxTokens: 512,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      input: ["text"],
    },
  },
} as ProofBladeConfig;

/** A project root with the inputs the version snapshot is derived from. */
async function project(withSkill = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "proofblade-version-cache-"));
  await writeFile(join(root, "proofblade.config.json"), JSON.stringify(config), "utf8");
  if (withSkill) {
    await mkdir(join(root, "skills", "alpha"), { recursive: true });
    await writeFile(join(root, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: first\n---\n\nbody\n", "utf8");
  }
  return root;
}

test("one snapshot is built per unchanged revision, not per call", async () => {
  const root = await project();
  try {
    const cache = createCachedRunVersionSnapshot(root, config);
    const first = await cache.provider();
    const second = await cache.provider();
    const third = await cache.provider();

    assert.equal(cache.buildCount(), 1, "an unchanged revision must reuse the snapshot");
    // Identity, not deep-equality: a rebuild would produce a new object.
    assert.equal(second, first);
    assert.equal(third, first);
    assert.ok(cache.revision());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent callers share one in-flight build", async () => {
  const root = await project();
  try {
    const cache = createCachedRunVersionSnapshot(root, config);
    const results = await Promise.all([cache.provider(), cache.provider(), cache.provider(), cache.provider()]);

    assert.equal(cache.buildCount(), 1, "a concurrent burst must not build the snapshot more than once");
    for (const result of results) assert.equal(result, results[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("editing a skill rebuilds the snapshot so the catalog hash cannot go stale", async () => {
  const root = await project();
  try {
    const cache = createCachedRunVersionSnapshot(root, config);
    const before = await cache.provider();
    assert.equal(cache.buildCount(), 1);

    await writeFile(join(root, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: edited\n---\n\nbody\n", "utf8");
    const after = await cache.provider();

    assert.equal(cache.buildCount(), 2, "a changed skill must invalidate the cached snapshot");
    assert.notEqual(after.skillCatalogHash, before.skillCatalogHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adding a skill directory rebuilds the snapshot", async () => {
  const root = await project();
  try {
    const cache = createCachedRunVersionSnapshot(root, config);
    const before = await cache.provider();

    await mkdir(join(root, "skills", "beta"), { recursive: true });
    await writeFile(join(root, "skills", "beta", "SKILL.md"), "---\nname: beta\ndescription: second\n---\n\nbody\n", "utf8");
    const after = await cache.provider();

    assert.equal(cache.buildCount(), 2);
    assert.equal(after.skills.length, before.skills.length + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed config value rebuilds the snapshot, and the file is not the input", async () => {
  // The revision keys on the values the builder reads out of the *parsed*
  // config, which is not the same thing as the config file. Keying on the file
  // left a live mismatch: the GUI rewrites `config.modelProfiles.executor` at
  // startup from provider settings, so a caller that changed the parsed config
  // in memory kept receiving a snapshot describing the previous values.
  const root = await project();
  try {
    const mutable = { ...config, runtime: { ...config.runtime }, modelProfiles: { executor: { ...config.modelProfiles.executor } } } as ProofBladeConfig;
    const cache = createCachedRunVersionSnapshot(root, mutable);
    const first = await cache.provider();
    assert.equal(first.piVersion, "0.83.0");
    const revisionBefore = cache.revision();

    mutable.runtime.piVersion = "0.84.0";
    const second = await cache.provider();

    assert.equal(cache.buildCount(), 2, "a changed parsed config value must invalidate the cached snapshot");
    assert.notEqual(cache.revision(), revisionBefore);
    assert.equal(second.piVersion, "0.84.0", "the rebuilt snapshot must describe the value it was given");

    // The file on disk was never touched, so the rebuild came from the value and
    // not from metadata: this is the half the old key got wrong.
    await writeFile(join(root, "proofblade.config.json"), JSON.stringify({ ...config, runtime: { piVersion: "9.9.9" } }), "utf8");
    const third = await cache.provider();
    assert.equal(cache.buildCount(), 2, "editing a config file the builder does not read must not rebuild");
    assert.equal(third.piVersion, "0.84.0", "and it must certainly not change what the snapshot reports");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed thinking level rebuilds the snapshot", async () => {
  const root = await project();
  try {
    const mutable = { ...config, runtime: { ...config.runtime }, modelProfiles: { executor: { ...config.modelProfiles.executor, thinkingLevel: "off" as const } } } as ProofBladeConfig;
    const cache = createCachedRunVersionSnapshot(root, mutable);
    await cache.provider();

    mutable.modelProfiles.executor.thinkingLevel = "high";
    const second = await cache.provider();

    assert.equal(cache.buildCount(), 2);
    assert.equal(second.thinkingLevel, "high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("editing .mcp.json rebuilds the snapshot", async () => {
  const root = await project();
  try {
    const cache = createCachedRunVersionSnapshot(root, config);
    await cache.provider();

    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { local: { command: "node", args: ["server.js"] } } }), "utf8");
    const revisionBefore = cache.revision();
    await cache.provider();

    assert.equal(cache.buildCount(), 2, "a changed .mcp.json must invalidate the cached snapshot");
    assert.notEqual(cache.revision(), revisionBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rewriting a file with identical bytes does not count as a change", async () => {
  // Proves the revision is content-derived rather than metadata-derived: the
  // rewrite moves mtime forward, so a `mtimeMs + size` key would report a change
  // and rebuild needlessly. The content digest must absorb that and keep serving
  // the cached snapshot.
  const root = await project();
  try {
    const cache = createCachedRunVersionSnapshot(root, config);
    const before = await cache.provider();
    const revisionBefore = cache.revision();

    const body = "---\nname: alpha\ndescription: first\n---\n\nbody\n";
    await new Promise((done) => setTimeout(done, 20));
    await writeFile(join(root, "skills", "alpha", "SKILL.md"), body, "utf8");
    const after = await cache.provider();

    assert.equal(cache.revision(), revisionBefore, "identical bytes must yield the identical revision");
    assert.equal(cache.buildCount(), 1, "an identical rewrite must not rebuild the snapshot");
    assert.equal(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a same-size, same-mtime rewrite is not hidden by the revision", async () => {
  // The revision is a digest of every input's bytes, so this does not depend on
  // being able to freeze the clock: no metadata key exists to reproduce itself.
  //
  // The mtime is frozen explicitly at a whole second. Restoring whatever
  // timestamp the write produced would compare against the filesystem's
  // rounding, and a sub-millisecond difference would fail the setup assertion for
  // a reason that has nothing to do with the revision.
  const root = await project();
  try {
    const skillPath = join(root, "skills", "alpha", "SKILL.md");
    const first = "---\nname: alpha\ndescription: aaaa\n---\n\nbody\n";
    const second = "---\nname: alpha\ndescription: bbbb\n---\n\nbody\n";
    assert.equal(Buffer.byteLength(first), Buffer.byteLength(second), "the two bodies must be the same length");
    const frozen = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    await writeFile(skillPath, first, "utf8");
    await utimes(skillPath, frozen, frozen);

    const cache = createCachedRunVersionSnapshot(root, config);
    const before = await cache.provider();
    const revisionBefore = cache.revision();
    const beforeStat = await stat(skillPath);

    assert.notEqual(first, second, "the bytes must actually differ");
    await writeFile(skillPath, second, "utf8");
    await utimes(skillPath, frozen, frozen);
    const afterStat = await stat(skillPath);
    assert.equal(afterStat.size, beforeStat.size, "the rewrite must keep the byte length");
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, "the rewrite must keep the modification time exactly, or this test proves nothing");

    const after = await cache.provider();
    assert.notEqual(cache.revision(), revisionBefore, "same-size, same-mtime different bytes must change the revision");
    assert.equal(cache.buildCount(), 2, "the snapshot must be rebuilt from the new bytes");
    assert.equal(after.skills.length, before.skills.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the revision never consults file metadata", async () => {
  // The structural half, and the part a filesystem cannot make vacuous. Why both
  // halves are needed, stated plainly because one of them is weaker than it looks:
  //
  // - the runtime assertion above fails for the *narrow* key
  //   (`path|size|mtimeMs`) that the first review round reported.
  // - it does NOT fail for the wide key (`path|ino|size|mtimeMs|ctimeMs`) on this
  //   filesystem, because a Windows in-place write moves `ctimeMs` and no ordinary
  //   writer can put that back. "Widening the key passes the test" would be true
  //   while the hole is still open, which is exactly what the third round found.
  //
  // So the digest path must reach `readFile` and must not touch metadata. Mutating
  // in either key shape fails this.
  const source = await readFile(join(import.meta.dirname, "../src/runtime/version.ts"), "utf8");
  const helper = source.slice(source.indexOf("async function fileDigest("), source.indexOf("async function canonicalOrResolved("));
  assert.ok(helper.length > 0, "fileDigest must exist");
  assert.match(helper, /readFile\(/, "the per-file digest must read the bytes");
  assert.doesNotMatch(helper, /stats\.(ino|mtimeMs|ctimeMs|size)/, "the digest must not depend on metadata");
  assert.doesNotMatch(source, /revisions\.get\(/, "there must be no metadata-keyed digest cache");
});
test("invalidate() forces the next call to rebuild", async () => {
  const root = await project();
  try {
    const cache = createCachedRunVersionSnapshot(root, config);
    await cache.provider();
    cache.invalidate();
    await cache.provider();

    assert.equal(cache.buildCount(), 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed build is not cached, so one transient read error does not become permanent", async () => {
  const root = await project();
  try {
    let attempts = 0;
    const broken = {
      ...config,
      get runtime(): ProofBladeConfig["runtime"] {
        attempts += 1;
        throw new Error("transient config read failure");
      },
    } as ProofBladeConfig;
    const cache = createCachedRunVersionSnapshot(root, broken);

    await assert.rejects(() => cache.provider(), /transient config read failure/);
    await assert.rejects(() => cache.provider(), /transient config read failure/);
    assert.equal(attempts, 2, "a rejected build must not be served from cache");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project with no skill root still produces a snapshot", async () => {
  const root = await project(false);
  try {
    const cache = createCachedRunVersionSnapshot(root, config);
    const snapshot = await cache.provider();

    assert.deepEqual(snapshot.skills, []);
    assert.equal(cache.buildCount(), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the cached provider returns the same value an uncached build would", async () => {
  const root = await project();
  try {
    const cache = createCachedRunVersionSnapshot(root, config);
    const cached = await cache.provider();
    const direct = await createRunVersionSnapshot(root, config);

    // The cache must be transparent: it may not change what a Run records.
    assert.deepEqual(cached, direct);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the revision cache is bounded and still correct after eviction", async () => {
  const root = await project();
  try {
    // Capacity 1 forces constant eviction; correctness must not depend on the
    // metadata cache still holding a previous entry.
    const cache = createCachedRunVersionSnapshot(root, config, { maxRevisionEntries: 1 });
    const first = await cache.provider();
    await writeFile(join(root, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: changed\n---\n\nbody\n", "utf8");
    const second = await cache.provider();

    assert.equal(cache.buildCount(), 2);
    assert.notEqual(second.skillCatalogHash, first.skillCatalogHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the cache rejects a capacity that cannot hold one revision", () => {
  assert.throws(() => createCachedRunVersionSnapshot(resolve("."), config, { maxRevisionEntries: 0 }), /positive integer/);
});

test("the revision covers every skill root the registry loads, recursively", async () => {
  // Review finding on this change: the revision walked only `skills/` and only
  // one level deep, while ProofBladeSkillRegistry.load() defaults to
  // ["skills", "skills-library/ctf-skills"] and recurses. In this repository the
  // vendored tree holds 11 of the 13 SKILL.md files, so a long-lived process kept
  // serving a snapshot built before a pull updated it, and every later Run's
  // run_started.versionSnapshot described the pre-pull catalog while the lanes
  // used the live one.
  //
  // This asserts agreement with the registry rather than a hardcoded count, so it
  // stays true if the vendored tree grows.
  const root = await mkdtemp(join(tmpdir(), "proofblade-version-skill-roots-"));
  try {
    // Two roots, and a nested directory inside the vendored one: the old walk
    // missed the second root entirely and would have missed the nested file even
    // had it looked.
    await mkdir(join(root, "skills", "alpha"), { recursive: true });
    await writeFile(join(root, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: a\n---\n\nbody\n", "utf8");
    await mkdir(join(root, "skills-library", "ctf-skills", "nested", "beta"), { recursive: true });
    await writeFile(join(root, "skills-library", "ctf-skills", "nested", "beta", "SKILL.md"), "---\nname: beta\ndescription: b\n---\n\nbody\n", "utf8");

    const before = await skillInputFiles(root);
    assert.equal(before.length, 2, "both roots must be walked, including the nested one");

    const cache = createCachedRunVersionSnapshot(root, config);
    const first = await cache.provider();
    const revisionBefore = cache.revision();

    // The vendored root is the one the old revision ignored.
    await writeFile(
      join(root, "skills-library", "ctf-skills", "nested", "beta", "SKILL.md"),
      "---\nname: beta\ndescription: changed\n---\n\nbody\n",
      "utf8",
    );

    const second = await cache.provider();
    assert.notEqual(cache.revision(), revisionBefore, "editing a vendored skill must move the revision");
    assert.equal(cache.buildCount(), 2, "and must rebuild the snapshot");
    assert.notEqual(second.skillCatalogHash, first.skillCatalogHash, "the catalog hash must reflect the vendored tree");
    assert.equal(second.skills.length, 2, "and both roots must appear in the snapshot");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
