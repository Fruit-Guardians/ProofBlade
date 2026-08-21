#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectApi, PACKAGE_CONFIGS } from "./collector.mjs";
import { findDuplicateCandidates } from "./duplicates.mjs";
import { renderAgentContext, renderMarkdown } from "./renderer.mjs";

const args = process.argv.slice(2);
const command = args[0] ?? "generate";
const repoRoot = resolve(valueOf("--repo-root") ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../"));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

export async function main() {
  const packageIds = selectedPackages(args);
  if (command === "generate") {
    for (const packageId of packageIds) await generatePackage(packageId);
    return;
  }
  if (command === "check") {
    const errors = [];
    for (const packageId of packageIds) errors.push(...await checkPackage(packageId));
    if (errors.length > 0) throw new Error(`API index check failed:\n- ${errors.join("\n- ")}`);
    console.log(`API index check passed (${packageIds.join(", ")}).`);
    return;
  }
  if (command === "duplicates") {
    const indexes = packageIds.map((packageId) => collectApi({ repoRoot, packageId }));
    const report = findDuplicateCandidates(indexes);
    for (const packageId of packageIds) {
      const root = outputRoot(packageId);
      await mkdir(join(root, "duplicates"), { recursive: true });
      await writeFile(join(root, "duplicates", `${packageId}.json`), `${JSON.stringify(findDuplicateCandidates([collectApi({ repoRoot, packageId })]), null, 2)}\n`, "utf8");
    }
    console.log(JSON.stringify(report, null, 2));
    if (report.counts.exact > 0) process.exitCode = 2;
    return;
  }
  if (command === "search") {
    const query = args.slice(1).filter((arg) => !arg.startsWith("--")).join(" ").toLowerCase().trim();
    if (!query) throw new Error("Usage: npm run api:search -- <query>");
    const tokens = query.split(/\s+/).filter(Boolean);
    const matches = packageIds.flatMap((packageId) => collectApi({ repoRoot, packageId }).symbols.map((symbol) => ({ symbol, packageId })))
      .map((item) => ({ ...item, score: score(item.symbol, tokens) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.symbol.id.localeCompare(right.symbol.id))
      .slice(0, 20)
      .map((item) => ({ score: item.score, id: item.symbol.id, name: item.symbol.name, kind: item.symbol.kind, signature: item.symbol.signature, summary: item.symbol.summary, exportPath: item.symbol.exportPath, module: item.symbol.module, line: item.symbol.line, testRefs: item.symbol.testRefs }));
    console.log(JSON.stringify({ schemaVersion: 1, query, results: matches }, null, 2));
    return;
  }
  if (command === "explain") {
    const target = args.slice(1).find((arg) => !arg.startsWith("--"));
    if (!target) throw new Error("Usage: npm run api:explain -- <symbol-id-or-name>");
    const symbols = packageIds.flatMap((packageId) => collectApi({ repoRoot, packageId }).symbols);
    const matches = symbols.filter((symbol) => symbol.id === target || symbol.name === target || symbol.name.endsWith(`.${target}`));
    if (matches.length === 0) throw new Error(`Symbol not found: ${target}`);
    console.log(JSON.stringify({ schemaVersion: 1, query: target, symbols: matches }, null, 2));
    return;
  }
  throw new Error(`Unknown API index command: ${command}`);
}

async function generatePackage(packageId) {
  const index = collectApi({ repoRoot, packageId });
  const root = outputRoot(packageId);
  const apiDirectory = join(root, "api");
  const agentDirectory = join(root, "agent");
  const duplicateDirectory = join(root, "duplicates");
  await Promise.all([mkdir(apiDirectory, { recursive: true }), mkdir(agentDirectory, { recursive: true }), mkdir(duplicateDirectory, { recursive: true })]);
  await writeFile(join(apiDirectory, `${packageId}.json`), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await writeFile(join(apiDirectory, `${packageId}.md`), renderMarkdown(index), "utf8");
  await writeFile(join(agentDirectory, `${packageId}-context.json`), renderAgentContext(index), "utf8");
  const report = findDuplicateCandidates([index]);
  await writeFile(join(duplicateDirectory, `${packageId}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Generated ${packageId}: ${index.symbols.length} symbols, ${report.counts.exact} exact duplicates, ${report.counts.candidates} candidates.`);
}

async function checkPackage(packageId) {
  const index = collectApi({ repoRoot, packageId });
  const root = outputRoot(packageId);
  const expected = {
    [join(root, "api", `${packageId}.json`)]: `${JSON.stringify(index, null, 2)}\n`,
    [join(root, "api", `${packageId}.md`)]: renderMarkdown(index),
    [join(root, "agent", `${packageId}-context.json`)]: renderAgentContext(index),
    [join(root, "duplicates", `${packageId}.json`)]: `${JSON.stringify(findDuplicateCandidates([index]), null, 2)}\n`,
  };
  return Object.entries(expected).flatMap(([path, content]) => {
    if (!existsSync(path)) return [`missing ${path}; run npm run api:index`];
    return readFileSync(path, "utf8") === content ? [] : [`stale ${path}; run npm run api:index`];
  });
}

function outputRoot(packageId) {
  return join(repoRoot, "docs", "generated");
}

function selectedPackages(argv) {
  if (argv.includes("--all")) return Object.keys(PACKAGE_CONFIGS);
  const index = argv.indexOf("--package");
  const value = index >= 0 ? argv[index + 1] : "atoms";
  if (!PACKAGE_CONFIGS[value]) throw new Error(`Unknown package: ${value}`);
  return [value];
}

function valueOf(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function score(symbol, tokens) {
  const haystack = `${symbol.name} ${symbol.signature} ${symbol.summary} ${symbol.tags.map((tag) => `${tag.name} ${tag.text}`).join(" ")} ${symbol.module}`.toLowerCase();
  return tokens.reduce((scoreValue, token) => scoreValue + (symbol.name.toLowerCase().includes(token) ? 5 : 0) + (haystack.includes(token) ? 1 : 0), 0);
}
