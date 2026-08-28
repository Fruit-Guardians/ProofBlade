import assert from "node:assert/strict";
import test from "node:test";
import { runDeploymentPreflight } from "../deployment-preflight.mjs";

const checks = [
  { id: "runtime-selfcheck", script: "runtime", args: ["runtime", "selfcheck"] },
  { id: "browser-smoke", script: "browser", args: [] },
  { id: "pwn-docker-smoke", script: "pwn", args: [] },
];

test("deployment preflight keeps optional external dependencies explicitly skipped", async () => {
  const report = await runDeploymentPreflight({
    checks,
    run: async ({ check }) => check.id === "runtime-selfcheck"
      ? { exitCode: 0, stdout: JSON.stringify({ ready: true }), durationMs: 1 }
      : { exitCode: 0, stdout: JSON.stringify({ status: "skipped", reason: "dependency missing" }), durationMs: 2 },
  });
  assert.deepEqual(report, {
    schemaVersion: 1,
    mode: "optional",
    status: "skipped",
    checks: [
      { id: "runtime-selfcheck", status: "passed", exitCode: 0, durationMs: 1 },
      { id: "browser-smoke", status: "skipped", exitCode: 0, durationMs: 2, reason: "dependency missing" },
      { id: "pwn-docker-smoke", status: "skipped", exitCode: 0, durationMs: 2, reason: "dependency missing" },
    ],
  });
});

test("required deployment preflight turns skipped smoke into a blocking failure", async () => {
  const calls = [];
  const report = await runDeploymentPreflight({
    required: true,
    checks,
    run: async ({ check, args }) => {
      calls.push({ id: check.id, args });
      return check.id === "runtime-selfcheck"
        ? { exitCode: 0, stdout: JSON.stringify({ ready: true }), durationMs: 1 }
        : { exitCode: 2, stdout: JSON.stringify({ status: "skipped", reason: "Docker unavailable" }), durationMs: 2 };
    },
  });
  assert.equal(report.status, "failed");
  assert.deepEqual(report.checks.slice(1).map((item) => [item.status, item.reason]), [
    ["failed", "Docker unavailable"],
    ["failed", "Docker unavailable"],
  ]);
  assert.deepEqual(calls.map((call) => call.args), [
    ["runtime", "selfcheck", "--config", "proofblade.config.json"],
    ["--required"],
    ["--required"],
  ]);
});

test("runtime selfcheck failure is never downgraded to an optional skip", async () => {
  const report = await runDeploymentPreflight({
    checks: [checks[0]],
    run: async () => ({ exitCode: 2, stdout: JSON.stringify({ ready: false }), durationMs: 3 }),
  });
  assert.equal(report.status, "failed");
  assert.deepEqual(report.checks[0], {
    id: "runtime-selfcheck",
    status: "failed",
    exitCode: 2,
    durationMs: 3,
    reason: "configured runtime selfcheck did not report ready",
  });
});

test("deployment report does not copy child output into the durable summary", async () => {
  const report = await runDeploymentPreflight({
    checks: [{ id: "browser-smoke", script: "browser", args: [] }],
    run: async () => ({
      exitCode: 1,
      stdout: `diagnostic with secret-token\n${JSON.stringify({ status: "failed", reason: "provider rejected" })}`,
      stderr: "raw target response",
      durationMs: 4,
    }),
  });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("raw target response"), false);
  assert.deepEqual(report.checks[0], {
    id: "browser-smoke",
    status: "failed",
    exitCode: 1,
    durationMs: 4,
    reason: "provider rejected",
  });
});
