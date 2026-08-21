import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const GENERATED_HEADER = "<!-- GENERATED FILE. Run npm run api:index. Do not edit manually. -->";

export function renderMarkdown(index) {
  const lines = [GENERATED_HEADER, "", `# ${index.package} API Index`, "", `- Package: \`${index.package}\``, `- Module hashes: ${Object.keys(index.moduleHashes).length}`, `- Symbols: ${index.symbols.length}`, "", "## Public Symbols", ""];
  for (const symbol of index.symbols) {
    lines.push(`### ${symbol.name}`);
    lines.push(`- Kind: \`${symbol.kind}\``);
    lines.push(`- Signature: \`${symbol.signature}\``);
    const sourcePath = `../../../${index.sourceRoot}/${symbol.module}`;
    lines.push(`- Source: [${symbol.module}:${symbol.line}](${sourcePath}:${symbol.line})`);
    lines.push(`- Export: \`${symbol.exportPath}\``);
    lines.push(`- Summary: ${symbol.summary}`);
    lines.push(`- Summary source: \`${symbol.summarySource}\``);
    if (symbol.tags.length > 0) lines.push(`- Tags: ${symbol.tags.map((tag) => `\`${tag.name}\``).join(", ")}`);
    if (symbol.testRefs.length > 0) lines.push(`- Tests: ${symbol.testRefs.map((path) => `\`${path}\``).join(", ")}`);
    lines.push("");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export function renderAgentContext(index) {
  return JSON.stringify({
    schemaVersion: 1,
    package: index.package,
    sourceRoot: index.sourceRoot,
    moduleHashes: index.moduleHashes,
    instructions: [
      "Prefer an existing canonical export before adding a new helper.",
      "Check signature, invariants, error behavior, and layer ownership before reuse.",
      "Treat duplicate candidates as evidence, not as an automatic refactor command.",
    ],
    symbols: index.symbols.map((symbol) => ({
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      signature: symbol.signature,
      summary: symbol.summary,
      summarySource: symbol.summarySource,
      tags: symbol.tags,
      exportPath: symbol.exportPath,
      module: symbol.module,
      line: symbol.line,
      moduleHash: index.moduleHashes[symbol.module],
      testRefs: symbol.testRefs,
    })),
  }, null, 2) + "\n";
}

export async function writeIndexFiles({ repoRoot, packageId, index }) {
  const root = join(repoRoot, "docs", "generated");
  const apiDirectory = join(root, "api");
  const agentDirectory = join(root, "agent");
  await mkdir(apiDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(join(apiDirectory, `${packageId}.json`), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await writeFile(join(apiDirectory, `${packageId}.md`), renderMarkdown(index), "utf8");
  await writeFile(join(agentDirectory, `${packageId}-context.json`), renderAgentContext(index), "utf8");
}

export async function readIndexFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export { GENERATED_HEADER };
