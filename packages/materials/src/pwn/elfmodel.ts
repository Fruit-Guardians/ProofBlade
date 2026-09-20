import { elfSections, elfSymbols, isElf } from "../capabilities/binary.js";

/**
 * Minimal ELF runtime model for the pwn exploit-construction tools.
 * Header/program-header parsing stays here; section/symbol parsing reuses the
 * battle-tested capability parser in capabilities/binary.ts.
 */
export interface ElfLoadSegment {
  /** Virtual address the segment is mapped at (before any base rebase). */
  vaddr: bigint;
  /** File offset of the segment image. */
  offset: number;
  /** File bytes covered by this segment. */
  fileSize: number;
  /** Segment flags: 1 = X, 2 = W, 4 = R. */
  flags: number;
}

export interface ElfImage {
  bits: 32 | 64;
  endian: "little" | "big";
  /** ELF e_type: 2 = EXEC (absolute vaddrs), 3 = DYN (PIE / shared object). */
  type: number;
  machine: number;
  loads: ElfLoadSegment[];
  symbols: Array<{ name: string; value: bigint; size: number }>;
}

const MAX_SYMBOLS = 65_536;

export function loadElf(bytes: Buffer): ElfImage {
  if (!isElf(bytes)) throw new Error("Not a supported ELF image");
  const bits = bytes[4] === 1 ? 32 : 64;
  const endian = bytes[5] === 2 ? "big" : "little";
  const type = read16(bytes, 16, endian);
  const machine = read16(bytes, 18, endian);
  const loads = loadSegments(bytes, bits, endian);
  if (loads.length === 0) throw new Error("ELF has no PT_LOAD segments");
  const symbolRows = elfSymbols(bytes) ?? [];
  return {
    bits,
    endian,
    type,
    machine,
    loads,
    symbols: symbolRows.slice(0, MAX_SYMBOLS).map((symbol) => ({
      name: symbol.name,
      value: BigInt(symbol.value),
      size: symbol.size,
    })),
  };
}

/** Map a virtual address to a file offset within a PT_LOAD segment. */
export function vaddrToOffset(image: ElfImage, vaddr: bigint): number | undefined {
  for (const segment of image.loads) {
    if (vaddr >= segment.vaddr && vaddr < segment.vaddr + BigInt(segment.fileSize)) {
      return segment.offset + Number(vaddr - segment.vaddr);
    }
  }
  return undefined;
}

/** All addresses whose mapped bytes begin with the needle. */
export function findMappedBytes(image: ElfImage, bytes: Buffer, needle: Buffer): bigint[] {
  const hits: bigint[] = [];
  if (needle.length === 0) return hits;
  for (const segment of image.loads) {
    const start = segment.offset;
    const end = Math.min(bytes.length, segment.offset + segment.fileSize);
    let cursor = start;
    while (cursor <= end - needle.length) {
      let match = true;
      for (let index = 0; index < needle.length; index += 1) {
        if (bytes[cursor + index] !== needle[index]) { match = false; break; }
      }
      if (match) hits.push(segment.vaddr + BigInt(cursor - segment.offset));
      cursor += 1;
    }
  }
  return hits;
}

/** Look up a function/data symbol by exact name. */
export function findSymbol(image: ElfImage, name: string): { name: string; value: bigint; size: number } | undefined {
  return image.symbols.find((symbol) => symbol.name === name);
}

function loadSegments(bytes: Buffer, bits: 32 | 64, endian: "little" | "big"): ElfLoadSegment[] {
  const phOffset = Number(readWord(bytes, bits === 32 ? 28 : 32, bits, endian));
  const entrySize = read16(bytes, bits === 32 ? 42 : 54, endian);
  const count = read16(bytes, bits === 32 ? 44 : 56, endian);
  const segments: ElfLoadSegment[] = [];
  for (let index = 0; index < count; index += 1) {
    const base = phOffset + index * entrySize;
    if (base < 0 || base + entrySize > bytes.length) break;
    const type = read32(bytes, base, endian);
    if (type !== 1) continue; // PT_LOAD
    if (bits === 32) {
      segments.push({
        vaddr: BigInt(read32(bytes, base + 8, endian)),
        offset: read32(bytes, base + 4, endian),
        fileSize: read32(bytes, base + 16, endian),
        flags: read32(bytes, base + 24, endian),
      });
    } else {
      segments.push({
        vaddr: read64(bytes, base + 16, endian),
        offset: Number(read64(bytes, base + 8, endian)),
        fileSize: Number(read64(bytes, base + 32, endian)),
        flags: read32(bytes, base + 4, endian),
      });
    }
  }
  return segments;
}

/** Section list surfaced for completeness (mirrors the capability parser). */
export function elfSectionNames(bytes: Buffer): string[] {
  return (elfSections(bytes) ?? []).map((section) => section.name);
}

function read16(bytes: Buffer, offset: number, endian: "little" | "big"): number {
  if (offset < 0 || offset + 2 > bytes.length) throw new Error("ELF header is truncated");
  return endian === "little" ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
}

function read32(bytes: Buffer, offset: number, endian: "little" | "big"): number {
  if (offset < 0 || offset + 4 > bytes.length) throw new Error("ELF header is truncated");
  return endian === "little" ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
}

function read64(bytes: Buffer, offset: number, endian: "little" | "big"): bigint {
  if (offset < 0 || offset + 8 > bytes.length) throw new Error("ELF header is truncated");
  return endian === "little" ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset);
}

function readWord(bytes: Buffer, offset: number, bits: 32 | 64, endian: "little" | "big"): bigint {
  return bits === 32 ? BigInt(read32(bytes, offset, endian)) : read64(bytes, offset, endian);
}
