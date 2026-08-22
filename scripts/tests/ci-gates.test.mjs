import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveAuditTimestamp } from "../audit-time.mjs";
import { canonicalComponentContent } from "../component-audit-lib.mjs";
import { componentTransitionErrors } from "../component-transition-lib.mjs";
import { changeContractErrors } from "../change-contract-lib.mjs";
import { requiresProjectStatus } from "../project-report-change-lib.mjs";
import { selectTestCommands } from "../check-changed-tests.mjs";

test("[contract:unchanged-source-no-reaudit] rejects audit churn without a source change", () => {
  const previous = metadata({ version: "1.2.3", updatedAt: "2026-08-07T10:00:00+08:00", count: 4, hash: "a".repeat(64) });
  const current = metadata({ version: "1.2.4", updatedAt: "2026-08-07T11:00:00+08:00", count: 5, hash: "a".repeat(64) });
  const errors = componentTransitionErrors({ componentId: "atoms", previous, current, sourceChanged: false, documentChanged: true });
  assert.deepEqual(errors, ["atoms: qualityAudit must not change when component source is unchanged"]);

  const reordered = { ...current, qualityAudit: Object.fromEntries(Object.entries(previous.qualityAudit).reverse()) };
  assert.deepEqual(componentTransitionErrors({ componentId: "atoms", previous, current: reordered, sourceChanged: false, documentChanged: true }), []);
});

test("[contract:single-audit-increment] [contract:parallel-source-change] accepts source changes without mutating shared audit snapshots", () => {
  const previous = metadata({ version: "1.2.3", updatedAt: "2026-08-07T10:00:00+08:00", count: 4, hash: "a".repeat(64) });
  assert.deepEqual(componentTransitionErrors({ componentId: "gui", previous, current: previous, sourceChanged: true, documentChanged: false }), []);
  const independentlyAudited = metadata({ version: "1.9.0", updatedAt: "2026-08-07T11:00:00+08:00", count: 9, hash: "b".repeat(64) });
  assert.deepEqual(componentTransitionErrors({ componentId: "gui", previous, current: independentlyAudited, sourceChanged: true, documentChanged: true }), []);
});

test("[contract:stale-audit-repair] permits exactly one correction to the computed source hash", () => {
  const stale = metadata({ version: "1.2.3", updatedAt: "2026-08-07T10:00:00Z", count: 4, hash: "a".repeat(64) });
  const repaired = metadata({ version: "1.2.4", updatedAt: "2026-08-07T11:00:00Z", count: 5, hash: "b".repeat(64) });
  assert.deepEqual(componentTransitionErrors({
    componentId: "materials",
    previous: stale,
    current: repaired,
    sourceChanged: false,
    documentChanged: true,
    expectedSourceHash: "b".repeat(64),
  }), []);

  const wrongHash = metadata({ version: "1.2.4", updatedAt: "2026-08-07T11:00:00Z", count: 5, hash: "c".repeat(64) });
  assert.deepEqual(componentTransitionErrors({
    componentId: "materials",
    previous: stale,
    current: wrongHash,
    sourceChanged: false,
    documentChanged: true,
    expectedSourceHash: "b".repeat(64),
  }), ["materials: qualityAudit must not change when component source is unchanged"]);

  const jumped = metadata({ version: "1.2.4", updatedAt: "2026-08-07T11:00:00Z", count: 6, hash: "b".repeat(64) });
  const errors = componentTransitionErrors({ componentId: "materials", previous: stale, current: jumped, sourceChanged: false, documentChanged: true, expectedSourceHash: "b".repeat(64) });
  assert.equal(errors.some((error) => error.includes("bugAuditCount must increase exactly once")), true);
});

test("[contract:cross-platform-source-hash] normalizes text line endings without decoding binary files", () => {
  const lf = canonicalComponentContent("source.ts", Buffer.from("one\ntwo\n"));
  const crlf = canonicalComponentContent("source.ts", Buffer.from("one\r\ntwo\r\n"));
  assert.deepEqual(crlf, lf);

  const binary = Buffer.from([0xff, 0x0d, 0x0a, 0x00]);
  assert.equal(canonicalComponentContent("fixture.bin", binary), binary);
});

test("[contract:parallel-project-status] ordinary source PRs do not mutate shared project status", () => {
  assert.equal(requiresProjectStatus("packages/materials/src/runtime/coding-lane.ts"), false);
  assert.equal(requiresProjectStatus("apps/gui/src/server.ts"), false);
  assert.equal(requiresProjectStatus("packages/materials/src/runtime/COMPONENT.md"), false);
  assert.equal(requiresProjectStatus("scripts/check-component-docs.mjs"), false);
  assert.equal(requiresProjectStatus("README.md"), true);
  assert.equal(requiresProjectStatus("project-status.json"), true);
});

test("change contracts require executable scenario markers only when a trigger changes", () => {
  const manifest = {
    schemaVersion: 1,
    contracts: [{
      id: "shutdown",
      triggers: [{ path: "server.ts", patterns: ["shutdown"] }],
      testPaths: ["tests/"],
      scenarios: ["contract:shutdown-failure"],
    }],
  };
  const missing = changeContractErrors({
    manifest,
    changedFiles: new Set(["server.ts"]),
    diffs: new Map([["server.ts", "+const shutdown = true;"]]),
    testFiles: new Map([["tests/server.test.ts", "test('happy path', () => {})"]]),
  });
  assert.equal(missing.length, 1);
  assert.match(missing[0], /contract:shutdown-failure/);

  const covered = changeContractErrors({
    manifest,
    changedFiles: new Set(["server.ts"]),
    diffs: new Map([["server.ts", "+const shutdown = true;"]]),
    testFiles: new Map([["tests/server.test.ts", "test('[contract:shutdown-failure]', () => {})"]]),
  });
  assert.deepEqual(covered, []);
  assert.deepEqual(changeContractErrors({ manifest, changedFiles: new Set(["readme.md"]), diffs: new Map(), testFiles: new Map() }), []);
});

test("change contracts reject malformed regex and non-normalized test paths", () => {
  const errors = changeContractErrors({
    manifest: {
      schemaVersion: 1,
      contracts: [{
        id: "invalid",
        triggers: [{ path: "server.ts", patterns: ["("] }],
        testPaths: ["tests\\"],
        scenarios: ["contract:shutdown-failure"],
      }],
    },
    changedFiles: new Set(),
    diffs: new Map(),
    testFiles: new Map(),
  });
  assert.deepEqual(errors, ["invalid: trigger paths and regular expressions must be valid and normalized"]);
});

test("changed-test matrix maps source changes to existing targeted commands", () => {
  const manifest = {
    schemaVersion: 1,
    rules: [{ id: "runtime", sourceGlobs: ["packages/materials/src/runtime/**"], testGlobs: ["packages/materials/tests/runtime.test.ts"], command: "node --test packages/materials/tests/runtime.test.ts" }],
  };
  const selected = selectTestCommands({ root: process.cwd(), manifest, changedFiles: new Set(["packages/materials/src/runtime/foo.ts"]) });
  assert.equal(selected.errors.length, 1, "the synthetic test file must be reported as missing");
  assert.match(selected.errors[0], /mapped test file is missing/);
});

test("changed-test matrix rejects uncovered production source", () => {
  const selected = selectTestCommands({ root: process.cwd(), manifest: { schemaVersion: 1, rules: [] }, changedFiles: new Set(["packages/materials/src/unknown/new.ts"]) });
  assert.deepEqual(selected.commands, []);
  assert.deepEqual(selected.errors, ["packages/materials/src/unknown/new.ts: no test-matrix rule covers this source file"]);
});

test("[contract:component-audit-time-fallback] resolves audit time from explicit, environment, commit, then clock", () => {
  const now = new Date("2026-08-08T10:00:00.000Z");
  assert.equal(resolveAuditTimestamp({ explicit: "2026-08-08T08:00:00Z", now }), "2026-08-08T08:00:00.000Z");
  assert.equal(resolveAuditTimestamp({ env: { COMPONENT_AUDIT_AT: "2026-08-08T08:30:00Z" }, gitCommitAt: "2026-08-08T07:00:00Z", now }), "2026-08-08T08:30:00.000Z");
  assert.equal(resolveAuditTimestamp({ gitCommitAt: "2026-08-08T09:00:00Z", now }), "2026-08-08T09:00:00.000Z");
  const directory = mkdtempSync(join(tmpdir(), "proofblade-audit-time-"));
  const eventPath = join(directory, "event.json");
  writeFileSync(eventPath, JSON.stringify({ pull_request: { updated_at: "2026-08-08T09:30:00Z" } }));
  assert.equal(resolveAuditTimestamp({ eventPath, gitCommitAt: "2026-08-08T09:00:00Z", now }), "2026-08-08T09:30:00.000Z");
  rmSync(directory, { recursive: true, force: true });
  assert.equal(resolveAuditTimestamp({ now }), "2026-08-08T10:00:00.000Z");
});

function metadata({ version, updatedAt, count, hash }) {
  return {
    version,
    updatedAt,
    qualityAudit: {
      bugAuditCount: count,
      securityAuditCount: count,
      lastBugAuditAt: updatedAt,
      lastSecurityAuditAt: updatedAt,
      sourceHash: hash,
      result: "passed",
    },
  };
}
