import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { spawnSync } from "node:child_process";

export function componentSourceHash(root, registry, component) {
  const documents = new Set(registry.components.map((item) => normalize(item.document)));
  const files = sourceFiles(root, documents)
    .filter((file) => ownerFor(registry, file)?.id === component.id)
    .sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const file of files) {
    const content = canonicalComponentContent(file, readFileSync(join(root, file)));
    const contentHash = createHash("sha256").update(content).digest("hex");
    hash.update(`${file}\0${contentHash}\n`);
  }
  return hash.digest("hex");
}

const canonicalTextExtensions = new Set([
  ".cjs", ".css", ".csv", ".html", ".js", ".json", ".md", ".mjs",
  ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);

export function canonicalComponentContent(file, content) {
  if (!canonicalTextExtensions.has(extname(file).toLowerCase())) return content;
  return Buffer.from(content.toString("utf8").replaceAll("\r\n", "\n"));
}

export function ownerFor(registry, file) {
  return registry.components
    .flatMap((component) => component.paths.map((path) => ({ component, path })))
    .filter(({ path }) => file.startsWith(path))
    .sort((left, right) => right.path.length - left.path.length)[0]?.component;
}

export function parseMetadataBlock(markdown, label = "component document") {
  const marker = "```json component-metadata";
  const start = markdown.indexOf(marker);
  if (start < 0) throw new Error(`${label}: missing component-metadata JSON block`);
  const bodyStart = markdown.indexOf("\n", start) + 1;
  const end = markdown.indexOf("\n```", bodyStart);
  if (bodyStart === 0 || end < 0) throw new Error(`${label}: malformed component-metadata JSON block`);
  return {
    metadata: JSON.parse(markdown.slice(bodyStart, end)),
    bodyStart,
    end,
  };
}

export function replaceMetadataBlock(markdown, parsed, metadata) {
  return `${markdown.slice(0, parsed.bodyStart)}${JSON.stringify(metadata, null, 2)}${markdown.slice(parsed.end)}`;
}

export function incrementPatchVersion(version) {
  const parts = String(version).split(".").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) throw new Error(`Invalid component version: ${version}`);
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

export function normalize(path) {
  return path.replaceAll("\\", "/");
}

function sourceFiles(root, documents) {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "packages", "apps"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
  return result.stdout.split(/\r?\n/)
    .filter(Boolean)
    .map(normalize)
    .filter((file) => existsSync(join(root, file)))
    .filter((file) => !documents.has(file));
}
