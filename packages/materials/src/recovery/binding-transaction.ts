import type { SessionRecord, SessionStatus } from "../domain/types.js";
import { externalResourceBindingTransactionId, type ExternalResourceKind, type ExternalResourceRecord } from "./external-resource-registry.js";

/** Durable phases observed while an external handle is handed to Control Store. */
export type ExternalBindingPhase =
  | "MISSING"
  | "PROPOSED"
  | "STARTED"
  | "CONTROL_BOUND"
  | "CONTROL_CLOSED"
  | "RELEASED"
  | "AMBIGUOUS";

/** Recovery action selected from the two durable ledgers. */
export type ExternalBindingRecoveryAction = "NONE" | "RELEASE" | "RECONCILE" | "ADOPT" | "MANUAL";

export interface ExternalBindingDecision {
  phase: ExternalBindingPhase;
  action: ExternalBindingRecoveryAction;
  reason: string;
  /** Stable id used to correlate a registry record with a backend request. */
  bindingTxnId?: string;
}

export interface ExternalBindingObservation {
  resource?: ExternalResourceRecord;
  controlSession?: Pick<SessionRecord, "id" | "runId" | "kind" | "generation" | "status" | "externalId" | "ownerLane" | "bindingTxnId">;
}

/**
 * Classify the cross-ledger handoff without performing I/O or changing state.
 *
 * The decision is intentionally conservative: an OPEN Control Store session
 * with an exact resource binding may be reconciled/adopted, while a missing or
 * closed owner may only be released through an exact backend adapter. Any
 * mismatch becomes MANUAL and must not be guessed into a new session.
 */
export function classifyExternalBinding(observation: ExternalBindingObservation): ExternalBindingDecision {
  const resource = observation.resource;
  if (!resource) return { phase: "MISSING", action: "NONE", reason: "external resource record is absent" };
  const bindingTxnId = resource.bindingTxnId ?? externalResourceBindingTransactionId(resource);
  if (resource.state === "RELEASED") return { phase: "RELEASED", action: "NONE", reason: "external resource is already released", bindingTxnId };

  const session = observation.controlSession;
  if (session && !matchesSession(resource, session)) {
    return { phase: "AMBIGUOUS", action: "MANUAL", reason: "Control Store session does not match the immutable external resource binding", bindingTxnId };
  }
  if (resource.controlSessionId !== undefined && (!session || resource.controlSessionId !== session.id)) {
    return { phase: "AMBIGUOUS", action: "MANUAL", reason: "external resource control-session marker has no exact owner", bindingTxnId };
  }

  if (session) {
    if (session.status === "OPEN") {
      if (resource.state === "PROPOSED") {
        return { phase: "AMBIGUOUS", action: "MANUAL", reason: "an OPEN Control Store session is backed by a resource that never recorded STARTED", bindingTxnId };
      }
      if (resource.controlSessionId === session.id) {
        return { phase: "CONTROL_BOUND", action: "ADOPT", reason: "the exact Control Store owner marker is durable", bindingTxnId };
      }
      return { phase: "STARTED", action: "RECONCILE", reason: "the exact Control Store owner exists but the binding marker is not durable yet", bindingTxnId };
    }
    if (isClosedSession(session.status)) {
      return { phase: "CONTROL_CLOSED", action: "RELEASE", reason: `Control Store session is ${session.status}; external ownership must be released`, bindingTxnId };
    }
  }

  if (resource.state === "PROPOSED") {
    return { phase: "PROPOSED", action: "RELEASE", reason: "no Control Store owner exists and the external action never recorded STARTED", bindingTxnId };
  }
  if (resource.externalId) {
    return { phase: "STARTED", action: "RELEASE", reason: "external handle has no durable Control Store owner", bindingTxnId };
  }
  return { phase: "AMBIGUOUS", action: "MANUAL", reason: "external resource has no owner and no opaque handle that can be inspected", bindingTxnId };
}

function matchesSession(
  resource: ExternalResourceRecord,
  session: Pick<SessionRecord, "id" | "runId" | "kind" | "generation" | "status" | "externalId" | "ownerLane" | "bindingTxnId">,
): boolean {
  return resource.id === `session:${session.id}`
    && resource.runId === session.runId
    && resource.generation === session.generation
    && resource.ownerLane === session.ownerLane
    // Older Control Store sessions may predate the cross-ledger marker. Keep
    // those records recoverable using the immutable identity fields; whenever
    // both ledgers carry a marker it must match exactly.
    && (resource.bindingTxnId === undefined || session.bindingTxnId === undefined || resource.bindingTxnId === session.bindingTxnId)
    && (resource.externalId === session.externalId || (session.externalId === undefined && resource.kind === "browser-context" && resource.externalId === session.id))
    && sessionKindMatches(resource.kind, session.kind);
}

function sessionKindMatches(resourceKind: ExternalResourceKind, sessionKind: SessionRecord["kind"]): boolean {
  if (resourceKind === "pwn-session") return sessionKind === "pwn-local" || sessionKind === "pwn-remote";
  if (resourceKind === "http-session") return sessionKind === "http";
  if (resourceKind === "browser-context") return sessionKind === "browser";
  return false;
}

function isClosedSession(status: SessionStatus): boolean {
  return status === "CLOSED" || status === "EXITED" || status === "ERROR" || status === "SUPERSEDED";
}
