import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProofBladeSkillRegistry, collectSkillFiles } from "../src/skills/registry.js";

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

test("a memo hit is indistinguishable from a fresh parse of the same tree", async () => {
  // The transparency test has to compare against a parse the memo did NOT
  // produce. Comparing two memo hits to each other passes even when the memo is
  // disabled, which is exactly the case it is supposed to catch.
  const root = await project();
  try {
    ProofBladeSkillRegistry.resetCache();
    const first = await ProofBladeSkillRegistry.load(root);
    const second = await ProofBladeSkillRegistry.load(root);
    assert.equal(ProofBladeSkillRegistry.cacheStats().hits, 1, "the second load must come from the memo");

    ProofBladeSkillRegistry.resetCache();
    const independent = await ProofBladeSkillRegistry.load(root);

    assert.equal(second.catalogHash(), independent.catalogHash());
    assert.deepEqual(second.list(), independent.list());
    assert.deepEqual(second.piSkills(), independent.piSkills());
    assert.deepEqual(second.diagnostics, independent.diagnostics);
    assert.equal(second.loadForModel("alpha").content, independent.loadForModel("alpha").content);
    // And the memo's own answer is not observable through the shape either.
    assert.equal(second.piSkills().length, first.piSkills().length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mutating a returned list does not reach the next memo hit", async () => {
  const root = await project();
  try {
    ProofBladeSkillRegistry.resetCache();
    const first = await ProofBladeSkillRegistry.load(root);
    first.list().push({ name: "injected", description: "", path: "", contentHash: "", disableModelInvocation: false });
    first.list()[0]!.description = "mutated";

    const second = await ProofBladeSkillRegistry.load(root);
    assert.equal(second.list().length, 1, "a caller's list edit must not become catalog state");
    assert.equal(second.list()[0]?.description, "first");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a direct *.md in the first root moves the revision", async () => {
  // `loadSkills` treats a direct root `.md` as a skill, so the walker must see
  // it: the original walker collected `SKILL.md` only, so adding one moved the
  // catalog without moving the revision.
  //
  // The catalog half of this is deliberately NOT asserted here. On Windows the
  // upstream loader drops root `.md` files and the registry therefore does not
  // gain a skill, because `NodeExecutionEnv` hands absolute backslash paths to
  // `ignore`, whose `relativeEnvPath(root, path)` then fails to strip the root
  // prefix and `ignore` rejects the absolute path. So the two halves differ by
  // platform, and the walker is written to be correct on the platform where the
  // loader does read them. Collecting it where the loader ignores it costs one
  // re-parse, which is the safe direction.
  const root = await project();
  try {
    ProofBladeSkillRegistry.resetCache();
    await ProofBladeSkillRegistry.load(root);

    await writeFile(join(root, "skills", "loose.md"), "---\nname: loose\ndescription: direct root file\n---\n\nbody\n", "utf8");

    await ProofBladeSkillRegistry.load(root);
    assert.equal(ProofBladeSkillRegistry.cacheStats().parses, 2, "a new direct root file must re-parse");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the walker collects every input the loader's rules depend on", async () => {
  // Measured directly against the walker, because this is the part that decides
  // whether the memo can go stale. `skills/` is the first root; a hidden
  // directory and `node_modules` must not contribute, an ignore file must.
  const root = await project();
  try {
    await mkdir(join(root, "skills", ".hidden"), { recursive: true });
    await writeFile(join(root, "skills", ".hidden", "SKILL.md"), "---\nname: hidden\ndescription: hidden\n---\n\nbody\n", "utf8");
    await mkdir(join(root, "skills", "node_modules", "dep"), { recursive: true });
    await writeFile(join(root, "skills", "node_modules", "dep", "SKILL.md"), "---\nname: dep\ndescription: dep\n---\n\nbody\n", "utf8");
    await writeFile(join(root, "skills", ".gitignore"), "generated/\n", "utf8");
    await writeFile(join(root, "skills", "notes.md"), "# notes\n", "utf8");

    const names = (await collectSkillFiles([join(root, "skills")])).map((entry) => entry.split("\u0000")[0]!.replace(/\\/g, "/"));
    assert.deepEqual(names.map((path) => path.slice(root.length + 1)).sort(), [
      "skills/.gitignore",
      "skills/alpha/SKILL.md",
      "skills/notes.md",
    ]);
    for (const entry of await collectSkillFiles([join(root, "skills")])) {
      assert.match(entry, /\u0000\d+\u0000\d+\u0000[\d.]+\u0000[\d.]+$/, "each entry must carry identity and metadata");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an ignore file in a skill root moves the revision", async () => {
  // The loader consults `.gitignore` / `.ignore` / `.fdignore` to prune its
  // walk. This walker includes the rule files themselves rather than
  // re-implementing the `ignore` matcher, so changing the rules always
  // invalidates -- a false invalidation costs one re-parse, a missed one serves
  // a catalog the rules no longer describe.
  const root = await project();
  try {
    ProofBladeSkillRegistry.resetCache();
    await ProofBladeSkillRegistry.load(root);

    await writeFile(join(root, "skills", ".gitignore"), "beta/\n", "utf8");

    await ProofBladeSkillRegistry.load(root);
    assert.equal(ProofBladeSkillRegistry.cacheStats().parses, 2, "changed ignore rules must re-parse");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second root's loose *.md moves the revision even though it adds no skill", async () => {
  // m10 from the third review round. The registry drops non-SKILL.md *skills*
  // from roots after the first, so this file never becomes a skill -- but the
  // upstream loader still reads it as one and reports `invalid_metadata` for it,
  // and the registry copies every loader diagnostic into `registry.diagnostics`,
  // which the CLI prints. So the file IS an input to the registry's observable
  // output, and excluding it from the walker let it change that output without
  // moving the revision. The walker now collects it for every root, which is a
  // conservative superset: it can cause a re-parse that was not needed, never a
  // stale catalog.
  const root = await mkdtemp(join(tmpdir(), "proofblade-skill-cache-second-"));
  try {
    await mkdir(join(root, "skills", "alpha"), { recursive: true });
    await writeFile(join(root, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: first\n---\n\nbody\n", "utf8");
    await mkdir(join(root, "skills-library", "ctf-skills"), { recursive: true });
    await writeFile(join(root, "skills-library", "ctf-skills", "README.md"), "# vendored docs\n", "utf8");

    ProofBladeSkillRegistry.resetCache();
    await ProofBladeSkillRegistry.load(root);
    await ProofBladeSkillRegistry.load(root);
    assert.equal(ProofBladeSkillRegistry.cacheStats().hits, 1);

    // Editing the loose doc must invalidate: it is not a skill, but it is an
    // input to the diagnostics the registry exposes.
    ProofBladeSkillRegistry.resetCache();
    await ProofBladeSkillRegistry.load(root);
    await writeFile(join(root, "skills-library", "ctf-skills", "README.md"), "# vendored docs, edited\n", "utf8");
    const after = await ProofBladeSkillRegistry.load(root);
    assert.equal(ProofBladeSkillRegistry.cacheStats().hits, 0, "a second-root loose doc is an input to diagnostics");
    assert.equal(ProofBladeSkillRegistry.cacheStats().parses, 2, "so it must force a re-parse");
    assert.deepEqual(after.list().map((skill) => skill.name), ["alpha"], "and still contribute no skill");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent cold loads share one walk and one parse", async () => {
  // Both the version snapshot and every lane creation load this registry, so a
  // cold cache is hit by several callers at once. Without single-flight they
  // each walk the tree and each parse it.
  const root = await project();
  try {
    ProofBladeSkillRegistry.resetCache();
    const loaded = await Promise.all([
      ProofBladeSkillRegistry.load(root),
      ProofBladeSkillRegistry.load(root),
      ProofBladeSkillRegistry.load(root),
      ProofBladeSkillRegistry.load(root),
    ]);

    assert.equal(ProofBladeSkillRegistry.cacheStats().parses, 1, "concurrent cold loads must parse once");
    assert.equal(ProofBladeSkillRegistry.cacheStats().hits, 0, "the waiters are not cache hits");
    assert.equal(new Set(loaded).size, 1, "every caller must receive the same registry");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a load that throws does not poison the single-flight entry", async () => {
  const root = await project();
  try {
    ProofBladeSkillRegistry.resetCache();
    await ProofBladeSkillRegistry.load(root);
    // A later load of the same key must still be able to parse, i.e. the
    // in-flight map is cleared on both settlement paths.
    ProofBladeSkillRegistry.resetCache();
    const registry = await ProofBladeSkillRegistry.load(root);
    assert.deepEqual(registry.list().map((skill) => skill.name), ["alpha"]);
    assert.equal(ProofBladeSkillRegistry.cacheStats().parses, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a link cycle in a skill root terminates and counts each file once", async () => {
  // m9 from the third review round. Following directory symlinks is deliberate
  // -- the loader recurses by entry kind, so the walker has to as well -- but
  // without a visited set a link back to an ancestor recurses to the path-length
  // limit once per level, pushing the same `SKILL.md` repeatedly. The old walker
  // skipped these entries (`Dirent.isDirectory()` is false for a link), so this
  // is a risk the symlink-following change introduced.
  //
  // A Windows junction is what is available without elevation, and it is the same
  // shape of hazard: `readdir` reports it as a symbolic link and `stat` follows it
  // to a directory.
  const root = await project();
  try {
    const loop = join(root, "skills", "loop");
    try {
      execFileSync("cmd", ["/c", "mklink", "/J", loop, root], { stdio: "ignore" });
    } catch {
      return; // No junction support on this host; the property is untestable here.
    }

    const entries = await collectSkillFiles([join(root, "skills")]);
    const paths = entries.map((entry) => entry.split("\u0000")[0]!);
    assert.equal(
      paths.filter((path) => path.endsWith("SKILL.md")).length,
      1,
      "a cycle must not make the walker push the same file once per level",
    );
    assert.deepEqual([...new Set(paths)], paths, "no path may be collected twice");
  } finally {
    // The junction has to go before the tree it points into, or `rm` recurses
    // through it.
    await rm(join(root, "skills", "loop"), { recursive: true, force: true }).catch(() => undefined);
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
