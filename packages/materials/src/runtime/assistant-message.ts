import type { TaskContract } from "../domain/types.js";
import { sha256 } from "../domain/utils.js";

/**
 * Build the assistant fields safe to persist in the durable Control Store.
 * Pi's JSONL Session remains the complete provider-visible transcript; CTF
 * Control events must not become a second plaintext copy of a candidate.
 */
export function persistedAssistantText(mode: TaskContract["mode"], text: string): Record<string, unknown> {
  const base = { textHash: sha256(text), textLength: text.length };
  if (mode === "coding_assistant") return { ...base, text };
  return { ...base, textRedacted: true };
}
