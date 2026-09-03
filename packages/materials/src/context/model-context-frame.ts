import { canonicalJson, estimateTokens, id, sha256 } from "../domain/utils.js";

const MAX_FRAME_MESSAGES = 128;
const MAX_FRAME_REFS_PER_ITEM = 32;
const MAX_FRAME_OMITTED_ITEMS = 128;
const MAX_FRAME_METADATA_CHARS = 256;

export type ContextSourceKind = "session" | "task" | "ledger" | "observation" | "evidence" | "artifact" | "job" | "queue" | "user" | "system" | "context" | "unknown";

export interface ModelContextItem {
  itemId: string;
  role: string;
  source: ContextSourceKind;
  sourceIds: string[];
  contentHash: string;
  visibleChars: number;
  estimatedTokens: number;
  included: boolean;
  artifactRefs: string[];
  evidenceRefs: string[];
}

/** Metadata-only proof of the exact provider payload after adapter conversion. */
export interface ModelContextFrame {
  schemaVersion: 1;
  frameId: string;
  runId: string;
  generation: number;
  requestId: string;
  epochId?: string;
  provider: string;
  model: string;
  api: string;
  systemPromptHash?: string;
  toolCatalogHash?: string;
  contextManifestHash?: string;
  sourceMessages: ModelContextItem[];
  finalMessages: ModelContextItem[];
  omittedItems: ModelContextItem[];
  totalVisibleChars: number;
  estimatedVisibleTokens: number;
  messageCount: number;
  frameHash: string;
  createdAt: string;
}

export interface ModelContextFrameInput {
  runId: string;
  generation: number;
  requestId: string;
  epochId?: string;
  provider: string;
  model: string;
  api: string;
  payload: unknown;
  systemPromptHash?: string;
  toolCatalogHash?: string;
  contextManifestHash?: string;
  /** IDs intentionally omitted by the final payload adapter. */
  omittedItems?: readonly ModelContextItem[];
  createdAt?: string;
}

export function buildModelContextFrame(input: ModelContextFrameInput): ModelContextFrame {
  const messages = extractMessages(input.payload);
  const sourceMessages = messages.slice(0, MAX_FRAME_MESSAGES).map((message, index) => {
    const contentHash = sha256(message.content);
    const artifactRefs = boundedRefs(message.content.match(/\bA-[A-Za-z0-9_-]{3,128}\b/g) ?? []);
    const evidenceRefs = boundedRefs(message.content.match(/\bEV-[A-Za-z0-9_-]{3,128}\b/g) ?? []);
    const source = message.content.includes("<proofblade-context") ? "context" : roleSource(message.role);
    return boundedFrameItem({
      itemId: `${input.requestId}:message:${index}`,
      role: message.role,
      source,
      sourceIds: [...new Set([...artifactRefs, ...evidenceRefs])].sort(),
      contentHash,
      visibleChars: message.content.length,
      estimatedTokens: estimateTokens(message.content),
      included: true,
      artifactRefs,
      evidenceRefs,
    } satisfies ModelContextItem);
  });
  const omittedItems = [...(input.omittedItems ?? [])]
    .slice(0, MAX_FRAME_OMITTED_ITEMS)
    .map((item) => boundedFrameItem({ ...item, included: false }));
  const base = {
    schemaVersion: 1 as const,
    frameId: id("MCF"),
    runId: boundMetadata(input.runId),
    generation: input.generation,
    requestId: boundMetadata(input.requestId),
    ...(input.epochId ? { epochId: boundMetadata(input.epochId) } : {}),
    provider: boundMetadata(input.provider),
    model: boundMetadata(input.model),
    api: boundMetadata(input.api),
    ...(input.systemPromptHash ? { systemPromptHash: input.systemPromptHash } : {}),
    ...(input.toolCatalogHash ? { toolCatalogHash: input.toolCatalogHash } : {}),
    ...(input.contextManifestHash ? { contextManifestHash: input.contextManifestHash } : {}),
    sourceMessages,
    finalMessages: sourceMessages,
    omittedItems,
    totalVisibleChars: sourceMessages.reduce((sum, item) => sum + item.visibleChars, 0),
    estimatedVisibleTokens: sourceMessages.reduce((sum, item) => sum + item.estimatedTokens, 0),
    messageCount: messages.length,
    createdAt: boundMetadata(input.createdAt ?? new Date().toISOString()),
  };
  // The request identity and timestamp are intentionally excluded from the
  // content hash so identical final payloads can be compared across retries.
  const hashInput = {
    provider: base.provider,
    model: base.model,
    api: base.api,
    ...(base.systemPromptHash ? { systemPromptHash: base.systemPromptHash } : {}),
    ...(base.toolCatalogHash ? { toolCatalogHash: base.toolCatalogHash } : {}),
    ...(base.contextManifestHash ? { contextManifestHash: base.contextManifestHash } : {}),
    sourceMessages: base.sourceMessages.map(({ itemId: _itemId, ...item }) => item),
    finalMessages: base.finalMessages.map(({ itemId: _itemId, ...item }) => item),
    omittedItems: base.omittedItems.map(({ itemId: _itemId, ...item }) => item),
    messageCount: base.messageCount,
  };
  return { ...base, frameHash: sha256(canonicalJson(hashInput)) };
}

function boundedFrameItem(item: ModelContextItem): ModelContextItem {
  return {
    ...item,
    itemId: item.itemId.slice(0, 256),
    role: item.role.slice(0, 64),
    sourceIds: boundedRefs(item.sourceIds),
    artifactRefs: boundedRefs(item.artifactRefs),
    evidenceRefs: boundedRefs(item.evidenceRefs),
    contentHash: item.contentHash.slice(0, 128),
    visibleChars: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, item.visibleChars)),
    estimatedTokens: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, item.estimatedTokens)),
  };
}

function boundMetadata(value: string): string {
  return value.slice(0, MAX_FRAME_METADATA_CHARS);
}

function boundedRefs(refs: readonly string[]): string[] {
  return [...new Set(refs)].sort().slice(0, MAX_FRAME_REFS_PER_ITEM).map((ref) => ref.slice(0, 128));
}

function extractMessages(payload: unknown): Array<{ role: string; content: string }> {
  if (!payload || typeof payload !== "object") return [{ role: "user", content: String(payload ?? "") }];
  const value = payload as Record<string, unknown>;
  const messages = Array.isArray(value.messages) ? value.messages : Array.isArray(value.input) ? value.input : [];
  const extracted = messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const item = message as Record<string, unknown>;
    return [{ role: typeof item.role === "string" ? item.role : "unknown", content: contentText(item.content ?? item) }];
  });
  if (typeof value.system === "string") extracted.unshift({ role: "system", content: value.system });
  return extracted.length > 0 ? extracted : [{ role: "user", content: contentText(value.input ?? value) }];
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => contentText(item)).join("\n");
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    if (typeof item.text === "string") return item.text;
    if (typeof item.content === "string") return item.content;
  }
  try { return JSON.stringify(value) ?? ""; } catch { return String(value); }
}

function roleSource(role: string): ContextSourceKind {
  if (role === "system") return "system";
  if (role === "user") return "user";
  if (role === "tool") return "artifact";
  if (role === "assistant") return "session";
  return "unknown";
}
