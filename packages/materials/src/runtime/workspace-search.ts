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
export const WORKSPACE_SEARCH_MODEL_MAX_CHARS = 12_000;
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

/** Render a bounded model-facing view; the complete result remains in its Artifact. */
export function workspaceSearchText(result: WorkspaceGlobResult | WorkspaceGrepResult, maxChars = WORKSPACE_SEARCH_MODEL_MAX_CHARS): string {
  if (!Number.isInteger(maxChars) || maxChars < 64 || maxChars > 64_000) throw new Error("Search presentation maxChars must be an integer from 64 to 64000");
  if (result.kind === "glob") {
    return boundPresentation([
      `glob pattern=${result.pattern} matches=${result.totalMatches}${result.truncated ? " truncated=true" : ""}`,
      ...result.matches,
    ].join("\n"), maxChars);
  }
  return boundPresentation([
    `grep query=${JSON.stringify(result.query)} matches=${result.totalMatches}${result.truncated ? " truncated=true" : ""} filesScanned=${result.filesScanned} filesSkipped=${result.filesSkipped}`,
    ...result.matches.map((match) => `${match.path}:${match.line}:${match.text}`),
  ].join("\n"), maxChars);
}

/** Bound the structured result independently from its text rendering. */
export function limitWorkspaceSearchResult<T extends WorkspaceGlobResult | WorkspaceGrepResult>(result: T, maxChars = WORKSPACE_SEARCH_MODEL_MAX_CHARS): T {
  if (!Number.isInteger(maxChars) || maxChars < 256 || maxChars > 64_000) throw new Error("Search result maxChars must be an integer from 256 to 64000");
  if (JSON.stringify(result).length <= maxChars) return structuredClone(result);
  let low = 0;
  let high = result.matches.length;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    const candidate = { ...result, matches: result.matches.slice(0, count), truncated: true };
    if (JSON.stringify(candidate).length <= maxChars) low = count;
    else high = count - 1;
  }
  return { ...result, matches: result.matches.slice(0, low), truncated: true } as T;
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

function boundPresentation(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = `\n...[${value.length - Math.max(32, maxChars - 64)} chars archived in the result Artifact]...\n`;
  const contentBudget = Math.max(32, maxChars - marker.length);
  const head = Math.ceil(contentBudget * 0.65);
  return `${value.slice(0, head)}${marker}${value.slice(-Math.max(0, contentBudget - head))}`.slice(0, maxChars);
}
