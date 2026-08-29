import type { ControlStore } from "../control/control-store.js";
import type { HarnessEvent, RunEventEnvelope, RunEventPriority, RunEventReplayPolicy, RunEventSource } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";

export type SafePoint = "provider_terminal" | "tool_end" | "job_safe_point" | "user_cancel" | "idle";

export interface RunEventInput {
  source: RunEventSource;
  kind: string;
  priority?: RunEventPriority;
  generation?: number;
  correlationId: string;
  causationId?: string;
  idempotencyKey?: string;
  coalescingKey?: string;
  operationId?: string;
  requestEpochId?: string;
  deadlineAt?: string;
  replayPolicy?: RunEventReplayPolicy;
  payload?: Record<string, unknown>;
  payloadRef?: RunEventEnvelope["payloadRef"];
}

export interface RunEventAction {
  ingressId: string;
  kind: string;
  source: RunEventSource;
  generation: number;
  payload: Record<string, unknown>;
}

export interface RunEventDrainResult {
  safePoint: SafePoint;
  admitted: RunEventAction[];
  deferred: string[];
  coalesced: string[];
}

type IngressPayload = { envelope: RunEventEnvelope; payload?: Record<string, unknown> };

/**
 * Durable ingress adapter for user, provider, Job and maintenance signals.
 * Received events are immutable; processing appends a second fact instead of
 * mutating the first event, so a restart can rebuild the pending queue.
 */
export class RunEventIngress {
  public constructor(private readonly controlStore: ControlStore) {}

  public async enqueue(runId: string, input: RunEventInput): Promise<RunEventEnvelope> {
    const snapshot = await this.controlStore.snapshot(runId);
    const generation = input.generation ?? snapshot.generation;
    const payload = input.payload ? boundedPayload(input.payload) : undefined;
    const idempotencyKey = input.idempotencyKey ?? `${input.source}:${input.kind}:${sha256(canonicalJson(payload ?? {}))}:${generation}`;
    const events = await this.controlStore.events(runId);
    const previous = events.find((event) => event.type === "event_ingress_received" && event.envelope?.idempotencyKey === idempotencyKey);
    if (previous?.envelope) return previous.envelope;
    const now = new Date().toISOString();
    const envelope: RunEventEnvelope = {
      id: `${runId}:ING-${sha256(canonicalJson({ idempotencyKey, correlationId: input.correlationId })).slice(0, 24)}`,
      runId,
      generation,
      source: input.source,
      kind: normalizeKind(input.kind),
      priority: input.priority ?? defaultPriority(input.source, input.kind),
      status: "queued",
      sequence: 0,
      correlationId: input.correlationId,
      ...(input.causationId ? { causationId: input.causationId } : {}),
      idempotencyKey,
      ...(input.coalescingKey ? { coalescingKey: input.coalescingKey } : {}),
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(input.requestEpochId ? { requestEpochId: input.requestEpochId } : {}),
      ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
      replayPolicy: input.replayPolicy ?? "idempotent",
      ...(input.payloadRef ? { payloadRef: input.payloadRef } : {}),
      createdAt: now,
    };
    const appended = await this.controlStore.append(runId, [{
      schemaVersion: 1,
      type: "event_ingress_received",
      actor: "orchestrator",
      lane: "main",
      correlationId: input.correlationId,
      payload: { envelope, ...(payload ? { payload } : {}) },
      envelope,
    }]);
    return appended.at(-1)!.envelope!;
  }

  public async drain(runId: string, safePoint: SafePoint, maxEvents = 32): Promise<RunEventDrainResult> {
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 256) throw new Error("event ingress maxEvents must be an integer from 1 to 256");
    const events = await this.controlStore.events(runId);
    const currentGeneration = (await this.controlStore.snapshot(runId)).generation;
    const processed = new Set(events.filter((event) => event.type === "event_ingress_processed").map((event) => String(event.payload?.ingressId ?? "")));
    const pending = events
      .filter((event): event is HarnessEvent & { payload: IngressPayload } => event.type === "event_ingress_received" && Boolean(event.envelope) && !processed.has(event.envelope!.id) && Boolean(event.payload?.envelope))
      .sort((a, b) => priorityRank(a.envelope!.priority) - priorityRank(b.envelope!.priority) || a.seq - b.seq);
    const selected: Array<{ event: HarnessEvent & { payload: IngressPayload }; status: RunEventEnvelope["status"] }> = [];
    const deferred: string[] = [];
    const coalesced: string[] = [];
    const latestByKey = new Map<string, HarnessEvent & { payload: IngressPayload }>();
    for (const event of pending) {
      const envelope = event.envelope!;
      if (envelope.generation !== currentGeneration) {
        selected.push({ event, status: "deferred" });
        deferred.push(envelope.id);
        continue;
      }
      if (envelope.priority !== "urgent" && safePoint === "provider_terminal" && envelope.source === "provider") {
        selected.push({ event, status: "deferred" });
        deferred.push(envelope.id);
        continue;
      }
      if (envelope.coalescingKey) {
        const previous = latestByKey.get(envelope.coalescingKey);
        if (previous) {
          selected.push({ event: previous, status: "coalesced" });
          coalesced.push(previous.envelope!.id);
        }
        latestByKey.set(envelope.coalescingKey, event);
      } else {
        selected.push({ event, status: "applied" });
      }
      if (selected.length >= maxEvents) break;
    }
    for (const event of latestByKey.values()) {
      if (!selected.some((item) => item.event.envelope!.id === event.envelope!.id)) selected.push({ event, status: "applied" });
    }
    const bounded = selected.slice(0, maxEvents);
    if (bounded.length > 0) {
      await this.controlStore.append(runId, bounded.map(({ event, status }) => ({
        schemaVersion: 1,
        type: "event_ingress_processed" as const,
        actor: "orchestrator" as const,
        lane: "main" as const,
        correlationId: event.envelope!.correlationId,
        payload: { ingressId: event.envelope!.id, status, safePoint },
        envelope: { ...event.envelope!, status },
      })));
    }
    return {
      safePoint,
      admitted: bounded.filter((item) => item.status === "applied").map(({ event }) => ({ ingressId: event.envelope!.id, kind: event.envelope!.kind, source: event.envelope!.source, generation: event.envelope!.generation, payload: event.payload.payload ?? {} })),
      deferred,
      coalesced,
    };
  }
}

function boundedPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const serialized = canonicalJson(payload);
  if (serialized.length <= 8_000) return structuredClone(payload);
  return { summary: serialized.slice(0, 2_000), contentHash: sha256(serialized), truncated: true };
}

function normalizeKind(kind: string): string {
  const normalized = kind.trim().toLowerCase();
  if (!normalized || normalized.length > 120 || !/^[a-z0-9_.:-]+$/.test(normalized)) throw new Error("event ingress kind must be a bounded identifier");
  return normalized;
}

function defaultPriority(source: RunEventSource, kind: string): RunEventPriority {
  if (source === "user" && /pause|resume|cancel/i.test(kind)) return "urgent";
  if (source === "maintenance" || kind.includes("heartbeat")) return "background";
  return "normal";
}

function priorityRank(priority: RunEventPriority): number {
  return priority === "urgent" ? 0 : priority === "normal" ? 1 : 2;
}
