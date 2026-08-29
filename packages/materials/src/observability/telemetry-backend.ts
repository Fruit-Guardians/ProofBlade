import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ControlStore } from "../control/control-store.js";
import type { HarnessEvent } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import { redactRequestValue } from "../runtime/request-epoch.js";

export type TelemetrySpanStatus = "ok" | "error" | "unknown";

export interface TelemetrySpan {
  schemaVersion: 1;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  runId: string;
  eventId: string;
  sequence: number;
  kind: string;
  status: TelemetrySpanStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  attributes: Record<string, unknown>;
  artifactIds: string[];
  evidenceIds: string[];
  effectIds: string[];
  requestEpochIds: string[];
}

export interface TelemetryBackend {
  write(spans: readonly TelemetrySpan[]): Promise<void>;
}

export interface TelemetryExportResult {
  runId: string;
  exported: number;
  cursor: number;
  fromSequence?: number;
  toSequence?: number;
  diagnostic?: string;
}

export class MemoryTelemetryBackend implements TelemetryBackend {
  private readonly stored: TelemetrySpan[] = [];

  public async write(spans: readonly TelemetrySpan[]): Promise<void> {
    this.stored.push(...spans.map((span) => structuredClone(span)));
  }

  public records(): TelemetrySpan[] {
    return this.stored.map((span) => structuredClone(span));
  }
}

/** Append-only JSONL telemetry sink. It is deliberately a projection, never a ControlStore. */
export class JsonlTelemetryBackend implements TelemetryBackend {
  public constructor(private readonly root: string) {}

  public async write(spans: readonly TelemetrySpan[]): Promise<void> {
    if (spans.length === 0) return;
    const runId = spans[0]!.runId;
    if (spans.some((span) => span.runId !== runId)) throw new Error("Telemetry batch cannot mix runs");
    await mkdir(this.root, { recursive: true });
    await appendFile(join(this.root, `${safeFileSegment(runId)}.jsonl`), spans.map((span) => `${canonicalJson(span)}\n`).join(""), "utf8");
  }
}

/**
 * Exports new ControlStore events to a replaceable telemetry backend. Backend
 * errors are returned as diagnostics and never advance the durable cursor.
 */
export class RunTelemetryExporter {
  public constructor(
    private readonly controlStore: ControlStore,
    private readonly backend: TelemetryBackend,
    private readonly cursorRoot?: string,
  ) {}

  public async export(runId: string): Promise<TelemetryExportResult> {
    const events = await this.controlStore.events(runId);
    const previousCursor = await this.readCursor(runId);
    const pending = events.filter((event) => event.seq > previousCursor).sort((left, right) => left.seq - right.seq);
    if (pending.length === 0) return { runId, exported: 0, cursor: previousCursor };
    const spans = pending.map((event) => spanFromEvent(event, events));
    try {
      await this.backend.write(spans);
    } catch (error) {
      return {
        runId,
        exported: 0,
        cursor: previousCursor,
        fromSequence: pending[0]!.seq,
        toSequence: pending.at(-1)!.seq,
        diagnostic: `telemetry backend failed: ${String(error).slice(0, 500)}`,
      };
    }
    const cursor = pending.at(-1)!.seq;
    await this.writeCursor(runId, cursor).catch(() => undefined);
    return { runId, exported: spans.length, cursor, fromSequence: pending[0]!.seq, toSequence: cursor };
  }

  private async readCursor(runId: string): Promise<number> {
    if (!this.cursorRoot) return 0;
    try {
      const parsed = JSON.parse(await readFile(join(this.cursorRoot, `${safeFileSegment(runId)}.cursor.json`), "utf8")) as { cursor?: unknown };
      return typeof parsed.cursor === "number" && Number.isInteger(parsed.cursor) && parsed.cursor >= 0 ? parsed.cursor : 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      return 0;
    }
  }

  private async writeCursor(runId: string, cursor: number): Promise<void> {
    if (!this.cursorRoot) return;
    await mkdir(this.cursorRoot, { recursive: true });
    const path = join(this.cursorRoot, `${safeFileSegment(runId)}.cursor.json`);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, `${canonicalJson({ schemaVersion: 1, runId, cursor })}\n`, "utf8");
  }
}

function spanFromEvent(event: HarnessEvent, allEvents: readonly HarnessEvent[]): TelemetrySpan {
  const payload = event.payload ?? {};
  const parentSpanId = event.envelope?.causationId
    ? spanIdFor(event.envelope.causationId)
    : undefined;
  const durationValue = payload.durationMs;
  const durationMs = typeof durationValue === "number" && Number.isFinite(durationValue) && durationValue >= 0 ? durationValue : undefined;
  const status = event.type.includes("failed") || event.type.includes("error") || payload.isError === true || ["FAILED", "TIMED_OUT", "UNKNOWN"].includes(String(payload.status ?? ""))
    ? "error"
    : event.type.includes("reconciled") || event.type.includes("recovery")
      ? "unknown"
      : "ok";
  const references = collectReferences(payload);
  const attributes = safeAttributes({
    actor: event.actor,
    lane: event.lane,
    eventType: event.type,
    correlationId: event.correlationId,
    generation: event.envelope?.generation,
    ...(event.envelope?.operationId ? { operationId: event.envelope.operationId } : {}),
    ...(event.envelope?.requestEpochId ? { requestEpochId: event.envelope.requestEpochId } : {}),
    payload,
  });
  const prior = allEvents.filter((candidate) => candidate.seq < event.seq && candidate.envelope?.correlationId === event.envelope?.correlationId).at(-1);
  const inferredParentSpanId = parentSpanId ?? (prior ? spanIdFor(prior.id) : undefined);
  return {
    schemaVersion: 1,
    traceId: event.runId,
    spanId: spanIdFor(event.id),
    ...(inferredParentSpanId ? { parentSpanId: inferredParentSpanId } : {}),
    runId: event.runId,
    eventId: event.id,
    sequence: event.seq,
    kind: event.type,
    status,
    startedAt: event.ts,
    ...(durationMs === undefined ? {} : { endedAt: new Date(Date.parse(event.ts) + durationMs).toISOString(), durationMs }),
    attributes,
    artifactIds: references.artifactIds,
    evidenceIds: references.evidenceIds,
    effectIds: references.effectIds,
    requestEpochIds: references.requestEpochIds,
  };
}

function safeAttributes(value: Record<string, unknown>): Record<string, unknown> {
  return redactRequestValue(value) as Record<string, unknown>;
}

function collectReferences(value: unknown): { artifactIds: string[]; evidenceIds: string[]; effectIds: string[]; requestEpochIds: string[] } {
  const found = { artifactIds: new Set<string>(), evidenceIds: new Set<string>(), effectIds: new Set<string>(), requestEpochIds: new Set<string>() };
  const visit = (current: unknown, key = ""): void => {
    if (typeof current === "string") {
      const normalized = key.toLowerCase().replace(/[_-]/g, "");
      if (normalized === "artifactid") found.artifactIds.add(current);
      if (normalized === "evidenceid") found.evidenceIds.add(current);
      if (normalized === "effectid") found.effectIds.add(current);
      if (normalized === "requestepochid" || normalized === "epochid") found.requestEpochIds.add(current);
      return;
    }
    if (Array.isArray(current)) { current.forEach((item) => visit(item, key)); return; }
    if (current && typeof current === "object") Object.entries(current as Record<string, unknown>).forEach(([childKey, child]) => visit(child, childKey));
  };
  visit(value);
  return {
    artifactIds: [...found.artifactIds].sort(),
    evidenceIds: [...found.evidenceIds].sort(),
    effectIds: [...found.effectIds].sort(),
    requestEpochIds: [...found.requestEpochIds].sort(),
  };
}

function spanIdFor(value: string): string {
  return `span-${sha256(value).slice(0, 24)}`;
}

function safeFileSegment(value: string): string {
  const segment = value.trim();
  if (!segment || segment === "." || segment === ".." || /[\\/\u0000]/.test(segment)) throw new Error("Telemetry run id is not a safe file segment");
  return segment.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}
