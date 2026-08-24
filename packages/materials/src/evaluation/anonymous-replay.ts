import type { RealModelEvaluationSummary } from "./real-model-evaluator.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import type { HarnessEvent } from "../domain/types.js";

/** A historical evaluation projection safe to attach to bug reports. */
export interface AnonymousEvaluationReplay {
  schemaVersion: 1;
  protocolVersion: RealModelEvaluationSummary["protocolVersion"];
  corpusHash: string;
  variants: Array<{
    id: string;
    cases: Array<Omit<RealModelEvaluationSummary["variants"][number]["cases"][number], "runId" | "error"> & { runKey: string }>;
  }>;
  replayHash: string;
}

/** A bounded event-level projection suitable for sharing historical Run traces. */
export interface AnonymousRunReplay {
  schemaVersion: 1;
  runKey: string;
  eventCount: number;
  events: Array<{
    seq: number;
    type: HarnessEvent["type"];
    lane: HarnessEvent["lane"];
    actor: HarnessEvent["actor"];
    payload: Record<string, boolean | number | string | null>;
    payloadHash: string;
  }>;
  replayHash: string;
}

/**
 * Project a Run event stream without copying task text, paths, identifiers, or
 * tool output. Safe operational fields remain so phase/tool/convergence
 * regressions can be compared across historical Runs.
 */
export function anonymizeRunReplay(events: readonly HarnessEvent[]): AnonymousRunReplay {
  const projected = events.map((event) => ({
    seq: event.seq,
    type: event.type,
    lane: event.lane,
    actor: event.actor,
    payload: safePayload(event.payload ?? {}),
    payloadHash: sha256(canonicalJson(event.payload ?? {})),
  }));
  const base: Omit<AnonymousRunReplay, "replayHash"> = {
    schemaVersion: 1,
    runKey: sha256(events[0]?.runId ?? ""),
    eventCount: projected.length,
    events: projected,
  };
  return { ...base, replayHash: sha256(canonicalJson(base)) };
}

/**
 * Remove run paths/ids and free-form errors while retaining enough telemetry
 * to compare historical Runs and verify that the projection itself is stable.
 */
export function anonymizeEvaluationSummary(summary: RealModelEvaluationSummary): AnonymousEvaluationReplay {
  const base: Omit<AnonymousEvaluationReplay, "replayHash"> = {
    schemaVersion: 1,
    protocolVersion: summary.protocolVersion,
    corpusHash: summary.corpus.hash,
    variants: summary.variants.map((variant) => ({
      id: variant.id,
      cases: variant.cases.map(({ runId, error: _error, ...item }) => ({
        ...item,
        runKey: sha256(`${variant.id}:${runId}`),
      })),
    })),
  };
  return { ...base, replayHash: sha256(canonicalJson(base)) };
}

const SAFE_PAYLOAD_KEYS = new Set([
  "accepted",
  "api",
  "attempt",
  "cacheRetention",
  "domainPhase",
  "effectiveActions",
  "evidenceAdded",
  "failureCategory",
  "finishReason",
  "health",
  "isError",
  "maxConcurrentRequests",
  "operation",
  "outcome",
  "phase",
  "profileId",
  "provider",
  "queueCancelled",
  "queueDepth",
  "retries",
  "runtime",
  "status",
  "stopReason",
  "success",
  "targetKind",
  "toolCallCount",
  "toolName",
  "turn",
]);

function safePayload(payload: Record<string, unknown>): Record<string, boolean | number | string | null> {
  const safe: Record<string, boolean | number | string | null> = {};
  for (const key of [...SAFE_PAYLOAD_KEYS].sort()) {
    const value = payload[key];
    if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") safe[key] = value;
  }
  return safe;
}
