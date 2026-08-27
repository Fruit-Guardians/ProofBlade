import { readFile } from "node:fs/promises";
import { atomicWriteFile, KeyedOperationQueue, withFileLock, type FileLockOptions } from "@proofblade/atoms";
import { canonicalJson } from "../domain/utils.js";
import type { ExternalResourceInspection, ExternalResourceRecord } from "./external-resource-registry.js";
import {
  type SessionRuntimeActionService,
  type SessionRuntimeCreateRequest,
  type SessionRuntimeCreateService,
  type SessionRuntimeCreateWireResponse,
  normalizeSessionRuntimeCreateRequest,
  type SessionRuntimeHealthCapabilities,
  type SessionRuntimeHealthService,
  type SessionRuntimeHealthStatus,
  type SessionRuntimeHealthWireResponse,
  type SessionRuntimeHeartbeatService,
  type SessionRuntimeHeartbeatWireResponse,
  type SessionRuntimeWireResource,
  type SessionRuntimeBrokerService,
} from "./session-runtime-wire.js";

const LEDGER_SCHEMA_VERSION = 1 as const;
const MAX_RECORDS = 2_048;
const MAX_SUMMARY_LENGTH = 512;
const DEFAULT_LEASE_MS = 120_000;

export interface SessionRuntimeCreatedSession {
  readonly sessionId: string;
  readonly externalId: string;
  readonly stateHash: string;
}

export type SessionRuntimeHostPresence = "PRESENT" | "ABSENT" | "UNKNOWN";

export interface SessionRuntimeHostInspection {
  readonly status: SessionRuntimeHostPresence;
  readonly externalId?: string;
  readonly summary?: string;
}

/** Real host port. The service never invents a replacement session. */
export interface SessionRuntimeHost {
  create(request: SessionRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<SessionRuntimeCreatedSession>;
  inspect(externalId: string, request: SessionRuntimeCreateRequest, signal?: AbortSignal): Promise<SessionRuntimeHostInspection>;
  adopt(externalId: string, request: SessionRuntimeCreateRequest, signal?: AbortSignal): Promise<boolean>;
  release(externalId: string, request: SessionRuntimeCreateRequest, reason: string, signal?: AbortSignal): Promise<boolean>;
  actions?: SessionRuntimeActionService;
  /** Refresh a host lease for the exact immutable create request kind. */
  heartbeat?(externalId: string, signal?: AbortSignal, request?: SessionRuntimeCreateRequest): Promise<void>;
  inspectByIdempotency?(request: SessionRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<{ status: SessionRuntimeHostPresence; created?: SessionRuntimeCreatedSession }>;
  health?(signal?: AbortSignal): Promise<{ status: SessionRuntimeHealthStatus; capabilities: SessionRuntimeHealthCapabilities; summary?: string }>;
}

export interface DurableSessionRuntimeServiceOptions {
  readonly leaseMs?: number;
  readonly lock?: FileLockOptions;
  readonly now?: () => number;
}

/**
 * Result of a bounded startup scan of durable session reservations. `pending`
 * means the host could not prove the reservation either way; it must remain
 * retryable and must never be replaced by a new host session.
 */
export interface SessionRuntimeReconcileReport {
  readonly recovered: readonly string[];
  readonly unknown: readonly string[];
  readonly pending: readonly string[];
}

interface DurableSessionRuntimeRecord {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  idempotencyKey: string;
  request: SessionRuntimeCreateRequest;
  state: "STARTING" | "ACTIVE" | "UNKNOWN" | "RELEASED";
  sessionId?: string;
  externalId?: string;
  stateHash?: string;
  createdAt: string;
  updatedAt: string;
  leaseExpiresAt?: string;
  lastSummary?: string;
}

interface DurableSessionRuntimeLedger {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  records: DurableSessionRuntimeRecord[];
}

/**
 * Durable service-side identity and idempotency manager for Pwn/HTTP hosts.
 * The host owns sockets/processes; this class owns only bounded metadata,
 * immutable binding checks and crash recovery reservations.
 */
export class DurableSessionRuntimeService implements SessionRuntimeBrokerService, SessionRuntimeCreateService, SessionRuntimeHealthService, SessionRuntimeHeartbeatService {
  public readonly actionService: SessionRuntimeActionService;
  private readonly lockPath: string;
  private readonly lock: FileLockOptions;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly queue = new KeyedOperationQueue();

  public constructor(
    private readonly ledgerPath: string,
    private readonly host: SessionRuntimeHost,
    options: DurableSessionRuntimeServiceOptions = {},
  ) {
    if (!ledgerPath.trim()) throw new Error("Session runtime service requires a ledger path");
    if (!host || typeof host.create !== "function" || typeof host.inspect !== "function" || typeof host.adopt !== "function" || typeof host.release !== "function") throw new Error("Session runtime service requires a complete host");
    this.lockPath = `${ledgerPath}.lock`;
    this.lock = options.lock ?? {};
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isInteger(this.leaseMs) || this.leaseMs < 1_000 || this.leaseMs > 86_400_000) throw new Error("Session runtime service leaseMs must be between 1000 and 86400000");
    this.now = options.now ?? Date.now;
    this.actionService = {
      pwnWrite: async (resource, data, readOptions, signal) => await this.withActive(resource, "pwn-session", signal, (actions) => actions.pwnWrite(resource, data, readOptions, signal)),
      pwnRead: async (resource, readOptions, signal) => await this.withActive(resource, "pwn-session", signal, (actions) => actions.pwnRead(resource, readOptions, signal)),
      pwnSignal: async (resource, signalName, signal) => await this.withActive(resource, "pwn-session", signal, (actions) => actions.pwnSignal(resource, signalName, signal)),
      pwnClose: async (resource, signal) => await this.withActive(resource, "pwn-session", signal, (actions) => actions.pwnClose(resource, signal)),
      httpRequest: async (resource, request, signal) => await this.withActive(resource, "http-session", signal, (actions) => actions.httpRequest(resource, request, signal)),
    };
  }

  public async create(request: SessionRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<Pick<SessionRuntimeCreateWireResponse, "state" | "sessionId" | "externalId" | "stateHash" | "summary">> {
    assertCreateRequest(request);
    assertHash(idempotencyKey, "idempotencyKey");
    return await this.queue.run(`create:${idempotencyKey}`, async () => {
      const reservation = await this.reserve(request, idempotencyKey);
      if (!reservation.created) {
        assertSameRequest(reservation.record.request, request);
        if (reservation.record.state === "ACTIVE" && isComplete(reservation.record) && isLeaseActive(reservation.record, this.now())) {
          await this.touch(reservation.record.idempotencyKey);
          return responseFromRecord(reservation.record, "EXISTING");
        }
        if (reservation.record.state === "RELEASED") return { state: "UNKNOWN", summary: "Session create key was already released" };
        const recovered = await this.reconcileStarting(reservation.record, signal);
        return recovered ? responseFromRecord(recovered, "EXISTING") : { state: "UNKNOWN", summary: "Session create is awaiting exact host reconciliation" };
      }
      try {
        const created = await this.host.create(request, idempotencyKey, signal);
        assertCreated(created);
        await this.mutate((ledger) => {
          const record = findByKey(ledger, idempotencyKey);
          if (!record) throw new Error("Session create reservation disappeared");
          record.state = "ACTIVE";
          record.sessionId = created.sessionId;
          record.externalId = created.externalId;
          record.stateHash = created.stateHash;
          record.leaseExpiresAt = this.leaseTimestamp();
          record.updatedAt = this.timestamp();
        });
        return responseFromCreated(created, "CREATED");
      } catch (error) {
        await this.mutate((ledger) => {
          const record = findByKey(ledger, idempotencyKey);
          if (!record) return;
          record.state = "UNKNOWN";
          record.lastSummary = boundedSummary(error instanceof Error ? error.message : String(error));
          record.updatedAt = this.timestamp();
        }).catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * Reconcile interrupted create reservations after a service restart. The
   * scan is deliberately read-only with respect to the host: only an exact
   * idempotency lookup that returns a complete created identity can promote a
   * STARTING record to ACTIVE. Missing or ambiguous remote state stays UNKNOWN
   * (or pending when the host cannot answer), so a retry cannot create a second
   * session by guesswork.
   */
  public async reconcile(signal?: AbortSignal): Promise<SessionRuntimeReconcileReport> {
    const ledger = await this.readLedger();
    const report: { recovered: string[]; unknown: string[]; pending: string[] } = { recovered: [], unknown: [], pending: [] };
    for (const record of ledger.records.filter((candidate) => candidate.state === "STARTING")) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Session runtime reconciliation aborted");
      const result = await this.queue.run(`create:${record.idempotencyKey}`, async () => await this.reconcileReservation(record, signal));
      if (result === "recovered") report.recovered.push(record.idempotencyKey);
      else if (result === "unknown") report.unknown.push(record.idempotencyKey);
      else report.pending.push(record.idempotencyKey);
    }
    return report;
  }

  public async inspect(resource: SessionRuntimeWireResource, signal?: AbortSignal): Promise<ExternalResourceInspection> {
    const record = await this.findByExternalId(resource.externalId);
    if (!record) return { status: "UNKNOWN", binding: "UNKNOWN", externalId: resource.externalId, summary: "Session runtime has no durable record for this handle" };
    if (!sameResourceBinding(record, resource)) return { status: "PRESENT", binding: "MISMATCH", externalId: record.externalId, summary: "Session runtime resource binding does not match the durable create request" };
    if (record.state !== "ACTIVE" || !isComplete(record) || !isLeaseActive(record, this.now())) return { status: "UNKNOWN", binding: "UNKNOWN", externalId: record.externalId, summary: "Session runtime lease is not active" };
    const inspected = await this.host.inspect(record.externalId, record.request, signal);
    if (inspected.status === "PRESENT" && inspected.externalId !== undefined && inspected.externalId !== record.externalId) return { status: "PRESENT", binding: "MISMATCH", externalId: inspected.externalId, summary: "Session host returned a different opaque handle" };
    return inspected.status === "PRESENT"
      ? { status: "PRESENT", binding: "MATCH", externalId: record.externalId, ...(inspected.summary ? { summary: boundedSummary(inspected.summary) } : {}) }
      : { status: inspected.status, binding: "UNKNOWN", externalId: record.externalId, ...(inspected.summary ? { summary: boundedSummary(inspected.summary) } : {}) };
  }

  public async adopt(resource: SessionRuntimeWireResource, signal?: AbortSignal): Promise<{ state: "CONFIRMED" | "UNKNOWN"; externalId?: string; summary?: string }> {
    const record = await this.findByExternalId(resource.externalId);
    if (!record || !sameResourceBinding(record, resource) || record.state !== "ACTIVE" || !isComplete(record) || !isLeaseActive(record, this.now())) return { state: "UNKNOWN", summary: "Session runtime cannot adopt an unbound or expired session" };
    const adopted = await this.host.adopt(record.externalId, record.request, signal);
    return adopted ? { state: "CONFIRMED", externalId: record.externalId } : { state: "UNKNOWN", summary: "Session host did not confirm adoption" };
  }

  public async release(resource: SessionRuntimeWireResource, reason: string, signal?: AbortSignal): Promise<{ released: boolean; summary?: string }> {
    const record = await this.findByExternalId(resource.externalId);
    if (!record || !sameResourceBinding(record, resource) || !isComplete(record)) return { released: false, summary: "Session runtime release binding is ambiguous" };
    const inspected = await this.host.inspect(record.externalId, record.request, signal);
    if (inspected.status === "ABSENT") {
      await this.markReleased(record.idempotencyKey, reason);
      return { released: true, summary: "Session was already absent" };
    }
    if (inspected.status !== "PRESENT" || record.state !== "ACTIVE") return { released: false, summary: "Session release remains UNKNOWN" };
    const released = await this.host.release(record.externalId, record.request, boundedSummary(reason), signal);
    if (!released) return { released: false, summary: "Session host did not confirm release" };
    await this.markReleased(record.idempotencyKey, reason);
    return { released: true, summary: `Session released: ${boundedSummary(reason)}` };
  }

  /** Refresh a durable lease only after the exact immutable binding matches. */
  public async heartbeat(resource: SessionRuntimeWireResource, signal?: AbortSignal): Promise<Pick<SessionRuntimeHeartbeatWireResponse, "state" | "externalId" | "expiresAt" | "summary">> {
    const record = await this.findByExternalId(resource.externalId);
    if (!record || !sameResourceBinding(record, resource) || record.state !== "ACTIVE" || !isLeaseActive(record, this.now())) throw new Error("Session runtime heartbeat binding is not active");
    if (this.host.heartbeat) {
      await this.host.heartbeat(resource.externalId, signal, record.request);
    } else {
      const inspected = await this.host.inspect(resource.externalId, record.request, signal);
      if (inspected.status !== "PRESENT" || (inspected.externalId !== undefined && inspected.externalId !== resource.externalId)) throw new Error("Session runtime heartbeat could not confirm the exact host resource");
    }
    const expiresAt = this.leaseTimestamp();
    await this.mutate((ledger) => {
      const current = findByKey(ledger, record.idempotencyKey);
      if (!current || current.state !== "ACTIVE") throw new Error("Session runtime heartbeat record is no longer active");
      current.leaseExpiresAt = expiresAt;
      current.updatedAt = this.timestamp();
    });
    return { state: "CONFIRMED", externalId: resource.externalId, expiresAt };
  }

  public async health(signal?: AbortSignal): Promise<Pick<SessionRuntimeHealthWireResponse, "status" | "capabilities" | "summary">> {
    if (!this.host.health) return { status: "DEGRADED", capabilities: defaultCapabilities(false), summary: "Session runtime host does not expose a health probe" };
    const result = await this.host.health(signal);
    const capabilities = validateCapabilities(result.capabilities);
    if (result.status !== "READY") return { status: result.status, capabilities, ...(result.summary ? { summary: boundedSummary(result.summary) } : {}) };
    const missingActions = missingActionKinds(this.host.actions, capabilities.kinds);
    if (missingActions.length > 0) {
      return {
        status: "DEGRADED",
        capabilities: { ...capabilities, stableAcrossRestart: false },
        summary: `Session runtime host does not expose actions for ${missingActions.join(", ")}`,
      };
    }
    if (capabilities.stableAcrossRestart && !this.host.inspectByIdempotency) {
      return {
        status: "DEGRADED",
        capabilities: { ...capabilities, stableAcrossRestart: false },
        summary: "Session runtime host cannot reconcile an interrupted create by idempotency key",
      };
    }
    return { status: result.status, capabilities, ...(result.summary ? { summary: boundedSummary(result.summary) } : {}) };
  }

  private async withActive<T>(resource: SessionRuntimeWireResource, kind: "pwn-session" | "http-session", signal: AbortSignal | undefined, operation: (actions: SessionRuntimeActionService) => Promise<T>): Promise<T> {
    if (resource.kind !== kind) throw new Error(`Session runtime action ${kind} cannot use ${resource.kind}`);
    const record = await this.findByExternalId(resource.externalId);
    if (!record || !sameResourceBinding(record, resource) || record.state !== "ACTIVE" || !isLeaseActive(record, this.now())) throw new Error("Session runtime action binding is not active");
    if (!this.host.actions) throw new Error("Session runtime host does not expose action capabilities");
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Session runtime action aborted");
    return await operation(this.host.actions);
  }

  private async reconcileStarting(record: DurableSessionRuntimeRecord, signal?: AbortSignal): Promise<DurableSessionRuntimeRecord | undefined> {
    if (!this.host.inspectByIdempotency) return undefined;
    const result = await this.host.inspectByIdempotency(record.request, record.idempotencyKey, signal);
    if (result.status !== "PRESENT" || !result.created) return undefined;
    return await this.promoteStarting(record, result.created);
  }

  private async promoteStarting(record: DurableSessionRuntimeRecord, created: SessionRuntimeCreatedSession): Promise<DurableSessionRuntimeRecord | undefined> {
    assertCreated(created);
    let usable = false;
    await this.mutate((ledger) => {
      const current = findByKey(ledger, record.idempotencyKey);
      if (!current) throw new Error("Session create reservation disappeared during reconciliation");
      assertSameRequest(current.request, record.request);
      if (current.state === "ACTIVE") {
        if (!isComplete(current) || current.sessionId !== created.sessionId || current.externalId !== created.externalId || current.stateHash !== created.stateHash) throw new Error("Session create reconciliation returned a different active identity");
        usable = true;
        return;
      }
      // A concurrent release is terminal. Never resurrect it from a stale host
      // lookup that started before the release committed.
      if (current.state !== "STARTING" && current.state !== "UNKNOWN") return;
      current.state = "ACTIVE";
      current.sessionId = created.sessionId;
      current.externalId = created.externalId;
      current.stateHash = created.stateHash;
      current.leaseExpiresAt = this.leaseTimestamp();
      current.updatedAt = this.timestamp();
      usable = true;
    });
    return usable ? await this.findByKey(record.idempotencyKey) : undefined;
  }

  private async reconcileReservation(record: DurableSessionRuntimeRecord, signal?: AbortSignal): Promise<"recovered" | "unknown" | "pending"> {
    if (!this.host.inspectByIdempotency) return "pending";
    try {
      const result = await this.host.inspectByIdempotency(record.request, record.idempotencyKey, signal);
      if (result.status === "PRESENT" && result.created) {
        return await this.promoteStarting(record, result.created) ? "recovered" : "pending";
      }
      if (result.status === "ABSENT") {
        await this.mutate((ledger) => {
          const current = findByKey(ledger, record.idempotencyKey);
          if (!current || current.state !== "STARTING") return;
          current.state = "UNKNOWN";
          current.lastSummary = "Session host reported no exact resource for the interrupted create";
          current.updatedAt = this.timestamp();
        });
        return "unknown";
      }
      return "pending";
    } catch {
      return "pending";
    }
  }

  private async reserve(request: SessionRuntimeCreateRequest, idempotencyKey: string): Promise<{ created: true } | { created: false; record: DurableSessionRuntimeRecord }> {
    let result: { created: true } | { created: false; record: DurableSessionRuntimeRecord } = { created: true };
    await withFileLock(this.lockPath, async () => {
      let ledger = await this.readLedgerUnlocked();
      const existing = findByKey(ledger, idempotencyKey);
      if (existing) {
        result = { created: false, record: structuredClone(existing) };
        return;
      }
      if (ledger.records.length >= MAX_RECORDS) throw new Error("Session runtime service ledger is full");
      const timestamp = this.timestamp();
      ledger.records.push({ schemaVersion: LEDGER_SCHEMA_VERSION, idempotencyKey, request: structuredClone(request), state: "STARTING", createdAt: timestamp, updatedAt: timestamp, leaseExpiresAt: this.leaseTimestamp() });
      await this.writeLedgerUnlocked(ledger);
    }, this.lock);
    return result;
  }

  private async findByKey(idempotencyKey: string): Promise<DurableSessionRuntimeRecord | undefined> {
    const ledger = await this.readLedger();
    const record = findByKey(ledger, idempotencyKey);
    return record ? structuredClone(record) : undefined;
  }

  private async findByExternalId(externalId: string): Promise<DurableSessionRuntimeRecord | undefined> {
    const ledger = await this.readLedger();
    const record = ledger.records.find((candidate) => candidate.externalId === externalId);
    return record ? structuredClone(record) : undefined;
  }

  private async markReleased(idempotencyKey: string, reason: string): Promise<void> {
    await this.mutate((ledger) => {
      const record = findByKey(ledger, idempotencyKey);
      if (!record) return;
      record.state = "RELEASED";
      record.leaseExpiresAt = undefined;
      record.lastSummary = boundedSummary(reason);
      record.updatedAt = this.timestamp();
    });
  }

  private async readLedger(): Promise<DurableSessionRuntimeLedger> {
    return await withFileLock(this.lockPath, async () => await this.readLedgerUnlocked(), this.lock);
  }

  private async readLedgerUnlocked(): Promise<DurableSessionRuntimeLedger> {
    try {
      return parseLedger(JSON.parse(await readFile(this.ledgerPath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: LEDGER_SCHEMA_VERSION, records: [] };
      if (error instanceof SyntaxError) throw new Error("Session runtime service ledger is malformed JSON");
      throw error;
    }
  }

  private async mutate(operation: (ledger: DurableSessionRuntimeLedger) => void): Promise<void> {
    await withFileLock(this.lockPath, async () => {
      const ledger = await this.readLedgerUnlocked();
      operation(ledger);
      await this.writeLedgerUnlocked(ledger);
    }, this.lock);
  }

  private async writeLedgerUnlocked(ledger: DurableSessionRuntimeLedger): Promise<void> {
    await atomicWriteFile(this.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  }

  private timestamp(): string { return new Date(this.now()).toISOString(); }

  private leaseTimestamp(): string { return new Date(this.now() + this.leaseMs).toISOString(); }

  private async touch(idempotencyKey: string): Promise<void> {
    await this.mutate((ledger) => {
      const record = findByKey(ledger, idempotencyKey);
      if (record?.state === "ACTIVE") {
        record.leaseExpiresAt = this.leaseTimestamp();
        record.updatedAt = this.timestamp();
      }
    });
  }
}

function parseLedger(value: unknown): DurableSessionRuntimeLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Session runtime service ledger must be an object");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== LEDGER_SCHEMA_VERSION || !Array.isArray(input.records) || input.records.length > MAX_RECORDS) throw new Error("Session runtime service ledger has an unsupported schema or size");
  return { schemaVersion: LEDGER_SCHEMA_VERSION, records: input.records.map(parseRecord) };
}

function parseRecord(value: unknown): DurableSessionRuntimeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Session runtime service ledger record is invalid");
  const input = value as Record<string, unknown>;
  if (!isHash(input.idempotencyKey) || !["STARTING", "ACTIVE", "UNKNOWN", "RELEASED"].includes(input.state as string) || typeof input.createdAt !== "string" || typeof input.updatedAt !== "string") throw new Error("Session runtime service ledger record is invalid");
  const request = parseCreateRequest(input.request);
  const record = structuredClone(input) as unknown as DurableSessionRuntimeRecord;
  if (record.state === "ACTIVE" && (!isSafeText(record.sessionId) || !isSafeText(record.externalId) || !isHash(record.stateHash))) throw new Error("Session runtime active record is incomplete");
  if (
    (record.sessionId !== undefined && !isSafeText(record.sessionId))
    || (record.externalId !== undefined && !isSafeText(record.externalId))
    || (record.stateHash !== undefined && !isHash(record.stateHash))
    || (record.leaseExpiresAt !== undefined && (!isSafeText(record.leaseExpiresAt, 64) || !Number.isFinite(Date.parse(record.leaseExpiresAt))))
    || (record.lastSummary !== undefined && !isSafeText(record.lastSummary))
  ) throw new Error("Session runtime ledger identity is invalid");
  return { ...record, request };
}

function parseCreateRequest(value: unknown): SessionRuntimeCreateRequest {
  return normalizeSessionRuntimeCreateRequest(value);
}

function assertCreateRequest(request: SessionRuntimeCreateRequest): void { parseCreateRequest(request); }
function assertSameRequest(left: SessionRuntimeCreateRequest, right: SessionRuntimeCreateRequest): void { if (canonicalJson(left) !== canonicalJson(right)) throw new Error("Session create idempotency key is bound to a different immutable request"); }
function assertCreated(created: SessionRuntimeCreatedSession): void { if (!isSafeText(created.sessionId) || !isSafeText(created.externalId) || !isHash(created.stateHash)) throw new Error("Session host returned an invalid created session"); }
function assertHash(value: unknown, label: string): asserts value is string { if (!isHash(value)) throw new Error(`Session runtime ${label} must be a sha256 hex value`); }
function isComplete(record: DurableSessionRuntimeRecord): record is DurableSessionRuntimeRecord & Required<Pick<DurableSessionRuntimeRecord, "sessionId" | "externalId" | "stateHash">> { return Boolean(record.sessionId && record.externalId && record.stateHash); }
function isLeaseActive(record: DurableSessionRuntimeRecord, now: number): boolean { return record.leaseExpiresAt === undefined || Date.parse(record.leaseExpiresAt) > now; }
function responseFromRecord(record: DurableSessionRuntimeRecord, state: "CREATED" | "EXISTING"): Pick<SessionRuntimeCreateWireResponse, "state" | "sessionId" | "externalId" | "stateHash"> { if (!isComplete(record)) throw new Error("Session runtime record has no complete create identity"); return { state, sessionId: record.sessionId, externalId: record.externalId, stateHash: record.stateHash }; }
function responseFromCreated(created: SessionRuntimeCreatedSession, state: "CREATED" | "EXISTING"): Pick<SessionRuntimeCreateWireResponse, "state" | "sessionId" | "externalId" | "stateHash"> { return { state, sessionId: created.sessionId, externalId: created.externalId, stateHash: created.stateHash }; }
function findByKey(ledger: DurableSessionRuntimeLedger, key: string): DurableSessionRuntimeRecord | undefined { return ledger.records.find((record) => record.idempotencyKey === key); }
function sameResourceBinding(record: DurableSessionRuntimeRecord, resource: SessionRuntimeWireResource): boolean { return isComplete(record) && resource.id === `session:${record.sessionId}` && record.externalId === resource.externalId && record.request.kind === resource.kind && record.request.runId === resource.runId && record.request.generation === resource.generation && record.request.ownerLane === resource.ownerLane && record.request.requestKey === resource.requestKey && record.request.policyHash === resource.policyHash && record.request.recipeHash === resource.recipeHash && record.request.scopeHash === resource.scopeHash; }
function isOwnerLane(value: unknown): value is ExternalResourceRecord["ownerLane"] { return value === "main" || value === "planner" || value === "executor" || value === "verifier" || value === "system"; }
function isHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }
function isSafeText(value: unknown, maxLength = 512): value is string { return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value); }
function boundedSummary(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_SUMMARY_LENGTH); }
function defaultCapabilities(stableAcrossRestart: boolean): SessionRuntimeHealthCapabilities { return { kinds: ["pwn-session", "http-session"], maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576, stableAcrossRestart }; }
function validateCapabilities(value: SessionRuntimeHealthCapabilities): SessionRuntimeHealthCapabilities { if (!value || !Array.isArray(value.kinds) || value.kinds.length === 0 || value.kinds.some((kind) => kind !== "pwn-session" && kind !== "http-session") || new Set(value.kinds).size !== value.kinds.length || !Number.isSafeInteger(value.maxRequestBytes) || value.maxRequestBytes < 1 || value.maxRequestBytes > 4 * 1_048_576 || !Number.isSafeInteger(value.maxResponseBytes) || value.maxResponseBytes < 1 || value.maxResponseBytes > 8 * 1_048_576 || typeof value.stableAcrossRestart !== "boolean") throw new Error("Session runtime host returned invalid capabilities"); return { kinds: [...value.kinds], maxRequestBytes: value.maxRequestBytes, maxResponseBytes: value.maxResponseBytes, stableAcrossRestart: value.stableAcrossRestart }; }
function missingActionKinds(actions: SessionRuntimeActionService | undefined, kinds: readonly SessionRuntimeHealthCapabilities["kinds"][number][]): string[] {
  const missing: string[] = [];
  if (kinds.includes("pwn-session") && (!actions || !actions.pwnWrite || !actions.pwnRead || !actions.pwnSignal || !actions.pwnClose)) missing.push("pwn-session");
  if (kinds.includes("http-session") && (!actions || !actions.httpRequest)) missing.push("http-session");
  return missing;
}
