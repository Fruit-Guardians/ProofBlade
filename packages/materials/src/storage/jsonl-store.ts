import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HarnessEvent, RunSnapshot, RunVersionSnapshot } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import { createInitialSnapshot, projectionHash, reduce } from "../control/reducer.js";
import { atomicWriteFile, durableAppendFile, KeyedOperationQueue, withFileLock } from "@proofblade/atoms";
import type { FileLockOptions } from "@proofblade/atoms";
import { EventProjector } from "@proofblade/molecules";

export interface JsonlRunWriter {
  append(events: HarnessEvent[], authoritySecret: string): Promise<void>;
  saveProjection(snapshot: RunSnapshot, authoritySecret: string): Promise<void>;
}

export class JsonlControlStore {
  private readonly runsRoot: string;
  private readonly writes = new KeyedOperationQueue();
  private readonly authorityHashes = new Map<string, string>();
  private readonly lockOptions: FileLockOptions;

  public constructor(runsRoot: string, options: { lock?: FileLockOptions } = {}) {
    this.runsRoot = runsRoot;
    this.lockOptions = options.lock ?? {};
  }

  public runPath(runId: string): string {
    return join(this.runsRoot, runId, "events.jsonl");
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

  public async events(runId: string): Promise<HarnessEvent[]> {
    try {
      const content = await readFile(this.runPath(runId), "utf8");
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line, index) => {
          try {
            return JSON.parse(line) as HarnessEvent;
          } catch (error) {
            throw new Error(`Invalid event at ${runId}:${index + 1}: ${String(error)}`);
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Run not found: ${runId}`);
      throw error;
    }
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
    await mkdir(dirname(path), { recursive: true });
    const serialized = events.map((event) => `${canonicalJson(event)}\n`).join("");
    if (events.length === 1) {
      // The common single-event path keeps append-only throughput and the
      // established one-event-per-line JSONL format.
      await durableAppendFile(path, serialized);
      return;
    }
    // Replacing the complete JSONL file makes a multi-command dispatchBatch
    // atomic from the replayer's perspective. A process may die before the
    // rename, in which case the previous complete stream remains; it cannot
    // expose a half of a multi-event batch.
    const current = await readFile(path, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    await atomicWriteFile(path, `${current}${serialized}`);
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

export function makeEvent(
  runId: string,
  seq: number,
  type: HarnessEvent["type"],
  actor: HarnessEvent["actor"],
  lane: HarnessEvent["lane"],
  payload: Record<string, unknown> = {},
  correlationId = `${runId}:system`,
): HarnessEvent {
  return {
    schemaVersion: 1,
    id: `${runId}-E${String(seq).padStart(6, "0")}`,
    streamId: runId,
    runId,
    lane,
    seq,
    ts: new Date().toISOString(),
    correlationId,
    actor,
    type,
    payload,
  };
}
