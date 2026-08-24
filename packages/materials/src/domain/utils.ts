export { canonicalJson, createId as id, estimateTokens, sha256 } from "@proofblade/atoms";

export function redactSecrets(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s,]+/gi, "$1[REDACTED]")
    .replace(/(token\s*[=:]\s*)[^\s,]+/gi, "$1[REDACTED]")
    .replace(/(cookie\s*[=:]\s*)[^\r\n]+/gi, "$1[REDACTED]");
}

export function isTerminal(status: string): boolean {
  return ["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"].includes(status);
}

/**
 * Return the bounded wall-clock budget left in a Run.
 *
 * A malformed or missing persisted timestamp must not turn the deadline into
 * zero: recovery should retain the task's configured budget and let the outer
 * controller remain authoritative. Callers can pass a captured `now` in tests
 * or when several prompt fields need the same time sample.
 */
export function remainingRunDeadlineMs(startedAt: string | undefined, deadlineMs: number, now = Date.now()): number {
  if (!startedAt) return Math.max(0, deadlineMs);
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return Math.max(0, deadlineMs);
  return Math.max(0, deadlineMs - Math.max(0, now - startedMs));
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
