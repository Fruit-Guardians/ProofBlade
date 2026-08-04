import { createHash, randomUUID } from "node:crypto";

export function id(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

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

export function redactSecrets(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s,]+/gi, "$1[REDACTED]")
    .replace(/(token\s*[=:]\s*)[^\s,]+/gi, "$1[REDACTED]")
    .replace(/(cookie\s*[=:]\s*)[^\r\n]+/gi, "$1[REDACTED]");
}

export function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

export function isTerminal(status: string): boolean {
  return ["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"].includes(status);
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
