import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const smoke = resolve(root, "scripts", "browser-runtime-smoke.ts");

test("Browser smoke persists a bounded pass/skip deployment report", async () => {
  const reportDir = await mkdtemp(join(tmpdir(), "proofblade-browser-smoke-report-"));
  try {
    const reportPath = join(reportDir, "browser-smoke.json");
    const env = {
      ...process.env,
      PROOFBLADE_PLAYWRIGHT_MODULE: join(reportDir, "missing-playwright.mjs"),
      PROOFBLADE_BROWSER_SMOKE_REPORT: reportPath,
    };
    const optional = spawnSync(process.execPath, ["--import", "tsx", smoke], { cwd: root, env, encoding: "utf8" });
    assert.equal(optional.status, 0, optional.stderr);
    const stdout = JSON.parse(optional.stdout.trim());
    assert.deepEqual(stdout, {
      schemaVersion: 1,
      generatedAt: stdout.generatedAt,
      smoke: "browser-runtime",
      status: "skipped",
      reason: "Playwright is not installed",
    });
    const persisted = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(persisted, stdout);
    assert.match(persisted.generatedAt, /^\d{4}-\d{2}-\d{2}T/);

    const required = spawnSync(process.execPath, ["--import", "tsx", smoke, "--required"], { cwd: root, env, encoding: "utf8" });
    assert.equal(required.status, 2, required.stderr);
    assert.match(required.stdout, /"status":"skipped"/);
    const requiredReport = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(requiredReport.smoke, "browser-runtime");
    assert.equal(requiredReport.status, "skipped");
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
});
