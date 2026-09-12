import { watch } from "node:fs";
import type { Stats } from "node:fs";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HarnessEvent, RunEventEnvelope, RunSnapshot, RunVersionSnapshot } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import { createInitialSnapshot, projectionHash, reduce } from "../control/reducer.js";
import { atomicWriteFile, durableAppendFile, KeyedOperationQueue, withFileLock } from "@proofblade/atoms";
import type { FileLockOptions } from "@proofblade/atoms";
import { EventProjector } from "@proofblade/molecules";

export interface JsonlRunWriter {
  append(events: HarnessEvent[], authoritySecret: string): Promise<void>;
  saveProjection(snapshot: RunSnapshot, authoritySecret: string): Promise<void>;
}

/**
 * Cheap identity for the append-only event stream.  Consumers use this to
 * avoid reparsing an unchanged stream; size is included with mtime because
 * Windows filesystems may coalesce timestamp updates.
 */
export interface JsonlRunRevision {
  /** Event-stream identity. */
  readonly size: number;
  readonly mtimeMs: number;
  /** Persisted task-contract identity. */
  readonly taskSize: number;
  readonly taskMtimeMs: number;
}

interface EventCacheEntry {
  readonly revision: JsonlRunRevision;
  readonly events: HarnessEvent[];
}

const EVENT_CACHE_LIMIT = 64;

export class JsonlControlStore {
  private readonly runsRoot: string;
  private readonly writes = new KeyedOperationQueue();
  private readonly authorityHashes = new Map<string, string>();
  private readonly lockOptions: FileLockOptions;
  /** Parsed event streams are shared by snapshot, telemetry and GUI reads. */
  private readonly eventCache = new Map<string, EventCacheEntry>();
  /** Coalesce concurrent cold reads for the same Run. */
  private readonly eventLoads = new Map<string, Promise<HarnessEvent[]>>();

  public constructor(runsRoot: string, options: { lock?: FileLockOptions } = {}) {
    this.runsRoot = runsRoot;
    this.lockOptions = options.lock ?? {};
  }

  public runPath(runId: string): string {
    return join(this.runsRoot, runId, "events.jsonl");
  }

  /** Return the current event-stream revision without reading or parsing it. */
  public async revision(runId: string): Promise<JsonlRunRevision> {
    try {
      const events = await stat(this.runPath(runId));
      let task: Stats | undefined;
      try {
        task = await stat(join(this.runsRoot, runId, "task.json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return {
        size: events.size,
        mtimeMs: events.mtimeMs,
        taskSize: task?.size ?? -1,
        taskMtimeMs: task?.mtimeMs ?? -1,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Run not found: ${runId}`);
      throw error;
    }
  }

  public async create(runId: string, task: RunSnapshot["task"], versionSnapshot: RunVersionSnapshot | undefined, authorityHash: string, authoritySecret?: string): Promise<RunSnapshot> {
    const path = this.runPath(runId);
    await mkdir(this.runsRoot, { recursive: true });
    try {
      // The run directory is the create-exclusive anchor. Never truncate an
      // existing task/event stream under the same run id.
      await mkdir(dirname(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Run already exists: ${runId}`);
      throw error;
    }
    return await this.writes.run(runId, async () => await withFileLock(join(dirname(path), ".control.lock"), async () => {
      await this.#persistTask(runId, task);
      await atomicWriteFile(path, "");
      await this.#appendUnchecked([makeEvent(runId, 1, "run_started", "orchestrator", "main", { generation: 0, taskHash: sha256(canonicalJson(task)), authorityHash, versionSnapshot })]);
      this.authorityHashes.set(runId, authorityHash);
      const snapshot = await this.replayWithTask(runId, task, await this.events(runId));
      if (authoritySecret !== undefined) await this.#saveProjectionUnlocked(snapshot, authoritySecret);
      return snapshot;
    }, this.lockOptions));
  }

  /**
   * Execute a complete read/validate/append/projection transaction while
   * holding the cross-process Run lock. Callers must reread the event stream
   * inside this callback; an in-memory ControlStore queue is not sufficient
   * when another process owns the same Run.
   */
  public async withRunLock<T>(runId: string, operation: (writer: JsonlRunWriter) => Promise<T>): Promise<T> {
    const lockPath = join(this.runsRoot, runId, ".control.lock");
    return await this.writes.run(runId, async () => await withFileLock(lockPath, async () => {
      const writer: JsonlRunWriter = {
        append: async (events, authoritySecret) => await this.#appendAuthorizedUnlocked(events, authoritySecret),
        saveProjection: async (snapshot, authoritySecret) => await this.#saveProjectionUnlocked(snapshot, authoritySecret),
      };
      return await operation(writer);
    }, this.lockOptions));
  }

  /** Serialize slow, durable Run maintenance without holding the Control lock. */
  public async withRunMaintenanceLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = join(this.runsRoot, runId, ".maintenance.lock");
    return await this.writes.run(`maintenance:${runId}`, async () => await withFileLock(lockPath, operation, this.lockOptions));
  }

  public async events(runId: string): Promise<HarnessEvent[]> {
    const revision = await this.revision(runId);
    const cached = this.eventCache.get(runId);
    if (cached && sameEventRevision(cached.revision, revision)) {
      this.eventCache.delete(runId);
      this.eventCache.set(runId, cached);
      return cached.events.slice();
    }
    const inFlight = this.eventLoads.get(runId);
    if (inFlight) return (await inFlight).slice();
    const load = this.#loadEvents(runId, revision);
    this.eventLoads.set(runId, load);
    try {
      return (await load).slice();
    } finally {
      if (this.eventLoads.get(runId) === load) this.eventLoads.delete(runId);
    }
  }

  async #loadEvents(runId: string, initialRevision: JsonlRunRevision): Promise<HarnessEvent[]> {
    try {
      const content = await readFile(this.runPath(runId), "utf8");
      const lines = content.split(/\r?\n/);
      const events: HarnessEvent[] = [];
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line) continue;
        try {
          events.push(JSON.parse(line) as HarnessEvent);
        } catch (error) {
          // A process can be terminated after an append has written part of
          // the final UTF-8 record but before the newline reaches durable
          // storage. The event stream is append-only, so the incomplete
          // tail is safe to discard; malformed records in the middle remain
          // a hard corruption signal.
          const isTrailingFragment = index === lines.length - 1 && !content.endsWith("\n");
          if (isTrailingFragment) continue;
          throw new Error(`Invalid event at ${runId}:${index + 1}: ${String(error)}`);
        }
      }
      const finalRevision = await this.revision(runId);
      if (sameEventRevision(initialRevision, finalRevision)) {
        this.eventCache.delete(runId);
        this.eventCache.set(runId, { revision: finalRevision, events });
        while (this.eventCache.size > EVENT_CACHE_LIMIT) {
          const oldest = this.eventCache.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.eventCache.delete(oldest);
        }
      }
      return events;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Run not found: ${runId}`);
      throw error;
    }
  }

  /** Wait for a newer durable event without repeatedly replaying a large Run. */
  public async waitForEvents(runId: string, afterSeq: number, timeoutMs = 30_000): Promise<HarnessEvent[]> {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error("afterSeq must be a non-negative integer");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000) throw new Error("timeoutMs must be an integer from 0 to 120000");
    const path = this.runPath(runId);
    const readNew = async (): Promise<HarnessEvent[]> => (await this.events(runId)).filter((event) => event.seq > afterSeq);
    const current = await readNew();
    if (current.length > 0 || timeoutMs === 0) return current;
    return await new Promise<HarnessEvent[]>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let watcher: ReturnType<typeof watch> | undefined;
      const finish = (result: HarnessEvent[] | Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        watcher?.close();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const check = (): void => {
        void readNew().then((events) => {
          if (events.length > 0) finish(events);
        }).catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
      };
      try {
        watcher = watch(path, { persistent: false }, check);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      timer = setTimeout(() => finish([]), timeoutMs);
      // Close the read/watch race: an append may happen between the initial
      // read and watcher registration.
      check();
    });
  }

  /**
   * Control-plane write primitive. The raw store is exported for read-only
   * projection consumers, but an event stream can only be extended by the
   * ControlStore instance that created its immutable Run anchor.
   */
  public async append(events: HarnessEvent[], authoritySecret: string): Promise<void> {
    if (events.length === 0) return;
    const runId = events[0]!.runId;
    if (events.some((event) => event.runId !== runId || event.streamId !== runId)) {
      throw new Error("A JSONL append cannot mix Run event streams");
    }
    await this.withRunLock(runId, async (writer) => await writer.append(events, authoritySecret));
  }

  public async snapshot(runId: string): Promise<RunSnapshot | undefined> {
    const events = await this.events(runId);
    const first = events.find((event) => event.type === "run_started");
    if (!first) throw new Error(`Run ${runId} has no run_started event`);
    const task = first.payload?.task as RunSnapshot["task"] | undefined;
    if (!task) {
      const stored = await this.loadTask(runId);
      if (!stored) throw new Error(`Run ${runId} has no task contract`);
      return this.replayWithTask(runId, stored, events);
    }
    return this.replayWithTask(runId, task, events);
  }

  public async replay(runId: string, task?: RunSnapshot["task"]): Promise<RunSnapshot> {
    const events = await this.events(runId);
    const resolvedTask = task ?? (await this.loadTask(runId));
    if (!resolvedTask) throw new Error(`Run ${runId} has no task contract`);
    return this.replayWithTask(runId, resolvedTask, events);
  }

  /**
   * Upgrade a pre-authority event stream without rewriting its history. The
   * original task/event files are backed up create-exclusively, then one
   * migration event binds the persisted task contract to the current local
   * control credential. If another process owns the migration lock, callers can
   * still replay the Run as LEGACY-UNTRUSTED/read-only.
   */
  public async migrateLegacyRun(runId: string, authorityHash: string): Promise<"anchored" | "migrated" | "read_only"> {
    if (!/^[a-f0-9]{64}$/i.test(authorityHash)) throw new Error("Legacy Run migration requires a valid authority hash");
    return await this.withRunLock(runId, async () => {
      const events = await this.events(runId);
      const first = events[0];
      if (!first || first.type !== "run_started" || first.seq !== 1) throw new Error(`Run ${runId} has no valid first run_started event`);
      const existing = authorityAnchor(events);
      if (existing) return "anchored";
      if (first.payload?.taskHash !== undefined || first.payload?.authorityHash !== undefined) {
        return "read_only";
      }
      const task = await this.loadTask(runId);
      if (!task) return "read_only";
      // Prove that the complete legacy stream is replayable against the durable
      // task contract before granting it a write credential.
      const legacy = await this.replayWithTask(runId, task, events);
      if (legacy.authorityHash !== "LEGACY-UNTRUSTED") return "read_only";

      const runDir = dirname(this.runPath(runId));
      const eventBackup = join(runDir, "events.pre-authority-migration.jsonl");
      const taskBackup = join(runDir, "task.pre-authority-migration.json");
      const eventContent = await readFile(this.runPath(runId), "utf8");
      const taskContent = await readFile(join(runDir, "task.json"), "utf8");
      try {
        await writeExclusive(eventBackup, eventContent);
        await writeExclusive(taskBackup, taskContent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Another process either completed or currently owns migration. Never
        // append a competing anchor; a later snapshot can retry safely.
        return authorityAnchor(await this.events(runId)) ? "anchored" : "read_only";
      }

      const migration = makeEvent(runId, events.at(-1)!.seq + 1, "run_authority_migrated", "orchestrator", "main", {
        taskHash: sha256(canonicalJson(task)),
        authorityHash,
        migratedFrom: "legacy-v1",
      });
      // Defense-in-depth: reducer validation happens before the durable append.
      reduce(legacy, migration);
      const current = await readFile(this.runPath(runId), "utf8");
      await atomicWriteFile(this.runPath(runId), `${current}${canonicalJson(migration)}\n`);
      this.authorityHashes.set(runId, authorityHash);
      return "migrated";
    });
  }

  async #persistTask(runId: string, task: RunSnapshot["task"]): Promise<void> {
    const path = join(this.runsRoot, runId, "task.json");
    await mkdir(dirname(path), { recursive: true });
    await atomicWriteFile(path, `${canonicalJson(task)}\n`);
  }

  public async loadTask(runId: string): Promise<RunSnapshot["task"] | undefined> {
    try {
      return JSON.parse(await readFile(join(this.runsRoot, runId, "task.json"), "utf8")) as RunSnapshot["task"];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  public async saveProjection(snapshot: RunSnapshot, authoritySecret: string): Promise<void> {
    await this.withRunLock(snapshot.runId, async (writer) => await writer.saveProjection(snapshot, authoritySecret));
  }

  async #saveProjectionUnlocked(snapshot: RunSnapshot, authoritySecret: string): Promise<void> {
    const anchored = await this.#authorityHashFor(snapshot.runId);
    if (sha256(authoritySecret) !== anchored || snapshot.authorityHash !== anchored) {
      throw new Error("Projection write authority does not match the immutable Run anchor");
    }
    const path = join(this.runsRoot, snapshot.runId, "projection.json");
    const content = { ...snapshot, projectionHash: projectionHash(snapshot) };
    await atomicWriteFile(path, `${canonicalJson(content)}\n`);
  }

  public async loadProjection(runId: string): Promise<RunSnapshot | undefined> {
    try {
      return JSON.parse(await readFile(join(this.runsRoot, runId, "projection.json"), "utf8")) as RunSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  public async projectionDigest(runId: string): Promise<string> {
    return sha256(canonicalJson(await this.replay(runId)));
  }

  async #appendAuthorizedUnlocked(events: HarnessEvent[], authoritySecret: string): Promise<void> {
    if (events.length === 0) return;
    const runId = events[0]!.runId;
    if (events.some((event) => event.runId !== runId || event.streamId !== runId)) {
      throw new Error("A JSONL append cannot mix Run event streams");
    }
    const anchored = await this.#authorityHashFor(runId);
    if (sha256(authoritySecret) !== anchored) {
      throw new Error("JSONL write authority does not match the immutable Run anchor");
    }
    await this.#appendUnchecked(events);
  }

  async #appendUnchecked(events: HarnessEvent[]): Promise<void> {
    if (events.length === 0) return;
    const path = this.runPath(events[0]!.runId);
    const runId = events[0]!.runId;
    const cached = this.eventCache.get(runId);
    const cacheCanExtend = cached !== undefined
      && (cached.events.at(-1)?.seq ?? 0) + 1 === events[0]!.seq
      && events.every((event, index) => event.seq === events[0]!.seq + index);
    await mkdir(dirname(path), { recursive: true });
    // Repair a torn final record left by an interrupted append before adding
    // new data. This is a cheap last-byte check in the normal case and only
    // scans backwards when a crash left an unterminated JSON line.
    await repairTrailingRecord(path);
    const serialized = events.map((event) => `${canonicalJson(event)}\n`).join("");
    // One append + one fsync for both single events and validated batches.
    // The lock and pre-validated reducer state preserve ordering, while the
    // append path avoids reading and rewriting the complete history on every
    // tool turn. A torn final line is discarded by the reader/repaired above.
    await durableAppendFile(path, serialized);
    // Keep a warm reader cache coherent with our own append. Without this,
    // the next context/GUI read would parse the entire long event stream again
    // even though the writer already knows the exact new suffix.
    if (cacheCanExtend && cached) {
      const revision = await this.revision(runId);
      this.eventCache.delete(runId);
      this.eventCache.set(runId, { revision, events: [...cached.events, ...events] });
    }
  }

  async #authorityHashFor(runId: string): Promise<string> {
    const cached = this.authorityHashes.get(runId);
    if (cached) return cached;
    const anchored = authorityAnchor(await this.events(runId));
    if (!anchored) {
      throw new Error("Run has no trusted JSONL write anchor");
    }
    this.authorityHashes.set(runId, anchored);
    return anchored;
  }

  private async replayWithTask(runId: string, task: RunSnapshot["task"], events: HarnessEvent[]): Promise<RunSnapshot> {
    const projector = new EventProjector(() => createInitialSnapshot(runId, task), reduce);
    const snapshot = projector.replay(events);
    snapshot.projectionHash = projectionHash(snapshot);
    return snapshot;
  }
}

function sameEventRevision(left: JsonlRunRevision, right: JsonlRunRevision): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function authorityAnchor(events: HarnessEvent[]): string | undefined {
  const anchors = events.flatMap((event) => {
    if (event.type !== "run_started" && event.type !== "run_authority_migrated") return [];
    const value = event.payload?.authorityHash;
    return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? [value] : [];
  });
  if (anchors.length === 0) return undefined;
  if (new Set(anchors).size !== 1) throw new Error("Run contains conflicting authority anchors");
  return anchors[0];
}

async function writeExclusive(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Remove an unterminated final JSONL record left by a crashed append.
 *
 * All ProofBlade writers terminate records with a newline. Checking the last
 * byte keeps the hot path O(1); the backwards scan is only used for recovery.
 */
async function repairTrailingRecord(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r+");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    if (size === 0) return;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    if (last[0] === 0x0a) return;

    const chunkSize = 64 * 1024;
    let cursor = size;
    while (cursor > 0) {
      const length = Math.min(chunkSize, cursor);
      cursor -= length;
      const chunk = Buffer.alloc(length);
      const result = await handle.read(chunk, 0, length, cursor);
      for (let index = result.bytesRead - 1; index >= 0; index -= 1) {
        if (chunk[index] !== 0x0a) continue;
        await handle.truncate(cursor + index + 1);
        await handle.sync();
        return;
      }
    }
    await handle.truncate(0);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function makeEvent(
  runId: string,
  seq: number,
  type: HarnessEvent["type"],
  actor: HarnessEvent["actor"],
  lane: HarnessEvent["lane"],
  payload: Record<string, unknown> = {},
  correlationId = `${runId}:system`,
  envelopeInput?: Partial<RunEventEnvelope>,
): HarnessEvent {
  const ts = new Date().toISOString();
  const envelope: RunEventEnvelope = {
    id: envelopeInput?.id ?? `${runId}:EV-${String(seq).padStart(6, "0")}`,
    runId,
    generation: typeof envelopeInput?.generation === "number" ? envelopeInput.generation : Number(payload.generation ?? 0),
    source: envelopeInput?.source ?? sourceForEvent(type, actor),
    kind: envelopeInput?.kind ?? type,
    priority: envelopeInput?.priority ?? priorityForEvent(type),
    status: envelopeInput?.status ?? "applied",
    sequence: seq,
    correlationId: envelopeInput?.correlationId ?? correlationId,
    ...(envelopeInput?.causationId ? { causationId: envelopeInput.causationId } : {}),
    ...(envelopeInput?.idempotencyKey ? { idempotencyKey: envelopeInput.idempotencyKey } : {}),
    ...(envelopeInput?.coalescingKey ? { coalescingKey: envelopeInput.coalescingKey } : {}),
    ...(envelopeInput?.operationId ? { operationId: envelopeInput.operationId } : {}),
    ...(envelopeInput?.requestEpochId ? { requestEpochId: envelopeInput.requestEpochId } : {}),
    ...(envelopeInput?.deadlineAt ? { deadlineAt: envelopeInput.deadlineAt } : {}),
    replayPolicy: envelopeInput?.replayPolicy ?? replayPolicyForEvent(type),
    ...(envelopeInput?.payloadRef ? { payloadRef: envelopeInput.payloadRef } : {}),
    createdAt: envelopeInput?.createdAt ?? ts,
  };
  const eventPayload = type.startsWith("event_ingress_") && payload.envelope && typeof payload.envelope === "object"
    ? { ...payload, envelope: { ...(payload.envelope as Record<string, unknown>), sequence: seq, status: envelope.status } }
    : payload;
  return {
    schemaVersion: 1,
    id: `${runId}-E${String(seq).padStart(6, "0")}`,
    streamId: runId,
    runId,
    lane,
    seq,
    ts,
    correlationId,
    actor,
    type,
    payload: eventPayload,
    envelope,
  };
}

function sourceForEvent(type: HarnessEvent["type"], actor: HarnessEvent["actor"]): RunEventEnvelope["source"] {
  if (type.startsWith("provider_") || type === "model_usage" || type === "request_epoch_started" || type === "request_epoch_context" || type === "model_context_frame_recorded") return "provider";
  if (type.startsWith("job_")) return "job";
  if (type.startsWith("tool_") || type.startsWith("effect_") || actor === "tool") return "tool";
  if (type.startsWith("consolidate") || type === "compaction_recorded") return "maintenance";
  if (type.startsWith("event_ingress_")) return "external";
  return "maintenance";
}

function priorityForEvent(type: HarnessEvent["type"]): RunEventEnvelope["priority"] {
  if (type === "run_paused" || type === "run_resumed" || type === "run_finished" || type === "run_failed") return "urgent";
  if (type.startsWith("event_ingress_")) return "normal";
  return "background";
}

function replayPolicyForEvent(type: HarnessEvent["type"]): RunEventEnvelope["replayPolicy"] {
  if (type.startsWith("event_ingress_")) return "idempotent";
  if (type.startsWith("provider_") || type === "model_usage" || type === "model_context_frame_recorded" || type.startsWith("tool_") || type.startsWith("consolidate")) return "pure";
  return "unknown";
}
