import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile } from "@proofblade/atoms";
import { classifyCompetitionEnvironmentIdentity, type CompetitionApi, type CompetitionEnvironment, type CompetitionEnvironmentIdentityCapabilities, type CompetitionEnvironmentInspection } from "./api.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import type { ExternalResourceAdapter, ExternalResourceInspection, ExternalResourceRecord, ExternalResourceRegistry } from "../recovery/external-resource-registry.js";

const LEDGER_SCHEMA_VERSION = 2;
const RESERVATION_SCHEMA_VERSION = 2;

export type ManagedCompetitionEnvironmentStatus = "ACTIVE" | "STOPPED";

export interface ManagedCompetitionEnvironment {
  schemaVersion: 1;
  leaseId: string;
  ownerId: string;
  challengeId: string;
  instanceId?: string;
  idempotencyKey?: string;
  connectionInfo?: string;
  expiresAt?: number;
  registeredAt: string;
  status: ManagedCompetitionEnvironmentStatus;
  generation?: number;
  stoppedAt?: string;
  stopReason?: string;
  lastError?: string;
}

export interface CompetitionEnvironmentReservation {
  leaseId: string;
  ownerId: string;
  challengeId?: string;
  idempotencyKey?: string;
}

export interface CompetitionEnvironmentReservationOptions {
  challengeId?: string;
}

export interface CompetitionEnvironmentSweepResult {
  examined: number;
  stopped: number;
  failed: number;
  retained: number;
}

export interface CompetitionEnvironmentJanitorInit {
  api: Pick<CompetitionApi, "stopEnvironment" | "inspectEnvironment" | "environmentIdentity">;
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
  /**
   * Require an exact remote inspection before an automatic expiry sweep calls
   * the non-idempotent stop endpoint. Keep the legacy direct-stop behavior for
   * local callers that explicitly opt out; live platform composition enables
   * this fail-closed mode.
   */
  requireRemoteInspectionForSweep?: boolean;
  /** Allow legacy ledger-only recovery explicitly; default is fail-closed. */
  allowLedgerOnlyRecovery?: boolean;
  /** Optional common external-resource ledger shared with Run recovery. */
  externalResources?: ExternalResourceRegistry;
}

interface EnvironmentReservationRecord {
  schemaVersion: 1 | typeof RESERVATION_SCHEMA_VERSION;
  leaseId: string;
  ownerId: string;
  challengeId?: string;
  idempotencyKey?: string;
  state?: "RESERVED" | "STARTING";
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
  private readonly api: Pick<CompetitionApi, "stopEnvironment" | "inspectEnvironment">;
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  private readonly maxActive: number;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly historyLimit: number;
  private readonly reservationTtlMs: number;
  private readonly lockTimeoutMs: number;
  private readonly lockStaleMs: number;
  private readonly requireRemoteInspectionForSweep: boolean;
  public readonly allowLedgerOnlyRecovery: boolean;
  private readonly externalResources?: ExternalResourceRegistry;
  public readonly environmentIdentity?: CompetitionEnvironmentIdentityCapabilities;
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
    this.requireRemoteInspectionForSweep = init.requireRemoteInspectionForSweep ?? false;
    this.allowLedgerOnlyRecovery = init.allowLedgerOnlyRecovery ?? false;
    this.externalResources = init.externalResources;
    this.environmentIdentity = init.api.environmentIdentity;
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
   * Query the remote platform when it exposes an idempotent environment
   * inspection seam. An absent seam deliberately returns undefined so the
   * resource adapter can distinguish local ownership from remote proof.
   */
  public async inspectRemote(record: Pick<ManagedCompetitionEnvironment, "challengeId" | "instanceId" | "idempotencyKey">): Promise<CompetitionEnvironmentInspection | undefined> {
    if (!this.api.inspectEnvironment) return undefined;
    try {
      return await this.api.inspectEnvironment(record.challengeId, record.instanceId, { idempotencyKey: record.idempotencyKey });
    } catch (error) {
      return { status: "UNKNOWN", summary: `platform environment inspection failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Wait for a capacity slot before calling the platform's non-idempotent build
   * endpoint. The reservation is durable, so another process observes it too.
   */
  public async acquire(ownerId: string, signal?: AbortSignal): Promise<CompetitionEnvironmentReservation> {
    return await this.acquireInternal(ownerId, undefined, signal);
  }

  /** Acquire a reservation bound to one challenge and a stable remote key. */
  public async acquireForChallenge(ownerId: string, challengeId: string, signal?: AbortSignal): Promise<CompetitionEnvironmentReservation> {
    const normalizedChallenge = challengeId.trim();
    if (!normalizedChallenge) throw new Error("Environment reservation requires a non-empty challengeId");
    return await this.acquireInternal(ownerId, { challengeId: normalizedChallenge }, signal);
  }

  /** Mark that the non-idempotent platform start request is about to be sent. */
  public async markStarting(reservation: CompetitionEnvironmentReservation): Promise<void> {
    await this.serial(async () => await this.withLedgerLock(async () => {
      const current = this.reservationsById.get(reservation.leaseId);
      if (!current) throw new Error(`Unknown environment reservation: ${reservation.leaseId}`);
      if (current.ownerId !== reservation.ownerId || current.idempotencyKey !== reservation.idempotencyKey) throw new Error(`Environment reservation ${reservation.leaseId} binding mismatch`);
      current.state = "STARTING";
      await this.persist();
    }));
  }

  private async acquireInternal(ownerId: string, options: CompetitionEnvironmentReservationOptions | undefined, signal?: AbortSignal): Promise<CompetitionEnvironmentReservation> {
    const normalizedOwner = ownerId.trim();
    if (!normalizedOwner) throw new Error("Environment reservation requires a non-empty ownerId");
    const leaseId = id("ENV");
    const challengeId = options?.challengeId;
    const idempotencyKey = challengeId ? environmentIdempotencyKey(normalizedOwner, challengeId) : undefined;
    await this.sweepExpired();
    for (;;) {
      throwIfAborted(signal);
      const reserved = await this.serial(async () => await this.withLedgerLock(async () => {
        this.pruneExpiredReservations();
        if (challengeId) {
          const duplicateReservation = [...this.reservationsById.values()]
            .find((reservation) => reservation.ownerId === normalizedOwner && reservation.challengeId === challengeId);
          if (duplicateReservation) throw new Error(`Environment reservation already exists for owner ${normalizedOwner} and challenge ${challengeId}`);
          const activeEnvironment = [...this.recordsById.values()]
            .find((record) => record.status === "ACTIVE" && record.ownerId === normalizedOwner && record.challengeId === challengeId);
          if (activeEnvironment) throw new Error(`Active environment already exists for owner ${normalizedOwner} and challenge ${challengeId}`);
        }
        if (this.activeRecords().length + this.reservationsById.size >= this.maxActive) return false;
        const now = this.now();
        this.reservationsById.set(leaseId, {
          schemaVersion: RESERVATION_SCHEMA_VERSION,
          leaseId,
          ownerId: normalizedOwner,
          ...(challengeId ? { challengeId } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          state: "RESERVED",
          createdAt: new Date(now).toISOString(),
          expiresAt: now + this.reservationTtlMs,
        });
        await this.persist();
        return true;
      }));
      if (reserved) return { leaseId, ownerId: normalizedOwner, ...(challengeId ? { challengeId } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) };
      await wait(this.pollMs, signal);
    }
  }

  /**
   * Reconcile reservations whose process may have died after sending a start.
   * Only a remote ACTIVE response carrying the exact idempotency key is
   * promoted; every other result remains pending and is never guessed into a
   * new environment.
   */
  public async reconcilePending(): Promise<{ examined: number; adopted: number; unknown: number }> {
    const pending = await this.serial(async () => await this.withLedgerLock(async () => [...this.reservationsById.values()]
      .filter((reservation) => reservation.state === "STARTING" && reservation.challengeId && reservation.idempotencyKey)
      .map((reservation) => structuredClone(reservation))));
    let adopted = 0;
    let unknown = 0;
    for (const reservation of pending) {
      const inspection = await this.inspectRemote({ challengeId: reservation.challengeId!, idempotencyKey: reservation.idempotencyKey });
      if (!inspection || classifyCompetitionEnvironmentIdentity({ challengeId: reservation.challengeId!, idempotencyKey: reservation.idempotencyKey! }, inspection, this.environmentIdentity) !== "MATCH") {
        unknown += 1;
        continue;
      }
      const challengeId = reservation.challengeId;
      const idempotencyKey = reservation.idempotencyKey;
      if (!challengeId || !idempotencyKey) {
        unknown += 1;
        continue;
      }
      const environment: CompetitionEnvironment = {
        ...(inspection.instanceId ? { instanceId: inspection.instanceId } : {}),
        idempotencyKey,
        ...(inspection.connectionInfo ? { connectionInfo: inspection.connectionInfo } : {}),
        ...(inspection.expiresAt === undefined ? {} : { expiresAt: inspection.expiresAt }),
        ...(inspection.raw ? { raw: inspection.raw } : {}),
      };
      await this.register({ leaseId: reservation.leaseId, ownerId: reservation.ownerId, challengeId, idempotencyKey }, challengeId, environment);
      adopted += 1;
    }
    return { examined: pending.length, adopted, unknown };
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
      const pending = this.reservationsById.get(reservation.leaseId);
      if (!pending) throw new Error(`Unknown or already consumed environment reservation: ${reservation.leaseId}`);
      if (pending.ownerId !== reservation.ownerId) throw new Error(`Environment reservation ${reservation.leaseId} owner mismatch`);
      if (pending?.challengeId && pending.challengeId !== challengeId) throw new Error(`Environment reservation ${reservation.leaseId} is bound to challenge ${pending.challengeId}, not ${challengeId}`);
      if (pending.idempotencyKey && reservation.idempotencyKey && pending.idempotencyKey !== reservation.idempotencyKey) throw new Error(`Environment reservation ${reservation.leaseId} has an idempotency key mismatch`);
      this.reservationsById.delete(reservation.leaseId);
      const idempotencyKey = environment.idempotencyKey ?? pending.idempotencyKey ?? reservation.idempotencyKey;
      if (!environment.instanceId && !environment.connectionInfo && environment.expiresAt === undefined && !idempotencyKey) {
        await this.persist();
        return undefined;
      }
      const record: ManagedCompetitionEnvironment = {
        schemaVersion: 1,
        leaseId: reservation.leaseId,
        ownerId: pending.ownerId,
        challengeId,
        ...(environment.instanceId ? { instanceId: environment.instanceId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(environment.connectionInfo ? { connectionInfo: environment.connectionInfo } : {}),
        ...(environment.expiresAt === undefined ? {} : { expiresAt: environment.expiresAt }),
        registeredAt: new Date(this.now()).toISOString(),
        status: "ACTIVE",
      };
      this.recordsById.set(record.leaseId, record);
      await this.persist();
      if (this.externalResources) {
        const resourceId = platformResourceId(record.leaseId);
        await this.externalResources.register({ id: resourceId, kind: "platform-environment", runId: record.ownerId, generation: record.generation ?? 0, ownerLane: "executor", ...(record.instanceId ? { externalId: record.instanceId } : {}), ...(record.idempotencyKey ? { requestKey: record.idempotencyKey } : {}) });
        await this.externalResources.markStarted(resourceId, record.instanceId);
        await this.externalResources.markConfirmed(resourceId, "platform environment registered");
      }
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
      await this.externalResources?.markUnknown(platformResourceId(leaseId), error instanceof Error ? error.message : String(error)).catch(() => undefined);
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
    await this.externalResources?.markReleased(platformResourceId(leaseId), reason).catch(() => undefined);
    return true;
  }

  /**
   * Record that a remote query proved this environment is already absent.
   * This closes the local capacity lease without issuing a second stop request.
   */
  public async markRemoteAbsent(leaseId: string, reason = "remote platform query confirmed absence"): Promise<boolean> {
    return await this.serial(async () => await this.withLedgerLock(async () => {
      const current = this.recordsById.get(leaseId);
      if (!current || current.status === "STOPPED") return true;
      current.status = "STOPPED";
      current.stoppedAt = new Date(this.now()).toISOString();
      current.stopReason = reason.slice(0, 512);
      delete current.lastError;
      await this.persist();
      return true;
    }));
  }

  /** Stop all records whose platform expiry has passed. */
  public async sweepExpired(now = this.now()): Promise<CompetitionEnvironmentSweepResult> {
    await this.reconcilePending();
    const due = await this.serial(async () => await this.withLedgerLock(async () => {
      const reservationsChanged = this.pruneExpiredReservations(now);
      const expired = [...this.recordsById.values()]
        .filter((record) => record.status === "ACTIVE" && (record.lastError !== undefined || (record.expiresAt !== undefined && record.expiresAt <= now)))
        .map((record) => structuredClone(record));
      if (reservationsChanged) await this.persist();
      return expired;
    }));
    let stopped = 0;
    let failed = 0;
    for (const record of due) {
      if (this.requireRemoteInspectionForSweep) {
        const inspection = await this.inspectRemote(record);
        if (inspection?.status === "ABSENT") {
          if (await this.markRemoteAbsent(record.leaseId, "remote query confirmed expired environment is absent")) stopped += 1;
          else failed += 1;
          continue;
        }
        if (!remoteMatchesManaged(record, inspection, this.environmentIdentity)) {
          await this.recordSweepFailure(record.leaseId, inspection?.summary ?? "remote query could not confirm the exact environment");
          failed += 1;
          continue;
        }
      }
      if (await this.release(record.leaseId, "expired lease sweep")) stopped += 1;
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
      for (const reservation of parsed.reservations) this.reservationsById.set(reservation.leaseId, normalizeReservation(reservation));
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
      reservations: [...this.reservationsById.values()].map((reservation) => ({ ...reservation, schemaVersion: RESERVATION_SCHEMA_VERSION })),
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

  private async recordSweepFailure(leaseId: string, reason: string): Promise<void> {
    await this.serial(async () => await this.withLedgerLock(async () => {
      const current = this.recordsById.get(leaseId);
      if (!current || current.status === "STOPPED") return;
      current.lastError = reason.slice(0, 512);
      await this.persist();
    }));
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
        // Windows may report EPERM while another janitor is removing the
        // directory lock. Treat it as contention just like EEXIST; the
        // bounded retry below still surfaces a real permission problem.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "EPERM") throw error;
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

/**
 * Adapter used by Run recovery for platform environments. A matching ACTIVE
 * janitor record is necessary; when the platform exposes inspectEnvironment,
 * the remote ACTIVE challenge/instance must also match. Platforms without the
 * optional query seam retain the conservative ledger-only adopt behavior and
 * never guess an orphan into a release.
 */
export class CompetitionEnvironmentResourceAdapter implements ExternalResourceAdapter {
  public readonly kind = "platform-environment" as const;

  public constructor(private readonly janitor: CompetitionEnvironmentJanitor) {}

  public async inspect(record: ExternalResourceRecord): Promise<ExternalResourceInspection> {
    const leaseId = leaseIdFromResource(record.id);
    if (!leaseId) return { status: "UNKNOWN", binding: "UNKNOWN", summary: "invalid platform resource id" };
    const managed = (await this.janitor.records()).find((item) => item.leaseId === leaseId);
    if (!managed || managed.status === "STOPPED") return { status: "ABSENT", binding: "UNKNOWN", summary: "platform environment is no longer active" };
    if (managed.ownerId !== record.runId || (record.externalId !== undefined && managed.instanceId !== record.externalId)) {
      return { status: "PRESENT", binding: "MISMATCH", externalId: managed.instanceId, summary: "platform environment ownership does not match the Run" };
    }
    const remote = await this.janitor.inspectRemote(managed);
    if (!remote && !this.janitor.allowLedgerOnlyRecovery) {
      return { status: "UNKNOWN", binding: "UNKNOWN", externalId: managed.instanceId, summary: "platform has no remote identity query; ledger-only recovery is disabled" };
    }
    if (remote) {
      if (remote.status === "ABSENT") return { status: "ABSENT", binding: "UNKNOWN", summary: remote.summary ?? "platform query confirmed the environment is absent" };
      if (remote.status !== "ACTIVE") return { status: "UNKNOWN", binding: "UNKNOWN", summary: remote.summary ?? "platform query could not confirm the environment" };
      const identity = classifyCompetitionEnvironmentIdentity(managed, remote, this.janitor.environmentIdentity);
      if (identity === "MISMATCH") return { status: "PRESENT", binding: "MISMATCH", externalId: remote.instanceId, summary: "platform query returned a different environment identity" };
      if (identity !== "MATCH") return { status: "UNKNOWN", binding: "UNKNOWN", summary: "platform query did not prove the recorded stable environment identity" };
    }
    return { status: "PRESENT", binding: "MATCH", externalId: managed.instanceId, summary: "janitor ledger confirms platform ownership" };
  }

  public async adopt(_record: ExternalResourceRecord, inspection: ExternalResourceInspection): Promise<{ state: "CONFIRMED" | "UNKNOWN"; summary?: string }> {
    return inspection.status === "PRESENT" && inspection.binding === "MATCH"
      ? { state: "CONFIRMED", summary: inspection.summary }
      : { state: "UNKNOWN", summary: inspection.summary ?? "platform ownership is ambiguous" };
  }

  public async release(record: ExternalResourceRecord, reason: string): Promise<{ released: boolean; summary?: string }> {
    const leaseId = leaseIdFromResource(record.id);
    if (!leaseId) return { released: false, summary: "invalid platform resource id" };
    const inspection = await this.inspect(record);
    if (inspection.status === "ABSENT") {
      await this.janitor.markRemoteAbsent(leaseId, inspection.summary ?? "platform environment is already absent");
      return { released: true, summary: inspection.summary ?? "platform environment is already absent" };
    }
    if (inspection.status !== "PRESENT" || inspection.binding !== "MATCH") return { released: false, summary: inspection.summary ?? "platform environment ownership is ambiguous" };
    const released = await this.janitor.release(leaseId, reason);
    return released ? { released: true, summary: "platform environment released" } : { released: false, summary: "platform stop did not confirm release" };
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
  return (input.schemaVersion === 1 || input.schemaVersion === RESERVATION_SCHEMA_VERSION)
    && typeof input.leaseId === "string"
    && typeof input.ownerId === "string"
    && (input.challengeId === undefined || typeof input.challengeId === "string")
    && (input.idempotencyKey === undefined || typeof input.idempotencyKey === "string")
    && (input.state === undefined || input.state === "RESERVED" || input.state === "STARTING")
    && typeof input.createdAt === "string"
    && typeof input.expiresAt === "number";
}

function normalizeReservation(value: EnvironmentReservationRecord): EnvironmentReservationRecord {
  return {
    ...structuredClone(value),
    schemaVersion: RESERVATION_SCHEMA_VERSION,
    state: value.state ?? "RESERVED",
  };
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
    && (input.generation === undefined || (Number.isInteger(input.generation) && (input.generation as number) >= 0))
    && (input.instanceId === undefined || typeof input.instanceId === "string")
    && (input.idempotencyKey === undefined || typeof input.idempotencyKey === "string")
    && (input.connectionInfo === undefined || typeof input.connectionInfo === "string")
    && (input.expiresAt === undefined || typeof input.expiresAt === "number")
    && (input.stoppedAt === undefined || typeof input.stoppedAt === "string")
    && (input.stopReason === undefined || typeof input.stopReason === "string")
    && (input.lastError === undefined || typeof input.lastError === "string");
}

function platformResourceId(leaseId: string): string {
  return `platform:${leaseId}`;
}

function leaseIdFromResource(resourceId: string): string | undefined {
  const prefix = "platform:";
  return resourceId.startsWith(prefix) && resourceId.length > prefix.length ? resourceId.slice(prefix.length) : undefined;
}

function environmentIdempotencyKey(ownerId: string, challengeId: string): string {
  return `proofblade-env-${sha256(canonicalJson({ ownerId, challengeId })).slice(0, 48)}`;
}

function remoteMatchesManaged(
  managed: Pick<ManagedCompetitionEnvironment, "challengeId" | "instanceId" | "idempotencyKey">,
  inspection: CompetitionEnvironmentInspection | undefined,
  capabilities?: CompetitionEnvironmentIdentityCapabilities,
): boolean {
  return inspection !== undefined && classifyCompetitionEnvironmentIdentity(managed, inspection, capabilities) === "MATCH";
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
