import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export interface WorkspaceSearchOptions {
  cwd: string;
  pattern?: string;
  query?: string;
  caseSensitive?: boolean;
  maxResults?: number;
  maxFileBytes?: number;
}

export interface WorkspaceGlobResult {
  kind: "glob";
  pattern: string;
  matches: string[];
  totalMatches: number;
  truncated: boolean;
}

export interface WorkspaceGrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface WorkspaceGrepResult {
  kind: "grep";
  query: string;
  matches: WorkspaceGrepMatch[];
  filesScanned: number;
  filesSkipped: number;
  totalMatches: number;
  truncated: boolean;
}

const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_MAX_FILE_BYTES = 1_048_576;
const IGNORED_DIRECTORIES = new Set([".git", ".proofblade", "node_modules"]);

export async function globWorkspace(options: WorkspaceSearchOptions): Promise<WorkspaceGlobResult> {
  const pattern = normalizePattern(options.pattern ?? "**/*");
  const maxResults = boundedLimit(options.maxResults);
  const files = await listWorkspaceFiles(options.cwd);
  const matches = files.filter((file) => globMatches(file, pattern));
  return {
    kind: "glob",
    pattern,
    matches: matches.slice(0, maxResults),
    totalMatches: matches.length,
    truncated: matches.length > maxResults,
  };
}

export async function grepWorkspace(options: WorkspaceSearchOptions): Promise<WorkspaceGrepResult> {
  const query = options.query?.trim();
  if (!query) throw new Error("grep requires a non-empty query");
  const pattern = normalizePattern(options.pattern ?? "**/*");
  const maxResults = boundedLimit(options.maxResults);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 16 * 1024 * 1024) throw new Error("maxFileBytes must be an integer from 1 to 16777216");
  const matcher = options.caseSensitive === false ? query.toLocaleLowerCase() : query;
  const files = (await listWorkspaceFiles(options.cwd)).filter((file) => globMatches(file, pattern));
  const matches: WorkspaceGrepMatch[] = [];
  let filesScanned = 0;
  let filesSkipped = 0;
  let truncated = false;
  for (const path of files) {
    if (truncated) break;
    const absolute = resolve(options.cwd, path);
    try {
      const info = await stat(absolute);
      if (!info.isFile() || info.size > maxFileBytes) {
        filesSkipped += 1;
        continue;
      }
      const content = await readFile(absolute);
      if (looksBinary(content)) {
        filesSkipped += 1;
        continue;
      }
      filesScanned += 1;
      const lines = content.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index]!;
        const candidate = options.caseSensitive === false ? text.toLocaleLowerCase() : text;
        if (!candidate.includes(matcher)) continue;
        if (matches.length < maxResults) {
          matches.push({ path, line: index + 1, text: text.slice(0, 2_000) });
        } else {
          truncated = true;
          break;
        }
      }
    } catch {
      filesSkipped += 1;
    }
  }
  const totalMatches = truncated ? maxResults + 1 : matches.length;
  return { kind: "grep", query, matches, filesScanned, filesSkipped, totalMatches, truncated };
}

export function workspaceSearchText(result: WorkspaceGlobResult | WorkspaceGrepResult): string {
  if (result.kind === "glob") {
    return [
      `glob pattern=${result.pattern} matches=${result.totalMatches}${result.truncated ? " truncated=true" : ""}`,
      ...result.matches,
    ].join("\n");
  }
  return [
    `grep query=${JSON.stringify(result.query)} matches=${result.totalMatches}${result.truncated ? " truncated=true" : ""} filesScanned=${result.filesScanned} filesSkipped=${result.filesSkipped}`,
    ...result.matches.map((match) => `${match.path}:${match.line}:${match.text}`),
  ].join("\n");
}

export function workspaceSearchHash(result: WorkspaceGlobResult | WorkspaceGrepResult): string {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

async function listWorkspaceFiles(cwd: string): Promise<string[]> {
  const root = resolve(cwd);
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push(relative(root, absolute).split(sep).join("/"));
    }
  };
  await visit(root);
  return output.sort((left, right) => left.localeCompare(right));
}

function normalizePattern(pattern: string): string {
  const normalized = pattern.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error("Search pattern must stay inside the workspace");
  return normalized;
}

function globMatches(path: string, pattern: string): boolean {
  let regex = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        regex += "(?:.*/)?";
        index += 2;
      } else {
        regex += ".*";
        index += 1;
      }
    } else if (character === "*") {
      regex += "[^/]*";
    } else if (character === "?") {
      regex += "[^/]";
    } else {
      regex += escapeRegex(character);
    }
  }
  return new RegExp(`${regex}/?$`).test(path);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+\.]/g, "\\$&");
}

function looksBinary(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.length, 8_192));
  return sample.includes(0);
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RESULTS;
  if (!Number.isInteger(value) || value < 1 || value > 2_000) throw new Error("maxResults must be an integer from 1 to 2000");
  return value;
}
