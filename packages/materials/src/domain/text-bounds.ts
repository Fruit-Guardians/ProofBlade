import { snipText, type SnippedText } from "@proofblade/molecules";

/**
 * Bound model-facing text by the same deterministic token approximation used
 * by the context compiler. The character limit remains an input preference,
 * but the token limit is authoritative.
 */
export function boundModelText(value: string, requestedChars: number, maxTokens: number): SnippedText {
  if (!Number.isInteger(requestedChars) || requestedChars < 64) throw new Error("Text bound must be an integer of at least 64 characters");
  if (!Number.isInteger(maxTokens) || maxTokens < 16) throw new Error("Text token bound must be an integer of at least 16 tokens");
  let charLimit = Math.max(64, Math.min(requestedChars, maxTokens * 4));
  let bounded = snipText(value, charLimit);
  if (utf8TokenEstimate(bounded.text) <= maxTokens) return bounded;
  return boundUtf8Text(value, maxTokens);
}

function utf8TokenEstimate(value: string): number { return Buffer.byteLength(value, "utf8"); }

export function boundedRequestedChars(requestedChars: number | undefined, defaultChars: number, maxTokens: number): number {
  const value = requestedChars ?? defaultChars;
  if (!Number.isInteger(value) || value < 256) throw new Error("Requested text bound must be an integer of at least 256 characters");
  return Math.min(value, maxTokens * 4);
}

function boundUtf8Text(value: string, maxBytes: number): SnippedText {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false, originalChars: value.length, omittedChars: 0 };
  const marker = "\n...[truncated]...\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes) {
    const text = takeUtf8Prefix(value, maxBytes);
    return { text, truncated: true, originalChars: value.length, omittedChars: Math.max(0, value.length - text.length) };
  }
  const contentBytes = maxBytes - markerBytes;
  const head = takeUtf8Prefix(value, Math.ceil(contentBytes * 0.65));
  const tail = takeUtf8Suffix(value, contentBytes - Buffer.byteLength(head, "utf8"));
  const text = `${head}${marker}${tail}`;
  return { text, truncated: true, originalChars: value.length, omittedChars: Math.max(0, value.length - head.length - tail.length) };
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return value.slice(0, end);
}

function takeUtf8Suffix(value: string, maxBytes: number): string {
  let bytes = 0;
  let start = value.length;
  for (const character of [...value].reverse()) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    start -= character.length;
  }
  return value.slice(start);
}
