/** A bounded common CTF flag form, for example PB{...}, flag{...}, or ISCC{...}. */
const CTF_CANDIDATE_PATTERN = /[A-Za-z][A-Za-z0-9_-]{0,31}\{[^{}\r\n]{1,512}\}/g;
const CTF_CANDIDATE_VALUE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}\{[^{}\r\n]{1,512}\}$/;

export function containsCtfCandidate(value: string): boolean {
  return /[A-Za-z][A-Za-z0-9_-]{0,31}\{[^{}\r\n]{1,512}\}/.test(value);
}

export function isCtfCandidate(value: string): boolean {
  return CTF_CANDIDATE_VALUE_PATTERN.test(value);
}

export function redactCtfCandidates(value: string, replacement: (candidate: string) => string): string {
  return value.replace(CTF_CANDIDATE_PATTERN, replacement);
}
