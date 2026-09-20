import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProofBladeConfig } from "../src/config.js";
import { createCachedRunVersionSnapshot, createRunVersionSnapshot } from "../src/runtime/version.js";

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

test("editing the config file rebuilds the snapshot", async () => {
  const root = await project();
  try {
    const cache = createCachedRunVersionSnapshot(root, config);
    await cache.provider();

    await writeFile(join(root, "proofblade.config.json"), JSON.stringify({ ...config, runtime: { piVersion: "0.84.0" } }), "utf8");
    // The provider is built from the config object it was handed, so assert on
    // the rebuild and on the revision moving rather than on the new piVersion.
    const revisionBefore = cache.revision();
    await cache.provider();

    assert.equal(cache.buildCount(), 2, "a changed config file must invalidate the cached snapshot");
    assert.notEqual(cache.revision(), revisionBefore);
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
