import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
if (args.length === 0) {
  console.error("Usage: node scripts/run-tests-with-watchdog.mjs <node test arguments...>");
  process.exit(2);
}

const timeoutMs = parseTimeout(process.env.PROOFBLADE_TEST_WATCHDOG_MS);
const startedAt = Date.now();
const child = spawn(process.execPath, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

const recentOutput = [];
for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    target.write(chunk);
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      recentOutput.push(line.slice(0, 500));
      if (recentOutput.length > 24) recentOutput.shift();
    }
  });
}

let timedOut = false;
let forceKillTimer;
const watchdog = setTimeout(() => {
  timedOut = true;
  console.error(`[test-watchdog] test process ${child.pid ?? "unknown"} exceeded ${timeoutMs}ms; terminating`);
  console.error(`[test-watchdog] stage=${process.env.PROOFBLADE_TEST_STAGE ?? "unknown"} recent_output=${JSON.stringify(recentOutput)}`);
  child.kill("SIGTERM");
  forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
}, timeoutMs);

child.once("error", (error) => {
  clearTimeout(watchdog);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  console.error(`[test-watchdog] failed to start test process: ${error.message}`);
  process.exit(1);
});

child.once("exit", (code, signal) => {
  clearTimeout(watchdog);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  const elapsedMs = Date.now() - startedAt;
  if (timedOut) {
    console.error(`[test-watchdog] terminated after ${elapsedMs}ms (signal=${signal ?? "none"})`);
    process.exit(124);
  }
  if (code !== null) process.exit(code);
  console.error(`[test-watchdog] test process exited without a code (signal=${signal ?? "unknown"})`);
  process.exit(1);
});

function parseTimeout(value) {
  if (value === undefined || value.trim() === "") return 720_000;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 3_600_000) {
    console.error("PROOFBLADE_TEST_WATCHDOG_MS must be an integer between 1000 and 3600000");
    process.exit(2);
  }
  return timeout;
}
