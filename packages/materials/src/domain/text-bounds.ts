import { snipText, type SnippedText } from "@proofblade/molecules";
import { estimateTokens } from "./utils.js";

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
  while (estimateTokens(bounded.text) > maxTokens && charLimit > 64) {
    charLimit = Math.max(64, Math.floor(charLimit * 0.8));
    bounded = snipText(value, charLimit);
  }
  return bounded;
}

export function boundedRequestedChars(requestedChars: number | undefined, defaultChars: number, maxTokens: number): number {
  const value = requestedChars ?? defaultChars;
  if (!Number.isInteger(value) || value < 256) throw new Error("Requested text bound must be an integer of at least 256 characters");
  return Math.min(value, maxTokens * 4);
}
