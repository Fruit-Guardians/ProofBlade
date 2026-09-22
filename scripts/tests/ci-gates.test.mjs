import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveAuditTimestamp } from "../audit-time.mjs";
import { canonicalComponentContent } from "../component-audit-lib.mjs";
import { componentTransitionErrors } from "../component-transition-lib.mjs";
import { changeContractErrors } from "../change-contract-lib.mjs";
import { requiresProjectStatus } from "../project-report-change-lib.mjs";
import { selectTestCommands } from "../check-changed-tests.mjs";
import { PROJECT_REPORT_FILES, loadProjectStatus, renderProjectReports } from "../project-report-lib.mjs";

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

test("CI always archives staged watchdog logs", () => {
  const workflow = readFileSync(resolve(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
  assert.match(workflow, /name: Upload staged test logs/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /uses: actions\/upload-artifact@v4/);
  assert.match(workflow, /path: \.proofblade\/test-logs\/\*\*\/\*\.log/);
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

test("every script typechecks, with no exclusion left to hide breakage", () => {
  // `scripts/**` belonged to no TypeScript project, so `tsc -b` could not see it:
  // `npm run baseline:tools -- --json` shipped with a `ReferenceError` on a name
  // that exists only inside a function, and neither the build nor any test
  // reached that branch. `tsconfig.scripts.json` closes the class.
  //
  // Three scripts were excluded at first, and that list turned out to be hiding a
  // real type error in each of them (four unchecked calls on a
  // `BrowserContextPort | BrowserVerifierContextHandle` union, a `ProofBladeConfig`
  // literal seven fields short, and a narrowing lost inside a closure). All three
  // are fixed, so the list is empty and this test now pins it that way: an entry
  // here means a script nobody typechecks, which is how the ReferenceError shipped
  // in the first place. The `allowImportingTsExtensions` assertion is the other
  // half -- two hosts import their sibling by path with an explicit `.ts`, and
  // dropping the flag would force those files back onto the exclusion list.
  const config = JSON.parse(readFileSync(resolve(process.cwd(), "tsconfig.scripts.json"), "utf8"));
  assert.deepEqual(
    config.exclude ?? [],
    [],
    "an entry in tsconfig.scripts.json's exclude list hides a real type error; fix the script instead",
  );
  assert.ok(config.include.includes("scripts/**/*.ts"), "the project must include the scripts it gates");
  assert.equal(
    config.compilerOptions?.allowImportingTsExtensions,
    true,
    "the path-launched hosts import their siblings with a .ts extension; without this flag they cannot be checked",
  );
  const root = JSON.parse(readFileSync(resolve(process.cwd(), "tsconfig.json"), "utf8"));
  assert.ok(
    root.references.some((reference) => reference.path === "./tsconfig.scripts.json"),
    "the scripts project must be in the root build so `tsc -b` and `npm run build` typecheck it",
  );
});

test("the provider-free baseline script can emit JSON", () => {
  // The `--json` branch is the one no test or build reached; asserting the source
  // shape keeps this cheap, and the CI step that runs the script exercises it for
  // real. Both are needed: the shape check is what fails at review time.
  const source = readFileSync(resolve(process.cwd(), "scripts", "tool-hot-path-baseline.ts"), "utf8");
  const emitted = source.slice(source.indexOf("if (asJson)"), source.indexOf("} else {"));
  assert.match(emitted, /JSON\.stringify\(/, "the --json branch must serialise something");
  assert.doesNotMatch(
    emitted,
    /JSON\.stringify\(\{\s*iterations,\s*summaries\s*\}/,
    "`summaries` only exists inside printReport; serialising it throws at runtime",
  );
});

test("the project reports are deterministic and carry the ledger's content", () => {
  // The byte-comparison gate over `docs/project/*.md` no longer has teeth: those
  // files are untracked and CI generates them immediately before checking them, so
  // `check:project-reports` is guaranteed to pass and a renderer regression is
  // invisible. Re-tracking them is what produced the merge conflicts this removed,
  // so the resolution is to test the generator here -- the job that gate was doing
  // -- and to state the tradeoff rather than keep a gate that cannot fail.
  const files = renderProjectReports(process.cwd());
  assert.deepEqual([...files.keys()].sort(), Object.values(PROJECT_REPORT_FILES).sort());
  for (const [path, text] of files) {
    assert.ok(text.length > 0, `${path} must not be empty`);
    assert.match(text, /\S/, `${path} must contain non-whitespace`);
  }

  // Deterministic: the same ledger renders the same bytes, which is what lets the
  // reports stay untracked and still be reproducible in CI.
  const again = renderProjectReports(process.cwd());
  assert.deepEqual(again, files, "rendering must be a pure function of project-status.json");

  // And the content is the ledger's, not a stub: every plan, update and completion
  // id has to appear in the report that lists it.
  const status = loadProjectStatus(process.cwd());
  const plan = files.get(PROJECT_REPORT_FILES.plan);
  const updates = files.get(PROJECT_REPORT_FILES.updates);
  const completions = files.get(PROJECT_REPORT_FILES.completions);
  for (const item of status.plans) {
    assert.ok(plan.includes(item.id), `PLAN.md must list ${item.id}`);
  }
  for (const update of status.updates) {
    assert.ok(updates.includes(update.id), `UPDATE_LOG.md must list ${update.id}`);
  }
  for (const completion of status.completions ?? []) {
    assert.ok(completions.includes(completion.id), `COMPLETION_REPORT.md must list ${completion.id}`);
  }
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
