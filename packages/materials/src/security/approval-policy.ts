import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "@proofblade/atoms";
import { canonicalJson, id, sha256 } from "../domain/utils.js";

export type ProtectedOperation = "platform.submit" | "environment.start" | "network.request" | "session.open";
export type ApprovalStatus = "PENDING" | "GRANTED" | "DENIED" | "CONSUMED";

export interface ApprovalRequest {
  runId: string;
  operation: ProtectedOperation;
  resource?: string;
  reason: string;
  ttlMs?: number;
}

export interface ApprovalRecord {
  schemaVersion: 1;
  id: string;
  runId: string;
  operation: ProtectedOperation;
  resourceHash?: string;
  reason: string;
  status: ApprovalStatus;
  requestedAt: string;
  expiresAt: number;
  actor?: string;
  decidedAt?: string;
  consumedAt?: string;
}

export interface ApprovalPolicyInit {
  ledgerPath: string;
  now?: () => number;
  defaultTtlMs?: number;
}

interface ApprovalLedger {
  schemaVersion: 1;
  records: ApprovalRecord[];
}

export interface ApprovalDecision {
  allowed: boolean;
  approvalId?: string;
  reason?: string;
}

/**
 * Durable high-risk action approval ledger. The policy is deliberately
 * operation-oriented rather than tool-oriented: multiple tools that can reach
 * the same external effect share one approval boundary. Resource values are
 * hashed before persistence so flags, credentials, and URLs do not enter the
 * approval log in plaintext.
 */
export class ApprovalPolicy {
  private readonly ledgerPath: string;
  private readonly now: () => number;
  private readonly defaultTtlMs: number;
  private readonly recordsById = new Map<string, ApprovalRecord>();
  private queue: Promise<void> = Promise.resolve();

  public constructor(init: ApprovalPolicyInit) {
    this.ledgerPath = init.ledgerPath;
    this.now = init.now ?? Date.now;
    this.defaultTtlMs = clamp(init.defaultTtlMs ?? 15 * 60_000, 1_000, 24 * 60 * 60_000);
  }

  /** Return pending, non-expired approvals, optionally scoped to one Run. */
  public async pending(runId?: string): Promise<ApprovalRecord[]> {
    return await this.serial(async () => {
      await this.load();
      const now = this.now();
      return [...this.recordsById.values()]
        .filter((record) => record.status === "PENDING" && record.expiresAt > now && (runId === undefined || record.runId === runId))
        .map((record) => structuredClone(record));
    });
  }

  /** Request or reuse one approval for the same Run/effect/resource tuple. */
  public async request(input: ApprovalRequest): Promise<ApprovalRecord> {
    return await this.serial(async () => {
      await this.load();
      const resourceHash = input.resource === undefined ? undefined : sha256(input.resource);
      const now = this.now();
      const existing = [...this.recordsById.values()].find((record) => record.runId === input.runId
        && record.operation === input.operation
        && record.resourceHash === resourceHash
        && record.expiresAt > now);
      if (existing) return structuredClone(existing);
      const record: ApprovalRecord = {
        schemaVersion: 1,
        id: id("APR"),
        runId: input.runId,
        operation: input.operation,
        ...(resourceHash ? { resourceHash } : {}),
        reason: input.reason.slice(0, 512),
        status: "PENDING",
        requestedAt: new Date(now).toISOString(),
        expiresAt: now + clamp(input.ttlMs ?? this.defaultTtlMs, 1_000, 24 * 60 * 60_000),
      };
      this.recordsById.set(record.id, record);
      await this.persist();
      return structuredClone(record);
    });
  }

  public async grant(approvalId: string, actor = "operator"): Promise<ApprovalRecord> {
    return await this.decide(approvalId, "GRANTED", actor);
  }

  public async deny(approvalId: string, actor = "operator"): Promise<ApprovalRecord> {
    return await this.decide(approvalId, "DENIED", actor);
  }

  /** Consume a grant exactly once; repeated consumption is an idempotent replay. */
  public async consume(approvalId: string): Promise<ApprovalRecord> {
    return await this.serial(async () => {
      await this.load();
      const record = this.recordsById.get(approvalId);
      if (!record) throw new Error(`Unknown approval: ${approvalId}`);
      if (record.status === "CONSUMED") return structuredClone(record);
      if (record.status !== "GRANTED") throw new Error(`Approval ${approvalId} is ${record.status.toLowerCase()}, not granted`);
      if (record.expiresAt <= this.now()) throw new Error(`Approval ${approvalId} has expired`);
      record.status = "CONSUMED";
      record.consumedAt = new Date(this.now()).toISOString();
      await this.persist();
      return structuredClone(record);
    });
  }

  /**
   * Check an effect and create a pending approval when it has not been granted.
   * Callers should stop before the external side effect when `allowed=false`.
   */
  public async check(input: ApprovalRequest): Promise<ApprovalDecision> {
    const requested = await this.request(input);
    if (requested.status === "PENDING") return { allowed: false, approvalId: requested.id, reason: "Operator approval is required before this external effect." };
    if (requested.status === "DENIED") return { allowed: false, approvalId: requested.id, reason: "Operator denied this external effect." };
    if (requested.status === "CONSUMED") return { allowed: true, approvalId: requested.id };
    await this.consume(requested.id);
    return { allowed: true, approvalId: requested.id };
  }

  private async decide(approvalId: string, status: "GRANTED" | "DENIED", actor: string): Promise<ApprovalRecord> {
    return await this.serial(async () => {
      await this.load();
      const record = this.recordsById.get(approvalId);
      if (!record) throw new Error(`Unknown approval: ${approvalId}`);
      if (record.status === status) return structuredClone(record);
      if (record.status !== "PENDING") throw new Error(`Approval ${approvalId} is already ${record.status.toLowerCase()}`);
      if (record.expiresAt <= this.now()) throw new Error(`Approval ${approvalId} has expired`);
      record.status = status;
      record.actor = actor.trim().slice(0, 128) || "operator";
      record.decidedAt = new Date(this.now()).toISOString();
      await this.persist();
      return structuredClone(record);
    });
  }

  private async load(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.ledgerPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`Approval ledger is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isLedger(parsed)) throw new Error("Approval ledger has an unsupported schema");
    this.recordsById.clear();
    for (const record of parsed.records) this.recordsById.set(record.id, structuredClone(record));
  }

  private async persist(): Promise<void> {
    const now = this.now();
    const records = [...this.recordsById.values()]
      .filter((record) => record.status === "PENDING" ? record.expiresAt > now : true)
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
    this.recordsById.clear();
    for (const record of records) this.recordsById.set(record.id, record);
    await atomicWriteFile(this.ledgerPath, `${canonicalJson({ schemaVersion: 1, records })}\n`);
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(() => undefined, () => undefined);
    return await run;
  }
}

function isLedger(value: unknown): value is ApprovalLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.schemaVersion === 1 && Array.isArray(input.records) && input.records.every(isRecord);
}

function isRecord(value: unknown): value is ApprovalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.schemaVersion === 1
    && typeof input.id === "string"
    && typeof input.runId === "string"
    && (input.operation === "platform.submit" || input.operation === "environment.start" || input.operation === "network.request" || input.operation === "session.open")
    && typeof input.reason === "string"
    && (input.status === "PENDING" || input.status === "GRANTED" || input.status === "DENIED" || input.status === "CONSUMED")
    && typeof input.requestedAt === "string"
    && typeof input.expiresAt === "number"
    && (input.resourceHash === undefined || typeof input.resourceHash === "string")
    && (input.actor === undefined || typeof input.actor === "string")
    && (input.decidedAt === undefined || typeof input.decidedAt === "string")
    && (input.consumedAt === undefined || typeof input.consumedAt === "string");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(Number.isFinite(value) ? value : min)));
}
