import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { TargetKind } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import { assertRunId } from "../domain/run-id.js";

const MAX_CORPUS_FILE_BYTES = 128 * 1024 * 1024;
const RESERVED_TARGET_PATHS = new Set(["challenge.txt", "generation.txt"]);

export interface RealEvaluationCorpusManifest {
  schemaVersion: 1;
  id: string;
  cases: RealEvaluationCorpusCase[];
}

export interface RealEvaluationCorpusCase {
  id: string;
  targetKind: TargetKind;
  objective: string;
  expected: string;
  files: Array<{ source: string; path?: string; sha256: string }>;
}

export interface RealEvaluationCorpusSnapshot {
  hash: string;
  id: string;
  cases: Array<{
    id: string;
    targetKind: TargetKind;
    objectiveHash: string;
    expectedHash: string;
    files: Array<{ path: string; sha256: string; bytes: number }>;
  }>;
}

export interface LoadedRealEvaluationCorpus {
  manifestPath: string;
  root: string;
  manifest: RealEvaluationCorpusManifest;
  cases: LoadedRealEvaluationCase[];
  snapshot: RealEvaluationCorpusSnapshot;
}

export interface LoadedRealEvaluationCase {
  id: string;
  targetKind: TargetKind;
  objective: string;
  expected: string;
  files: Array<{ sourcePath: string; path: string; sha256: string; bytes: number }>;
}

/** Load and hash a local-only corpus without exposing expected values in its snapshot. */
export async function loadRealEvaluationCorpus(inputPath: string): Promise<LoadedRealEvaluationCorpus> {
  const manifestPath = resolve(inputPath);
  const root = dirname(manifestPath);
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const manifest = validateManifest(parsed);
  const cases = (await Promise.all(manifest.cases.map(async (item) => await loadCase(root, item)))).sort((left, right) => left.id.localeCompare(right.id));
  const snapshotCases = cases.map((item) => ({
    id: item.id,
    targetKind: item.targetKind,
    objectiveHash: sha256(item.objective),
    expectedHash: sha256(item.expected),
    files: item.files.map(({ path, sha256: fileHash, bytes }) => ({ path, sha256: fileHash, bytes })),
  }));
  return {
    manifestPath,
    root,
    manifest,
    cases,
    snapshot: { id: manifest.id, cases: snapshotCases, hash: sha256(canonicalJson(snapshotCases)) },
  };
}

/** Stage a fresh, read-only corpus case before the normal Fixture Sandbox builds it. */
export async function stageRealEvaluationCase(fixturesRoot: string, runId: string, corpus: LoadedRealEvaluationCorpus, item: LoadedRealEvaluationCase): Promise<void> {
  assertRunId(runId);
  const fixtureRoot = resolve(fixturesRoot, runId);
  assertInside(fixturesRoot, fixtureRoot, "Real evaluation Run ID escapes the fixtures directory");
  await mkdir(fixturesRoot, { recursive: true });
  try {
    await mkdir(fixtureRoot);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "EEXIST") throw new Error(`Real evaluation fixture already exists: ${fixtureRoot}`);
    throw error;
  }
  for (const file of item.files) {
    const target = resolveInside(fixtureRoot, file.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file.sourcePath, target);
    if (await hashFile(target) !== file.sha256) throw new Error(`Corpus source changed while staging: ${file.path}`);
  }
  await writeFile(join(fixtureRoot, "challenge.txt"), [
    `ProofBlade real evaluation corpus: ${corpus.manifest.id}/${item.id}`,
    item.objective,
    "Analyze only the listed input files. The expected answer is held by an isolated scorer.",
  ].join("\n") + "\n", "utf8");
  const privateRoot = join(fixtureRoot, ".proofblade");
  await mkdir(privateRoot, { recursive: true });
  await writeFile(join(privateRoot, "scorer.json"), JSON.stringify({ expected: item.expected }), "utf8");
}

function validateManifest(value: unknown): RealEvaluationCorpusManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Real evaluation corpus must be a JSON object");
  const record = value as Partial<RealEvaluationCorpusManifest>;
  if (record.schemaVersion !== 1) throw new Error("Real evaluation corpus schemaVersion must be 1");
  const id = requiredString(record.id, "corpus id");
  if (!Array.isArray(record.cases) || record.cases.length === 0) throw new Error("Real evaluation corpus must contain at least one case");
  const cases = record.cases.map((item, index) => validateCase(item, index));
  const ids = new Set(cases.map((item) => item.id));
  if (ids.size !== cases.length) throw new Error("Real evaluation corpus case ids must be unique");
  return { schemaVersion: 1, id, cases };
}

function validateCase(value: unknown, index: number): RealEvaluationCorpusCase {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Corpus case ${index} must be an object`);
  const record = value as Partial<RealEvaluationCorpusCase>;
  const id = requiredString(record.id, `corpus case ${index} id`);
  try {
    assertRunId(id);
  } catch {
    throw new Error(`Corpus case ${index} id must be a safe Run ID segment`);
  }
  const targetKind = record.targetKind;
  if (!isTargetKind(targetKind)) throw new Error(`Corpus case ${id} has unsupported targetKind`);
  const objective = requiredString(record.objective, `corpus case ${id} objective`);
  const expected = requiredString(record.expected, `corpus case ${id} expected`);
  if (expected.length > 1024 || /[\r\n]/.test(expected)) throw new Error(`Corpus case ${id} expected must be one line up to 1024 characters`);
  if (!Array.isArray(record.files) || record.files.length === 0) throw new Error(`Corpus case ${id} must contain at least one file`);
  const files = record.files.map((file, fileIndex) => validateFile(file, id, fileIndex));
  const paths = new Set(files.map((file) => file.path ?? basename(file.source)));
  if (paths.size !== files.length) throw new Error(`Corpus case ${id} target paths must be unique`);
  return { id, targetKind, objective, expected, files };
}

function validateFile(value: unknown, caseId: string, index: number): { source: string; path?: string; sha256: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Corpus case ${caseId} file ${index} must be an object`);
  const record = value as { source?: unknown; path?: unknown; sha256?: unknown };
  const source = requiredRelativePath(record.source, `Corpus case ${caseId} file ${index} source`);
  const path = record.path === undefined ? undefined : requiredRelativePath(record.path, `Corpus case ${caseId} file ${index} path`);
  const target = path ?? basename(source);
  if (RESERVED_TARGET_PATHS.has(target) || target.split(/[\\/]/).includes(".proofblade")) throw new Error(`Corpus case ${caseId} file ${index} uses a reserved target path`);
  const fileHash = requiredString(record.sha256, `Corpus case ${caseId} file ${index} sha256`).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fileHash)) throw new Error(`Corpus case ${caseId} file ${index} sha256 must be lowercase SHA-256`);
  return { source, ...(path ? { path } : {}), sha256: fileHash };
}

async function loadCase(root: string, item: RealEvaluationCorpusCase): Promise<LoadedRealEvaluationCase> {
  const files = await Promise.all(item.files.map(async (file) => {
    const sourcePath = await resolveCorpusFile(root, file.source);
    const metadata = await stat(sourcePath);
    if (!metadata.isFile() || metadata.size > MAX_CORPUS_FILE_BYTES) throw new Error(`Corpus file exceeds the ${MAX_CORPUS_FILE_BYTES} byte limit: ${file.source}`);
    const actualHash = await hashFile(sourcePath);
    if (actualHash !== file.sha256) throw new Error(`Corpus file hash mismatch: ${file.source}`);
    return { sourcePath, path: file.path ?? basename(file.source), sha256: actualHash, bytes: metadata.size };
  }));
  return { id: item.id, targetKind: item.targetKind, objective: item.objective, expected: item.expected, files: files.sort((left, right) => left.path.localeCompare(right.path)) };
}

async function resolveCorpusFile(root: string, source: string): Promise<string> {
  const sourcePath = resolve(root, source);
  assertInside(root, sourcePath, "Corpus source escapes its manifest directory");
  const link = await lstat(sourcePath);
  if (link.isSymbolicLink() || !link.isFile()) throw new Error(`Corpus source must be a regular file: ${source}`);
  const resolved = await realpath(sourcePath);
  assertInside(root, resolved, "Corpus source resolves outside its manifest directory");
  return resolved;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function resolveInside(root: string, path: string): string {
  const resolved = resolve(root, path);
  assertInside(root, resolved, "Corpus target escapes the fixture directory");
  return resolved;
}

function assertInside(root: string, path: string, message: string): void {
  const value = relative(resolve(root), resolve(path));
  if (value === "" || value.split(/[\\/]/)[0] === ".." || isAbsolute(value)) throw new Error(message);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function requiredRelativePath(value: unknown, label: string): string {
  const path = requiredString(value, label);
  if (isAbsolute(path) || path.split(/[\\/]/).some((segment) => segment === "" || segment === "." || segment === "..")) throw new Error(`${label} must be a safe relative path`);
  return path;
}

function isTargetKind(value: unknown): value is TargetKind {
  return value === "unknown" || value === "web" || value === "reverse" || value === "pwn" || value === "crypto" || value === "misc" || value === "mixed";
}
