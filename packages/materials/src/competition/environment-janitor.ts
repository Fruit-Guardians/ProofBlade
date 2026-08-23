import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile } from "@proofblade/atoms";
import type { CompetitionApi, CompetitionEnvironment } from "./api.js";
import { id } from "../domain/utils.js";

const LEDGER_SCHEMA_VERSION = 2;
const RESERVATION_SCHEMA_VERSION = 1;

export type ManagedCompetitionEnvironmentStatus = "ACTIVE" | "STOPPED";

export interface ManagedCompetitionEnvironment {
  schemaVersion: 1;
  leaseId: string;
  ownerId: string;
  challengeId: string;
  instanceId?: string;
  expiresAt?: number;
  registeredAt: string;
  status: ManagedCompetitionEnvironmentStatus;
  stoppedAt?: string;
  stopReason?: string;
  lastError?: string;
}

export interface CompetitionEnvironmentReservation {
  leaseId: string;
  ownerId: string;
}

export interface CompetitionEnvironmentSweepResult {
  examined: number;
  stopped: number;
  failed: number;
  retained: number;
}

export interface CompetitionEnvironmentJanitorInit {
  api: Pick<CompetitionApi, "stopEnvironment">;
  /** Small durable ledger. It is deliberately outside the challenge workspace. */
  ledgerPath: string;
  /** Maximum number of live platform environments owned by this process/ledger. */
  maxActive?: number;
  /** Injectable clock for deterministic expiry tests. */
  now?: () => number;
  /** Poll interval while waiting for a capacity slot or ledger lock. */
  pollMs?: number;
  /** Number of stopped records retained for audit/recovery inspection. */
  historyLimit?: number;
  /** Maximum time a pre-start reservation can hold capacity after a crash. */
  reservationTtlMs?: number;
  /** Maximum time to wait for another process to release the ledger lock. */
  lockTimeoutMs?: number;
  /** A lock older than this is considered abandoned and may be reclaimed. */
  lockStaleMs?: number;
}

interface EnvironmentReservationRecord {
  schemaVersion: typeof RESERVATION_SCHEMA_VERSION;
  leaseId: string;
  ownerId: string;
  createdAt: string;
  expiresAt: number;
}

interface EnvironmentLedgerFile {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  reservations: EnvironmentReservationRecord[];
  records: ManagedCompetitionEnvironment[];
}

interface LegacyEnvironmentLedgerFile {
  schemaVersion: 1;
  records: ManagedCompetitionEnvironment[];
}

/**
 * Durable environment lifecycle guard for the competition Fleet.
 *
 * The platform API exposes a stop operation but does not provide a reliable
 * list-environments endpoint. This ledger therefore records every environment
 * ProofBlade starts, bounds concurrent live instances, and lets a fresh process
 * sweep expired records without trusting an in-memory worker map. Reservations
 * are persisted before `startEnvironment()` so separate Fleet processes cannot
 * race past the configured platform capacity. The ledger is upgraded from the
 * original schema-1 records on the next mutation and all writes use an atomic
 * temp-file rename.
 */
export class CompetitionEnvironmentJanitor {
  private readonly api: Pick<CompetitionApi, "stopEnvironment">;
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  private readonly maxActive: number;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly historyLimit: number;
  private readonly reservationTtlMs: number;
  private readonly lockTimeoutMs: number;
  private readonly lockStaleMs: number;
  private readonly reservationsById = new Map<string, EnvironmentReservationRecord>();
  private readonly stopping = new Set<string>();
  private readonly recordsById = new Map<string, ManagedCompetitionEnvironment>();
  private queue: Promise<void> = Promise.resolve();

  public constructor(init: CompetitionEnvironmentJanitorInit) {
    this.api = init.api;
    this.ledgerPath = init.ledgerPath;
    this.lockPath = `${init.ledgerPath}.lock`;
    this.maxActive = clamp(init.maxActive ?? 8, 1, 128);
    this.now = init.now ?? Date.now;
    this.pollMs = clamp(init.pollMs ?? 250, 10, 5_000);
    this.historyLimit = clamp(init.historyLimit ?? 512, 16, 10_000);
    this.reservationTtlMs = clamp(init.reservationTtlMs ?? 30_000, 1_000, 3_600_000);
    this.lockTimeoutMs = clamp(init.lockTimeoutMs ?? 5_000, 100, 120_000);
    this.lockStaleMs = clamp(init.lockStaleMs ?? 30_000, this.pollMs, 3_600_000);
  }

  /** Load the durable ledger and return the currently active records. */
  public async active(): Promise<ManagedCompetitionEnvironment[]> {
    return await this.serial(async () => {
      await this.loadLedger();
      return this.activeRecords();
    });
  }

  /** Return all retained records, including stopped records for audit. */
  public async records(): Promise<ManagedCompetitionEnvironment[]> {
    return await this.serial(async () => {
      await this.loadLedger();
      return [...this.recordsById.values()].map((record) => structuredClone(record));
    });
  }

  /**
   * Wait for a capacity slot before calling the platform's non-idempotent build
   * endpoint. The reservation is durable, so another process observes it too.
   */
  public async acquire(ownerId: string, signal?: AbortSignal): Promise<CompetitionEnvironmentReservation> {
    const normalizedOwner = ownerId.trim();
    if (!normalizedOwner) throw new Error("Environment reservation requires a non-empty ownerId");
    const leaseId = id("ENV");
    await this.sweepExpired();
    for (;;) {
      throwIfAborted(signal);
      const reserved = await this.serial(async () => await this.withLedgerLock(async () => {
        this.pruneExpiredReservations();
        if (this.activeRecords().length + this.reservationsById.size >= this.maxActive) return false;
        const now = this.now();
        this.reservationsById.set(leaseId, {
          schemaVersion: RESERVATION_SCHEMA_VERSION,
          leaseId,
          ownerId: normalizedOwner,
          createdAt: new Date(now).toISOString(),
          expiresAt: now + this.reservationTtlMs,
        });
        await this.persist();
        return true;
      }));
      if (reserved) return { leaseId, ownerId: normalizedOwner };
      await wait(this.pollMs, signal);
    }
  }

  /** Release a pre-start reservation after an API failure or cancellation. */
  public async releaseReservation(reservation: CompetitionEnvironmentReservation): Promise<void> {
    await this.serial(async () => await this.withLedgerLock(async () => {
      if (this.reservationsById.delete(reservation.leaseId)) await this.persist();
    }));
  }

  /**
   * Convert a reservation into a durable live environment record. Static
   * challenges without any connection/expiry/instance handle do not consume a
   * cleanup record, but the reservation is still released durably.
   */
  public async register(
    reservation: CompetitionEnvironmentReservation,
    challengeId: string,
    environment: CompetitionEnvironment,
  ): Promise<ManagedCompetitionEnvironment | undefined> {
    return await this.serial(async () => await this.withLedgerLock(async () => {
      if (!this.reservationsById.delete(reservation.leaseId)) throw new Error(`Unknown or already consumed environment reservation: ${reservation.leaseId}`);
      if (!environment.instanceId && !environment.connectionInfo && environment.expiresAt === undefined) {
        await this.persist();
        return undefined;
      }
      const record: ManagedCompetitionEnvironment = {
        schemaVersion: 1,
        leaseId: reservation.leaseId,
        ownerId: reservation.ownerId,
        challengeId,
        ...(environment.instanceId ? { instanceId: environment.instanceId } : {}),
        ...(environment.expiresAt === undefined ? {} : { expiresAt: environment.expiresAt }),
        registeredAt: new Date(this.now()).toISOString(),
        status: "ACTIVE",
      };
      this.recordsById.set(record.leaseId, record);
      await this.persist();
      return structuredClone(record);
    }));
  }

  /**
   * Stop one managed environment. A failed stop stays ACTIVE with the error so
   * a later sweep/reconcile can retry it instead of silently losing the lease.
   */
  public async release(leaseId: string, reason = "released"): Promise<boolean> {
    const record = await this.serial(async () => await this.withLedgerLock(async () => {
      const current = this.recordsById.get(leaseId);
      if (!current || current.status === "STOPPED") return undefined;
      if (this.stopping.has(leaseId)) return null;
      this.stopping.add(leaseId);
      return structuredClone(current);
    }));
    if (record === undefined) return true;
    if (record === null) return false;
    try {
      await this.api.stopEnvironment(record.challengeId, record.instanceId);
    } catch (error) {
      await this.serial(async () => await this.withLedgerLock(async () => {
        this.stopping.delete(leaseId);
        const current = this.recordsById.get(leaseId);
        if (!current || current.status === "STOPPED") return;
        current.lastError = error instanceof Error ? error.message : String(error);
        await this.persist();
      }));
      return false;
    }
    await this.serial(async () => await this.withLedgerLock(async () => {
      this.stopping.delete(leaseId);
      const current = this.recordsById.get(leaseId);
      if (!current || current.status === "STOPPED") return;
      current.status = "STOPPED";
      current.stoppedAt = new Date(this.now()).toISOString();
      current.stopReason = reason.slice(0, 512);
      delete current.lastError;
      await this.persist();
    }));
    return true;
  }

  /** Stop all records whose platform expiry has passed. */
  public async sweepExpired(now = this.now()): Promise<CompetitionEnvironmentSweepResult> {
    const due = await this.serial(async () => await this.withLedgerLock(async () => {
      const reservationsChanged = this.pruneExpiredReservations(now);
      const expired = [...this.recordsById.values()]
        .filter((record) => record.status === "ACTIVE" && record.expiresAt !== undefined && record.expiresAt <= now)
        .map((record) => record.leaseId);
      if (reservationsChanged) await this.persist();
      return expired;
    }));
    let stopped = 0;
    let failed = 0;
    for (const leaseId of due) {
      if (await this.release(leaseId, "expired lease sweep")) stopped += 1;
      else failed += 1;
    }
    const retained = (await this.active()).length;
    return { examined: due.length, stopped, failed, retained };
  }

  private activeRecords(): ManagedCompetitionEnvironment[] {
    return [...this.recordsById.values()]
      .filter((record) => record.status === "ACTIVE")
      .map((record) => structuredClone(record));
  }

  private async loadLedger(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.ledgerPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.recordsById.clear();
        this.reservationsById.clear();
        return;
      }
      throw new Error(`Competition environment ledger is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.recordsById.clear();
    this.reservationsById.clear();
    if (isLedger(parsed)) {
      for (const record of parsed.records) this.recordsById.set(record.leaseId, structuredClone(record));
      for (const reservation of parsed.reservations) this.reservationsById.set(reservation.leaseId, structuredClone(reservation));
      return;
    }
    if (isLegacyLedger(parsed)) {
      for (const record of parsed.records) this.recordsById.set(record.leaseId, structuredClone(record));
      return;
    }
    throw new Error("Competition environment ledger has an unsupported schema");
  }

  private async persist(): Promise<void> {
    const stopped = [...this.recordsById.values()]
      .filter((record) => record.status === "STOPPED")
      .sort((a, b) => Date.parse(b.stoppedAt ?? b.registeredAt) - Date.parse(a.stoppedAt ?? a.registeredAt));
    const active = [...this.recordsById.values()].filter((record) => record.status === "ACTIVE");
    const retained = [...active, ...stopped.slice(0, this.historyLimit)];
    this.recordsById.clear();
    for (const record of retained) this.recordsById.set(record.leaseId, record);
    await atomicWriteFile(this.ledgerPath, `${JSON.stringify({
      schemaVersion: LEDGER_SCHEMA_VERSION,
      reservations: [...this.reservationsById.values()],
      records: retained,
    }, null, 2)}\n`);
  }

  private pruneExpiredReservations(now = this.now()): boolean {
    let removed = false;
    for (const [leaseId, reservation] of this.reservationsById) {
      if (reservation.expiresAt <= now) {
        this.reservationsById.delete(leaseId);
        removed = true;
      }
    }
    return removed;
  }

  private async withLedgerLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquireLedgerLock();
    try {
      await this.loadLedger();
      return await operation();
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }

  private async acquireLedgerLock(): Promise<void> {
    const deadline = Date.now() + this.lockTimeoutMs;
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    for (;;) {
      try {
        await mkdir(this.lockPath);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const details = await stat(this.lockPath);
          if (Date.now() - details.mtimeMs > this.lockStaleMs) await rm(this.lockPath, { recursive: true, force: true });
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for competition environment ledger lock: ${this.lockPath}`);
        await wait(this.pollMs);
      }
    }
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(() => undefined, () => undefined);
    return await run;
  }
}

function isLedger(value: unknown): value is EnvironmentLedgerFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.schemaVersion === LEDGER_SCHEMA_VERSION
    && Array.isArray(input.records)
    && input.records.every(isRecord)
    && Array.isArray(input.reservations)
    && input.reservations.every(isReservation);
}

function isLegacyLedger(value: unknown): value is LegacyEnvironmentLedgerFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.schemaVersion === 1 && Array.isArray(input.records) && input.records.every(isRecord);
}

function isReservation(value: unknown): value is EnvironmentReservationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.schemaVersion === RESERVATION_SCHEMA_VERSION
    && typeof input.leaseId === "string"
    && typeof input.ownerId === "string"
    && typeof input.createdAt === "string"
    && typeof input.expiresAt === "number";
}

function isRecord(value: unknown): value is ManagedCompetitionEnvironment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.schemaVersion === 1
    && typeof input.leaseId === "string"
    && typeof input.ownerId === "string"
    && typeof input.challengeId === "string"
    && typeof input.registeredAt === "string"
    && (input.status === "ACTIVE" || input.status === "STOPPED")
    && (input.instanceId === undefined || typeof input.instanceId === "string")
    && (input.expiresAt === undefined || typeof input.expiresAt === "number")
    && (input.stoppedAt === undefined || typeof input.stoppedAt === "string")
    && (input.stopReason === undefined || typeof input.stopReason === "string")
    && (input.lastError === undefined || typeof input.lastError === "string");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(Number.isFinite(value) ? value : min)));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Environment capacity wait aborted");
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Environment capacity wait aborted"));
    };
    const done = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
