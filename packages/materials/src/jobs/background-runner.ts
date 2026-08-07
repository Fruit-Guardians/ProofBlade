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

  public async poll(jobId: string): Promise<JobRecord> {
    const job = (await this.controlStore.snapshot(this.runId)).jobs[jobId];
    if (!job) throw new Error(`Unknown job ${jobId}`);
    return job;
  }

  public async cancel(jobId: string, reason = "Cancelled by operator."): Promise<JobRecord> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const job = snapshot.jobs[jobId];
    if (!job) throw new Error(`Unknown job ${jobId}`);
    if (["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "UNKNOWN"].includes(job.status)) return job;
    this.active.get(jobId)?.controller.abort(reason);
    await this.controlStore.dispatch(this.runId, { type: "job_cancelled", jobId, reason, lane: "executor" });
    return (await this.controlStore.snapshot(this.runId)).jobs[jobId]!;
  }

  public async recover(): Promise<JobRecord[]> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const recovered: JobRecord[] = [];
    for (const job of Object.values(snapshot.jobs)) {
      if (job.status !== "QUEUED" && job.status !== "RUNNING") continue;
      if (isTerminalRun(snapshot.status)) {
        await this.controlStore.dispatch(this.runId, { type: "job_reconciled", jobId: job.id, reason: `Run is already terminal (${snapshot.status}); background work was not resumed.`, lane: "executor" });
        recovered.push((await this.controlStore.snapshot(this.runId)).jobs[job.id]!);
        continue;
      }
      if (job.argsRedacted) {
        await this.controlStore.dispatch(this.runId, { type: "job_reconciled", jobId: job.id, reason: "Process restarted after background arguments were redacted; original arguments are unavailable for replay.", lane: "executor" });
        recovered.push((await this.controlStore.snapshot(this.runId)).jobs[job.id]!);
        continue;
      }
      if (job.replayPolicy === "pure" || job.replayPolicy === "idempotent" || job.replayPolicy === "resumable") {
        this.schedule(job);
        recovered.push(job);
      } else {
        await this.controlStore.dispatch(this.runId, { type: "job_reconciled", jobId: job.id, reason: "Process restarted while an unsafe background job was active.", lane: "executor" });
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
      if (current.status === "CANCELLED") return;
      await this.controlStore.dispatch(this.runId, { type: "job_started", jobId: job.id, lane: job.lane, startedAt: new Date().toISOString() });
      if (job.timeoutMs) entry.timeout = setTimeout(() => { entry.timedOut = true; entry.controller.abort("background job timeout"); }, job.timeoutMs);
      const result = await this.router.invoke({ capabilityId: job.capabilityId, operation: job.operation, input: executionInput }, entry.controller.signal);
      const after = await this.poll(job.id);
      if (after.status === "CANCELLED") return;
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
      if (!after || after.status === "CANCELLED") return;
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
}

function isTerminalRun(status: string): boolean {
  return ["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"].includes(status);
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return 30_000;
  if (!Number.isFinite(value) || value < 50) throw new Error("Background timeout must be at least 50ms");
  return Math.min(120_000, Math.floor(value));
}
