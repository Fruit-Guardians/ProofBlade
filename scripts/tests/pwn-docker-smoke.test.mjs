import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const smoke = resolve(root, "scripts", "pwn-docker-smoke.ts");

test("Pwn Docker smoke is explicit about missing deployment dependencies", () => {
  const env = { ...process.env, PROOFBLADE_PWN_SMOKE_IMAGE: "" };
  const optional = spawnSync(process.execPath, ["--import", "tsx", smoke], { cwd: root, env, encoding: "utf8" });
  assert.equal(optional.status, 0, optional.stderr);
  assert.deepEqual(JSON.parse(optional.stdout.trim()), {
    smoke: "pwn-docker",
    status: "skipped",
    reason: "PROOFBLADE_PWN_SMOKE_IMAGE is not set; use a pinned image or digest in the deployment environment",
  });

  const required = spawnSync(process.execPath, ["--import", "tsx", smoke, "--required"], { cwd: root, env, encoding: "utf8" });
  assert.equal(required.status, 2, required.stderr);
  assert.match(required.stdout, /"status":"skipped"/);

  const mutable = spawnSync(process.execPath, ["--import", "tsx", smoke, "--required"], {
    cwd: root,
    env: { ...env, PROOFBLADE_PWN_SMOKE_IMAGE: "alpine:3.20" },
    encoding: "utf8",
  });
  assert.equal(mutable.status, 2, mutable.stderr);
  assert.match(mutable.stdout, /immutable image digest/);
});

test("Pwn Docker fault matrix is an explicit deployment gate and can persist evidence", async () => {
  const matrix = resolve(root, "scripts", "pwn-docker-fault-matrix.ts");
  const reportDir = await mkdtemp(join(tmpdir(), "proofblade-pwn-docker-report-"));
  try {
    const reportPath = join(reportDir, "fault-matrix.json");
    const env = { ...process.env, PROOFBLADE_PWN_SMOKE_IMAGE: "", PROOFBLADE_PWN_FAULT_MATRIX_REPORT: reportPath };
    const optional = spawnSync(process.execPath, ["--import", "tsx", matrix], { cwd: root, env, encoding: "utf8" });
    assert.equal(optional.status, 0, optional.stderr);
    const payload = JSON.parse(optional.stdout.trim());
    assert.deepEqual(payload, {
      smoke: "pwn-docker-fault-matrix",
      status: "skipped",
      reason: "PROOFBLADE_PWN_SMOKE_IMAGE is not set; use a pinned image or digest in the deployment environment",
    });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(report, { schemaVersion: 1, generatedAt: report.generatedAt, ...payload });
    assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T/);

    const required = spawnSync(process.execPath, ["--import", "tsx", matrix, "--required"], { cwd: root, env, encoding: "utf8" });
    assert.equal(required.status, 2, required.stderr);
    assert.match(required.stdout, /"status":"skipped"/);

    const mutable = spawnSync(process.execPath, ["--import", "tsx", matrix, "--required"], {
      cwd: root,
      env: { ...env, PROOFBLADE_PWN_SMOKE_IMAGE: "alpine:3.20" },
      encoding: "utf8",
    });
    assert.equal(mutable.status, 2, mutable.stderr);
    assert.match(mutable.stdout, /immutable image digest/);
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
});
