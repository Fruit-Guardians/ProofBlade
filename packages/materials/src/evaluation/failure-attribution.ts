import type { HarnessEvent } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";

export interface FailureAttribution {
  taskId: string;
  firstErrorStep: number;
  errorCategory: string;
  rootCauseOwner: "model" | "harness" | "tool" | "provider" | "environment" | "verifier";
  primaryCause: string;
  secondaryCauses: string[];
  supportingEvidenceIds: string[];
  recoverability: "recoverable" | "needs_human" | "terminal";
  confidence: number;
}

export interface TrajectoryPrefix {
  schemaVersion: 1;
  taskId: string;
  firstErrorStep: number;
  frozenEventIds: string[];
  frozenRequestEpochIds: string[];
  frozenArtifactIds: string[];
  frozenEvidenceIds: string[];
  environmentStateHash?: string;
  hash: string;
}

export interface FailureAttributionOptions {
  taskId: string;
  environmentStateHash?: string;
}

interface ErrorCandidate {
  event: HarnessEvent;
  owner: FailureAttribution["rootCauseOwner"];
  category: string;
  cause: string;
  recoverability: FailureAttribution["recoverability"];
  confidence: number;
}

/** Attribute the first machine-observable deviation, not the final cascade error. */
export function attributeFailure(events: readonly HarnessEvent[], options: FailureAttributionOptions): FailureAttribution | undefined {
  const candidates = events.map(toErrorCandidate).filter((candidate): candidate is ErrorCandidate => candidate !== undefined).sort((left, right) => left.event.seq - right.event.seq);
  const first = candidates[0];
  if (!first) return undefined;
  const secondary = candidates.slice(1).map((candidate) => `${candidate.event.seq}:${candidate.category}`).filter((value, index, values) => values.indexOf(value) === index).slice(0, 16);
  return {
    taskId: boundedTaskId(options.taskId),
    firstErrorStep: first.event.seq,
    errorCategory: first.category,
    rootCauseOwner: first.owner,
    primaryCause: first.cause,
    secondaryCauses: secondary,
    supportingEvidenceIds: collectReferences(events.filter((event) => event.seq <= first.event.seq)).evidenceIds,
    recoverability: first.recoverability,
    confidence: first.confidence,
  };
}

export function createTrajectoryPrefix(events: readonly HarnessEvent[], attribution: FailureAttribution, environmentStateHash?: string): TrajectoryPrefix {
  const prefix = events.filter((event) => event.seq < attribution.firstErrorStep);
  const references = collectReferences(prefix);
  const unsigned = {
    schemaVersion: 1 as const,
    taskId: attribution.taskId,
    firstErrorStep: attribution.firstErrorStep,
    frozenEventIds: prefix.map((event) => event.id),
    frozenRequestEpochIds: references.requestEpochIds,
    frozenArtifactIds: references.artifactIds,
    frozenEvidenceIds: references.evidenceIds,
    ...(environmentStateHash ? { environmentStateHash } : {}),
  };
  return { ...unsigned, hash: sha256(canonicalJson(unsigned)) };
}

function toErrorCandidate(event: HarnessEvent): ErrorCandidate | undefined {
  const payload = event.payload ?? {};
  if (event.type === "provider_response_received" && number(payload.status) >= 400) {
    const status = String(payload.status);
    return { event, owner: "provider", category: number(payload.status) >= 500 ? "provider_transient_error" : "provider_rejected_request", cause: `Provider response status ${status}`, recoverability: number(payload.status) >= 500 ? "recoverable" : "needs_human", confidence: 0.98 };
  }
  if (event.type === "provider_request_queue_cancelled") return { event, owner: "provider", category: "provider_queue_cancelled", cause: text(payload.reason, "Provider request was cancelled before execution"), recoverability: "recoverable", confidence: 0.96 };
  if (event.type === "tool_result_recorded" && payload.isError === true) {
    const timeout = /timeout|timed.out/i.test(text(payload.errorSignature, ""));
    return { event, owner: "tool", category: timeout ? "tool_timeout" : "tool_error", cause: text(payload.errorSignature, `Tool ${text(payload.toolName, "unknown")} returned an error`), recoverability: timeout ? "recoverable" : "needs_human", confidence: 0.96 };
  }
  if (event.type === "job_finished" && ["FAILED", "TIMED_OUT", "UNKNOWN"].includes(text(payload.status, ""))) {
    const status = text(payload.status, "UNKNOWN").toLowerCase();
    return { event, owner: "environment", category: `job_${status}`, cause: text(payload.error, `Background job ended ${status}`), recoverability: status === "timed_out" ? "recoverable" : "needs_human", confidence: 0.94 };
  }
  if (event.type === "effect_finished" && ["error", "timeout", "unknown"].includes(text(payload.outcome, ""))) {
    const outcome = text(payload.outcome, "unknown");
    return { event, owner: outcome === "unknown" ? "harness" : "environment", category: `effect_${outcome}`, cause: text(payload.errorSignature, `Effect ended ${outcome}`), recoverability: outcome === "timeout" ? "recoverable" : outcome === "unknown" ? "needs_human" : "terminal", confidence: 0.92 };
  }
  if (event.type === "completion_verified" && payload.accepted === false) return { event, owner: "verifier", category: "verification_rejected", cause: text(payload.reason, "Verifier rejected completion"), recoverability: "terminal", confidence: 0.98 };
  if (event.type === "run_failed") {
    const category = text(payload.category, "run_failed");
    return { event, owner: ownerForRunFailure(category), category, cause: text(payload.reason, `Run failed with ${category}`), recoverability: recoverabilityForCategory(category), confidence: 0.75 };
  }
  return undefined;
}

function collectReferences(events: readonly HarnessEvent[]): { evidenceIds: string[]; artifactIds: string[]; requestEpochIds: string[] } {
  const found = { evidenceIds: new Set<string>(), artifactIds: new Set<string>(), requestEpochIds: new Set<string>() };
  const visit = (value: unknown, key = ""): void => {
    if (typeof value === "string") {
      const normalized = key.toLowerCase().replace(/[_-]/g, "");
      if (normalized === "evidenceid" || normalized === "evidenceids") found.evidenceIds.add(value);
      if (normalized === "artifactid" || normalized === "artifactids") found.artifactIds.add(value);
      if (normalized === "requestepochid" || normalized === "requestepochids" || normalized === "epochid") found.requestEpochIds.add(value);
    } else if (Array.isArray(value)) value.forEach((item) => visit(item, key));
    else if (value && typeof value === "object") Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) => visit(child, childKey));
  };
  events.forEach((event) => visit(event.payload));
  return { evidenceIds: [...found.evidenceIds].sort(), artifactIds: [...found.artifactIds].sort(), requestEpochIds: [...found.requestEpochIds].sort() };
}

function ownerForRunFailure(category: string): FailureAttribution["rootCauseOwner"] {
  if (/provider/i.test(category)) return "provider";
  if (/tool|schema|argument/i.test(category)) return "tool";
  if (/verif/i.test(category)) return "verifier";
  if (/environment|permission/i.test(category)) return "environment";
  if (/model|hypothesis|amnesia|injection/i.test(category)) return "model";
  return "harness";
}

function recoverabilityForCategory(category: string): FailureAttribution["recoverability"] {
  if (/overflow|timeout|provider|budget/i.test(category)) return "recoverable";
  if (/permission|verif|environment/i.test(category)) return "needs_human";
  return "terminal";
}

function text(value: unknown, fallback: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  return (result || fallback).replace(/[\u0000\r\n]+/g, " ").slice(0, 1_000);
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

function boundedTaskId(value: string): string {
  const result = text(value, "unknown-task");
  if (result.length > 256) throw new Error("Failure attribution taskId is too long");
  return result;
}
