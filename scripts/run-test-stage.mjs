import { createWriteStream } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = dirname(ROOT);
const WATCHDOG = join(ROOT, "run-tests-with-watchdog.mjs");
const STAGES = {
  fast: {
    concurrency: 2,
    timeoutMs: 720_000,
    matches: [],
  },
  slow: {
    concurrency: 1,
    timeoutMs: 900_000,
    matches: [
      "packages/materials/tests/local-holdout.test.ts",
      "packages/materials/tests/real-model-evaluator.test.ts",
      "packages/materials/tests/runtime-scenario-evaluator.test.ts",
    ],
  },
  integration: {
    concurrency: 2,
    timeoutMs: 720_000,
    matches: [
      "packages/materials/tests/browser-resource-adapter.test.ts",
      "packages/materials/tests/browser-runtime-broker.test.ts",
      "packages/materials/tests/browser-runtime-playwright-host.test.ts",
      "packages/materials/tests/browser-runtime-service.test.ts",
      "packages/materials/tests/session-runtime-wire.test.ts",
      "packages/materials/tests/session-runtime-service.test.ts",
      "packages/materials/tests/competition-pwn-e2e.test.ts",
      "packages/materials/tests/competition-remote-query-matrix.test.ts",
      "packages/materials/tests/docker-resource-adapter.test.ts",
      "packages/materials/tests/mcp.test.ts",
      "packages/materials/tests/provider-pi-http-smoke.test.ts",
    ],
  },
};

const requested = process.argv.slice(2).filter((argument) => argument !== "--");
const listOnly = requested.includes("--list");
const names = requested.filter((argument) => argument !== "--list");
const selected = names.length === 0 || names.includes("all") ? Object.keys(STAGES) : names;
if (selected.some((name) => !Object.hasOwn(STAGES, name))) {
  console.error(`Unknown test stage. Expected one of: ${Object.keys(STAGES).join(", ")}, all`);
  process.exit(2);
}

const files = await discoverTestFiles(join(WORKSPACE, "packages"), join(WORKSPACE, "apps"));
const assignments = new Map(selected.map((stage) => [stage, assign(files, stage)]));
if (listOnly) {
  for (const stage of selected) {
    console.log(JSON.stringify({ event: "stage_manifest", stage, files: assignments.get(stage) }));
  }
  process.exit(0);
}

await mkdir(join(WORKSPACE, ".proofblade", "test-logs"), { recursive: true });
for (const stage of selected) {
  const stageFiles = assignments.get(stage);
  if (!stageFiles || stageFiles.length === 0) {
    console.error(`Test stage ${stage} has no test files`);
    process.exitCode = 1;
    break;
  }
  const config = STAGES[stage];
  const startedAt = Date.now();
  const logPath = join(WORKSPACE, ".proofblade", "test-logs", `${stage}.log`);
  console.log(JSON.stringify({ event: "stage_start", stage, fileCount: stageFiles.length, timeoutMs: config.timeoutMs, concurrency: config.concurrency, logPath: relative(WORKSPACE, logPath).replaceAll("\\", "/") }));
  const result = await runStage(stage, config, stageFiles, logPath);
  const durationMs = Date.now() - startedAt;
  console.log(JSON.stringify({ event: "stage_end", stage, status: result.code === 0 ? "passed" : "failed", exitCode: result.code, durationMs, logPath: relative(WORKSPACE, logPath).replaceAll("\\", "/") }));
  if (result.code !== 0) {
    process.exitCode = result.code;
    break;
  }
}

async function runStage(stage, config, stageFiles, logPath) {
  const log = createWriteStream(logPath, { flags: "w", encoding: "utf8" });
  const child = spawn(process.execPath, [
    WATCHDOG,
    "--import", "tsx",
    `--test-concurrency=${config.concurrency}`,
    "--test",
    ...stageFiles.map((file) => join(WORKSPACE, file)),
  ], {
    cwd: WORKSPACE,
    env: {
      ...process.env,
      PROOFBLADE_TEST_STAGE: stage,
      PROOFBLADE_TEST_WATCHDOG_MS: String(config.timeoutMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { process.stdout.write(chunk); log.write(chunk); });
  child.stderr.on("data", (chunk) => { process.stderr.write(chunk); log.write(chunk); });
  return await new Promise((resolve) => {
    child.once("error", (error) => {
      const message = `[test-stage:${stage}] failed to start: ${error.message}\n`;
      process.stderr.write(message);
      log.write(message);
      log.end();
      resolve({ code: 1 });
    });
    child.once("exit", (code, signal) => {
      log.end();
      resolve({ code: code ?? 1, signal });
    });
  });
}

async function discoverTestFiles(...roots) {
  const files = [];
  for (const root of roots) await walk(root, files);
  return files
    .map((file) => relative(WORKSPACE, file).replaceAll("\\", "/"))
    .filter((file) => /^(?:packages|apps)\/[^/]+\/tests\/[^/]+\.test\.(?:ts|mjs)$/.test(file))
    .sort();
}

async function walk(directory, files) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, files);
    else if (entry.isFile()) files.push(path);
  }
}

function assign(files, stage) {
  if (stage === "slow") return files.filter((file) => STAGES.slow.matches.includes(file));
  if (stage === "integration") return files.filter((file) => STAGES.integration.matches.includes(file));
  const excluded = new Set([...STAGES.slow.matches, ...STAGES.integration.matches]);
  return files.filter((file) => !excluded.has(file));
}
