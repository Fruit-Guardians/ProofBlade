import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  componentSourceHash,
  incrementPatchVersion,
  parseMetadataBlock,
  replaceMetadataBlock,
} from "./component-audit-lib.mjs";
import { resolveAuditTimestamp } from "./audit-time.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const registry = JSON.parse(readFileSync(join(root, "component-docs.json"), "utf8"));
const selection = requiredArgument("--components");
const auditedAt = resolveAuditTimestamp({
  explicit: optionalArgument("--at"),
  env: process.env,
  eventPath: process.env.GITHUB_EVENT_PATH,
  gitCommitAt: gitCommitTimestamp(root),
});
const result = requiredArgument("--result");
const force = process.argv.includes("--force");

if (Number.isNaN(Date.parse(auditedAt))) throw new Error("--at must be an ISO date/time");
if (result !== "passed" && result !== "findings") throw new Error("--result must be passed or findings");

const requested = selection === "all" ? new Set(registry.components.map((component) => component.id)) : new Set(selection.split(",").map((id) => id.trim()).filter(Boolean));
const unknown = [...requested].filter((id) => !registry.components.some((component) => component.id === id));
if (unknown.length > 0) throw new Error(`Unknown component ids: ${unknown.join(", ")}`);

let skipped = 0;
const updates = [];
for (const component of registry.components) {
  if (!requested.has(component.id)) continue;
  const documentPath = join(root, component.document);
  const markdown = readFileSync(documentPath, "utf8");
  const parsed = parseMetadataBlock(markdown, component.document);
  const previous = parsed.metadata.qualityAudit;
  const sourceHash = componentSourceHash(root, registry, component);
  if (!force && previous?.sourceHash === sourceHash) {
    skipped += 1;
    continue;
  }
  for (const field of ["lastBugAuditAt", "lastSecurityAuditAt"]) {
    if (previous?.[field] && Date.parse(auditedAt) <= Date.parse(previous[field])) {
      throw new Error(`${component.id}: --at must be later than qualityAudit.${field} (${previous[field]})`);
    }
  }
  if (parsed.metadata.updatedAt && Date.parse(auditedAt) <= Date.parse(parsed.metadata.updatedAt)) {
    throw new Error(`${component.id}: --at must be later than updatedAt (${parsed.metadata.updatedAt})`);
  }
  const metadata = {
    ...parsed.metadata,
    version: incrementPatchVersion(parsed.metadata.version),
    updatedAt: auditedAt,
    qualityAudit: {
      bugAuditCount: Number(previous?.bugAuditCount ?? 0) + 1,
      securityAuditCount: Number(previous?.securityAuditCount ?? 0) + 1,
      lastBugAuditAt: auditedAt,
      lastSecurityAuditAt: auditedAt,
      sourceHash,
      result,
    },
  };
  updates.push({ documentPath, markdown: replaceMetadataBlock(markdown, parsed, metadata) });
}

for (const update of updates) writeFileSync(update.documentPath, update.markdown, "utf8");

console.log(`Component audits recorded (${updates.length} updated, ${skipped} unchanged).`);

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function optionalArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function gitCommitTimestamp(cwd) {
  const result = spawnSync("git", ["log", "-1", "--format=%cI"], { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
