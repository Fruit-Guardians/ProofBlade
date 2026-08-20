/**
 * Shared byte helpers for pwn payloads. Kept in one place so pwn_send, the
 * reproducer stage replay, and the tool schema all decode identically — a
 * divergence here would let a payload that pwn_send delivered fail to replay in
 * pwn_reproduce (or vice versa).
 */

/** Decode base64 to exact bytes, rejecting malformed input instead of silently mangling a payload. */
export function decodeBase64Strict(value: string): Uint8Array {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new Error("base64 payload contains non-base64 characters");
  const buffer = Buffer.from(normalized, "base64");
  // Buffer.from is lenient; verify the round-trip so a truncated/invalid payload
  // is rejected rather than sending fewer bytes than intended.
  if (buffer.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    throw new Error("base64 payload is malformed");
  }
  return new Uint8Array(buffer);
}

/** Return a copy of `data` with one byte appended (used to add a LF in byte-exact line mode). */
export function appendByte(data: Uint8Array, byte: number): Uint8Array {
  const out = new Uint8Array(data.length + 1);
  out.set(data, 0);
  out[data.length] = byte;
  return out;
}
