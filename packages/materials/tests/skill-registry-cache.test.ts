import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProofBladeSkillRegistry } from "../src/skills/registry.js";

/** A minimal skill tree with one skill. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "proofblade-skill-cache-"));
  await mkdir(join(root, "skills", "alpha"), { recursive: true });
  await writeFile(join(root, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: first\n---\n\nbody\n", "utf8");
  return root;
}

test("a second load of an unchanged tree is served from the memo", async () => {
  // Parsing every SKILL.md costs ~30ms and both the version snapshot and every
  // lane creation load this registry, so the parse must not repeat.
  const root = await project();
  try {
    ProofBladeSkillRegistry.resetCache();
    const first = await ProofBladeSkillRegistry.load(root);
    const afterFirst = ProofBladeSkillRegistry.cacheStats();
    assert.equal(afterFirst.parses, 1, "the first load must parse");
    assert.equal(afterFirst.hits, 0);

    const second = await ProofBladeSkillRegistry.load(root);
    const afterSecond = ProofBladeSkillRegistry.cacheStats();
    assert.equal(afterSecond.parses, 1, "an unchanged tree must not re-parse");
    assert.equal(afterSecond.hits, 1);
    assert.equal(second, first, "the memo serves the same registry instance");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("editing a skill file invalidates the memo", async () => {
  const root = await project();
  try {
    ProofBladeSkillRegistry.resetCache();
    const before = await ProofBladeSkillRegistry.load(root);
    const hashBefore = before.catalogHash();

    // The mtime must move, so the write cannot land in the same tick.
    await new Promise((done) => setTimeout(done, 20));
    await writeFile(join(root, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: edited\n---\n\nbody\n", "utf8");

    const after = await ProofBladeSkillRegistry.load(root);
    assert.equal(ProofBladeSkillRegistry.cacheStats().parses, 2, "a changed skill must re-parse");
    assert.notEqual(after.catalogHash(), hashBefore, "the change must reach the catalog hash");
    assert.equal(after.list()[0]?.description, "edited");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adding a skill invalidates the memo", async () => {
  const root = await project();
  try {
    ProofBladeSkillRegistry.resetCache();
    const before = await ProofBladeSkillRegistry.load(root);

    await mkdir(join(root, "skills", "beta"), { recursive: true });
    await writeFile(join(root, "skills", "beta", "SKILL.md"), "---\nname: beta\ndescription: second\n---\n\nbody\n", "utf8");

    const after = await ProofBladeSkillRegistry.load(root);
    assert.equal(ProofBladeSkillRegistry.cacheStats().parses, 2);
    assert.equal(after.list().length, before.list().length + 1);
    assert.deepEqual(after.list().map((skill) => skill.name).sort(), ["alpha", "beta"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removing a skill invalidates the memo", async () => {
  const root = await project();
  try {
    ProofBladeSkillRegistry.resetCache();
    await ProofBladeSkillRegistry.load(root);

    await rm(join(root, "skills", "alpha"), { recursive: true, force: true });

    const after = await ProofBladeSkillRegistry.load(root);
    assert.equal(ProofBladeSkillRegistry.cacheStats().parses, 2);
    assert.deepEqual(after.list(), [], "a deleted skill must disappear from the catalog");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("different project roots do not share a memo entry", async () => {
  const first = await project();
  const second = await project();
  try {
    ProofBladeSkillRegistry.resetCache();
    const a = await ProofBladeSkillRegistry.load(first);
    const b = await ProofBladeSkillRegistry.load(second);

    assert.equal(ProofBladeSkillRegistry.cacheStats().parses, 2, "a distinct root must parse on its own");
    assert.notEqual(a, b);
    // Skill paths are reported relative to the root they came from.
    assert.equal(a.list()[0]?.path, "skills/alpha/SKILL.md");
    assert.equal(b.list()[0]?.path, "skills/alpha/SKILL.md");
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test("an explicitly different skill directory list is a distinct key", async () => {
  const root = await project();
  try {
    ProofBladeSkillRegistry.resetCache();
    await ProofBladeSkillRegistry.load(root);
    // The same root with a different directory list must not reuse the entry:
    // the catalog would otherwise silently keep the other list's skills.
    const narrow = await ProofBladeSkillRegistry.load(root, ["skills"]);
    assert.equal(ProofBladeSkillRegistry.cacheStats().parses, 2);
    assert.deepEqual(narrow.list().map((skill) => skill.name), ["alpha"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing skill root yields an empty catalog without throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-skill-cache-empty-"));
  try {
    ProofBladeSkillRegistry.resetCache();
    const registry = await ProofBladeSkillRegistry.load(root);
    assert.deepEqual(registry.list(), []);

    // And the empty result is itself memoized.
    await ProofBladeSkillRegistry.load(root);
    assert.equal(ProofBladeSkillRegistry.cacheStats().hits, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a memo hit returns a registry that still answers identically", async () => {
  // The cache must be transparent: callers cannot observe whether they were
  // served from it.
  const root = await project();
  try {
    ProofBladeSkillRegistry.resetCache();
    const first = await ProofBladeSkillRegistry.load(root);
    const second = await ProofBladeSkillRegistry.load(root);

    assert.equal(second.catalogHash(), first.catalogHash());
    assert.deepEqual(second.list(), first.list());
    assert.deepEqual(second.piSkills(), first.piSkills());
    assert.deepEqual(second.diagnostics, first.diagnostics);
    assert.equal(second.loadForModel("alpha").content, first.loadForModel("alpha").content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resetCache clears both the memo and the counters", async () => {
  const root = await project();
  try {
    ProofBladeSkillRegistry.resetCache();
    await ProofBladeSkillRegistry.load(root);
    await ProofBladeSkillRegistry.load(root);
    assert.deepEqual(ProofBladeSkillRegistry.cacheStats(), { parses: 1, hits: 1 });

    ProofBladeSkillRegistry.resetCache();
    assert.deepEqual(ProofBladeSkillRegistry.cacheStats(), { parses: 0, hits: 0 });
    await ProofBladeSkillRegistry.load(root);
    assert.equal(ProofBladeSkillRegistry.cacheStats().parses, 1, "the memo must be gone after a reset");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
