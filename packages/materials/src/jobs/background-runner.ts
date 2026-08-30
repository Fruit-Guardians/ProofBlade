import type { ControlStore } from "../control/control-store.js";
import type { JobRecord, Lane } from "../domain/types.js";
import { id } from "../domain/utils.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { ProofBladeCapabilityRouter } from "../capabilities/router.js";
import { snipText } from "@proofblade/molecules";

export interface BackgroundJobStartInput {
  capabilityId: string;
  operation: string;
  input: Record<string, unknown>;
  lane?: Lane;
  timeoutMs?: number;
}

export interface JobOutput {
  jobId: string;
  status: JobRecord["status"];
  artifactId?: string;
  output: string;
  truncated: boolean;
  originalChars: number;
}

export type JobMonitorTrigger = "new_output" | "keyword" | "exit" | "error" | "heartbeat";

export interface JobMonitorInput {
  sinceCursor?: string;
  triggers?: JobMonitorTrigger[];
  keywords?: string[];
  waitMs?: number;
  heartbeatMs?: number;
}

export interface JobMonitorResult {
  jobId: string;
  status: JobRecord["status"];
  trigger: JobMonitorTrigger | "timeout";
  cursor: string;
  output?: string;
  matchedKeyword?: string;
  artifactId?: string;
}

export class BackgroundJobRunner {
  private readonly active = new Map<string, { controller: AbortController; timeout?: ReturnType<typeof setTimeout>; timedOut: boolean; promise: Promise<void> }>();

  public constructor(
    private readonly runId: string,
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
    private readonly router: ProofBladeCapabilityRouter,
  ) {}

  public async start(input: BackgroundJobStartInput): Promise<JobRecord> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    if (["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"].includes(snapshot.status)) throw new Error(`Cannot start a background job for terminal run ${snapshot.status}`);
    const invocation = { capabilityId: input.capabilityId, operation: input.operation, input: input.input };
    const persistence = this.router.preparePersistence(invocation);
    const timeoutMs = normalizeTimeout(input.timeoutMs);
    const job: Omit<JobRecord, "createdSeq"> = {
      id: id("J"),
      capabilityId: input.capabilityId,
      operation: input.operation,
      backendId: persistence.backendId,
      backendVersion: persistence.backendVersion,
      args: persistence.input,
      argsRedacted: persistence.argsRedacted || undefined,
      replayPolicy: persistence.operation.replay,
      status: "QUEUED",
      lane: input.lane ?? "executor",
      generation: snapshot.generation,
      timeoutMs,
    };
    await this.controlStore.dispatch(this.runId, { type: "job_queued", job, lane: job.lane });
    const created = (await this.controlStore.snapshot(this.runId)).jobs[job.id];
    if (!created) throw new Error(`Job was not persisted: ${job.id}`);
    this.schedule(created, structuredClone(input.input));
    return created;
  }

  public async poll(jobId: string, now = Date.now()): Promise<JobRecord> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const job = snapshot.jobs[jobId];
    if (!job) throw new Error(`Unknown job ${jobId}`);
    if (job.generation !== snapshot.generation && job.status !== "UNKNOWN") {
      await this.reconcileStale(job, snapshot.generation);
      return (await this.controlStore.snapshot(this.runId)).jobs[jobId]!;
    }
    if (isExpired(job, now)) {
      await this.controlStore.dispatch(this.runId, {
        type: "job_finished",
        jobId: job.id,
        status: "TIMED_OUT",
        outcome: "timeout",
        error: "Background job timeout exceeded.",
        lane: job.lane,
      });
      return (await this.controlStore.snapshot(this.runId)).jobs[jobId]!;
    }
    return job;
  }

  public async cancel(jobId: string, reason = "Cancelled by operator."): Promise<JobRecord> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const job = snapshot.jobs[jobId];
    if (!job) throw new Error(`Unknown job ${jobId}`);
    if (job.generation !== snapshot.generation) {
      await this.reconcileStale(job, snapshot.generation);
      return (await this.controlStore.snapshot(this.runId)).jobs[jobId]!;
    }
    if (["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "UNKNOWN"].includes(job.status)) return job;
    this.active.get(jobId)?.controller.abort(reason);
    await this.controlStore.dispatch(this.runId, { type: "job_cancelled", jobId, reason, lane: "executor" });
    return (await this.controlStore.snapshot(this.runId)).jobs[jobId]!;
  }

  public async recover(now = Date.now()): Promise<JobRecord[]> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const recovered: JobRecord[] = [];
    for (const job of Object.values(snapshot.jobs)) {
      if (job.status !== "QUEUED" && job.status !== "RUNNING") continue;
      if (job.generation !== snapshot.generation) {
        await this.reconcileStale(job, snapshot.generation);
        recovered.push((await this.controlStore.snapshot(this.runId)).jobs[job.id]!);
        continue;
      }
      if (isTerminalRun(snapshot.status)) {
        await this.controlStore.dispatch(this.runId, { type: "job_reconciled", jobId: job.id, reason: `Run is already terminal (${snapshot.status}); background work was not resumed.`, lane: "executor" });
        recovered.push((await this.controlStore.snapshot(this.runId)).jobs[job.id]!);
        continue;
      }
      if (job.status === "RUNNING" && job.timeoutMs !== undefined) {
        const deadline = durableDeadline(job);
        if (deadline === undefined) {
          await this.controlStore.dispatch(this.runId, {
            type: "job_reconciled",
            jobId: job.id,
            reason: "Process restarted while the running job had no valid durable deadline; execution was not resumed.",
            lane: job.lane,
          });
          recovered.push((await this.controlStore.snapshot(this.runId)).jobs[job.id]!);
          continue;
        }
        if (now >= deadline) {
          await this.controlStore.dispatch(this.runId, {
            type: "job_finished",
            jobId: job.id,
            status: "TIMED_OUT",
            outcome: "timeout",
            error: "Background job deadline elapsed before recovery.",
            finishedAt: new Date(now).toISOString(),
            lane: job.lane,
          });
          recovered.push((await this.controlStore.snapshot(this.runId)).jobs[job.id]!);
          continue;
        }
      }
      if (job.argsRedacted) {
        await this.controlStore.dispatch(this.runId, { type: "job_reconciled", jobId: job.id, reason: "Process restarted after background arguments were redacted; original arguments are unavailable for replay.", lane: job.lane });
        recovered.push((await this.controlStore.snapshot(this.runId)).jobs[job.id]!);
        continue;
      }
      if (job.replayPolicy === "pure" || job.replayPolicy === "idempotent" || job.replayPolicy === "resumable") {
        this.schedule(job);
        recovered.push(job);
      } else {
        await this.controlStore.dispatch(this.runId, { type: "job_reconciled", jobId: job.id, reason: "Process restarted while an unsafe background job was active.", lane: job.lane });
        recovered.push((await this.controlStore.snapshot(this.runId)).jobs[job.id]!);
      }
    }
    return recovered;
  }

  public async readOutput(jobId: string, maxChars = 4_000): Promise<JobOutput> {
    const job = await this.poll(jobId);
    if (!job.artifactId) return { jobId, status: job.status, output: job.error ?? "", truncated: false, originalChars: (job.error ?? "").length };
    const snapshot = await this.controlStore.snapshot(this.runId);
    const artifact = snapshot.artifacts[job.artifactId];
    if (!artifact) throw new Error(`Job artifact missing: ${job.artifactId}`);
    const content = await this.artifactStore.readText(this.runId, artifact);
    const snipped = snipText(content, maxChars);
    return { jobId, status: job.status, artifactId: artifact.id, output: snipped.text, truncated: snipped.truncated, originalChars: snipped.originalChars };
  }

  public async wait(jobId: string, timeoutMs = 30_000): Promise<JobRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await this.poll(jobId);
      if (["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "UNKNOWN"].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return await this.poll(jobId);
  }

  /** Wait for a durable job signal instead of making the model poll in a loop. */
  public async monitor(jobId: string, input: JobMonitorInput = {}): Promise<JobMonitorResult> {
    const triggers = new Set<JobMonitorTrigger>(input.triggers ?? ["new_output", "keyword", "exit", "error", "heartbeat"]);
    const keywords = (input.keywords ?? []).map((value) => value.trim()).filter(Boolean);
    if (triggers.has("keyword") && keywords.length === 0) throw new Error("monitor_job keyword trigger requires keywords");
    const sinceCursor = parseCursor(input.sinceCursor);
    const waitMs = normalizeMonitorWait(input.waitMs);
    const heartbeatMs = normalizeMonitorHeartbeat(input.heartbeatMs);
    const deadline = Date.now() + waitMs;
    let lastHeartbeat = Date.now();
    let eventCursor = (await this.controlStore.events(this.runId)).at(-1)?.seq ?? 0;
    while (true) {
      const job = await this.poll(jobId);
      const content = await this.jobContent(job);
      // The cursor is a wire/storage position, so count UTF-8 bytes rather
      // than JavaScript code units. This keeps monitor_job resumable when a
      // capability emits non-ASCII output and matches shell_job semantics.
      const contentBytes = Buffer.from(content, "utf8");
      const cursor = contentBytes.length;
      const delta = decodeUtf8FromByteCursor(contentBytes, sinceCursor);
      if (triggers.has("new_output") && cursor > sinceCursor) return monitorResult(job, "new_output", cursor, delta);
      if (triggers.has("keyword")) {
        const matchedKeyword = keywords.find((keyword) => delta.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()));
        if (matchedKeyword) return { ...monitorResult(job, "keyword", cursor, delta), matchedKeyword };
      }
      if (isTerminal(job.status)) {
        if (triggers.has("error") && ["FAILED", "TIMED_OUT", "UNKNOWN"].includes(job.status)) return monitorResult(job, "error", cursor, delta);
        if (triggers.has("exit")) return monitorResult(job, "exit", cursor, delta);
        return monitorResult(job, "timeout", cursor, delta);
      }
      if (triggers.has("heartbeat") && Date.now() - lastHeartbeat >= heartbeatMs) {
        lastHeartbeat = Date.now();
        return monitorResult(job, "heartbeat", cursor, delta);
      }
      if (Date.now() >= deadline) return monitorResult(job, "timeout", cursor, delta);
      const untilDeadline = Math.max(0, deadline - Date.now());
      const untilHeartbeat = triggers.has("heartbeat") ? Math.max(1, heartbeatMs - (Date.now() - lastHeartbeat)) : untilDeadline;
      const waitFor = Math.min(untilDeadline, untilHeartbeat);
      if (waitFor <= 0) continue;
      const events = await this.controlStore.waitForEvents(this.runId, eventCursor, waitFor);
      if (events.length > 0) eventCursor = Math.max(eventCursor, events.at(-1)!.seq);
    }
  }

  public async stopAll(reason = "Run ended; stopping background jobs."): Promise<void> {
    for (const jobId of this.active.keys()) await this.cancel(jobId, reason).catch(() => undefined);
  }

  public async close(): Promise<void> {
    await this.stopAll();
    await Promise.all([...this.active.values()].map((entry) => entry.promise.catch(() => undefined)));
  }

  private schedule(job: JobRecord, executionInput?: Record<string, unknown>): void {
    if (this.active.has(job.id)) return;
    const controller = new AbortController();
    const entry = { controller, timedOut: false, timeout: undefined as ReturnType<typeof setTimeout> | undefined, promise: Promise.resolve() };
    entry.promise = this.run(job, executionInput ?? job.args, entry);
    this.active.set(job.id, entry);
    entry.promise.finally(() => {
      if (entry.timeout) clearTimeout(entry.timeout);
      this.active.delete(job.id);
    }).catch(() => undefined);
  }

  private async run(job: JobRecord, executionInput: Record<string, unknown>, entry: { controller: AbortController; timeout?: ReturnType<typeof setTimeout>; timedOut: boolean }): Promise<void> {
    try {
      const current = await this.poll(job.id);
      if (["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "UNKNOWN"].includes(current.status)) return;
      const currentGeneration = (await this.controlStore.snapshot(this.runId)).generation;
      if (current.generation !== currentGeneration) {
        await this.reconcileStale(current, currentGeneration);
        return;
      }
      let running = current;
      if (current.status === "QUEUED") {
        await this.controlStore.dispatch(this.runId, { type: "job_started", jobId: job.id, lane: job.lane, startedAt: new Date().toISOString() });
        running = (await this.controlStore.snapshot(this.runId)).jobs[job.id]!;
        const startedGeneration = (await this.controlStore.snapshot(this.runId)).generation;
        if (running.generation !== startedGeneration) {
          await this.reconcileStale(running, startedGeneration);
          return;
        }
      }
      const remainingTimeoutMs = running.timeoutMs === undefined ? undefined : durableDeadline(running) === undefined
        ? undefined
        : durableDeadline(running)! - Date.now();
      if (running.timeoutMs !== undefined && remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) {
        await this.controlStore.dispatch(this.runId, {
          type: "job_finished",
          jobId: job.id,
          status: "TIMED_OUT",
          outcome: "timeout",
          error: "Background job deadline elapsed before execution resumed.",
          lane: job.lane,
        });
        return;
      }
      if (remainingTimeoutMs !== undefined) entry.timeout = setTimeout(() => { entry.timedOut = true; entry.controller.abort("background job timeout"); }, remainingTimeoutMs);
      const result = await this.router.invoke({ capabilityId: job.capabilityId, operation: job.operation, input: executionInput, backendId: job.backendId, backendVersion: job.backendVersion, expectedGeneration: running.generation }, entry.controller.signal);
      const after = await this.poll(job.id);
      if (["CANCELLED", "FAILED", "TIMED_OUT", "UNKNOWN"].includes(after.status)) return;
      const afterGeneration = (await this.controlStore.snapshot(this.runId)).generation;
      if (after.generation !== afterGeneration) {
        await this.reconcileStale(after, afterGeneration);
        return;
      }
      await this.controlStore.dispatch(this.runId, {
        type: "job_finished",
        jobId: job.id,
        status: entry.timedOut ? "TIMED_OUT" : "SUCCEEDED",
        outcome: entry.timedOut ? "timeout" : "success",
        effectId: result.effectId,
        artifactId: result.artifactId,
        outputTier: result.outputTier,
        lane: job.lane,
      });
    } catch (error) {
      const after = await this.poll(job.id).catch(() => undefined);
      if (!after || ["CANCELLED", "FAILED", "TIMED_OUT", "UNKNOWN"].includes(after.status)) return;
      const currentGeneration = (await this.controlStore.snapshot(this.runId)).generation;
      if (after.generation !== currentGeneration) {
        await this.reconcileStale(after, currentGeneration);
        return;
      }
      const timedOut = entry.timedOut;
      await this.controlStore.dispatch(this.runId, {
        type: "job_finished",
        jobId: job.id,
        status: timedOut ? "TIMED_OUT" : "FAILED",
        outcome: timedOut ? "timeout" : "error",
        error: String(error),
        lane: job.lane,
      });
    }
  }

  private async reconcileStale(job: JobRecord, currentGeneration: number): Promise<void> {
    if (job.status === "UNKNOWN") return;
    await this.controlStore.dispatch(this.runId, {
      type: "job_reconciled",
      jobId: job.id,
      reason: `Background job belongs to generation ${job.generation}; current Run generation is ${currentGeneration}. Execution was not resumed.`,
      lane: job.lane,
    });
  }

  private async jobContent(job: JobRecord): Promise<string> {
    if (!job.artifactId) return job.error ?? "";
    const snapshot = await this.controlStore.snapshot(this.runId);
    const artifact = snapshot.artifacts[job.artifactId];
    return artifact ? await this.artifactStore.readText(this.runId, artifact) : job.error ?? "";
  }
}

function isExpired(job: JobRecord, now = Date.now()): boolean {
  if (job.status !== "RUNNING") return false;
  const deadline = durableDeadline(job);
  return deadline !== undefined && now >= deadline;
}

function durableDeadline(job: JobRecord): number | undefined {
  if (!job.timeoutMs || !job.startedAt) return undefined;
  const startedAt = Date.parse(job.startedAt);
  return Number.isFinite(startedAt) ? startedAt + job.timeoutMs : undefined;
}

function isTerminalRun(status: string): boolean {
  return ["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"].includes(status);
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return 30_000;
  if (!Number.isFinite(value) || value < 50) throw new Error("Background timeout must be at least 50ms");
  return Math.min(120_000, Math.floor(value));
}

function parseCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) throw new Error("monitor_job sinceCursor must be a non-negative byte cursor");
  return Number(value);
}

function normalizeMonitorWait(value: number | undefined): number {
  if (value === undefined) return 30_000;
  if (!Number.isInteger(value) || value < 50 || value > 120_000) throw new Error("monitor_job waitMs must be an integer from 50 to 120000");
  return value;
}

function normalizeMonitorHeartbeat(value: number | undefined): number {
  if (value === undefined) return 5_000;
  if (!Number.isInteger(value) || value < 50 || value > 120_000) throw new Error("monitor_job heartbeatMs must be an integer from 50 to 120000");
  return value;
}

function isTerminal(status: JobRecord["status"]): boolean {
  return ["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "UNKNOWN"].includes(status);
}

function monitorResult(job: JobRecord, trigger: JobMonitorResult["trigger"], cursor: number, output: string): JobMonitorResult {
  return { jobId: job.id, status: job.status, trigger, cursor: String(cursor), ...(output ? { output: output.slice(0, 12_000) } : {}), ...(job.artifactId ? { artifactId: job.artifactId } : {}) };
}

function decodeUtf8FromByteCursor(bytes: Buffer, cursor: number): string {
  let offset = Math.max(0, Math.min(bytes.length, Math.floor(cursor)));
  while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset += 1;
  return bytes.subarray(offset).toString("utf8");
}
