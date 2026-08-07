import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { changeContractErrors } from "./change-contract-lib.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, ".github", "change-contracts.json"), "utf8"));
const explicitBase = argumentValue("--base");
const base = explicitBase ?? "HEAD";
const changedFiles = changed(base, Boolean(explicitBase));
const diffs = new Map([...changedFiles].map((file) => [file, diffFor(file, base, Boolean(explicitBase))]));
const testFiles = new Map(sourceFiles()
  .filter((file) => /(^|\/)tests\/.*\.test\.(?:ts|tsx|mjs)$/.test(file))
  .map((file) => [file, readFileSync(join(root, file), "utf8")]));
const errors = changeContractErrors({ manifest, changedFiles, diffs, testFiles });

if (errors.length > 0) {
  console.error(`Change contract check failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Change contract check passed (${manifest.contracts.length} contracts, ${changedFiles.size} changed files).`);

function changed(base, hasExplicitBase) {
  const args = hasExplicitBase
    ? ["diff", "--name-only", "--diff-filter=ACMRD", `${base}...HEAD`]
    : ["diff", "--name-only", "--diff-filter=ACMRD", "HEAD"];
  const result = new Set(git(args).split(/\r?\n/).filter(Boolean).map(normalize));
  if (!hasExplicitBase) {
    for (const file of git(["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/).filter(Boolean)) result.add(normalize(file));
  }
  return result;
}

function diffFor(file, base, hasExplicitBase) {
  if (!hasExplicitBase && !git(["ls-files", "--error-unmatch", "--", file], true)) {
    return existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8").split(/\r?\n/).map((line) => `+${line}`).join("\n") : "";
  }
  const range = hasExplicitBase ? `${base}...HEAD` : "HEAD";
  return git(["diff", "--unified=0", "--no-ext-diff", range, "--", file]);
}

function sourceFiles() {
  return git(["ls-files", "--cached", "--others", "--exclude-standard", "--", "apps", "packages", "scripts"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map(normalize)
    .filter((file) => existsSync(join(root, file)));
}

function git(args, allowFailure = false) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    if (allowFailure) return "";
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function normalize(path) {
  return path.replaceAll("\\", "/");
}
