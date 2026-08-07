import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderProjectReports } from "./project-report-lib.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const reports = renderProjectReports(root);

for (const [relativePath, content] of reports) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

console.log(`Project reports generated (${reports.size} files).`);
