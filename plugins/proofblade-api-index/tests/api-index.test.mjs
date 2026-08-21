import assert from "node:assert/strict";
import test from "node:test";
import { collectApi } from "../scripts/collector.mjs";
import { findDuplicateCandidates } from "../scripts/duplicates.mjs";
import { renderAgentContext, renderMarkdown } from "../scripts/renderer.mjs";

const repoRoot = new URL("../../../", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)).replaceAll("/", "\\");

test("collects deterministic atoms exports with signatures, comments, tests, and no absolute paths", () => {
  const index = collectApi({ repoRoot, packageId: "atoms" });
  assert.equal(index.package, "@proofblade/atoms");
  assert.equal("sourceHash" in index, false);
  assert.ok(Object.values(index.moduleHashes).length > 0);
  assert.ok(Object.values(index.moduleHashes).every((hash) => hash.length === 64));
  assert.ok(index.symbols.length >= 20);
  const canonical = index.symbols.find((symbol) => symbol.name === "canonicalJson");
  assert.ok(canonical);
  assert.match(canonical.summary, /deterministically/);
  assert.ok(canonical.testRefs.some((path) => path.endsWith("packages/atoms/tests/atoms.test.ts")));
  assert.ok(index.symbols.every((symbol) => !/[A-Za-z]:\\|^\//.test(symbol.module)));
  assert.ok(index.symbols.some((symbol) => symbol.name === "KeyedOperationQueue.run" && symbol.kind === "method"));
});

test("renderers are deterministic and contain the generated marker", () => {
  const index = collectApi({ repoRoot, packageId: "atoms" });
  assert.equal(renderMarkdown(index), renderMarkdown(index));
  assert.equal(renderAgentContext(index), renderAgentContext(index));
  assert.match(renderMarkdown(index), /GENERATED FILE/);
  assert.match(renderAgentContext(index), /canonicalJson/);
});

test("duplicate detector separates exact duplicates from structural candidates", () => {
  const make = (id, signature, structureHash) => ({ id, package: "fixture", name: id, kind: "function", visibility: "public", signature, summary: "same summary", module: "src/index.ts", line: 1, structureHash });
  const report = findDuplicateCandidates([{ package: "fixture", symbols: [make("one", "(): string", "same") ] }, { package: "fixture", symbols: [make("one", "(): string", "same"), make("three", "(value: string): string", "same")] }]);
  assert.equal(report.counts.exact, 1);
  assert.equal(report.counts.candidates, 1);
  assert.equal(report.exact[0].status, "error");
  assert.equal(report.candidates[0].status, "candidate");
});
