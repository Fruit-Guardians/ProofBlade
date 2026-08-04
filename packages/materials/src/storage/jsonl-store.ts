import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HarnessEvent, RunSnapshot } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import { createInitialSnapshot, projectionHash, reduce } from "../control/reducer.js";
import { atomicWriteFile, durableAppendFile, KeyedOperationQueue } from "@proofblade/atoms";
import { EventProjector } from "@proofblade/molecules";

export class JsonlControlStore {
  private readonly runsRoot: string;
  private readonly writes = new KeyedOperationQueue();

  public constructor(runsRoot: string) {
    this.runsRoot = runsRoot;
  }

  public runPath(runId: string): string {
    return join(this.runsRoot, runId, "events.jsonl");
  }

  public async create(runId: string, task: RunSnapshot["task"]): Promise<RunSnapshot> {
    const path = this.runPath(runId);
    await mkdir(dirname(path), { recursive: true });
    const initial = createInitialSnapshot(runId, task);
    await this.persistTask(runId, task);
    await atomicWriteFile(path, "");
    await this.appendEvent(makeEvent(runId, 1, "run_started", "orchestrator", "main", { generation: 0 }));
    return (await this.snapshot(runId)) ?? initial;
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

  public async append(events: HarnessEvent[]): Promise<void> {
    if (events.length === 0) return;
    const path = this.runPath(events[0]!.runId);
    await mkdir(dirname(path), { recursive: true });
    await this.writes.run(events[0]!.runId, async () => {
      await durableAppendFile(path, events.map((event) => `${canonicalJson(event)}\n`).join(""));
    });
  }

  public async appendEvent(event: HarnessEvent): Promise<void> {
    await this.append([event]);
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

  public async persistTask(runId: string, task: RunSnapshot["task"]): Promise<void> {
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

  public async saveProjection(snapshot: RunSnapshot): Promise<void> {
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

  private async replayWithTask(runId: string, task: RunSnapshot["task"], events: HarnessEvent[]): Promise<RunSnapshot> {
    const projector = new EventProjector(() => createInitialSnapshot(runId, task), reduce);
    const snapshot = projector.replay(events);
    snapshot.projectionHash = projectionHash(snapshot);
    return snapshot;
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
