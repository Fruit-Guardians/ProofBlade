import { execFile, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { RawEffectResult } from "../domain/types.js";
import { readVisibleBinaryFile, validateBinaryInput, type BinaryCapabilityInput } from "./binary.js";

const RIZIN_ADAPTER_VERSION = "1";
const RIZIN_TIMEOUT_MS = 90_000;
const RIZIN_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_FUNCTIONS = 2_000;
const DEFAULT_INSTRUCTIONS = 128;
const DEFAULT_XREFS = 1_000;

export type ReverseOperation = "functions" | "disassemble" | "xrefs";
export type XrefDirection = "to" | "from" | "both";

export interface ReverseFunction {
  index: number;
  address: string;
  name: string;
  size: number;
  type?: string;
}

export interface ReverseInstruction {
  address: string;
  bytes: string;
  mnemonic: string;
  operands: string;
  type?: string;
}

export interface ReverseXref {
  from: string;
  to: string;
  type?: string;
}

export interface ReverseCapabilityInput extends BinaryCapabilityInput {
  [key: string]: unknown;
  address?: string;
  maxResults?: number;
  maxInstructions?: number;
  direction?: XrefDirection;
}

export interface RizinProcessRunner {
  (executable: string, args: string[], cwd: string, signal: AbortSignal): Promise<RawEffectResult>;
}

export interface RizinCapabilityOptions {
  executable?: string;
  version?: string;
  runner?: RizinProcessRunner;
}

export interface RizinAvailability {
  executable?: string;
  version: string;
  available: boolean;
  reason?: string;
  runner: RizinProcessRunner;
}

export async function executeRizinCapability(
  operation: ReverseOperation,
  input: ReverseCapabilityInput,
  fixtureRoot: string,
  executable: string,
  runner: RizinProcessRunner,
  signal: AbortSignal,
): Promise<RawEffectResult> {
  const started = Date.now();
  try {
    validateReverseInput(operation, input);
    const value = await withStagedVisibleBinary(fixtureRoot, input.path, signal, async (stagedPath) => {
      const value = operation === "functions"
        ? await queryFunctions(executable, stagedPath, runner, input, signal)
        : operation === "disassemble"
          ? await queryDisassembly(executable, stagedPath, runner, input, signal)
          : await queryXrefs(executable, stagedPath, runner, input, signal);
      throwIfAborted(signal);
      return value;
    });
    return { stdout: JSON.stringify(value, null, 2), stderr: "", exitCode: 0, durationMs: Date.now() - started };
  } catch (error) {
    return { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: signal.aborted ? null : 1, durationMs: Date.now() - started };
  }
}

/**
 * Give an external analyzer only a short-lived copy of a validated fixture
 * binary. The caller retains the logical relative path for effects and jobs.
 */
export async function withStagedVisibleBinary<T>(fixtureRoot: string, inputPath: string, signal: AbortSignal, execute: (stagedPath: string) => Promise<T>): Promise<T> {
  throwIfAborted(signal);
  const bytes = await readVisibleBinaryFile(fixtureRoot, inputPath);
  throwIfAborted(signal);
  const stagingRoot = await mkdtemp(join(tmpdir(), "proofblade-reverse-"));
  const stagedPath = join(stagingRoot, "input.bin");
  try {
    await writeFile(stagedPath, bytes, { flag: "wx", mode: 0o600 });
    throwIfAborted(signal);
    return await execute(stagedPath);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export function reverseOperation(operation: string): ReverseOperation {
  if (operation === "functions" || operation === "disassemble" || operation === "xrefs") return operation;
  throw new Error(`Unsupported reverse operation: ${operation}`);
}

export function validateReverseInput(operation: string, input: Record<string, unknown>): asserts input is ReverseCapabilityInput {
  reverseOperation(operation);
  validateBinaryInput(operation, input);
  if (operation === "functions") {
    assertInteger(input.maxResults, "maxResults", 1, 10_000);
    return;
  }
  const address = input.address;
  if (typeof address !== "string" || !/^0x[0-9a-f]{1,16}$/i.test(address)) throw new Error(`Reverse ${operation} requires a 64-bit hexadecimal address`);
  try { BigInt(address); } catch { throw new Error(`Reverse ${operation} address is invalid`); }
  if (operation === "disassemble") assertInteger(input.maxInstructions, "maxInstructions", 1, 512);
  if (operation === "xrefs") {
    assertInteger(input.maxResults, "maxResults", 1, 10_000);
    if (input.direction !== undefined && input.direction !== "to" && input.direction !== "from" && input.direction !== "both") throw new Error("Reverse xrefs direction must be to, from, or both");
  }
}

export function createRizinAvailability(options: RizinCapabilityOptions = {}): RizinAvailability {
  if (options.runner) {
    const version = options.version ?? "test";
    return { executable: options.executable ?? "rz", version: `rizin-${version}-adapter-${RIZIN_ADAPTER_VERSION}`, available: true, runner: options.runner };
  }
  const configured = options.executable ?? process.env.PROOFBLADE_RIZIN_PATH;
  const executable = configured ? resolveExecutable(configured) : resolveExecutable("rz") ?? resolveExecutable("rizin");
  const runner = defaultRizinRunner;
  if (!executable) return { version: `unavailable-adapter-${RIZIN_ADAPTER_VERSION}`, available: false, reason: "Rizin executable not found; install rz/rizin or set PROOFBLADE_RIZIN_PATH", runner };
  const probe = spawnSync(executable, ["-v"], { encoding: "utf8", timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024 });
  if (probe.error || probe.status !== 0) return { executable, version: `unavailable-adapter-${RIZIN_ADAPTER_VERSION}`, available: false, reason: `Rizin probe failed: ${probe.error?.message ?? String(probe.stderr || probe.stdout || "unknown error")}`, runner };
  const engineVersion = String(probe.stdout || probe.stderr).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "unknown";
  return { executable, version: `rizin-${engineVersion}-adapter-${RIZIN_ADAPTER_VERSION}`, available: true, runner };
}

async function queryFunctions(executable: string, file: string, runner: RizinProcessRunner, input: ReverseCapabilityInput, signal: AbortSignal): Promise<Record<string, unknown>> {
  const result = await runQuery(executable, file, "aflj", runner, signal);
  return { format: "rizin", functions: normalizeFunctions(parseJsonArray(result.stdout, "functions"), input.maxResults ?? DEFAULT_FUNCTIONS) };
}

async function queryDisassembly(executable: string, file: string, runner: RizinProcessRunner, input: ReverseCapabilityInput, signal: AbortSignal): Promise<Record<string, unknown>> {
  const result = await runQuery(executable, file, `pdj ${input.maxInstructions ?? DEFAULT_INSTRUCTIONS} @ ${input.address}`, runner, signal);
  return {
    format: "rizin",
    address: normalizeAddress(input.address, "disassembly address"),
    instructions: normalizeInstructions(parseJsonArray(result.stdout, "disassemble"), input.maxInstructions ?? DEFAULT_INSTRUCTIONS),
  };
}

async function queryXrefs(executable: string, file: string, runner: RizinProcessRunner, input: ReverseCapabilityInput, signal: AbortSignal): Promise<Record<string, unknown>> {
  const direction = input.direction ?? "to";
  const commands = direction === "both" ? ["axtj", "axfj"] : [direction === "from" ? "axfj" : "axtj"];
  const rows: Array<Record<string, unknown>> = [];
  for (const command of commands) {
    const result = await runQuery(executable, file, `${command} @ ${input.address}`, runner, signal);
    rows.push(...parseJsonArray(result.stdout, "xrefs"));
  }
  return {
    format: "rizin",
    address: normalizeAddress(input.address, "xref address"),
    direction,
    xrefs: normalizeXrefs(rows, input.maxResults ?? DEFAULT_XREFS),
  };
}

export function normalizeFunctions(rows: Array<Record<string, unknown>>, maxResults: number): ReverseFunction[] {
  const functions = rows.map((item) => ({
    address: normalizeAddress(item.offset ?? item.address ?? item.addr, "function address"),
    name: typeof item.name === "string" ? item.name : `function_${String(item.offset ?? item.address ?? item.addr ?? "unknown")}`,
    size: normalizeNumber(item.realsz ?? item.size ?? 0, "function size"),
    type: typeof item.type === "string" ? item.type : undefined,
  })).sort((left, right) => compareAddress(left.address, right.address) || left.name.localeCompare(right.name));
  return functions.slice(0, maxResults).map((item, index) => ({ index, ...item }));
}

export function normalizeInstructions(rows: Array<Record<string, unknown>>, maxInstructions: number): ReverseInstruction[] {
  return rows.map((item) => {
    const disassembly = typeof item.opcode === "string" ? item.opcode : typeof item.disasm === "string" ? item.disasm : "";
    const parsed = splitInstruction(disassembly);
    return {
      address: normalizeAddress(item.offset ?? item.address ?? item.addr, "instruction address"),
      bytes: typeof item.bytes === "string" ? item.bytes : "",
      mnemonic: typeof item.mnemonic === "string" ? item.mnemonic : parsed.mnemonic,
      operands: typeof item.operands === "string" ? item.operands : parsed.operands,
      type: typeof item.type === "string" ? item.type : undefined,
    };
  }).sort((left, right) => compareAddress(left.address, right.address) || left.bytes.localeCompare(right.bytes) || left.mnemonic.localeCompare(right.mnemonic))
    .slice(0, maxInstructions);
}

export function normalizeXrefs(rows: Array<Record<string, unknown>>, maxResults: number): ReverseXref[] {
  return rows.map((item) => ({
    from: normalizeAddress(item.from ?? item.source ?? item.addr, "xref source"),
    to: normalizeAddress(item.to ?? item.target ?? item.at, "xref target"),
    type: typeof item.type === "string" ? item.type : undefined,
  })).filter((item, index, all) => all.findIndex((candidate) => candidate.from === item.from && candidate.to === item.to && candidate.type === item.type) === index)
    .sort((left, right) => compareAddress(left.from, right.from) || compareAddress(left.to, right.to) || (left.type ?? "").localeCompare(right.type ?? ""))
    .slice(0, maxResults);
}

async function runQuery(executable: string, file: string, command: string, runner: RizinProcessRunner, signal: AbortSignal): Promise<RawEffectResult> {
  const result = await runner(executable, ["-q", "-A", "-c", command, "-c", "q", file], tmpdir(), signal);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Rizin command failed: ${command}`);
  return result;
}

function parseJsonArray(output: string, operation: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch (error) { throw new Error(`Rizin ${operation} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new Error(`Rizin ${operation} returned an invalid result shape`);
  return parsed as Array<Record<string, unknown>>;
}

function normalizeAddress(value: unknown, label: string): string {
  if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) throw new Error(`Rizin ${label} is missing or unsafe`);
  try {
    const parsed = BigInt(value as string | number);
    if (parsed < 0n) throw new Error("negative");
    return `0x${parsed.toString(16)}`;
  } catch { throw new Error(`Rizin ${label} is invalid`); }
}

function normalizeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Rizin ${label} is invalid`);
  return value;
}

function splitInstruction(value: string): { mnemonic: string; operands: string } {
  const trimmed = value.trim();
  const separator = trimmed.search(/\s/);
  return separator < 0 ? { mnemonic: trimmed, operands: "" } : { mnemonic: trimmed.slice(0, separator), operands: trimmed.slice(separator).trim() };
}

function compareAddress(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function assertInteger(value: unknown, name: string, min: number, max: number): asserts value is number | undefined {
  if (value === undefined) return;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Reverse ${name} must be an integer between ${min} and ${max}`);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Rizin analysis aborted");
}

function resolveExecutable(requested: string): string | undefined {
  return resolveExecutableName(requested);
}

function resolveExecutableName(name: string): string | undefined {
  if (isAbsolute(name) || name.includes("/") || name.includes(sep)) {
    const candidate = isAbsolute(name) ? name : resolve(name);
    return existsFile(candidate) ? candidate : undefined;
  }
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const directory of pathValue.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = resolve(directory, `${name}${extension}`);
      if (existsFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function existsFile(path: string): boolean {
  try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
}

const defaultRizinRunner: RizinProcessRunner = async (executable, args, cwd, signal) => await new Promise((resolve) => {
  const started = Date.now();
  execFile(executable, args, { cwd, encoding: "utf8", maxBuffer: RIZIN_MAX_OUTPUT_BYTES, timeout: RIZIN_TIMEOUT_MS, windowsHide: true, signal }, (error, stdout, stderr) => {
    const aborted = signal.aborted || error?.name === "AbortError";
    const processStderr = String(stderr ?? "").trim();
    const processError = error ? [error.message, typeof error.code === "string" ? error.code : undefined].filter(Boolean).join(" ") : "";
    resolve({ stdout: String(stdout ?? ""), stderr: processStderr || processError, exitCode: aborted ? null : error ? 1 : 0, durationMs: Date.now() - started });
  });
});
