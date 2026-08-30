import type { ControlStore, IngressClaim } from "../control/control-store.js";
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
  claimToken: string;
  leaseExpiresAt: string;
}

export interface RunEventDrainResult {
  safePoint: SafePoint;
  admitted: RunEventAction[];
  deferred: string[];
  coalesced: string[];
  failed: string[];
}

type IngressPayload = { envelope: RunEventEnvelope; payload?: Record<string, unknown> };

export interface RunEventIngressOptions {
  leaseMs?: number;
}

/**
 * Durable ingress adapter for user, provider, Job and maintenance signals.
 * Received events are immutable; processing appends a second fact instead of
 * mutating the first event, so a restart can rebuild the pending queue.
 */
export class RunEventIngress {
  private readonly leaseMs: number;

  public constructor(private readonly controlStore: ControlStore, options: RunEventIngressOptions = {}) {
    this.leaseMs = normalizeLease(options.leaseMs ?? 30_000);
  }

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
    return await this.controlStore.appendIngressReceived(runId, { envelope, ...(payload ? { payload } : {}) });
  }

  public async drain(runId: string, safePoint: SafePoint, maxEvents = 32): Promise<RunEventDrainResult> {
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 256) throw new Error("event ingress maxEvents must be an integer from 1 to 256");
    const events = await this.controlStore.events(runId);
    const currentGeneration = (await this.controlStore.snapshot(runId)).generation;
    const processed = new Set(events
      .filter((event) => event.type === "event_ingress_processed" && ["applied", "coalesced", "failed"].includes(String(event.payload?.status)))
      .map((event) => String(event.payload?.ingressId ?? "")));
    const pending = events
      .filter((event): event is HarnessEvent & { payload: IngressPayload } => event.type === "event_ingress_received" && Boolean(event.envelope) && !processed.has(event.envelope!.id) && Boolean(event.payload?.envelope))
      .sort((a, b) => priorityRank(a.envelope!.priority) - priorityRank(b.envelope!.priority) || a.seq - b.seq);
    const selected: Array<{ event: HarnessEvent & { payload: IngressPayload }; status: IngressClaim["status"] }> = [];
    const deferred: string[] = [];
    const coalesced: string[] = [];
    const failed: string[] = [];
    const stale: Array<{ event: HarnessEvent & { payload: IngressPayload }; status: "failed" }> = [];
    const ready: Array<HarnessEvent & { payload: IngressPayload }> = [];
    const latestByKey = new Map<string, HarnessEvent & { payload: IngressPayload }>();
    for (const event of pending) {
      const envelope = event.envelope!;
      if (envelope.generation !== currentGeneration) {
        stale.push({ event, status: "failed" });
        continue;
      }
      if (envelope.priority !== "urgent" && safePoint === "provider_terminal" && envelope.source === "provider") {
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
        ready.push(event);
      }
    }
    for (const event of latestByKey.values()) {
      ready.push(event);
    }
    selected.push(...ready.map((event) => ({ event, status: "claimed" as const })));
    const bounded = [...stale, ...selected].slice(0, maxEvents);
    const claims = await this.controlStore.claimIngress(runId, bounded.map(({ event, status }) => ({ ingressId: event.envelope!.id, envelope: event.envelope!, status, safePoint, leaseMs: this.leaseMs })));
    const claimedIds = new Set(claims.map((claim) => claim.ingressId));
    const claimed = bounded.filter((item) => claimedIds.has(item.event.envelope!.id));
    failed.push(...claimed.filter((item) => item.status === "failed").map((item) => item.event.envelope!.id));
    const admitted = claimed.filter((item) => item.status === "claimed");
    const claimedCoalesced = claimed.filter((item) => item.status === "coalesced");
    const claimsById = new Map(claims.map((claim) => [claim.ingressId, claim]));
    return {
      safePoint,
      admitted: admitted.map(({ event }) => {
        const claim = claimsById.get(event.envelope!.id)!;
        return { ingressId: event.envelope!.id, kind: event.envelope!.kind, source: event.envelope!.source, generation: event.envelope!.generation, payload: event.payload.payload ?? {}, claimToken: claim.claimToken!, leaseExpiresAt: claim.leaseExpiresAt! };
      }),
      deferred,
      coalesced: claimedCoalesced.map((item) => item.event.envelope!.id),
      failed,
    };
  }

  public async complete(runId: string, action: Pick<RunEventAction, "ingressId" | "claimToken" | "leaseExpiresAt">, status: "applied" | "failed" | "coalesced", reason?: string): Promise<void> {
    if (Date.parse(action.leaseExpiresAt) <= Date.now()) throw new Error(`Ingress ${action.ingressId} claim lease expired`);
    await this.controlStore.completeIngress(runId, { ingressId: action.ingressId, claimToken: action.claimToken, status, reason });
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

function normalizeLease(value: number): number {
  if (!Number.isInteger(value) || value < 50 || value > 300_000) throw new Error("event ingress lease must be an integer from 50 to 300000ms");
  return value;
}
