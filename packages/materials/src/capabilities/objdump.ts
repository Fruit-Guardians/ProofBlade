import { execFile, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve, sep } from "node:path";
import type { RawEffectResult } from "../domain/types.js";
import { validateReverseInput, withStagedVisibleBinary, type ReverseCapabilityInput, type ReverseInstruction } from "./reverse.js";

const OBJDUMP_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface ObjdumpProcessRunner {
  (executable: string, args: string[], signal: AbortSignal): Promise<RawEffectResult>;
}

export interface ObjdumpAvailability {
  executable?: string;
  version: string;
  available: boolean;
  reason?: string;
  runner: ObjdumpProcessRunner;
}

export interface ObjdumpCapabilityOptions {
  executable?: string;
  version?: string;
  runner?: ObjdumpProcessRunner;
}

/** A bounded, read-only fallback when a deep reverse backend is unavailable. */
export function createObjdumpAvailability(options: ObjdumpCapabilityOptions = {}): ObjdumpAvailability {
  if (options.runner) {
    return { executable: options.executable ?? "objdump", version: `objdump-${options.version ?? "test"}-adapter-1`, available: true, runner: options.runner };
  }
  const executable = options.executable ?? process.env.PROOFBLADE_OBJDUMP_PATH ?? resolveExecutable("objdump");
  const runner = defaultObjdumpRunner;
  if (!executable) return { version: "unavailable-adapter-1", available: false, reason: "objdump executable not found; install objdump or set PROOFBLADE_OBJDUMP_PATH", runner };
  const probe = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024 });
  if (probe.error || probe.status !== 0) return { executable, version: "unavailable-adapter-1", available: false, reason: `objdump probe failed: ${probe.error?.message ?? String(probe.stderr || probe.stdout || "unknown error")}`, runner };
  const line = String(probe.stdout || probe.stderr).split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? "unknown";
  return { executable, version: `objdump-${line}-adapter-1`, available: true, runner };
}

export async function executeObjdumpDisassembly(
  input: ReverseCapabilityInput,
  fixtureRoot: string,
  executable: string,
  runner: ObjdumpProcessRunner,
  signal: AbortSignal,
): Promise<RawEffectResult> {
  const started = Date.now();
  try {
    validateReverseInput("disassemble", input);
    const maxInstructions = input.maxInstructions ?? 128;
    const start = BigInt(input.address!);
    // x86 instructions are at most 15 bytes; a small cushion keeps an
    // instruction that starts before the boundary from being cut in half.
    const stop = start + BigInt(maxInstructions * 16 + 16);
    const result = await withStagedVisibleBinary(fixtureRoot, input.path, signal, async (stagedPath) => await runner(executable, [
      "-d",
      `--start-address=${toHex(start)}`,
      `--stop-address=${toHex(stop)}`,
      "--",
      stagedPath,
    ], signal));
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "objdump disassembly failed");
    const instructions = parseObjdumpInstructions(result.stdout, maxInstructions);
    if (instructions.length === 0) throw new Error(`objdump returned no instructions at ${input.address}`);
    return {
      stdout: JSON.stringify({ format: "objdump", address: toHex(start), instructions }, null, 2),
      stderr: "",
      exitCode: 0,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: signal.aborted ? null : 1, durationMs: Date.now() - started };
  }
}

export function parseObjdumpInstructions(stdout: string, maxInstructions: number): ReverseInstruction[] {
  const instructions: ReverseInstruction[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*([0-9a-f]+):\s+((?:[0-9a-f]{2}\s+)+)(.+)$/i.exec(line);
    if (!match) continue;
    const assembly = match[3]!.trim();
    const separator = assembly.search(/\s/);
    const mnemonic = separator < 0 ? assembly : assembly.slice(0, separator);
    instructions.push({
      address: `0x${BigInt(`0x${match[1]}`).toString(16)}`,
      bytes: match[2]!.trim().replace(/\s+/g, " "),
      mnemonic,
      operands: separator < 0 ? "" : assembly.slice(separator).trim(),
    });
    if (instructions.length >= maxInstructions) break;
  }
  return instructions;
}

function toHex(value: bigint): string { return `0x${value.toString(16)}`; }

function resolveExecutable(name: string): string | undefined {
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

const defaultObjdumpRunner: ObjdumpProcessRunner = async (executable, args, signal) => await new Promise((resolve) => {
  const started = Date.now();
  execFile(executable, args, { encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, timeout: OBJDUMP_TIMEOUT_MS, windowsHide: true, signal }, (error, stdout, stderr) => {
    const aborted = signal.aborted || error?.name === "AbortError";
    const processStderr = String(stderr ?? "").trim();
    const processError = error ? [error.message, typeof error.code === "string" ? error.code : undefined].filter(Boolean).join(" ") : "";
    resolve({ stdout: String(stdout ?? ""), stderr: processStderr || processError, exitCode: aborted ? null : error ? 1 : 0, durationMs: Date.now() - started });
  });
});
