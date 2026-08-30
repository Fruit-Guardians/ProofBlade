import type { HarnessEvent, JobRecord, RunSnapshot } from "../domain/types.js";

export type LifecycleOwner = "provider" | "tool" | "job";
export type LifecycleAuditStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "UNKNOWN" | "STALLED" | "RECOVERY_REQUIRED" | "ORPHAN";
export type LifecycleIssueCode = "STALLED" | "RECOVERY_REQUIRED" | "ORPHAN";

export interface LifecycleAuditItem {
  owner: LifecycleOwner;
  key: string;
  status: LifecycleAuditStatus;
  eventIds: string[];
  lastEventId?: string;
  ageMs: number;
  stalled: boolean;
  recoveryRequired: boolean;
  orphan: boolean;
  reason?: string;
}

export interface LifecycleAuditIssue {
  code: LifecycleIssueCode;
  owner: LifecycleOwner;
  key: string;
  reason: string;
  eventIds: string[];
}

export interface LifecycleAuditReport {
  schemaVersion: 1;
  asOf: string;
  providers: LifecycleAuditItem[];
  tools: LifecycleAuditItem[];
  jobs: LifecycleAuditItem[];
  issues: LifecycleAuditIssue[];
  counts: {
    stalled: number;
    recoveryRequired: number;
    orphan: number;
  };
}

export interface LifecycleAuditOptions {
  now?: string | number | Date;
  providerStallAfterMs?: number;
  toolStallAfterMs?: number;
  jobStallAfterMs?: number;
}

const DEFAULT_STALL_AFTER_MS = 120_000;

/**
 * Rebuilds provider, tool, and job lifecycle health from durable projections.
 * This is deliberately read-only: callers can run it after a crash without
 * depending on process-local registries or in-memory listeners.
 */
export function auditRunLifecycles(
  events: readonly HarnessEvent[],
  snapshot: Pick<RunSnapshot, "jobs">,
  options: LifecycleAuditOptions = {},
): LifecycleAuditReport {
  const nowMs = resolveNow(options.now, events);
  const providers = auditProviders(events, nowMs, stallAfter(options.providerStallAfterMs));
  const tools = auditTools(events, nowMs, stallAfter(options.toolStallAfterMs));
  const jobs = auditJobs(events, snapshot.jobs, nowMs, stallAfter(options.jobStallAfterMs));
  const items = [...providers, ...tools, ...jobs];
  const issues = items.flatMap(toIssues);
  return {
    schemaVersion: 1,
    asOf: new Date(nowMs).toISOString(),
    providers,
    tools,
    jobs,
    issues,
    counts: {
      stalled: items.filter((item) => item.stalled).length,
      recoveryRequired: items.filter((item) => item.recoveryRequired).length,
      orphan: items.filter((item) => item.orphan).length,
    },
  };
}

export function scanOrphanLifecycles(report: LifecycleAuditReport): LifecycleAuditItem[] {
  return [...report.providers, ...report.tools, ...report.jobs].filter((item) => item.orphan).map(cloneItem);
}

export function scanRecoveryRequiredLifecycles(report: LifecycleAuditReport): LifecycleAuditItem[] {
  return [...report.providers, ...report.tools, ...report.jobs].filter((item) => item.recoveryRequired).map(cloneItem);
}

function auditProviders(events: readonly HarnessEvent[], nowMs: number, threshold: number): LifecycleAuditItem[] {
  const states = new Map<string, MutableLifecycle>();
  for (const event of events) {
    if (!event.type.startsWith("provider_request_") && event.type !== "provider_recovery_required" && event.type !== "provider_response_received" && event.type !== "model_usage") continue;
    const key = stringValue(event.payload?.requestId) ?? stringValue(event.payload?.epochId);
    if (!key) continue;
    const state = states.get(key) ?? mutable("provider", key);
    state.eventIds.push(event.id);
    state.lastEventId = event.id;
    state.lastEventAt = eventTime(event);
    if (event.type === "provider_request_queued") {
      state.status = "QUEUED";
      state.started = true;
    }
    if (event.type === "provider_request_started" || event.type === "provider_request_slot_acquired") {
      state.status = "RUNNING";
      state.started = true;
    }
    if (event.type === "provider_request_stalled") {
      state.stalled = true;
      state.status = "STALLED";
      state.reason = stringValue(event.payload?.reason) ?? "provider stream stalled";
    }
    if (event.type === "provider_recovery_required") {
      state.recoveryRequired = true;
      state.status = "RECOVERY_REQUIRED";
      state.reason = stringValue(event.payload?.reason) ?? "provider recovery required";
    }
    if (event.type === "provider_request_queue_cancelled") state.status = "CANCELLED";
    if (event.type === "provider_response_received" && numberValue(event.payload?.status) >= 400) state.status = "FAILED";
    if (event.type === "model_usage") state.status = "SUCCEEDED";
    states.set(key, state);
  }
  return [...states.values()].map((state) => finalize(state, nowMs, threshold));
}

function auditTools(events: readonly HarnessEvent[], nowMs: number, threshold: number): LifecycleAuditItem[] {
  const states = new Map<string, MutableLifecycle>();
  for (const event of events) {
    if (event.type !== "tool_call_recorded" && event.type !== "tool_result_recorded") continue;
    const key = stringValue(event.payload?.toolCallId);
    if (!key) continue;
    const state = states.get(key) ?? mutable("tool", key);
    state.eventIds.push(event.id);
    state.lastEventId = event.id;
    state.lastEventAt = eventTime(event);
    if (event.type === "tool_call_recorded") {
      state.status = "RUNNING";
      state.started = true;
    } else {
      state.status = event.payload?.isError === true ? "FAILED" : "SUCCEEDED";
      state.terminal = true;
    }
    states.set(key, state);
  }
  return [...states.values()].map((state) => finalize(state, nowMs, threshold));
}

function auditJobs(events: readonly HarnessEvent[], jobs: RunSnapshot["jobs"], nowMs: number, threshold: number): LifecycleAuditItem[] {
  const eventIdsByJob = new Map<string, string[]>();
  for (const event of events) {
    const key = stringValue(event.payload?.jobId);
    if (!key) continue;
    const ids = eventIdsByJob.get(key) ?? [];
    ids.push(event.id);
    eventIdsByJob.set(key, ids);
  }
  const items = Object.values(jobs).map((job) => {
    const eventIds = eventIdsByJob.get(job.id) ?? [];
    const lastEvent = [...events].reverse().find((event) => eventIds.includes(event.id));
    const lastEventAt = job.heartbeatAt ? Date.parse(job.heartbeatAt) : job.startedAt ? Date.parse(job.startedAt) : lastEvent ? eventTime(lastEvent) : undefined;
    const state: MutableLifecycle = {
      owner: "job",
      key: job.id,
      status: job.status,
      eventIds,
      lastEventId: lastEvent?.id,
      lastEventAt: Number.isFinite(lastEventAt) ? lastEventAt : undefined,
      started: job.status !== "QUEUED" || eventIds.length > 0,
      terminal: isTerminalJob(job.status),
      stalled: false,
      recoveryRequired: job.status === "UNKNOWN",
      orphan: job.status === "QUEUED" && eventIds.length === 0,
      reason: job.error,
    };
    return finalize(state, nowMs, threshold, job);
  });
  const observed = new Set(Object.values(jobs).map((job) => job.id));
  for (const [jobId, eventIds] of eventIdsByJob) {
    if (observed.has(jobId)) continue;
    items.push({
      owner: "job", key: jobId, status: "ORPHAN", eventIds: [...eventIds], lastEventId: eventIds.at(-1), ageMs: 0,
      stalled: false, recoveryRequired: true, orphan: true, reason: "job events have no durable JobRecord",
    });
  }
  return items.sort(byKey);
}

interface MutableLifecycle {
  owner: LifecycleOwner;
  key: string;
  status: LifecycleAuditStatus;
  eventIds: string[];
  lastEventId?: string;
  lastEventAt?: number;
  started: boolean;
  terminal: boolean;
  stalled: boolean;
  recoveryRequired: boolean;
  orphan: boolean;
  reason?: string;
}

function mutable(owner: LifecycleOwner, key: string): MutableLifecycle {
  return { owner, key, status: "UNKNOWN", eventIds: [], started: false, terminal: false, stalled: false, recoveryRequired: false, orphan: false };
}

function finalize(state: MutableLifecycle, nowMs: number, threshold: number, job?: JobRecord): LifecycleAuditItem {
  const ageMs = state.lastEventAt === undefined ? 0 : Math.max(0, nowMs - state.lastEventAt);
  const active = !state.terminal && state.status !== "RECOVERY_REQUIRED";
  if (active && ageMs >= threshold) {
    state.stalled = true;
    if (state.status === "QUEUED" || state.status === "RUNNING" || state.status === "UNKNOWN") state.status = "STALLED";
    if (!state.reason) state.reason = `${state.owner} has not advanced for ${ageMs}ms`;
  }
  if (state.owner !== "job" && !state.started) state.orphan = true;
  if (state.owner === "job" && job && !state.terminal && state.status === "UNKNOWN") state.orphan = true;
  if (state.orphan && state.status !== "RECOVERY_REQUIRED") state.status = "ORPHAN";
  return {
    owner: state.owner,
    key: state.key,
    status: state.status,
    eventIds: [...state.eventIds],
    ...(state.lastEventId ? { lastEventId: state.lastEventId } : {}),
    ageMs,
    stalled: state.stalled,
    recoveryRequired: state.recoveryRequired,
    orphan: state.orphan,
    ...(state.reason ? { reason: state.reason } : {}),
  };
}

function toIssues(item: LifecycleAuditItem): LifecycleAuditIssue[] {
  const issues: LifecycleAuditIssue[] = [];
  if (item.stalled) issues.push({ code: "STALLED", owner: item.owner, key: item.key, reason: item.reason ?? "lifecycle stalled", eventIds: [...item.eventIds] });
  if (item.recoveryRequired) issues.push({ code: "RECOVERY_REQUIRED", owner: item.owner, key: item.key, reason: item.reason ?? "recovery required", eventIds: [...item.eventIds] });
  if (item.orphan) issues.push({ code: "ORPHAN", owner: item.owner, key: item.key, reason: item.reason ?? "lifecycle has no matching durable owner", eventIds: [...item.eventIds] });
  return issues;
}

function cloneItem(item: LifecycleAuditItem): LifecycleAuditItem {
  return { ...item, eventIds: [...item.eventIds] };
}

function resolveNow(value: LifecycleAuditOptions["now"], events: readonly HarnessEvent[]): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const latest = events.map(eventTime).filter(Number.isFinite).at(-1);
  return latest ?? Date.now();
}

function eventTime(event: HarnessEvent): number {
  const parsed = Date.parse(event.ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stallAfter(value: number | undefined): number {
  return value === undefined ? DEFAULT_STALL_AFTER_MS : Math.max(0, Math.floor(value));
}

function isTerminalJob(status: JobRecord["status"]): boolean {
  return status === "SUCCEEDED" || status === "FAILED" || status === "TIMED_OUT" || status === "CANCELLED";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function byKey(left: LifecycleAuditItem, right: LifecycleAuditItem): number {
  return left.owner.localeCompare(right.owner) || left.key.localeCompare(right.key);
}
