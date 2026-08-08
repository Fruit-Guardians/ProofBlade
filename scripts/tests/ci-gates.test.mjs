import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveAuditTimestamp } from "../audit-time.mjs";
import { canonicalComponentContent } from "../component-audit-lib.mjs";
import { componentTransitionErrors } from "../component-transition-lib.mjs";
import { changeContractErrors } from "../change-contract-lib.mjs";

test("[contract:unchanged-source-no-reaudit] rejects audit churn without a source change", () => {
  const previous = metadata({ version: "1.2.3", updatedAt: "2026-08-07T10:00:00+08:00", count: 4, hash: "a".repeat(64) });
  const current = metadata({ version: "1.2.4", updatedAt: "2026-08-07T11:00:00+08:00", count: 5, hash: "a".repeat(64) });
  const errors = componentTransitionErrors({ componentId: "atoms", previous, current, sourceChanged: false, documentChanged: true });
  assert.deepEqual(errors, ["atoms: qualityAudit must not change when component source is unchanged"]);

  const reordered = { ...current, qualityAudit: Object.fromEntries(Object.entries(previous.qualityAudit).reverse()) };
  assert.deepEqual(componentTransitionErrors({ componentId: "atoms", previous, current: reordered, sourceChanged: false, documentChanged: true }), []);
});

test("[contract:single-audit-increment] accepts one audit and rejects a multi-count jump", () => {
  const previous = metadata({ version: "1.2.3", updatedAt: "2026-08-07T10:00:00+08:00", count: 4, hash: "a".repeat(64) });
  const valid = metadata({ version: "1.3.0", updatedAt: "2026-08-07T11:00:00+08:00", count: 5, hash: "b".repeat(64) });
  assert.deepEqual(componentTransitionErrors({ componentId: "gui", previous, current: valid, sourceChanged: true, documentChanged: true }), []);

  const jumped = metadata({ version: "1.3.0", updatedAt: "2026-08-07T11:00:00+08:00", count: 6, hash: "b".repeat(64) });
  const errors = componentTransitionErrors({ componentId: "gui", previous, current: jumped, sourceChanged: true, documentChanged: true });
  assert.equal(errors.some((error) => error.includes("bugAuditCount must increase exactly once")), true);
  assert.equal(errors.some((error) => error.includes("securityAuditCount must increase exactly once")), true);
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
