import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { join } from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url));
const watchdog = join(root, "scripts", "run-tests-with-watchdog.mjs");

test("test watchdog preserves a successful child exit", async () => {
  const result = await run(["-e", "console.log('watchdog-ok')"], { PROOFBLADE_TEST_WATCHDOG_MS: "30000" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /watchdog-ok/);
});

test("test watchdog preserves a failing child exit", async () => {
  const result = await run(["-e", "process.exit(7)"], { PROOFBLADE_TEST_WATCHDOG_MS: "30000" });
  assert.equal(result.code, 7, result.stderr);
});

test("test watchdog turns an unbounded child into a non-zero timeout", async () => {
  const result = await run(["-e", "setTimeout(() => {}, 10000)"], { PROOFBLADE_TEST_WATCHDOG_MS: "1000" });
  assert.equal(result.code, 124, result.stderr);
  assert.match(result.stderr, /exceeded 1000ms/);
});

function run(args, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [watchdog, ...args], {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
  });
}
