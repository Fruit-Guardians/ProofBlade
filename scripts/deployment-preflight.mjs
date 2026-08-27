import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDirectory, "..");
const outputLimit = 32 * 1024;
const checkTimeoutMs = 90_000;

export const deploymentChecks = [
  { id: "runtime-selfcheck", script: "apps/cli/src/main.ts", args: ["runtime", "selfcheck"] },
  { id: "browser-smoke", script: "scripts/browser-runtime-smoke.ts", args: [] },
  { id: "pwn-docker-smoke", script: "scripts/pwn-docker-smoke.ts", args: [] },
  { id: "pwn-docker-fault-matrix", script: "scripts/pwn-docker-fault-matrix.ts", args: [] },
];

/**
 * Run the deployment checks with an injectable child runner. The injection is
 * intentional: CI can validate the aggregation semantics without Docker,
 * Chromium, or a configured remote broker.
 */
export async function runDeploymentPreflight({
  root = defaultRoot,
  required = false,
  configPath = "proofblade.config.json",
  checks = deploymentChecks,
  run = runCheck,
} = {}) {
  const results = [];
  for (const check of checks) {
    const args = [...check.args];
    if (check.id === "runtime-selfcheck") args.push("--config", configPath);
    if (required && check.id !== "runtime-selfcheck") args.push("--required");
    const result = await run({ root, check, args, required });
    results.push(classifyResult(check.id, result, required));
  }
  const hasFailure = results.some((result) => result.status === "failed");
  const hasSkipped = results.some((result) => result.status === "skipped");
  return {
    schemaVersion: 1,
    mode: required ? "required" : "optional",
    status: hasFailure ? "failed" : hasSkipped ? "skipped" : "passed",
    checks: results,
  };
}

function classifyResult(id, result, required) {
  const payload = lastJson(result.stdout);
  const reportedStatus = typeof payload?.status === "string" ? payload.status : undefined;
  const reason = typeof payload?.reason === "string" ? payload.reason : undefined;
  if (id === "runtime-selfcheck") {
    const ready = payload?.ready === true && (result.exitCode ?? 1) === 0;
    return {
      id,
      status: ready ? "passed" : "failed",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(ready ? {} : { reason: reason ?? "configured runtime selfcheck did not report ready" }),
    };
  }
  if (reportedStatus === "skipped") {
    return {
      id,
      status: required ? "failed" : "skipped",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      reason: reason ?? "deployment dependency is unavailable",
    };
  }
  if (reportedStatus === "passed" && (result.exitCode ?? 1) === 0) {
    return { id, status: "passed", exitCode: result.exitCode, durationMs: result.durationMs };
  }
  return {
    id,
    status: "failed",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    reason: reason ?? (result.timedOut ? `check exceeded ${checkTimeoutMs}ms` : "deployment check failed"),
  };
}

function lastJson(stdout) {
  const text = String(stdout ?? "").trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Continue with line-oriented parsing for checks that prefix diagnostics.
  }
  const lines = text.split(/\r?\n/).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Some checks print human diagnostics before their final JSON report.
    }
  }
  return undefined;
}

async function runCheck({ root, check, args }) {
  const startedAt = Date.now();
  const script = resolve(root, check.script);
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const append = (current, chunk) => `${current}${chunk}`.slice(-outputLimit);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, checkTimeoutMs);
  const exit = await new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ exitCode: 1, spawnError: error.message }));
    child.once("exit", (exitCode, signal) => resolveExit({ exitCode, signal }));
  });
  clearTimeout(timer);
  return {
    ...exit,
    stdout,
    stderr,
    timedOut,
    durationMs: Date.now() - startedAt,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run deployment:preflight [-- --required] [--report PATH]");
    return;
  }
  const report = await runDeploymentPreflight(options);
  const output = { generatedAt: new Date().toISOString(), ...report };
  console.log(JSON.stringify(output));
  if (options.reportPath) {
    const path = resolve(options.root ?? defaultRoot, options.reportPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(output)}\n`, "utf8");
  }
  if (report.status === "failed") process.exitCode = options.required ? 2 : 1;
}

function parseOptions(args) {
  const options = { root: defaultRoot, required: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--required") { options.required = true; continue; }
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--config") { options.configPath = requiredValue(args, ++index, "--config"); continue; }
    if (arg === "--report") { options.reportPath = requiredValue(args, ++index, "--report"); continue; }
    throw new Error(`Unknown deployment preflight option: ${arg}`);
  }
  return options;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
