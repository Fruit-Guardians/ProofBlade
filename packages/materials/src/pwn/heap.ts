import { toHex } from "./leak.js";

/**
 * Deterministic glibc heap arithmetic for the pwn tools. These are the rules
 * a model can recite but repeatedly miscalculates by hand (safe-linking,
 * request rounding, bin indexes); computing them here removes an entire class
 * of payload byte errors. All helpers are pure and allocation-free of any
 * run state.
 */

export interface HeapPointerProtection {
  operation: "protect_ptr" | "reveal_ptr";
  position: string;
  input: string;
  output: string;
  formula: string;
}

/** glibc ≥ 2.32 safe-linking: stored = (pos >> 12) XOR ptr, reveal is symmetric. */
export function protectPtr(position: bigint, pointer: bigint): bigint {
  return (position >> 12n) ^ pointer;
}

export function revealPtr(position: bigint, stored: bigint): bigint {
  return (position >> 12n) ^ stored;
}

export interface MallocRequestEstimate {
  bits: 32 | 64;
  request: string;
  chunkSize: string;
  usableSize: string;
  alignment: number;
  tcacheIndex?: number;
  fastbinIndex?: number;
}

/** request2size(req): chunk = max(MINSIZE, align(req + HDR + ALIGN - 1, ALIGN)). */
export function mallocRequest(request: bigint, bits: 32 | 64): MallocRequestEstimate {
  if (request < 0n) throw new Error("malloc request must be non-negative");
  const alignment = bits === 64 ? 16 : 8;
  const header = bits === 64 ? 8n : 4n;
  const minChunk = bits === 64 ? 0x20n : 0x10n;
  const mask = BigInt(alignment - 1);
  let chunk = (request + header + mask) & ~mask;
  if (chunk < minChunk) chunk = minChunk;
  const usable = chunk - header; // usable bytes borrow the next chunk's size field
  const estimate: MallocRequestEstimate = {
    bits,
    request: toHex(request),
    chunkSize: toHex(chunk),
    usableSize: toHex(usable),
    alignment,
  };
  if (bits === 64) {
    const tcacheIndex = Number(chunk / 0x10n) - 2;
    if (tcacheIndex >= 0 && tcacheIndex < 64) estimate.tcacheIndex = tcacheIndex;
    const fastbinIndex = Number(chunk / 0x10n) - 2;
    if (fastbinIndex >= 0 && fastbinIndex < 7 && chunk <= 0x90n) estimate.fastbinIndex = fastbinIndex;
  }
  return estimate;
}

export function pointerProtection(operation: "protect_ptr" | "reveal_ptr", position: bigint, input: bigint): HeapPointerProtection {
  const output = operation === "protect_ptr" ? protectPtr(position, input) : revealPtr(position, input);
  return {
    operation,
    position: toHex(position),
    input: toHex(input),
    output: toHex(output),
    formula: `(${toHex(position)} >> 12) ^ ${toHex(input)} = ${toHex(output)}`,
  };
}
