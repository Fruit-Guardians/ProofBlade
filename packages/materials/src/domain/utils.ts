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

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
