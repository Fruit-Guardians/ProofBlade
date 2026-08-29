import type { ControlStore } from "../control/control-store.js";
import type {
  HarnessEvent,
  ObservationQueueItem,
  ObservationQueueSummary,
  RunEventPriority,
  RunEventSource,
  RunSnapshot,
} from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";

export interface ObservationQueueProjection extends ObservationQueueSummary {
  items: ObservationQueueItem[];
}

export interface ObservationQueueOptions {
  /** Maximum number of coalesced observations retained in the projection. */
  limit?: number;
}

const DERIVED_EVENT_SOURCES: ReadonlyMap<HarnessEvent["type"], RunEventSource> = new Map([
  ["job_finished", "job"],
  ["job_reconciled", "job"],
  ["provider_request_stalled", "provider"],
  ["provider_recovery_required", "provider"],
  ["verification_recovery_required", "verifier"],
  ["verification_recovery_resolved", "verifier"],
  ["completion_verified", "verifier"],
  ["consolidate_failed", "maintenance"],
  ["context_overflow_recovered", "maintenance"],
]);

/**
 * Rebuild the model-facing observation queue from ControlStore events.
 *
 * The queue is a projection, not a second state store. Coalescing only changes
 * what is presented; every source event remains in the durable stream and is
 * acknowledged together when the corresponding observation is consumed.
 */
export function projectObservationQueue(
  events: readonly HarnessEvent[],
  snapshot: Pick<RunSnapshot, "runId" | "generation">,
  options: ObservationQueueOptions = {},
): ObservationQueueProjection {
  const limit = normalizeLimit(options.limit);
  const consumed = new Set(
    events
      .filter((event) => event.type === "observation_consumed")
      .map((event) => String(event.payload?.observationId ?? ""))
      .filter(Boolean),
  );
  const candidates = events
    .map((event) => observationCandidate(event, snapshot))
    .filter((candidate): candidate is ObservationCandidate => candidate !== undefined)
    .filter((candidate) => candidate.generation === snapshot.generation)
    .filter((candidate) => !consumed.has(candidate.event.id));
  const grouped = new Map<string, ObservationCandidate[]>();
  for (const candidate of candidates) {
    const group = grouped.get(candidate.groupKey) ?? [];
    group.push(candidate);
    grouped.set(candidate.groupKey, group);
  }
  const items = [...grouped.values()]
    .map((group) => toItem(group))
    .sort(compareItems);
  const visible = items.slice(0, limit);
  const summaryInput = visible.map(({ id, sourceEventIds, source, kind, priority, generation, sequence, summary, relatedIds, artifactIds, createdAt }) => ({ id, sourceEventIds, source, kind, priority, generation, sequence, summary, relatedIds, artifactIds, createdAt }));
  return {
    schemaVersion: 1,
    total: items.length,
    visible: visible.length,
    hidden: Math.max(0, items.length - visible.length),
    urgent: items.filter((item) => item.priority === "urgent").length,
    ids: visible.map((item) => item.id),
    hash: sha256(canonicalJson(summaryInput)),
    items: visible,
  };
}

/** Render a bounded queue marker suitable for the dynamic context suffix. */
export function formatObservationQueue(projection: ObservationQueueProjection, maxVisible = 8): string {
  const items = projection.items.slice(0, normalizeDisplayLimit(maxVisible));
  if (projection.total === 0 || items.length === 0) return "";
  const lines = [`<pending-observations total="${projection.total}" urgent="${projection.urgent}">`, `[未处理观察 ${items.length}/${projection.total}]`];
  items.forEach((item, index) => {
    const refs = item.artifactIds.length > 0 ? ` artifacts=${item.artifactIds.join(",")}` : "";
    const related = item.relatedIds.length > 0 ? ` refs=${item.relatedIds.join(",")}` : "";
    lines.push(`[${index + 1}/${projection.total}] ${item.kind} (${item.priority}) ${escapeText(item.summary)}${related}${refs}`);
  });
  if (projection.hidden > 0) lines.push(`... 另有 ${projection.hidden} 项，按优先级和事件序列保留在队列中。`);
  lines.push("读取对应 Job、Artifact 或验证状态后，观察才会从待处理列表中移除。", "</pending-observations>");
  return lines.join("\n");
}

/** Acknowledge all source events represented by one displayed observation. */
export async function acknowledgeObservationItems(control: ControlStore, runId: string, items: readonly ObservationQueueItem[], lane = "main" as const): Promise<string[]> {
  return await control.acknowledgeObservations(runId, items.flatMap((item) => item.sourceEventIds), lane);
}

interface ObservationCandidate {
  event: HarnessEvent;
  source: RunEventSource;
  kind: string;
  priority: RunEventPriority;
  generation: number;
  summary: string;
  relatedIds: string[];
  artifactIds: string[];
  createdAt: string;
  groupKey: string;
}

function observationCandidate(event: HarnessEvent, snapshot: Pick<RunSnapshot, "runId" | "generation">): ObservationCandidate | undefined {
  if (event.type === "event_ingress_received") {
    const envelope = event.envelope;
    if (!envelope || envelope.runId !== snapshot.runId || envelope.source === "user") return undefined;
    const payload = recordValue(event.payload?.payload);
    return {
      event,
      source: envelope.source,
      kind: envelope.kind,
      priority: envelope.priority,
      generation: envelope.generation,
      summary: ingressSummary(envelope.kind, payload),
      relatedIds: relatedIds(payload),
      artifactIds: artifactIds(payload),
      createdAt: envelope.createdAt,
      groupKey: envelope.coalescingKey ? `coalesce:${envelope.coalescingKey}` : `event:${event.id}`,
    };
  }
  const source = DERIVED_EVENT_SOURCES.get(event.type);
  if (!source) return undefined;
  const payload = recordValue(event.payload);
  return {
    event,
    source,
    kind: derivedKind(event.type),
    priority: derivedPriority(event.type),
    generation: payloadGeneration(event, snapshot.generation),
    summary: derivedSummary(event.type, payload),
    relatedIds: relatedIds(payload),
    artifactIds: artifactIds(payload),
    createdAt: event.ts,
    groupKey: `event:${event.id}`,
  };
}

function toItem(group: ObservationCandidate[]): ObservationQueueItem {
  const latest = group.at(-1)!;
  return {
    id: `observation:${latest.event.id}`,
    sourceEventIds: group.map((candidate) => candidate.event.id),
    source: latest.source,
    kind: latest.kind,
    priority: latest.priority,
    generation: latest.generation,
    sequence: latest.event.seq,
    summary: latest.summary,
    relatedIds: [...new Set(group.flatMap((candidate) => candidate.relatedIds))].sort(),
    artifactIds: [...new Set(group.flatMap((candidate) => candidate.artifactIds))].sort(),
    createdAt: latest.createdAt,
  };
}

function compareItems(left: ObservationQueueItem, right: ObservationQueueItem): number {
  return priorityRank(left.priority) - priorityRank(right.priority) || left.sequence - right.sequence || left.id.localeCompare(right.id);
}

function ingressSummary(kind: string, payload: Record<string, unknown>): string {
  const status = typeof payload.status === "string" ? payload.status : undefined;
  const trigger = typeof payload.trigger === "string" ? payload.trigger : undefined;
  const jobId = typeof payload.jobId === "string" ? payload.jobId : undefined;
  const cursor = typeof payload.cursor === "number" && Number.isSafeInteger(payload.cursor) ? `cursor=${payload.cursor}` : undefined;
  const suffix = [jobId, trigger, status, cursor].filter(Boolean).join(" ");
  return suffix ? `${kind} signal: ${suffix}` : `${kind} signal received`;
}

function derivedKind(type: HarnessEvent["type"]): string {
  return type.replaceAll("_", ".");
}

function derivedPriority(type: HarnessEvent["type"]): RunEventPriority {
  return type === "completion_verified" || type === "verification_recovery_required" ? "urgent" : type.startsWith("consolidate") || type === "context_overflow_recovered" ? "background" : "normal";
}

function derivedSummary(type: HarnessEvent["type"], payload: Record<string, unknown>): string {
  const id = relatedIds(payload)[0];
  const prefix = id ? `${type.replaceAll("_", ".")} (${id})` : type.replaceAll("_", ".");
  if (type === "completion_verified") return `${prefix}: verifier result is ready`;
  if (type === "verification_recovery_required") return `${prefix}: verifier recovery is required`;
  if (type === "provider_request_stalled" || type === "provider_recovery_required") return `${prefix}: Provider recovery state changed`;
  if (type === "job_finished" || type === "job_reconciled") return `${prefix}: background job state changed`;
  return `${prefix}: maintenance state changed`;
}

function payloadGeneration(event: HarnessEvent, fallback: number): number {
  return typeof event.envelope?.generation === "number" ? event.envelope.generation : typeof event.payload?.generation === "number" ? event.payload.generation : fallback;
}

function relatedIds(payload: Record<string, unknown>): string[] {
  return ["jobId", "requestId", "epochId", "requestEpochId", "completionId", "requestId", "effectId", "operationId"]
    .flatMap((key) => typeof payload[key] === "string" ? [payload[key] as string] : [])
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 8);
}

function artifactIds(payload: Record<string, unknown>): string[] {
  const values = [payload.artifactId, ...(Array.isArray(payload.artifactIds) ? payload.artifactIds : [])];
  return values.filter((value): value is string => typeof value === "string" && value.length <= 256).slice(0, 16).filter((value, index, all) => all.indexOf(value) === index);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function escapeText(value: string): string {
  return value.replace(/[<>&]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[character] ?? character);
}

function priorityRank(priority: RunEventPriority): number {
  return priority === "urgent" ? 0 : priority === "normal" ? 1 : 2;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 128;
  if (!Number.isInteger(value) || value < 1 || value > 512) throw new Error("Observation queue limit must be an integer from 1 to 512");
  return value;
}

function normalizeDisplayLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 32) throw new Error("Observation display limit must be an integer from 1 to 32");
  return value;
}
