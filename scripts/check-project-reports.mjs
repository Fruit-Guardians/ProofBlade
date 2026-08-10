import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requiresProjectStatus } from "./project-report-change-lib.mjs";
import { PROJECT_REPORT_FILES, renderProjectReports } from "./project-report-lib.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const errors = [];
const reports = renderProjectReports(root);

for (const [relativePath, expected] of reports) {
  const path = join(root, relativePath);
  if (!existsSync(path)) errors.push(`missing generated report: ${relativePath}`);
  else if (readFileSync(path, "utf8") !== expected) errors.push(`stale generated report: ${relativePath}`);
}

const base = argumentValue("--base");
if (base) enforceUpdateRecord(base);

if (errors.length > 0) {
  console.error(`Project report check failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Project report check passed (${reports.size} reports, ${reports.size === Object.keys(PROJECT_REPORT_FILES).length ? "complete" : "incomplete"}).`);

function enforceUpdateRecord(base) {
  const changed = git(["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`]).split(/\r?\n/).filter(Boolean).map(normalize);
  const generated = new Set(Object.values(PROJECT_REPORT_FILES));
  const meaningful = changed.filter((file) => !generated.has(file) && !isRuntimeOutput(file) && requiresProjectStatus(file));
  if (meaningful.length > 0 && !changed.includes("project-status.json")) {
    errors.push(`project-status.json was not updated for ${meaningful.length} changed files`);
    return;
  }
  if (meaningful.length > 0) {
    const previousText = gitShow(base, "project-status.json");
    if (!previousText) return;
    const previous = JSON.parse(previousText);
    const current = JSON.parse(readFileSync(join(root, "project-status.json"), "utf8"));
    const previousUpdates = new Set((previous.updates ?? []).map((entry) => entry.id));
    if (!(current.updates ?? []).some((entry) => !previousUpdates.has(entry.id))) {
      errors.push("project-status.json has no new update-log entry for this change");
    }
    if (Date.parse(current.updatedAt) <= Date.parse(previous.updatedAt)) {
      errors.push(`project-status.json updatedAt must be later than ${previous.updatedAt}`);
    }
  }
}

function isRuntimeOutput(path) {
  return path.startsWith("runs/") || path.startsWith("fixtures/runtime/") || path.startsWith("tmp/");
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function gitShow(base, path) {
  const result = spawnSync("git", ["show", `${base}:${path}`], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout : undefined;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function normalize(path) {
  return path.replaceAll("\\", "/");
}
