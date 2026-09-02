import type { ArtifactRef } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import type { ArtifactStore } from "../effects/artifact-store.js";

export type ContextLevel = "L0" | "L1" | "L2";
export type ContextTrust = "untrusted" | "observed" | "proposed" | "verified";
export type ContextSensitivity = "public" | "secret" | "flag_candidate";

export interface ContextRef {
  uri: string;
  kind: "operation" | "artifact" | "job" | "evidence" | "skill" | "session" | "task";
  runId?: string;
  generation?: number;
  scope: "current-run" | "same-project" | "public-project";
  level: ContextLevel;
  contentHash: string;
  sourceIds: string[];
  trust: ContextTrust;
  sensitivity: ContextSensitivity;
  stale: boolean;
  readPolicy: { maxChars: number; maxBytes: number; maxItems?: number; allowRange: boolean };
}

export type ReceiptState = "success" | "error" | "accepted" | "running" | "partial";
export type ReceiptNextAction = "recall" | "monitor" | "inspect" | "record_evidence" | "retry" | "wait" | "none";

export interface ModelReceipt {
  schemaVersion: 1;
  operationId: string;
  state: ReceiptState;
  title: string;
  summary: string;
  keyFacts: Array<{ key: string; value: string }>;
  refs: ContextRef[];
  preview?: { text?: string; head?: string; tail?: string; omittedChars?: number; omittedItems?: number };
  nextActions: ReceiptNextAction[];
  resultHash: string;
  presentationHash: string;
  generatedAt: string;
}

export interface ModelReceiptOptions {
  runId: string;
  generation: number;
  operationId: string;
  title: string;
  state?: ReceiptState;
  content: string;
  summary?: string;
  keyFacts?: Array<{ key: string; value: string }>;
  artifact?: ArtifactRef;
  maxInlineChars?: number;
  maxPreviewChars?: number;
  mode?: "full" | "path_only" | "receipt";
  trust?: ContextTrust;
  sensitivity?: ContextSensitivity;
  nextActions?: ReceiptNextAction[];
  /** Caller-known omitted character/byte count for an externally bounded result. */
  omittedChars?: number;
  generatedAt?: string;
}

export function artifactUri(runId: string, artifactId: string, content = true): string { return `pb://run/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifactId)}${content ? "/content" : ""}`; }

export function createModelReceipt(options: ModelReceiptOptions): ModelReceipt {
  const maxInlineChars = positive(options.maxInlineChars ?? 2_048, "maxInlineChars");
  const maxPreviewChars = positive(options.maxPreviewChars ?? 1_024, "maxPreviewChars");
  if (maxPreviewChars > maxInlineChars * 4) throw new Error("maxPreviewChars is unreasonably large");
  const content = options.content;
  const resultHash = sha256(content);
  const sensitivity = options.sensitivity ?? options.artifact?.sensitivity ?? "public";
  const ref: ContextRef | undefined = options.artifact ? {
    uri: artifactUri(options.runId, options.artifact.id), kind: "artifact", runId: options.runId, generation: options.generation, scope: "current-run", level: "L2", contentHash: options.artifact.sha256, sourceIds: [options.artifact.id], trust: options.trust ?? "observed", sensitivity, stale: options.artifact.generation !== options.generation, readPolicy: { maxChars: 6_000, maxBytes: 64 * 1024, allowRange: true },
  } : undefined;
  const mode = options.mode ?? "receipt";
  const preview = mode === "path_only" || sensitivity === "secret"
    ? undefined
    : options.omittedChars !== undefined
      ? { omittedChars: Math.max(0, Math.floor(options.omittedChars)) }
      : boundedPreview(content, maxPreviewChars, maxInlineChars);
  const receiptBase = {
    schemaVersion: 1 as const, operationId: options.operationId, state: options.state ?? "success", title: bounded(options.title, 256), summary: bounded(options.summary ?? summarize(content), 1_024), keyFacts: (options.keyFacts ?? []).slice(0, 16).map((item) => ({ key: bounded(item.key, 128), value: bounded(item.value, 512) })), refs: ref ? [ref] : [], ...(preview ? { preview } : {}), nextActions: [...new Set(options.nextActions ?? (ref ? ["recall"] : ["none"]))] as ReceiptNextAction[], resultHash, generatedAt: options.generatedAt ?? new Date().toISOString(),
  };
  return { ...receiptBase, presentationHash: sha256(canonicalJson(receiptBase)) };
}

/** Render a bounded, machine-readable receipt for direct model consumption. */
export function renderModelReceipt(receipt: ModelReceipt): string {
  const ref = receipt.refs[0];
  const preview = receipt.preview?.text
    ?? [receipt.preview?.head, receipt.preview?.tail].filter(Boolean).join(" ... ");
  return [
    "[ProofBlade receipt]",
    `operation=${receipt.operationId}`,
    `state=${receipt.state}`,
    `visible=${receipt.preview?.omittedChars ? "bounded" : "complete"}`,
    // Prefer the canonical L2 Artifact hash; resultHash is the visible
    // projection hash and may intentionally cover only a bounded viewport.
    `content_sha256=${ref?.contentHash ?? receipt.resultHash}`,
    `artifact=${ref?.uri ?? "none"}`,
    `omitted_chars=${receipt.preview?.omittedChars ?? 0}`,
    `next=${receipt.nextActions.join(",")}`,
    `summary=${receipt.summary}`,
    ...(preview && !receipt.preview?.omittedChars ? [`preview=${preview}`] : []),
    "[/ProofBlade receipt]",
  ].join("\n");
}

export interface RecallRecord {
  schemaVersion: 1;
  id: string;
  runId: string;
  generation: number;
  operationId?: string;
  requester: "agent" | "system" | "gui" | "cli";
  uri: string;
  requestedLevel: ContextLevel;
  range?: { offset: number; limit: number };
  returnedBytes: number;
  returnedChars: number;
  contentHash: string;
  projectionHash: string;
  truncated: boolean;
  status: "SUCCEEDED" | "DENIED" | "NOT_FOUND" | "STALE" | "RANGE_EXCEEDED" | "HASH_MISMATCH" | "FAILED";
  reason?: string;
  createdAt: string;
}

export interface RecallResult { record: RecallRecord; content?: string; marker: string; }

export async function recallArtifact(options: { artifactStore: ArtifactStore; artifact: ArtifactRef; runId: string; generation: number; requester: RecallRecord["requester"]; operationId?: string; level?: ContextLevel; offset?: number; limit?: number; allowSensitive?: boolean; recordId?: string; }): Promise<RecallResult> {
  const level = options.level ?? "L2";
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 4_000;
  const uri = artifactUri(options.runId, options.artifact.id);
  const base = { schemaVersion: 1 as const, id: options.recordId ?? `recall-${sha256(`${options.runId}:${options.artifact.id}:${level}:${offset}:${limit}`).slice(0, 24)}`, runId: options.runId, generation: options.generation, ...(options.operationId ? { operationId: options.operationId } : {}), requester: options.requester, uri, requestedLevel: level, range: { offset, limit }, createdAt: new Date().toISOString() };
  if (options.artifact.runId !== options.runId) return failedRecall(base, "NOT_FOUND", "artifact belongs to another run");
  if (options.artifact.generation !== options.generation) return failedRecall(base, "STALE", "artifact belongs to an older generation");
  if (options.artifact.sensitivity !== "public" && !options.allowSensitive) return failedRecall(base, "DENIED", "sensitive artifacts require explicit capability");
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 64 * 1024) return failedRecall(base, "RANGE_EXCEEDED", "recall range exceeds the bounded read policy");
  try {
    const range = await options.artifactStore.readTextRange(options.runId, options.artifact, limit, offset);
    const content = range.content;
    const record: RecallRecord = { ...base, returnedBytes: range.bytesRead, returnedChars: content.length, contentHash: options.artifact.sha256, projectionHash: sha256(content), truncated: range.truncated, status: "SUCCEEDED" };
    return { record, content, marker: recallMarker(record, options.artifact.sensitivity) };
  } catch (error) { return failedRecall(base, "FAILED", error instanceof Error ? error.message : String(error)); }
}

export interface ContextCandidate {
  id: string;
  uri: string;
  summary: string;
  sourceIds: string[];
  relevance: number;
  coverage: number;
  novelty: number;
  independentSources: number;
  conflict: number;
  trust: ContextTrust;
  estimatedTokens: number;
  required?: boolean;
}

export interface BrokerSelection { selected: ContextCandidate[]; omitted: Array<{ id: string; reason: string }>; scores: Record<string, { relevance: number; coverage: number; novelty: number; independence: number; conflict: number; cost: number; total: number }>; totalTokens: number; }

/** Deterministic, provenance-aware selection; scores are ranking signals, not trust. */
export function selectContextCandidates(candidates: readonly ContextCandidate[], maxTokens: number): BrokerSelection {
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error("maxTokens must be a positive integer");
  const scored = candidates.map((candidate) => {
    const cost = Math.min(1, candidate.estimatedTokens / maxTokens);
    const total = candidate.relevance * 0.32 + candidate.coverage * 0.24 + candidate.novelty * 0.16 + Math.min(1, candidate.independentSources / 3) * 0.12 + candidate.conflict * 0.08 + trustWeight(candidate.trust) * 0.08 - cost * 0.12;
    return { candidate, score: { relevance: candidate.relevance, coverage: candidate.coverage, novelty: candidate.novelty, independence: candidate.independentSources, conflict: candidate.conflict, cost, total } };
  }).sort((a, b) => b.score.total - a.score.total || a.candidate.id.localeCompare(b.candidate.id));
  const selected: ContextCandidate[] = []; const omitted: Array<{ id: string; reason: string }> = []; const scores: BrokerSelection["scores"] = {}; let totalTokens = 0;
  const ordered = [...scored.filter((item) => item.candidate.required), ...scored.filter((item) => !item.candidate.required)];
  for (const item of ordered) {
    scores[item.candidate.id] = item.score;
    if (item.candidate.required || totalTokens + item.candidate.estimatedTokens <= maxTokens) { selected.push(item.candidate); totalTokens += item.candidate.estimatedTokens; }
    else omitted.push({ id: item.candidate.id, reason: "token_budget" });
  }
  return { selected, omitted, scores, totalTokens };
}

function failedRecall(base: Omit<RecallRecord, "returnedBytes" | "returnedChars" | "contentHash" | "projectionHash" | "truncated" | "status">, status: RecallRecord["status"], reason: string): RecallResult {
  const record: RecallRecord = { ...base, returnedBytes: 0, returnedChars: 0, contentHash: "", projectionHash: "", truncated: false, status, reason };
  return { record, marker: recallMarker(record, "public") };
}
function recallMarker(record: RecallRecord, sensitivity: ContextSensitivity): string { return `[recall]\nuri=${record.uri}\nlevel=${record.requestedLevel} range=${record.range?.offset ?? 0}..${(record.range?.offset ?? 0) + (record.range?.limit ?? 0)} returned=${record.returnedChars} chars truncated=${record.truncated}\ncontent_sha256=${record.contentHash || "none"} projection=${record.projectionHash || "none"}\ntrust=${sensitivity === "public" ? "observed" : "restricted"} generation=${record.generation} status=${record.status}\n[/recall]`; }
function boundedPreview(content: string, maxPreviewChars: number, maxInlineChars: number): NonNullable<ModelReceipt["preview"]> {
  if (content.length <= maxInlineChars) return { text: content };
  const headSize = Math.ceil(maxPreviewChars / 2); const tailSize = Math.floor(maxPreviewChars / 2);
  return { head: content.slice(0, headSize), tail: content.slice(-tailSize), omittedChars: Math.max(0, content.length - headSize - tailSize) };
}
function summarize(content: string): string { const line = content.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? "empty result"; return bounded(line, 1_024); }
function bounded(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`; }
function positive(value: number, label: string): number { if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`); return value; }
function trustWeight(trust: ContextTrust): number { return trust === "verified" ? 1 : trust === "proposed" ? 0.7 : trust === "observed" ? 0.5 : 0.2; }
