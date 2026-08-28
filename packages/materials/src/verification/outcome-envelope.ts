import type { VerificationRequestKind } from "../domain/types.js";
import { canonicalJson } from "../domain/utils.js";

const HASH = /^[a-f0-9]{64}$/i;
const MAX_ENVELOPE_BYTES = 65_536;
const MAX_ATTEMPTS = 64;
const MAX_IDS = 128;

export type VerifierExternalStatus = "NOT_STARTED" | "RUNNING" | "CONFIRMED" | "UNKNOWN" | "RELEASED";
export type VerifierAttemptStatus = "PASSED" | "FAILED" | "UNKNOWN";

export interface VerifierOutcomeAttempt {
  id: string;
  phase: string;
  status: VerifierAttemptStatus;
  artifactId?: string;
  externalId?: string;
  summary: string;
}

/**
 * Bounded, restart-safe result index shared by all verifier backends.
 *
 * Raw HTTP bodies, screenshots, tube transcripts, and platform responses stay
 * in Artifacts. This envelope only contains stable hashes, bounded summaries,
 * and references to those Artifacts; a replay envelope never carries a trusted
 * candidate or verdict.
 */
export interface VerifierOutcomeEnvelope {
  schemaVersion: 1;
  requestKey: string;
  runId: string;
  generation: number;
  kind: VerificationRequestKind;
  policyHash: string;
  recipeHash: string;
  candidateHash?: string;
  externalId?: string;
  externalStatus: VerifierExternalStatus;
  attempts: VerifierOutcomeAttempt[];
  primaryArtifactId?: string;
  transcriptArtifactIds: string[];
  stageSummary?: Record<string, string | number | boolean>;
  accepted?: boolean;
  evidenceIds: string[];
  terminal: boolean;
  failureReason?: string;
}

export interface VerifierOutcomeEnvelopeOptions {
  /** Replay results must not contain candidate hashes, Evidence, or terminal verdicts. */
  replay?: boolean;
}

export function serializeVerifierOutcomeEnvelope(
  envelope: VerifierOutcomeEnvelope,
  options: VerifierOutcomeEnvelopeOptions = {},
): string {
  const normalized = parseVerifierOutcomeEnvelope(envelope, options);
  const serialized = canonicalJson(normalized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_ENVELOPE_BYTES) throw new Error("Verifier outcome envelope exceeds 64 KiB");
  return serialized;
}

export function parseVerifierOutcomeEnvelope(
  value: unknown,
  options: VerifierOutcomeEnvelopeOptions = {},
): VerifierOutcomeEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Verifier outcome envelope must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw new Error("Unsupported verifier outcome envelope schema");
  const requestKey = requiredString(raw.requestKey, "requestKey", 128);
  const runId = requiredString(raw.runId, "runId", 256);
  const generation = raw.generation;
  if (!Number.isInteger(generation) || (generation as number) < 0) throw new Error("Verifier outcome generation must be a non-negative integer");
  if (!isKind(raw.kind)) throw new Error("Verifier outcome kind is invalid");
  const policyHash = requiredHash(raw.policyHash, "policyHash");
  const recipeHash = requiredHash(raw.recipeHash, "recipeHash");
  const externalStatus = raw.externalStatus;
  if (!isExternalStatus(externalStatus)) throw new Error("Verifier outcome external status is invalid");
  if (!Array.isArray(raw.attempts) || raw.attempts.length > MAX_ATTEMPTS) throw new Error("Verifier outcome attempts must contain 0-64 entries");
  const attempts = raw.attempts.map((attempt, index) => parseAttempt(attempt, index));
  const transcriptArtifactIds = parseIdList(raw.transcriptArtifactIds, "transcriptArtifactIds");
  const evidenceIds = parseIdList(raw.evidenceIds, "evidenceIds");
  const candidateHash = raw.candidateHash === undefined ? undefined : requiredHash(raw.candidateHash, "candidateHash");
  const accepted = raw.accepted === undefined ? undefined : requiredBoolean(raw.accepted, "accepted");
  const terminal = requiredBoolean(raw.terminal, "terminal");
  if (terminal && accepted === undefined) throw new Error("Terminal verifier outcome requires an accepted boolean");
  if (options.replay && (candidateHash !== undefined || accepted !== undefined || terminal || evidenceIds.length > 0)) {
    throw new Error("Verifier replay outcome cannot contain a candidate, verdict, terminal state, or Evidence");
  }
  const envelope: VerifierOutcomeEnvelope = {
    schemaVersion: 1,
    requestKey,
    runId,
    generation: generation as number,
    kind: raw.kind,
    policyHash,
    recipeHash,
    ...(candidateHash === undefined ? {} : { candidateHash }),
    ...(raw.externalId === undefined ? {} : { externalId: requiredString(raw.externalId, "externalId", 256) }),
    externalStatus,
    attempts,
    ...(raw.primaryArtifactId === undefined ? {} : { primaryArtifactId: requiredString(raw.primaryArtifactId, "primaryArtifactId", 256) }),
    transcriptArtifactIds,
    ...(raw.stageSummary === undefined ? {} : { stageSummary: parseStageSummary(raw.stageSummary) }),
    ...(accepted === undefined ? {} : { accepted }),
    evidenceIds,
    terminal,
    ...(raw.failureReason === undefined ? {} : { failureReason: requiredString(raw.failureReason, "failureReason", 1_024) }),
  };
  if (Buffer.byteLength(canonicalJson(envelope), "utf8") > MAX_ENVELOPE_BYTES) throw new Error("Verifier outcome envelope exceeds 64 KiB");
  return envelope;
}

function parseAttempt(value: unknown, index: number): VerifierOutcomeAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Verifier outcome attempt ${index} must be an object`);
  const raw = value as Record<string, unknown>;
  const status = raw.status;
  if (!isAttemptStatus(status)) throw new Error(`Verifier outcome attempt ${index} has an invalid status`);
  return {
    id: requiredString(raw.id, `attempts[${index}].id`, 256),
    phase: requiredString(raw.phase, `attempts[${index}].phase`, 128),
    status,
    ...(raw.artifactId === undefined ? {} : { artifactId: requiredString(raw.artifactId, `attempts[${index}].artifactId`, 256) }),
    ...(raw.externalId === undefined ? {} : { externalId: requiredString(raw.externalId, `attempts[${index}].externalId`, 256) }),
    summary: requiredString(raw.summary, `attempts[${index}].summary`, 1_024),
  };
}

function parseIdList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_IDS) throw new Error(`Verifier outcome ${field} must contain 0-128 ids`);
  return value.map((entry, index) => requiredString(entry, `${field}[${index}]`, 256));
}

function parseStageSummary(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Verifier outcome stageSummary must be an object");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) throw new Error("Verifier outcome stageSummary is too large");
  const result: Record<string, string | number | boolean> = {};
  for (const [key, entry] of entries) {
    if (!/^[A-Za-z0-9_.:-]{1,96}$/.test(key) || (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean")) throw new Error("Verifier outcome stageSummary contains an invalid value");
    if (typeof entry === "string" && entry.length > 512) throw new Error("Verifier outcome stageSummary string is too long");
    result[key] = entry;
  }
  return result;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) throw new Error(`Verifier outcome ${field} must be a non-empty bounded string`);
  return value;
}

function requiredHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`Verifier outcome ${field} must be a sha256 hash`);
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Verifier outcome ${field} must be boolean`);
  return value;
}

function isKind(value: unknown): value is VerificationRequestKind {
  return value === "web" || value === "browser" || value === "pwn" || value === "claim";
}

function isExternalStatus(value: unknown): value is VerifierExternalStatus {
  return value === "NOT_STARTED" || value === "RUNNING" || value === "CONFIRMED" || value === "UNKNOWN" || value === "RELEASED";
}

function isAttemptStatus(value: unknown): value is VerifierAttemptStatus {
  return value === "PASSED" || value === "FAILED" || value === "UNKNOWN";
}
