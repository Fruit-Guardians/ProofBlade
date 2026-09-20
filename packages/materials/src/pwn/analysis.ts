const DEFAULT_ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const DEFAULT_CYCLIC_N = 4;
const DEFAULT_PATTERN_LENGTH = 1_024;
const MAX_PATTERN_LENGTH = 1_048_576;
const MAX_TRANSCRIPT_LENGTH = 256 * 1024;

export type CyclicEndian = "little" | "big";
export type PwnCrashClassification = "crash" | "timeout" | "exit" | "unknown";

export interface CyclicPatternOptions {
  alphabet?: string;
  n?: number;
}

export interface CyclicOffsetOptions extends CyclicPatternOptions {
  pattern?: string;
  patternLength?: number;
  endian?: CyclicEndian;
}

export interface CyclicOffsetResult {
  value: string;
  needle: string;
  offset?: number;
  patternLength: number;
  endian: CyclicEndian;
  n: number;
}

export interface GdbRegisterSnapshot {
  rip?: string;
  rsp?: string;
  rbp?: string;
  eip?: string;
  esp?: string;
  ebp?: string;
  pc?: string;
}

export interface GdbMappingSnapshot {
  start: string;
  end: string;
  permissions: string;
  path?: string;
}

export interface PwnCrashReport {
  parserVersion: 1;
  classification: PwnCrashClassification;
  signal?: string;
  registers: GdbRegisterSnapshot;
  faultAddress?: string;
  mappings: GdbMappingSnapshot[];
  controlRegister?: "rip" | "eip" | "pc";
  cyclic?: CyclicOffsetResult;
  ripControlled: boolean;
  transcriptTruncated: boolean;
  nextActions: string[];
}

/** Generate the same de Bruijn-style alphabet pattern used by common pwn tools. */
export function generateCyclicPattern(length: number, options: CyclicPatternOptions = {}): string {
  const alphabet = validateAlphabet(options.alphabet ?? DEFAULT_ALPHABET);
  const n = validateN(options.n ?? DEFAULT_CYCLIC_N);
  validatePatternLength(length);
  const capacity = BigInt(alphabet.length) ** BigInt(n);
  if (BigInt(length) > capacity) throw new Error(`cyclic pattern length exceeds the ${capacity.toString()} byte pattern capacity`);

  const state = new Array<number>(alphabet.length * n).fill(0);
  const output: string[] = [];
  const visit = (index: number, period: number): void => {
    if (output.length >= length) return;
    if (index > n) {
      if (n % period === 0) {
        for (let cursor = 1; cursor <= period && output.length < length; cursor += 1) output.push(alphabet[state[cursor]!]);
      }
      return;
    }
    state[index] = state[index - period]!;
    visit(index + 1, period);
    if (output.length >= length) return;
    for (let value = state[index - period]! + 1; value < alphabet.length; value += 1) {
      state[index] = value;
      visit(index + 1, index);
      if (output.length >= length) return;
    }
  };
  visit(1, 1);
  return output.join("").slice(0, length);
}

/** Locate an overwritten register value in a deterministic cyclic pattern. */
export function findCyclicOffset(value: string, options: CyclicOffsetOptions = {}): CyclicOffsetResult {
  const alphabet = validateAlphabet(options.alphabet ?? DEFAULT_ALPHABET);
  const n = validateN(options.n ?? DEFAULT_CYCLIC_N);
  const endian = options.endian ?? "little";
  const pattern = options.pattern ?? generateCyclicPattern(options.patternLength ?? DEFAULT_PATTERN_LENGTH, { alphabet, n });
  if (options.pattern !== undefined && options.pattern.length > MAX_PATTERN_LENGTH) throw new Error(`cyclic pattern must be at most ${MAX_PATTERN_LENGTH} characters`);
  if (pattern.length === 0) throw new Error("cyclic pattern must not be empty");
  const needle = cyclicNeedle(value, n, endian);
  const offset = pattern.indexOf(needle);
  return {
    value: value.trim(),
    needle,
    ...(offset < 0 ? {} : { offset }),
    patternLength: pattern.length,
    endian,
    n,
  };
}

/** Parse a bounded GDB transcript into facts useful for the next exploit step. */
export function analyzeGdbTranscript(transcript: string, options: CyclicOffsetOptions = {}): PwnCrashReport {
  if (typeof transcript !== "string" || transcript.length === 0) throw new Error("GDB transcript must be a non-empty string");
  const transcriptTruncated = transcript.length > MAX_TRANSCRIPT_LENGTH;
  const visible = transcriptTruncated ? transcript.slice(-MAX_TRANSCRIPT_LENGTH) : transcript;
  const signal = matchSignal(visible);
  const registers = parseRegisters(visible);
  const faultAddress = matchHex(visible, /(?:cannot access memory at address|access memory at address|si_addr\s*[:=])\s*(0x[0-9a-f]+)/i);
  const mappings = parseMappings(visible);
  const classification = signal
    ? "crash" as const
    : /(?:timed?\s*out|timeout)/i.test(visible)
      ? "timeout" as const
      : /(?:exited|exit(?:ed)?\s+with|inferior\s+\d+\s+\(process\s+\d+\)\s+exited)/i.test(visible)
        ? "exit" as const
        : "unknown" as const;
  const controlRegister = registers.rip !== undefined ? "rip" as const : registers.eip !== undefined ? "eip" as const : registers.pc !== undefined ? "pc" as const : undefined;
  const controlValue = controlRegister ? registers[controlRegister] : undefined;
  const cyclic = controlValue === undefined ? undefined : findCyclicOffset(controlValue, options);
  const ripControlled = cyclic?.offset !== undefined;
  return {
    parserVersion: 1,
    classification,
    ...(signal ? { signal } : {}),
    registers,
    ...(faultAddress ? { faultAddress } : {}),
    mappings,
    ...(controlRegister ? { controlRegister } : {}),
    ...(cyclic ? { cyclic } : {}),
    ripControlled,
    transcriptTruncated,
    nextActions: nextActions({ classification, signal, controlRegister, ripControlled, faultAddress, mappings }),
  };
}

function validateAlphabet(value: string): string {
  if (value.length < 2 || value.length > 128 || new Set(value).size !== value.length || /[\u0000\r\n]/.test(value)) {
    throw new Error("cyclic alphabet must contain 2-128 unique non-newline characters");
  }
  return value;
}

function validateN(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 8) throw new Error("cyclic n must be an integer from 1 to 8");
  return value;
}

function validatePatternLength(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PATTERN_LENGTH) throw new Error(`cyclic pattern length must be an integer from 1 to ${MAX_PATTERN_LENGTH}`);
}

function cyclicNeedle(value: string, n: number, endian: CyclicEndian): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("cyclic value must not be empty");
  if (!/^0x[0-9a-f]+$/i.test(trimmed) && !/^[0-9a-f]+$/i.test(trimmed) && trimmed.length < n) {
    throw new Error(`cyclic value must be hexadecimal or at least ${n} printable characters`);
  }
  if (/^0x[0-9a-f]+$/i.test(trimmed) || /^[0-9a-f]+$/i.test(trimmed)) {
    const digits = trimmed.replace(/^0x/i, "");
    if (digits.length === 0) throw new Error("cyclic hexadecimal value must not be empty");
    const numeric = BigInt(`0x${digits}`);
    const bytes = Buffer.alloc(n);
    for (let index = 0; index < n; index += 1) {
      const shift = endian === "little" ? index : n - index - 1;
      bytes[index] = Number((numeric >> BigInt(shift * 8)) & 0xffn);
    }
    return bytes.toString("latin1");
  }
  return trimmed.slice(0, n);
}

function matchSignal(text: string): string | undefined {
  const match = /\b(SIG[A-Z][A-Z0-9]+)\b/.exec(text);
  return match?.[1];
}

function parseRegisters(text: string): GdbRegisterSnapshot {
  const registers: GdbRegisterSnapshot = {};
  const names = ["rip", "rsp", "rbp", "eip", "esp", "ebp", "pc"] as const;
  for (const name of names) {
    const linePattern = new RegExp(`^\\s*${name}\\s+(0x[0-9a-f]+)\\b`, "im");
    const labeledPattern = new RegExp(`\\b${name}\\s*[:=]\\s*(0x[0-9a-f]+)\\b`, "i");
    const match = linePattern.exec(text) ?? labeledPattern.exec(text);
    if (match?.[1]) registers[name] = normalizeHex(match[1]);
  }
  return registers;
}

function parseMappings(text: string): GdbMappingSnapshot[] {
  const mappings: GdbMappingSnapshot[] = [];
  for (const line of text.split(/\r?\n/)) {
    const mapping = parseMappingLine(line);
    if (!mapping) continue;
    mappings.push(mapping);
    if (mappings.length >= 256) break;
  }
  return mappings;
}

function parseMappingLine(line: string): GdbMappingSnapshot | undefined {
  // GDB `info proc mappings` has start/end followed by size and offset;
  // pwndbg vmmap and shorter GDB output commonly omit one or both columns.
  const gdb = /^\s*((?:0x)?[0-9a-f]+)\s+((?:0x)?[0-9a-f]+)(?:\s+(?:0x)?[0-9a-f]+){0,2}\s+([rwxps-]{3,6})\b(?:\s+(.*?))?\s*$/i.exec(line);
  if (gdb) return mapping(gdb[1], gdb[2], gdb[3], gdb[4]);

  // `/proc/<pid>/maps` uses a hyphenated range and includes offset/device/inode
  // before the optional object name.
  const proc = /^\s*((?:0x)?[0-9a-f]+)-((?:0x)?[0-9a-f]+)\s+([rwxps-]{3,6})\s+[0-9a-f]+\s+\S+\s+\d+(?:\s+(.*?))?\s*$/i.exec(line);
  if (proc) return mapping(proc[1], proc[2], proc[3], proc[4]);
  return undefined;
}

function mapping(startValue: string | undefined, endValue: string | undefined, permissionsValue: string | undefined, pathValue: string | undefined): GdbMappingSnapshot {
  const start = normalizeHex(startValue)!;
  const end = normalizeHex(endValue)!;
  const permissions = permissionsValue!.toLowerCase();
  const path = pathValue?.trim();
  return { start, end, permissions, ...(path ? { path: path.slice(0, 256) } : {}) };
}

function matchHex(text: string, pattern: RegExp): string | undefined {
  return normalizeHex(pattern.exec(text)?.[1]);
}

function normalizeHex(value: string | undefined): string | undefined {
  return value ? `0x${value.replace(/^0x/i, "").toLowerCase()}` : undefined;
}

function nextActions(input: {
  classification: PwnCrashClassification;
  signal: string | undefined;
  controlRegister: "rip" | "eip" | "pc" | undefined;
  ripControlled: boolean;
  faultAddress: string | undefined;
  mappings: GdbMappingSnapshot[];
}): string[] {
  if (input.ripControlled) {
    return [
      "Persist the cyclic offset as a primitive precondition before changing the payload.",
      "Use the binary protection profile to choose ret2win, ROP, or a leak-first path.",
      "Re-run the same stage from a fresh target after changing only one payload assumption.",
    ];
  }
  if (input.classification === "crash" && input.controlRegister === undefined) {
    return [
      "Inspect the stack pointer and saved frame with a bounded GDB memory query.",
      "Repeat with a cyclic input and keep the crash transcript as the source Artifact.",
      "Check for a canary or input-length boundary before attempting a ROP chain.",
    ];
  }
  if (input.classification === "crash") {
    return [
      "The control register did not match the supplied cyclic pattern; inspect the fault address and stack bytes.",
      "Confirm whether the crash is a bad pointer, a canary failure, or an address/alignment problem.",
      "Use a fresh process for the next probe and preserve this negative result.",
    ];
  }
  if (input.classification === "timeout") return ["Bound the debugger command and inspect the last process state before retrying."];
  if (input.classification === "exit") return ["The target exited without a parsed control-flow crash; inspect protocol synchronization and exit status."];
  if (input.faultAddress || input.mappings.length > 0) return ["Record the observed address/mapping facts, then choose one falsifiable memory-safety probe."];
  return ["No structured crash was found; run a bounded GDB probe that prints the signal, registers, and stack pointer."];
}
