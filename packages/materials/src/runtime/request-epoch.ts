import type { HarnessEvent, Lane, RequestEpoch, RequestEpochStatus } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";

const SECRET_KEY = /(?:api[_-]?key|authorization|cookie|password|secret|token|private[_-]?key|credential)/i;
const BEARER_VALUE = /\b(?:bearer|basic)\s+[A-Za-z0-9+/=._-]+/gi;

export interface RequestEpochInput {
  runId: string;
  generation?: number;
  lane: Lane;
  provider: string;
  model: string;
  adapter: string;
  requestId?: string;
  turnId?: string;
  stepId?: string;
  contextWindow?: number;
  systemPrompt?: unknown;
  systemPromptHash?: string;
  toolNames?: readonly string[];
  toolCatalog?: unknown;
  toolCatalogHash?: string;
  capabilityCatalog?: unknown;
  capabilityCatalogHash?: string;
  contextManifest?: unknown;
  contextManifestHash?: string;
  stablePrefixHash?: string;
  dynamicSuffixHash?: string;
  requestBody?: unknown;
  requestHeaders?: Record<string, string | number | boolean | undefined>;
  providerBindingId?: string;
  scopePolicy?: unknown;
  scopePolicyHash?: string;
  parentEpochId?: string;
  createdAt?: string;
}

/**
 * Build the durable identity for one actual Provider request. Raw body and
 * header values never enter the returned object; only redacted hashes do.
 */
export function createRequestEpoch(input: RequestEpochInput): Omit<RequestEpoch, "createdSeq" | "updatedSeq"> {
  const provider = boundedIdentity(input.provider, "provider");
  const model = boundedIdentity(input.model, "model");
  const adapter = boundedIdentity(input.adapter, "adapter");
  const toolNames = [...new Set((input.toolNames ?? []).map((name) => boundedIdentity(name, "tool name")))].sort();
  const systemPromptHash = input.systemPromptHash ?? hashRequestValue(input.systemPrompt);
  const toolCatalogHash = input.toolCatalogHash ?? hashRequestValue(input.toolCatalog);
  const capabilityCatalogHash = input.capabilityCatalogHash ?? hashRequestValue(input.capabilityCatalog);
  const contextManifestHash = input.contextManifestHash ?? hashRequestValue(input.contextManifest);
  const requestContextHash = hashRequestValue({
    contextWindow: input.contextWindow,
    systemPromptHash,
    toolCatalogHash,
    capabilityCatalogHash,
    contextManifestHash,
    stablePrefixHash: input.stablePrefixHash,
    dynamicSuffixHash: input.dynamicSuffixHash,
  });
  const epoch: Omit<RequestEpoch, "createdSeq" | "updatedSeq"> = {
    id: input.requestId ? `RE-${sha256(`${input.runId}:${input.requestId}`).slice(0, 32)}` : `RE-${sha256(`${input.runId}:${Date.now()}:${Math.random()}`).slice(0, 32)}`,
    requestId: boundedIdentity(input.requestId ?? `request-${Date.now()}`, "request id"),
    runId: boundedIdentity(input.runId, "run id"),
    ...(input.generation === undefined ? {} : { generation: boundedGeneration(input.generation) }),
    ...(input.turnId ? { turnId: boundedIdentity(input.turnId, "turn id") } : {}),
    ...(input.stepId ? { stepId: boundedIdentity(input.stepId, "step id") } : {}),
    lane: input.lane,
    provider,
    model,
    adapter,
    ...(input.contextWindow === undefined ? {} : { contextWindow: boundedPositiveInteger(input.contextWindow, "context window") }),
    ...(systemPromptHash ? { systemPromptHash } : {}),
    ...(toolCatalogHash ? { toolCatalogHash } : {}),
    toolNames,
    ...(capabilityCatalogHash ? { capabilityCatalogHash } : {}),
    ...(contextManifestHash ? { contextManifestHash } : {}),
    ...(requestContextHash ? { requestContextHash } : {}),
    ...(input.requestHeaders ? { requestHeadersHash: hashRequestHeaders(input.requestHeaders) } : {}),
    ...(input.providerBindingId ? { providerBindingId: boundedIdentity(input.providerBindingId, "Provider binding") } : {}),
    ...(input.scopePolicyHash ?? input.scopePolicy ? { scopePolicyHash: input.scopePolicyHash ?? hashRequestValue(input.scopePolicy) } : {}),
    ...(input.stablePrefixHash ? { stablePrefixHash: boundedHash(input.stablePrefixHash, "stable prefix") } : {}),
    ...(input.dynamicSuffixHash ? { dynamicSuffixHash: boundedHash(input.dynamicSuffixHash, "dynamic suffix") } : {}),
    ...(input.requestBody === undefined ? {} : { requestBodyHash: hashRequestValue(input.requestBody) }),
    ...(input.parentEpochId ? { parentEpochId: boundedIdentity(input.parentEpochId, "parent epoch") } : {}),
    status: "STARTED",
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  return epoch;
}

/** Hash a request body after removing fields that must never be persisted. */
export function hashRequestValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return sha256(canonicalJson(redactRequestValue(value)));
}

/** Return a bounded, secret-free view suitable for diagnostics and hashing. */
export function redactRequestValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[DEPTH_LIMIT]";
  if (typeof value === "string") return value.replace(BEARER_VALUE, "[REDACTED]").slice(0, 32_000);
  if (Array.isArray(value)) return value.slice(0, 512).map((item) => redactRequestValue(item, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 512)) {
      output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactRequestValue(child, depth + 1);
    }
    return output;
  }
  return value;
}

export function hashRequestHeaders(headers: Record<string, string | number | boolean | undefined>): string {
  const names = Object.keys(headers).map((name) => name.trim().toLowerCase()).filter(Boolean).sort();
  return sha256(canonicalJson({ names }));
}

/** Rebuild one epoch from the authoritative event stream. */
export function reconstructRequestEpoch(events: readonly HarnessEvent[], epochId: string): RequestEpoch | undefined {
  const started = events.find((event) => event.type === "request_epoch_started" && epochIdFrom(event) === epochId);
  if (!started) return undefined;
  const raw = started.payload?.epoch;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Request epoch ${epochId} has an invalid start payload`);
  const epoch = structuredClone(raw) as Partial<RequestEpoch>;
  if (epoch.id !== epochId || epoch.runId !== started.runId) throw new Error(`Request epoch ${epochId} identity does not match its event`);
  let status: RequestEpochStatus = epoch.status ?? "STARTED";
  let updatedSeq = started.seq;
  for (const event of events.filter((candidate) => candidate.seq >= started.seq)) {
    if (event.type === "request_epoch_context" && String(event.payload?.requestEpochId ?? "") === epochId) {
      const fields = event.payload?.fields;
      if (fields && typeof fields === "object" && !Array.isArray(fields)) Object.assign(epoch, selectEpochFields(fields as Record<string, unknown>));
      updatedSeq = event.seq;
    }
    if (epochIdFrom(event) !== epochId) continue;
    const nextStatus = statusForEvent(event);
    if (nextStatus) status = nextStatus;
    updatedSeq = event.seq;
  }
  if (!epoch.requestId || !epoch.provider || !epoch.model || !epoch.adapter || !epoch.lane || !epoch.createdAt) throw new Error(`Request epoch ${epochId} is missing identity fields`);
  return { ...epoch, status, createdSeq: epoch.createdSeq ?? started.seq, updatedSeq } as RequestEpoch;
}

export function reconstructRequestEpochByRequestId(events: readonly HarnessEvent[], requestId: string): RequestEpoch | undefined {
  const started = events.find((event) => event.type === "request_epoch_started" && String((event.payload?.epoch as Record<string, unknown> | undefined)?.requestId ?? "") === requestId);
  const epochId = started ? epochIdFrom(started) : undefined;
  return epochId ? reconstructRequestEpoch(events, epochId) : undefined;
}

function epochIdFrom(event: HarnessEvent): string | undefined {
  if (typeof event.payload?.epochId === "string") return event.payload.epochId;
  const epoch = event.payload?.epoch;
  return epoch && typeof epoch === "object" && !Array.isArray(epoch) && typeof (epoch as Record<string, unknown>).id === "string"
    ? (epoch as Record<string, unknown>).id as string
    : undefined;
}

function statusForEvent(event: HarnessEvent): RequestEpochStatus | undefined {
  if (event.type === "provider_request_queue_cancelled") return "CANCELLED";
  if (event.type === "provider_response_received") return Number(event.payload?.status) >= 400 ? "FAILED" : "RESPONSE_RECEIVED";
  if (event.type === "model_usage") return "COMPLETED";
  if (event.type === "provider_request_started" || event.type === "assistant_message" || event.type === "turn_started") return "STARTED";
  return undefined;
}

function selectEpochFields(fields: Record<string, unknown>): Record<string, string> {
  const allowed = ["requestBodyHash", "requestHeadersHash", "requestContextHash", "providerBindingId", "scopePolicyHash", "stablePrefixHash", "dynamicSuffixHash", "systemPromptHash", "toolCatalogHash", "capabilityCatalogHash", "contextManifestHash"];
  return Object.fromEntries(allowed.filter((key) => typeof fields[key] === "string").map((key) => [key, fields[key] as string]));
}

function boundedIdentity(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || /[\u0000\r\n]/.test(trimmed)) throw new Error(`${label} must be a bounded identifier`);
  return trimmed;
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 10_000_000) throw new Error(`${label} must be a positive bounded integer`);
  return value;
}

function boundedGeneration(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000_000) throw new Error("generation must be a bounded non-negative integer");
  return value;
}

function boundedHash(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} must be a SHA-256 hash`);
  return value.toLowerCase();
}
