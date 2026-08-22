import type { HarnessEvent } from "../domain/types.js";
import type { ControlStore } from "./control-store.js";
import { ApprovalPolicy, type ApprovalRecord } from "../security/approval-policy.js";

export type AppServerMethod = "run/read" | "run/events" | "run/approvals" | "run/approve";

export interface AppServerRequest {
  method: AppServerMethod;
  params: Record<string, unknown>;
}

export interface AppServerResponse {
  method: AppServerMethod;
  result: unknown;
}

export interface RunEventsPage {
  runId: string;
  data: HarnessEvent[];
  nextCursor?: string;
}

export interface AppServerSubscriptionOptions {
  afterSeq?: number;
  pollMs?: number;
}

export type AppServerEventSubscriber = (events: HarnessEvent[]) => void | Promise<void>;

/**
 * Stable Run-facing application boundary for GUI, CLI, and future remote
 * clients. It exposes snapshots/events/approvals without exposing ControlStore
 * mutation primitives, so clients cannot bypass the reducer or the approval
 * ledger. Event subscriptions are polling-backed on purpose: JSONL remains the
 * source of truth and a restart simply resumes from the last cursor.
 */
export class ProofBladeAppServer {
  private readonly control: ControlStore;
  private readonly approvals: ApprovalPolicy;

  public constructor(init: { control: ControlStore; approvals: ApprovalPolicy }) {
    this.control = init.control;
    this.approvals = init.approvals;
  }

  public async request(request: AppServerRequest): Promise<AppServerResponse> {
    switch (request.method) {
      case "run/read": {
        const runId = requiredString(request.params.runId, "runId");
        return { method: request.method, result: await this.control.snapshot(runId) };
      }
      case "run/events": {
        const runId = requiredString(request.params.runId, "runId");
        const afterSeq = integerParam(request.params.afterSeq, "afterSeq", 0);
        const limit = integerParam(request.params.limit, "limit", 1, 1_000) || 1_000;
        const events = (await this.control.events(runId)).filter((event) => event.seq > afterSeq);
        const page = events.slice(0, limit);
        const nextCursor = page.length === limit && events.length > limit ? String(page.at(-1)!.seq) : undefined;
        const result: RunEventsPage = { runId, data: page, ...(nextCursor ? { nextCursor } : {}) };
        return { method: request.method, result };
      }
      case "run/approvals": {
        const runId = optionalString(request.params.runId);
        return { method: request.method, result: { data: await this.approvals.pending(runId) } };
      }
      case "run/approve": {
        const approvalId = requiredString(request.params.approvalId, "approvalId");
        const actor = optionalString(request.params.actor) ?? "operator";
        const decision = request.params.decision;
        const record = decision === "grant"
          ? await this.approvals.grant(approvalId, actor)
          : decision === "deny"
            ? await this.approvals.deny(approvalId, actor)
            : (() => { throw new Error("decision must be grant or deny"); })();
        return { method: request.method, result: record };
      }
    }
  }

  /**
   * Subscribe to append-only Run events. The callback receives only events
   * after the cursor; it is safe to call `unsubscribe` from inside the callback.
   */
  public subscribe(runId: string, subscriber: AppServerEventSubscriber, options: AppServerSubscriptionOptions = {}): () => void {
    let cursor = options.afterSeq ?? 0;
    let active = true;
    let running = false;
    const pollMs = clamp(options.pollMs ?? 250, 25, 10_000);
    const poll = async (): Promise<void> => {
      if (!active || running) return;
      running = true;
      try {
        const events = (await this.control.events(runId)).filter((event) => event.seq > cursor);
        if (events.length > 0) {
          cursor = events.at(-1)!.seq;
          await subscriber(events);
        }
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => { void poll(); }, pollMs);
    void poll();
    return () => {
      active = false;
      clearInterval(timer);
    };
  }

  public approvalPolicy(): ApprovalPolicy {
    return this.approvals;
  }
}

export function appServerApproval(record: ApprovalRecord): { approvalId: string; status: ApprovalRecord["status"] } {
  return { approvalId: record.id, status: record.status };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integerParam(value: unknown, field: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${field} must be an integer between ${min} and ${max}`);
  return Number(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(Number.isFinite(value) ? value : min)));
}
