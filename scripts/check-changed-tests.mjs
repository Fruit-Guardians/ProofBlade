import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = loadManifest(root);
  const changedFiles = changed(root, Boolean(argumentValue("--base")));
  const result = selectTestCommands({ root, manifest, changedFiles });
  if (result.errors.length > 0) {
    console.error(`Changed-test check failed (${result.errors.length}):`);
    for (const error of result.errors) console.error(`- ${error}`);
    process.exit(1);
  }
  if (result.commands.length === 0) {
    console.log("Changed-test check passed (no source rule requires a targeted test).");
  } else {
    console.log(`Changed-test check passed (${result.commands.length} targeted command${result.commands.length === 1 ? "" : "s"}):`);
    for (const command of result.commands) console.log(`- [${command.ruleId}] ${command.command}`);
  }
}

export function loadManifest(projectRoot = root) {
  const path = join(projectRoot, ".github", "test-matrix.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.rules)) throw new Error(".github/test-matrix.json must use schemaVersion 1 with rules");
  for (const rule of manifest.rules) {
    if (typeof rule?.id !== "string" || !Array.isArray(rule.sourceGlobs) || !Array.isArray(rule.testGlobs) || typeof rule.command !== "string") throw new Error("Every test matrix rule needs id, sourceGlobs, testGlobs, and command");
  }
  return manifest;
}

export function selectTestCommands({ root: projectRoot, manifest, changedFiles }) {
  const commands = new Map();
  const errors = [];
  for (const file of changedFiles) {
    const normalized = normalize(file);
    if (!isSourceChange(normalized)) continue;
    const rules = manifest.rules.filter((rule) => rule.sourceGlobs.some((glob) => matchesGlob(normalized, glob)));
    if (rules.length === 0) {
      errors.push(`${normalized}: no test-matrix rule covers this source file`);
      continue;
    }
    for (const rule of rules) {
      const missing = rule.testGlobs.filter((testPath) => !existsSync(join(projectRoot, testPath)));
      if (missing.length > 0) {
        errors.push(`${rule.id}: mapped test file is missing: ${missing.join(", ")}`);
        continue;
      }
      commands.set(rule.id, { ruleId: rule.id, command: rule.command, sourceFiles: [] });
      commands.get(rule.id).sourceFiles.push(normalized);
    }
  }
  return { errors, commands: [...commands.values()].sort((left, right) => left.ruleId.localeCompare(right.ruleId)) };
}

function isSourceChange(file) {
  return /^(?:packages|apps)\/.+\.(?:ts|tsx|mjs|mts|js)$/.test(file) && !/(?:^|\/)tests\//.test(file);
}

function matchesGlob(file, glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "§§DOUBLE§§")
    .replaceAll("*", "[^/]*")
    .replaceAll("§§DOUBLE§§", ".*");
  return new RegExp(`^${escaped}$`).test(file);
}

function changed(projectRoot, hasExplicitBase) {
  const base = argumentValue("--base");
  const args = hasExplicitBase ? ["diff", "--name-only", "--diff-filter=ACMRD", `${base}...HEAD`] : ["diff", "--name-only", "--diff-filter=ACMRD", "HEAD"];
  const files = new Set(git(projectRoot, args).split(/\r?\n/).filter(Boolean).map(normalize));
  if (!hasExplicitBase) for (const file of git(projectRoot, ["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/).filter(Boolean)) files.add(normalize(file));
  return files;
}

function git(projectRoot, args) {
  const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function normalize(path) {
  return path.replaceAll("\\", "/");
}
