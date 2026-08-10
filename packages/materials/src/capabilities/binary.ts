import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RawEffectResult } from "../domain/types.js";

const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const DEFAULT_STRING_MIN_LENGTH = 4;
const DEFAULT_STRING_MAX_RESULTS = 2_000;

export interface BinaryCapabilityInput {
  path: string;
  offset?: number;
  length?: number;
  minLength?: number;
  maxResults?: number;
}

export interface BinaryIdentity {
  format: "pe" | "elf" | "unknown";
  size: number;
  bits?: 32 | 64;
  endian?: "little" | "big";
  architecture?: string;
  entryPoint?: string;
  machine?: number;
}

export interface BinarySection {
  index: number;
  name: string;
  type?: string;
  flags?: string[];
  address?: string;
  offset: number;
  size: number;
  alignment?: number;
  link?: number;
  entrySize?: number;
  characteristics?: string[];
}

export interface BinarySymbol {
  index: number;
  name: string;
  value: string;
  size: number;
  section?: number;
  binding?: string;
  type?: string;
  storageClass?: number;
}

export async function executeBinaryCapability(operation: string, input: BinaryCapabilityInput, cwd: string, signal: AbortSignal): Promise<RawEffectResult> {
  const started = Date.now();
  try {
    throwIfAborted(signal);
    const path = await resolveBinaryPath(cwd, input.path);
    const bytes = await readBoundedFile(path);
    throwIfAborted(signal);
    const value = operation === "identify" ? identify(bytes)
      : operation === "read_range" ? readRange(bytes, input)
        : operation === "sections" ? sections(bytes)
          : operation === "symbols" ? symbols(bytes)
            : operation === "strings" ? strings(bytes, input)
              : (() => { throw new Error(`Unsupported binary operation: ${operation}`); })();
    throwIfAborted(signal);
    return { stdout: JSON.stringify(value, null, 2), stderr: "", exitCode: 0, durationMs: Date.now() - started };
  } catch (error) {
    return { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: signal.aborted ? null : 1, durationMs: Date.now() - started };
  }
}

export function validateBinaryInput(operation: string, input: Record<string, unknown>): void {
  if (typeof input.path !== "string" || input.path.length === 0 || isAbsolute(input.path)) throw new Error("Binary path must be a non-empty relative path");
  if (containsPrivatePathSegment(input.path)) throw new Error("Binary path targets private fixture data");
  if (operation === "read_range") {
    assertInteger(input.offset, "offset", 0, Number.MAX_SAFE_INTEGER);
    assertInteger(input.length, "length", 1, 65_536);
  }
  if (operation === "strings") {
    if (input.minLength !== undefined) assertInteger(input.minLength, "minLength", 3, 64);
    if (input.maxResults !== undefined) assertInteger(input.maxResults, "maxResults", 1, 10_000);
  }
}

async function resolveBinaryPath(root: string, inputPath: string): Promise<string> {
  if (isAbsolute(inputPath)) throw new Error("Binary path must stay inside the fixture");
  if (containsPrivatePathSegment(inputPath)) throw new Error("Binary path targets private fixture data");
  const resolvedRoot = await realpath(resolve(root));
  const candidatePath = resolve(resolvedRoot, inputPath);
  assertInsideFixture(resolvedRoot, candidatePath);
  const resolvedPath = await realpath(candidatePath);
  const relativePath = assertInsideFixture(resolvedRoot, resolvedPath);
  if (containsPrivatePathSegment(relativePath)) throw new Error("Binary path targets private fixture data");
  return resolvedPath;
}

function assertInsideFixture(root: string, path: string): string {
  const relativePath = relative(root, path);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error("Binary path escapes the fixture");
  return relativePath;
}

function containsPrivatePathSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => segment.toLowerCase() === ".proofblade");
}

async function readBoundedFile(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("Binary path must reference a file");
    if (metadata.nlink !== 1) throw new Error("Binary path must not reference a hard-linked file");
    if (metadata.size > MAX_BINARY_BYTES) throw new Error(`Binary exceeds ${MAX_BINARY_BYTES} byte analysis limit`);
    return await file.readFile();
  } finally {
    await file.close();
  }
}

function identify(bytes: Buffer): BinaryIdentity {
  if (isElf(bytes)) {
    const bits = bytes[4] === 1 ? 32 : 64;
    const endian = bytes[5] === 2 ? "big" : "little";
    const machine = read16(bytes, 18, endian);
    return { format: "elf", size: bytes.length, bits, endian, machine, architecture: elfArchitecture(machine), entryPoint: hex(readWord(bytes, bits === 32 ? 24 : 24, bits, endian)) };
  }
  const pe = peHeader(bytes);
  if (pe) {
    return { format: "pe", size: bytes.length, bits: pe.bits, endian: "little", machine: pe.machine, architecture: peArchitecture(pe.machine), entryPoint: hex(pe.imageBase + BigInt(pe.entryRva)) };
  }
  return { format: "unknown", size: bytes.length };
}

function readRange(bytes: Buffer, input: BinaryCapabilityInput): Record<string, unknown> {
  const offset = input.offset ?? 0;
  const length = input.length ?? Math.min(256, bytes.length - offset);
  assertInteger(offset, "offset", 0, Number.MAX_SAFE_INTEGER);
  assertInteger(length, "length", 1, 65_536);
  if (offset > bytes.length) throw new Error("Binary range offset exceeds file size");
  const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + length));
  return { offset, length: chunk.length, requestedLength: length, hex: chunk.toString("hex"), ascii: printableAscii(chunk) };
}

function sections(bytes: Buffer): Record<string, unknown> {
  const elf = elfSections(bytes);
  if (elf) return { format: "elf", sections: elf };
  const pe = peSections(bytes);
  if (pe) return { format: "pe", sections: pe.sections, characteristics: pe.characteristics };
  return { format: "unknown", sections: [] };
}

function symbols(bytes: Buffer): Record<string, unknown> {
  const elf = elfSymbols(bytes);
  if (elf) return { format: "elf", symbols: elf };
  const pe = peSymbols(bytes);
  if (pe) return { format: "pe", symbols: pe };
  return { format: "unknown", symbols: [] };
}

function strings(bytes: Buffer, input: BinaryCapabilityInput): Record<string, unknown> {
  const minLength = input.minLength ?? DEFAULT_STRING_MIN_LENGTH;
  const maxResults = input.maxResults ?? DEFAULT_STRING_MAX_RESULTS;
  assertInteger(minLength, "minLength", 3, 64);
  assertInteger(maxResults, "maxResults", 1, 10_000);
  const found: Array<{ offset: number; value: string; encoding: "ascii" | "utf16le" }> = [];
  scanAscii(bytes, minLength, maxResults, found);
  if (found.length < maxResults) scanUtf16(bytes, minLength, maxResults, found);
  found.sort((left, right) => left.offset - right.offset || left.encoding.localeCompare(right.encoding));
  return { count: found.length, strings: found.slice(0, maxResults) };
}

function scanAscii(bytes: Buffer, minLength: number, maxResults: number, output: Array<{ offset: number; value: string; encoding: "ascii" | "utf16le" }>): void {
  let start = -1;
  for (let index = 0; index <= bytes.length; index += 1) {
    const printable = index < bytes.length && bytes[index]! >= 0x20 && bytes[index]! <= 0x7e;
    if (printable && start < 0) start = index;
    if ((!printable || index === bytes.length) && start >= 0) {
      if (index - start >= minLength && output.length < maxResults) output.push({ offset: start, value: bytes.toString("ascii", start, index), encoding: "ascii" });
      start = -1;
    }
  }
}

function scanUtf16(bytes: Buffer, minLength: number, maxResults: number, output: Array<{ offset: number; value: string; encoding: "ascii" | "utf16le" }>): void {
  for (let index = 0; index + 1 < bytes.length && output.length < maxResults; index += 1) {
    if (bytes[index + 1] !== 0 || bytes[index]! < 0x20 || bytes[index]! > 0x7e) continue;
    const start = index;
    let cursor = index;
    while (cursor + 1 < bytes.length && bytes[cursor + 1] === 0 && bytes[cursor]! >= 0x20 && bytes[cursor]! <= 0x7e) cursor += 2;
    if (cursor - start >= minLength * 2) {
      output.push({ offset: start, value: bytes.toString("utf16le", start, cursor), encoding: "utf16le" });
      index = cursor - 1;
    }
  }
}

function isElf(bytes: Buffer): boolean {
  return bytes.length >= 20 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46 && (bytes[4] === 1 || bytes[4] === 2) && (bytes[5] === 1 || bytes[5] === 2);
}

function peHeader(bytes: Buffer): { offset: number; machine: number; sectionCount: number; optionalSize: number; bits: 32 | 64; entryRva: number; imageBase: bigint; symbolTable: number; symbolCount: number } | undefined {
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return undefined;
  const offset = read32(bytes, 0x3c, "little");
  if (offset + 24 > bytes.length || bytes.toString("ascii", offset, offset + 4) !== "PE\0\0") return undefined;
  const machine = read16(bytes, offset + 4, "little");
  const sectionCount = read16(bytes, offset + 6, "little");
  const symbolTable = read32(bytes, offset + 12, "little");
  const symbolCount = read32(bytes, offset + 16, "little");
  const optionalSize = read16(bytes, offset + 20, "little");
  const optional = offset + 24;
  const magic = read16(bytes, optional, "little");
  const bits = magic === 0x20b ? 64 : 32;
  if (magic !== 0x10b && magic !== 0x20b) return undefined;
  if (optionalSize < 32 || optional + optionalSize > bytes.length) return undefined;
  const imageBase = bits === 32 ? BigInt(read32(bytes, optional + 28, "little")) : read64(bytes, optional + 24, "little");
  return { offset, machine, sectionCount, optionalSize, bits, entryRva: read32(bytes, optional + 16, "little"), imageBase, symbolTable, symbolCount };
}

function peSections(bytes: Buffer): { sections: BinarySection[]; characteristics: string[] } | undefined {
  const header = peHeader(bytes);
  if (!header) return undefined;
  const start = header.offset + 24 + header.optionalSize;
  const result: BinarySection[] = [];
  for (let index = 0; index < header.sectionCount && start + (index + 1) * 40 <= bytes.length; index += 1) {
    const base = start + index * 40;
    const rawName = bytes.toString("ascii", base, base + 8).replace(/\0.*$/, "");
    const characteristics = read32(bytes, base + 36, "little");
    result.push({ index, name: rawName, offset: read32(bytes, base + 20, "little"), size: read32(bytes, base + 16, "little"), address: hex(header.imageBase + BigInt(read32(bytes, base + 12, "little"))), characteristics: peSectionCharacteristics(characteristics) });
  }
  return { sections: result, characteristics: [] };
}

function peSymbols(bytes: Buffer): BinarySymbol[] | undefined {
  const header = peHeader(bytes);
  if (!header || header.symbolTable === 0 || header.symbolCount === 0 || header.symbolTable + header.symbolCount * 18 > bytes.length) return header ? [] : undefined;
  const stringTable = header.symbolTable + header.symbolCount * 18;
  const stringSize = stringTable + 4 <= bytes.length ? read32(bytes, stringTable, "little") : 0;
  const result: BinarySymbol[] = [];
  for (let index = 0; index < header.symbolCount; index += 1) {
    const base = header.symbolTable + index * 18;
    const name = coffName(bytes, base, stringTable, stringSize);
    if (name) result.push({ index, name, value: hex(BigInt(read32(bytes, base + 8, "little"))), size: 0, section: read16(bytes, base + 12, "little"), storageClass: bytes[base + 16] });
    const auxiliary = bytes[base + 17] ?? 0;
    index += auxiliary;
  }
  return result;
}

function elfSections(bytes: Buffer): BinarySection[] | undefined {
  if (!isElf(bytes)) return undefined;
  const bits = bytes[4] === 1 ? 32 : 64;
  const endian = bytes[5] === 2 ? "big" : "little";
  const offset = Number(readWord(bytes, bits === 32 ? 32 : 40, bits, endian));
  const entrySize = read16(bytes, bits === 32 ? 46 : 58, endian);
  const count = read16(bytes, bits === 32 ? 48 : 60, endian);
  const nameIndex = read16(bytes, bits === 32 ? 50 : 62, endian);
  const raw: Array<{ nameOffset: number; type: number; flags: bigint; address: bigint; offset: number; size: number; link: number; align: number; entrySize: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const base = offset + index * entrySize;
    if (base + entrySize > bytes.length) break;
    raw.push(bits === 32 ? { nameOffset: read32(bytes, base, endian), type: read32(bytes, base + 4, endian), flags: BigInt(read32(bytes, base + 8, endian)), address: BigInt(read32(bytes, base + 12, endian)), offset: read32(bytes, base + 16, endian), size: read32(bytes, base + 20, endian), link: read32(bytes, base + 24, endian), align: read32(bytes, base + 32, endian), entrySize: read32(bytes, base + 36, endian) } : { nameOffset: read32(bytes, base, endian), type: read32(bytes, base + 4, endian), flags: read64(bytes, base + 8, endian), address: read64(bytes, base + 16, endian), offset: Number(read64(bytes, base + 24, endian)), size: Number(read64(bytes, base + 32, endian)), link: read32(bytes, base + 40, endian), align: Number(read64(bytes, base + 48, endian)), entrySize: Number(read64(bytes, base + 56, endian)) });
  }
  const stringSection = raw[nameIndex];
  return raw.map((section, index) => ({ index, name: sectionName(bytes, stringSection, section.nameOffset), type: elfSectionType(section.type), flags: elfSectionFlags(section.flags), address: hex(section.address), offset: section.offset, size: section.size, alignment: section.align, link: section.link, entrySize: section.entrySize }));
}

function elfSymbols(bytes: Buffer): BinarySymbol[] | undefined {
  const sections = elfSections(bytes);
  if (!sections) return undefined;
  const bits = bytes[4] === 1 ? 32 : 64;
  const endian = bytes[5] === 2 ? "big" : "little";
  const offset = Number(readWord(bytes, bits === 32 ? 32 : 40, bits, endian));
  const sectionSize = read16(bytes, bits === 32 ? 46 : 58, endian);
  const count = read16(bytes, bits === 32 ? 48 : 60, endian);
  const result: BinarySymbol[] = [];
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const section = sections[sectionIndex]!;
    if (section.type !== "SYMTAB" && section.type !== "DYNSYM") continue;
    const base = offset + sectionIndex * sectionSize;
    const link = section.link ?? 0;
    const stringTable = sections[link];
    const symbolEntrySize = section.entrySize || (bits === 32 ? 16 : 24);
    for (let index = 0; index < Math.floor(section.size / symbolEntrySize); index += 1) {
      const item = section.offset + index * symbolEntrySize;
      if (item + symbolEntrySize > bytes.length) break;
      const nameOffset = read32(bytes, item, endian);
      const value = bits === 32 ? BigInt(read32(bytes, item + 4, endian)) : read64(bytes, item + 8, endian);
      const size = bits === 32 ? read32(bytes, item + 8, endian) : Number(read64(bytes, item + 16, endian));
      const info = bytes[item + (bits === 32 ? 12 : 4)] ?? 0;
      const sectionNumber = read16(bytes, item + (bits === 32 ? 14 : 6), endian);
      const name = elfString(bytes, stringTable, nameOffset);
      if (name) result.push({ index, name, value: hex(value), size, section: sectionNumber, binding: elfSymbolBinding(info >> 4), type: elfSymbolType(info & 0xf) });
    }
    void base;
    void count;
  }
  return result;
}

function assertInteger(value: unknown, name: string, min: number, max: number): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Binary ${name} must be an integer between ${min} and ${max}`);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Binary analysis aborted");
}

function read16(bytes: Buffer, offset: number, endian: "little" | "big"): number {
  if (offset < 0 || offset + 2 > bytes.length) throw new Error("Binary header is truncated");
  return endian === "little" ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
}

function read32(bytes: Buffer, offset: number, endian: "little" | "big"): number {
  if (offset < 0 || offset + 4 > bytes.length) throw new Error("Binary header is truncated");
  return endian === "little" ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
}

function read64(bytes: Buffer, offset: number, endian: "little" | "big"): bigint {
  if (offset < 0 || offset + 8 > bytes.length) throw new Error("Binary header is truncated");
  return endian === "little" ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset);
}

function readWord(bytes: Buffer, offset: number, bits: 32 | 64, endian: "little" | "big"): bigint {
  return bits === 32 ? BigInt(read32(bytes, offset, endian)) : read64(bytes, offset, endian);
}

function hex(value: bigint): string { return `0x${value.toString(16)}`; }
function printableAscii(bytes: Buffer): string { return [...bytes].map((value) => value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : ".").join(""); }
function elfArchitecture(machine: number): string { return ({ 3: "x86", 40: "arm", 62: "x86_64", 183: "aarch64", 243: "riscv" } as Record<number, string>)[machine] ?? `machine-${machine}`; }
function peArchitecture(machine: number): string { return ({ 0x014c: "x86", 0x8664: "x86_64", 0xaa64: "aarch64", 0x01c0: "arm" } as Record<number, string>)[machine] ?? `machine-0x${machine.toString(16)}`; }
function peSectionCharacteristics(value: number): string[] { return [value & 0x20 ? "code" : "", value & 0x40 ? "initialized-data" : "", value & 0x80 ? "uninitialized-data" : "", value & 0x20000000 ? "execute" : "", value & 0x40000000 ? "read" : "", value & 0x80000000 ? "write" : ""].filter(Boolean); }
function elfSectionType(value: number): string { return ({ 0: "NULL", 1: "PROGBITS", 2: "SYMTAB", 3: "STRTAB", 4: "RELA", 5: "HASH", 6: "DYNAMIC", 7: "NOTE", 8: "NOBITS", 9: "REL", 11: "DYNSYM" } as Record<number, string>)[value] ?? `TYPE_${value}`; }
function elfSectionFlags(value: bigint): string[] { return [value & 0x1n ? "write" : "", value & 0x2n ? "alloc" : "", value & 0x4n ? "execute" : ""].filter(Boolean); }
function sectionName(bytes: Buffer, section: { offset: number; size: number } | undefined, offset: number): string { return section ? readCString(bytes, section.offset + offset, section.offset + section.size) : ""; }
function elfString(bytes: Buffer, section: BinarySection | undefined, offset: number): string { return section ? readCString(bytes, section.offset + offset, section.offset + section.size) : ""; }
function readCString(bytes: Buffer, start: number, end: number): string { if (start < 0 || start >= bytes.length || start >= end) return ""; let cursor = start; while (cursor < bytes.length && cursor < end && bytes[cursor] !== 0) cursor += 1; return bytes.toString("utf8", start, cursor); }
function elfSymbolBinding(value: number): string { return (["LOCAL", "GLOBAL", "WEAK"] as const)[value] ?? `BIND_${value}`; }
function elfSymbolType(value: number): string { return (["NOTYPE", "OBJECT", "FUNC", "SECTION", "FILE", "COMMON", "TLS"] as const)[value] ?? `TYPE_${value}`; }
function coffName(bytes: Buffer, base: number, stringTable: number, stringSize: number): string {
  const zeroes = read32(bytes, base, "little");
  if (zeroes === 0) { const offset = read32(bytes, base + 4, "little"); return offset >= 4 && offset < stringSize ? readCString(bytes, stringTable + offset, stringTable + stringSize) : ""; }
  return bytes.toString("ascii", base, base + 8).replace(/\0.*$/, "");
}
