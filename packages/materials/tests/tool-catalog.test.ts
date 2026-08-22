import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootstrapToolCatalog, ProofBladeToolCatalogRegistry, TOOL_CATALOG_MANIFEST } from "../src/tools/catalog.js";

const MANIFEST = (tools: unknown[]): string => JSON.stringify({ schemaVersion: 1, tools }, null, 2);

test("missing manifest degrades to an empty catalog with a diagnostic, never throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-toolcat-missing-"));
  try {
    const registry = await ProofBladeToolCatalogRegistry.load(root);
    assert.equal(registry.size, 0);
    assert.equal(registry.promptBlock(), "");
    assert.ok(registry.diagnostics.some((item) => item.code === "manifest_missing"));
    assert.equal(registry.catalogHash().length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid manifest JSON degrades to an empty catalog with a diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-toolcat-invalid-"));
  try {
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), "{ not json", "utf8");
    const registry = await ProofBladeToolCatalogRegistry.load(root);
    assert.equal(registry.size, 0);
    assert.ok(registry.diagnostics.some((item) => item.code === "manifest_invalid"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valid manifest loads entries, normalizes paths, and hashes deterministically", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-toolcat-valid-"));
  try {
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), MANIFEST([
      { id: "ghidra", name: "ghidra-headless", kind: "tool", path: "C:\\tools\\ghidra\\analyzeHeadless.bat", description: "无头 Ghidra" },
      { id: "py311", name: "python311", kind: "interpreter", path: "C:/Users/chriz/.pyenv/3.11/python.exe", description: "固定 Python 3.11" },
    ]), "utf8");
    const first = await ProofBladeToolCatalogRegistry.load(root);
    const second = await ProofBladeToolCatalogRegistry.load(root);
    assert.equal(first.size, 2);
    // Ids sorted; backslashes normalized to forward slashes.
    assert.deepEqual(first.list().map((e) => e.id), ["ghidra", "py311"]);
    assert.equal(first.get("ghidra")!.path, "C:/tools/ghidra/analyzeHeadless.bat");
    assert.equal(first.catalogHash(), second.catalogHash());
    assert.equal(first.catalogHash().length, 64);
    assert.equal(first.get("ghidra")!.contentHash.length, 64);
    await assert.doesNotReject(async () => first.probe());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog hash is order-insensitive and sensitive to content changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-toolcat-hash-"));
  try {
    const alpha = [
      { id: "a", name: "a", kind: "tool" as const, path: "C:/t/a.exe", description: "tool A" },
      { id: "b", name: "b", kind: "interpreter" as const, path: "C:/t/b.exe", description: "tool B" },
    ];
    const reversed = [alpha[1], alpha[0]];
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), MANIFEST(alpha), "utf8");
    const sorted = await ProofBladeToolCatalogRegistry.load(root);
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), MANIFEST(reversed), "utf8");
    const reordered = await ProofBladeToolCatalogRegistry.load(root);
    assert.equal(sorted.catalogHash(), reordered.catalogHash());
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), MANIFEST([{ ...alpha[0], description: "tool A changed" }, alpha[1]]), "utf8");
    const changed = await ProofBladeToolCatalogRegistry.load(root);
    assert.notEqual(sorted.catalogHash(), changed.catalogHash());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog hash covers the injected path/doc but excludes the unused category", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-toolcat-path-covered-"));
  try {
    const base = { id: "py", name: "py", kind: "interpreter", description: "fixed python" };
    const manifest = (tool: Record<string, unknown>) => MANIFEST([tool]);
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), manifest({ ...base, path: "C:/one/python.exe" }));
    const hPath1 = (await ProofBladeToolCatalogRegistry.load(root)).catalogHash();
    // changing path IS injected into the prompt, so the hash must change
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), manifest({ ...base, path: "C:/two/python.exe" }));
    const hPath2 = (await ProofBladeToolCatalogRegistry.load(root)).catalogHash();
    assert.notEqual(hPath1, hPath2, "changing path (which the prompt injects) must change catalogHash");
    // changing doc is injected into the coding prompt, so it must change too
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), manifest({ ...base, path: "C:/two/python.exe", doc: "C:/doc/a.md" }));
    const hDoc1 = (await ProofBladeToolCatalogRegistry.load(root)).catalogHash();
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), manifest({ ...base, path: "C:/two/python.exe", doc: "C:/doc/b.md" }));
    const hDoc2 = (await ProofBladeToolCatalogRegistry.load(root)).catalogHash();
    assert.notEqual(hDoc1, hDoc2, "changing doc (injected into the coding prompt) must change catalogHash");
    // category is never injected into any prompt, so it must NOT churn the hash
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), manifest({ ...base, path: "C:/two/python.exe", category: "web" }));
    const hCat1 = (await ProofBladeToolCatalogRegistry.load(root)).catalogHash();
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), manifest({ ...base, path: "C:/two/python.exe", category: "crypto" }));
    const hCat2 = (await ProofBladeToolCatalogRegistry.load(root)).catalogHash();
    assert.equal(hCat1, hCat2, "changing the unused category must not change catalogHash");
    // description change still changes the hash
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), manifest({ ...base, path: "C:/two/python.exe", description: "different python" }));
    const hDesc = (await ProofBladeToolCatalogRegistry.load(root)).catalogHash();
    assert.notEqual(hPath1, hDesc);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promptBlock groups by kind, escapes content, and is empty for an empty catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-toolcat-render-"));
  try {
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), MANIFEST([
      { id: "x", name: "x&y", kind: "tool", path: "C:/t/x.exe", description: "a <script> & more" },
      { id: "go", name: "go", kind: "toolchain", path: "C:/go/bin/go.exe", description: "Go toolchain" },
    ]), "utf8");
    const block = (await ProofBladeToolCatalogRegistry.load(root)).promptBlock();
    assert.match(block, /^<tool-catalog catalog-hash="[0-9a-f]{64}">/);
    assert.match(block, /<tool name="x&amp;y" kind="tool" path="C:\/t\/x\.exe">a &lt;script&gt; &amp; more<\/tool>/);
    assert.match(block, /kind="toolchain"/);
    assert.doesNotMatch(block, /kind="interpreter"/);
    assert.match(block, /<\/tool-catalog>$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid entries are dropped with diagnostics while valid entries stay", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-toolcat-invalid-entry-"));
  try {
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), MANIFEST([
      { id: "good", name: "good", kind: "tool", path: "C:/t/good.exe", description: "ok" },
      { id: "bad-kind", name: "bad-kind", kind: "wizard", path: "C:/t/bad.exe", description: "bad kind" },
      { id: "rel", name: "rel", kind: "tool", path: "relative/path.exe", description: "relative" },
      { id: "no-name", kind: "tool", path: "C:/t/no.exe", description: "no name" },
      { id: "no-path", name: "no-path", kind: "tool", description: "no path" },
    ]), "utf8");
    const registry = await ProofBladeToolCatalogRegistry.load(root);
    // "no-name" has no "name"; the id is used as the fallback name, so it stays.
    assert.deepEqual(registry.list().map((e) => e.id), ["good", "no-name"]);
    assert.equal(registry.get("no-name")!.name, "no-name");
    const codes = registry.diagnostics.map((d) => d.code);
    assert.ok(codes.includes("invalid_entry"));
    assert.ok(codes.includes("relative_path"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate ids keep the first entry and record a diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-toolcat-dup-"));
  try {
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), MANIFEST([
      { id: "same", name: "first", kind: "tool", path: "C:/t/first.exe", description: "first" },
      { id: "same", name: "second", kind: "tool", path: "C:/t/second.exe", description: "second" },
    ]), "utf8");
    const registry = await ProofBladeToolCatalogRegistry.load(root);
    assert.equal(registry.size, 1);
    assert.equal(registry.get("same")!.path, "C:/t/first.exe");
    assert.ok(registry.diagnostics.some((item) => item.code === "duplicate_id"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("probe reports missing paths as diagnostics without changing the catalog hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-toolcat-probe-"));
  try {
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), MANIFEST([
      { id: "ghost", name: "ghost", kind: "tool", path: "C:/definitely/not/here/ghost.exe", description: "missing" },
    ]), "utf8");
    const registry = await ProofBladeToolCatalogRegistry.load(root);
    const before = registry.catalogHash();
    const warnings = await registry.probe();
    assert.ok(warnings.some((item) => item.code === "path_missing"));
    assert.equal(registry.catalogHash(), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("contextSnapshot returns the catalog fields for RuntimeResourceSnapshot merging", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-toolcat-snapshot-"));
  try {
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), MANIFEST([
      { id: "py", name: "py", kind: "interpreter", path: "C:/py/python.exe", description: "python" },
    ]), "utf8");
    const registry = await ProofBladeToolCatalogRegistry.load(root);
    const snapshot = registry.contextSnapshot();
    assert.equal(snapshot.toolCatalogHash, registry.catalogHash());
    assert.deepEqual(snapshot.toolCatalog, [{ id: "py", name: "py", kind: "interpreter", path: "C:/py/python.exe", description: "python" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("container mode suppresses the host-local catalog entirely", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-toolcat-container-"));
  try {
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), MANIFEST([
      { id: "php", name: "php", kind: "interpreter", path: "C:/Web/php/php.exe", description: "host php" },
    ]), "utf8");
    const disabled = await ProofBladeToolCatalogRegistry.load(root, { container: true });
    const emptyHash = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"; // sha256("[]")
    assert.equal(disabled.isDisabled, true);
    assert.equal(disabled.size, 0);
    assert.deepEqual(disabled.list(), []);
    assert.equal(disabled.get("php"), undefined);
    assert.equal(disabled.promptBlock(), "");
    assert.equal(disabled.catalogHash(), emptyHash);
    assert.deepEqual(disabled.contextSnapshot(), { toolCatalogHash: emptyHash, toolCatalog: [] });
    assert.deepEqual(await disabled.probe(), []);
    // The same root WITHOUT the container flag still loads the entries.
    const enabled = await ProofBladeToolCatalogRegistry.load(root);
    assert.equal(enabled.isDisabled, false);
    assert.equal(enabled.size, 1);
    assert.notEqual(enabled.catalogHash(), emptyHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrap resolves a reviewed executable list once and refuses accidental overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-toolcat-bootstrap-"));
  try {
    const spec = { id: "node", name: "node", kind: "tool" as const, description: "Node runtime", candidates: [process.execPath], profiles: ["multi"] };
    const first = await bootstrapToolCatalog(root, [spec]);
    assert.equal(first.entries[0]?.id, "node");
    assert.equal(first.missing.length, 0);
    await assert.rejects(() => bootstrapToolCatalog(root, [spec]), /already exists/);
    const refreshed = await bootstrapToolCatalog(root, [spec], { force: true });
    assert.equal(refreshed.overwritten, true);
    assert.equal((await ProofBladeToolCatalogRegistry.load(root)).size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selectForProfile keeps only prepared direction entries and common tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-toolcat-profile-"));
  try {
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), MANIFEST([
      { id: "rev", name: "rev", kind: "tool", path: "C:/t/rev.exe", description: "reverse", profiles: ["reverse"] },
      { id: "web", name: "web", kind: "tool", path: "C:/t/web.exe", description: "web", category: "web" },
      { id: "common", name: "common", kind: "tool", path: "C:/t/common.exe", description: "common", category: "multi" },
    ]), "utf8");
    const registry = await ProofBladeToolCatalogRegistry.load(root);
    assert.deepEqual(registry.selectForProfile("reverse").map((entry) => entry.id), ["common", "rev"]);
    const block = registry.promptBlock("reverse");
    assert.match(block, /name="rev"/);
    assert.match(block, /name="common"/);
    assert.doesNotMatch(block, /name="web"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
