import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { join } from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url));
const runner = join(root, "scripts", "run-test-stage.mjs");

test("test stage manifests are disjoint and cover the repository test files", async () => {
  const result = await run(["all", "--list"]);
  assert.equal(result.code, 0, result.stderr);
  const manifests = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(manifests.map((item) => item.stage), ["fast", "slow", "integration"]);
  const sets = manifests.map((item) => new Set(item.files));
  const union = new Set(sets.flatMap((set) => [...set]));
  assert.ok(union.size > 0);
  assert.equal([...sets[0]].some((file) => sets[1].has(file) || sets[2].has(file)), false);
  assert.equal([...sets[1]].some((file) => sets[2].has(file)), false);
  assert.ok([...sets[1]].includes("packages/materials/tests/local-holdout.test.ts"));
  assert.ok([...sets[2]].includes("packages/materials/tests/browser-resource-adapter.test.ts"));
  assert.ok([...sets[2]].includes("packages/materials/tests/browser-runtime-broker.test.ts"));
  for (const file of union) assert.match(file, /^(?:packages|apps)\/[^/]+\/tests\/[^/]+\.test\.(?:ts|mjs)$/);
});

test("a single stage manifest can be inspected without building or running tests", async () => {
  const result = await run(["slow", "--list"]);
  assert.equal(result.code, 0, result.stderr);
  const manifest = JSON.parse(result.stdout.trim());
  assert.equal(manifest.event, "stage_manifest");
  assert.equal(manifest.stage, "slow");
  assert.deepEqual(manifest.files, [
    "packages/materials/tests/local-holdout.test.ts",
    "packages/materials/tests/real-model-evaluator.test.ts",
    "packages/materials/tests/runtime-scenario-evaluator.test.ts",
  ]);
});

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
