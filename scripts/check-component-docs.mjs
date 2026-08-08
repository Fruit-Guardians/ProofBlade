import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { componentSourceHash } from "./component-audit-lib.mjs";
import { componentTransitionErrors } from "./component-transition-lib.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const registryPath = join(root, "component-docs.json");
const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const errors = [];
const documents = new Set(registry.components.map((component) => normalize(component.document)));

if (registry.schemaVersion !== 1 || !Array.isArray(registry.components)) fail("component-docs.json must use schemaVersion 1 and contain a components array");

const ids = new Set();
for (const component of registry.components) {
  if (ids.has(component.id)) fail(`duplicate component id: ${component.id}`);
  ids.add(component.id);
  if (!Array.isArray(component.paths) || component.paths.length === 0) fail(`${component.id}: paths must be a non-empty array`);
  for (const path of component.paths) {
    if (path !== normalize(path) || !path.endsWith("/")) fail(`${component.id}: path must be a normalized directory prefix: ${path}`);
  }
  const documentPath = join(root, component.document);
  if (!existsSync(documentPath)) {
    fail(`${component.id}: missing ${component.document}`);
    continue;
  }
  validateMetadata(component, parseMetadata(readFileSync(documentPath, "utf8"), component.document));
}

for (const file of sourceFiles()) {
  if (!ownerFor(file)) fail(`source file has no component owner: ${file}`);
}

const base = argumentValue("--base") ?? "HEAD";
const changed = changedFiles(base, argumentValue("--base") !== undefined);
const affected = new Map();
for (const file of changed) {
  if (documents.has(file)) continue;
  const owner = ownerFor(file);
  if (owner) affected.set(owner.id, owner);
}

for (const component of registry.components) {
  const sourceChanged = affected.has(component.id);
  const documentChanged = changed.has(component.document);
  if (!sourceChanged && !documentChanged) continue;
  const previousText = gitShow(base, component.document);
  if (previousText === undefined) continue;
  const previous = parseMetadata(previousText, `${base}:${component.document}`);
  const current = parseMetadata(readFileSync(join(root, component.document), "utf8"), component.document);
  const expectedSourceHash = componentSourceHash(root, registry, component);
  for (const error of componentTransitionErrors({ componentId: component.id, previous, current, sourceChanged, documentChanged, expectedSourceHash })) fail(error);
}

if (errors.length > 0) {
  console.error(`Component documentation check failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Component documentation check passed (${registry.components.length} components, ${affected.size} affected).`);

function validateMetadata(component, metadata) {
  if (metadata.id !== component.id) fail(`${component.document}: metadata id must be ${component.id}`);
  if (typeof metadata.name !== "string" || metadata.name.trim().length === 0) fail(`${component.document}: metadata name is required`);
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version ?? "")) fail(`${component.document}: version must be x.y.z`);
  for (const field of ["createdAt", "updatedAt"]) {
    if (typeof metadata[field] !== "string" || Number.isNaN(Date.parse(metadata[field]))) fail(`${component.document}: ${field} must be an ISO date/time`);
  }
  if (Date.parse(metadata.updatedAt) < Date.parse(metadata.createdAt)) fail(`${component.document}: updatedAt must not precede createdAt`);
  const audit = metadata.qualityAudit;
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) {
    fail(`${component.document}: qualityAudit is required`);
    return;
  }
  for (const field of ["bugAuditCount", "securityAuditCount"]) {
    if (!Number.isInteger(audit[field]) || audit[field] < 1) fail(`${component.document}: qualityAudit.${field} must be a positive integer`);
  }
  for (const field of ["lastBugAuditAt", "lastSecurityAuditAt"]) {
    if (typeof audit[field] !== "string" || Number.isNaN(Date.parse(audit[field]))) fail(`${component.document}: qualityAudit.${field} must be an ISO date/time`);
    else if (Date.parse(audit[field]) > Date.parse(metadata.updatedAt)) fail(`${component.document}: qualityAudit.${field} must not be later than updatedAt`);
  }
  if (!/^[a-f0-9]{64}$/.test(audit.sourceHash ?? "")) fail(`${component.document}: qualityAudit.sourceHash must be a SHA-256 hash`);
  const expectedHash = componentSourceHash(root, registry, component);
  if (audit.sourceHash !== expectedHash) fail(`${component.id}: quality audit is stale (expected sourceHash ${expectedHash})`);
  if (audit.result !== "passed" && audit.result !== "findings") fail(`${component.document}: qualityAudit.result must be passed or findings`);
  if (audit.result === "findings") fail(`${component.id}: quality audit has unresolved findings`);
}

function parseMetadata(markdown, label) {
  const marker = "```json component-metadata";
  const start = markdown.indexOf(marker);
  if (start < 0) {
    fail(`${label}: missing component-metadata JSON block`);
    return {};
  }
  const bodyStart = markdown.indexOf("\n", start) + 1;
  const end = markdown.indexOf("\n```", bodyStart);
  if (bodyStart === 0 || end < 0) {
    fail(`${label}: malformed component-metadata JSON block`);
    return {};
  }
  try {
    return JSON.parse(markdown.slice(bodyStart, end));
  } catch (error) {
    fail(`${label}: invalid component metadata JSON (${error.message})`);
    return {};
  }
}

function ownerFor(file) {
  return registry.components
    .flatMap((component) => component.paths.map((path) => ({ component, path })))
    .filter(({ path }) => file.startsWith(path))
    .sort((left, right) => right.path.length - left.path.length)[0]?.component;
}

function sourceFiles() {
  const files = [];
  for (const top of ["packages", "apps"]) walk(join(root, top), files);
  return files
    .map((file) => normalize(relative(root, file)))
    .filter((file) => !documents.has(file))
    .filter((file) => !file.includes("/node_modules/") && !file.includes("/dist/") && !file.includes("/dist-server/"))
    .filter((file) => [".ts", ".tsx", ".css", ".html"].includes(extname(file)) || /\/(package|tsconfig)\.json$/.test(file));
}

function walk(directory, files) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "dist-server"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else files.push(path);
  }
}

function changedFiles(base, explicitBase) {
  const args = explicitBase ? ["diff", "--name-only", "--diff-filter=ACMRD", `${base}...HEAD`] : ["diff", "--name-only", "--diff-filter=ACMRD", "HEAD"];
  const changed = new Set(git(args).split(/\r?\n/).filter(Boolean).map(normalize));
  if (!explicitBase) {
    for (const file of git(["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/).filter(Boolean)) changed.add(normalize(file));
  }
  return changed;
}

function gitShow(base, path) {
  const result = spawnSync("git", ["show", `${base}:${path}`], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout : undefined;
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    fail(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
    return "";
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

function fail(message) {
  errors.push(message);
}
