/**
 * Leak/address ledger for pwn.  PentAGI has no equivalent: it never records the
 * source bytes, parse format, address type, or base-address formula behind a
 * leaked pointer, so it cannot reason about ASLR bases across steps.  Here every
 * leaked value is a first-class record whose derivation is explicit and whose
 * source bytes are auditable, so ROP/FSOP payloads reference a base formula
 * rather than a hardcoded absolute address.
 */
export type LeakFormat = "le64" | "le32" | "be64" | "be32";

export type AddressKind = "stack" | "heap" | "libc" | "pie" | "code" | "unknown";

export interface LeakRecord {
  id: string;
  /** Hex of the exact source bytes the value was parsed from (auditable). */
  sourceHex: string;
  format: LeakFormat;
  /** Parsed absolute value as a canonical 0x-prefixed hex string. */
  value: string;
  addressKind: AddressKind;
  /** Optional symbol/offset this leak corresponds to, e.g. "puts@GLIBC". */
  symbol?: string;
  /** Confidence in [0,1]; a single unverified leak should not be treated as fact. */
  confidence: number;
}

const WIDTH: Record<LeakFormat, number> = { le64: 8, le32: 4, be64: 8, be32: 4 };

/** Parse a little/big-endian 32/64-bit address from raw bytes. */
export function parseLeakAddress(bytes: Uint8Array, format: LeakFormat): bigint {
  const width = WIDTH[format];
  if (bytes.length < width) throw new Error(`Leak needs ${width} bytes for ${format}, got ${bytes.length}`);
  const slice = bytes.subarray(0, width);
  let value = 0n;
  if (format === "le64" || format === "le32") {
    for (let index = width - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(slice[index]!);
  } else {
    for (let index = 0; index < width; index += 1) value = (value << 8n) | BigInt(slice[index]!);
  }
  return value;
}

/** Parse from a hex string (whitespace/0x tolerated) rather than a byte buffer. */
export function parseLeakHex(hex: string, format: LeakFormat): bigint {
  const cleaned = hex.replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "");
  if (cleaned.length % 2 !== 0) throw new Error(`Leak hex must be whole bytes: ${hex}`);
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(cleaned.slice(index * 2, index * 2 + 2), 16);
  return parseLeakAddress(bytes, format);
}

export function toHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

/**
 * Derive a base address from a leaked pointer and the known offset of the
 * leaked symbol within its image (leak - offset).  Returns the base, so later
 * payload stages can be expressed as base + targetOffset rather than absolute.
 */
export function deriveBase(leaked: bigint, knownOffset: bigint): bigint {
  const base = leaked - knownOffset;
  if (base < 0n) throw new Error(`Derived base is negative: leak=${toHex(leaked)} offset=${toHex(knownOffset)}`);
  return base;
}

/** A page-aligned base is a strong sanity signal for libc/PIE leaks. */
export function isPageAligned(base: bigint, pageSize = 0x1000n): boolean {
  return base % pageSize === 0n;
}
