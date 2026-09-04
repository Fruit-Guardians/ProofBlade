import { createHash, randomUUID } from "node:crypto";

/**
 * Create a unique identifier with a caller-supplied display prefix.
 * @invariant The prefix is preserved; the identifier is not sortable or a security token.
 */
export function createId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Compute a lowercase SHA-256 digest for text or bytes.
 * @invariant The result is deterministic for identical input bytes.
 */
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Serialize a value deterministically by recursively sorting object keys.
 * @invariant Array order is preserved and the input value is not mutated.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

/**
 * Return a conservative upper bound for UTF-8 tokenizer input.
 *
 * Tokenizers used by the supported providers operate on UTF-8 bytes (or a
 * coarser unit), so no token can account for less than one input byte.  Using
 * the byte length prevents Chinese, JSON punctuation, and code-heavy payloads
 * from being under-counted by the old `characters / 4` heuristic.  This is
 * deliberately an upper bound rather than an exact provider tokenizer count:
 * hard context limits must fail closed across providers.
 */
export function estimateTokens(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
