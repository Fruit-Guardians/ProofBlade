import { readFile } from "node:fs/promises";
import { atomicWriteFile, KeyedOperationQueue, withFileLock, type FileLockOptions } from "@proofblade/atoms";
import { canonicalJson, sha256 } from "../domain/utils.js";
import {
  BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
  type BrowserRuntimeCapabilities,
  type BrowserRuntimeBrokerService,
  type BrowserRuntimeCreateRequest,
  type BrowserRuntimeCreateService,
  type BrowserRuntimeCreateWireResponse,
  type BrowserRuntimeHealthService,
  type BrowserRuntimeHealthStatus,
  type BrowserRuntimeHeartbeatService,
  type BrowserRuntimeWireResource,
  parseBrowserRuntimeCreateRequest,
} from "./browser-runtime-broker.js";
import {
  BrowserRuntimeContextActionService,
  type BrowserRuntimeActionService,
} from "./browser-runtime-actions.js";
import type { BrowserContextPort } from "./browser-session.js";
import { externalResourceBindingTransactionId, type ExternalResourceInspection } from "../recovery/external-resource-registry.js";

const LEDGER_SCHEMA_VERSION = 1 as const;
const MAX_RECORDS = 2_048;
const DEFAULT_LEASE_MS = 60_000;

export interface BrowserRuntimeCreatedContext {
  readonly sessionId: string;
  readonly externalId: string;
  readonly initialUrl: string;
  readonly stateHash: string;
  /** Optional current-process context; persistent services may resolve later. */
  readonly context?: BrowserContextPort;
}

export type BrowserRuntimePresence = "PRESENT" | "ABSENT" | "UNKNOWN";

export interface BrowserRuntimeReconcileReport {
  readonly recovered: readonly string[];
  readonly unknown: readonly string[];
  readonly pending: readonly string[];
}

export interface BrowserRuntimeHost {
  /** Start one context for an idempotency key. */
  create(request: BrowserRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<BrowserRuntimeCreatedContext>;
  /** Query exact create state after a service/process interruption. */
  inspectByIdempotency?(request: BrowserRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<{ status: BrowserRuntimePresence; created?: BrowserRuntimeCreatedContext }>;
  inspect(externalId: string, signal?: AbortSignal): Promise<BrowserRuntimePresence>;
  /** Reconnect an exact handle; request is optional for legacy process-local hosts. */
  adopt(externalId: string, signal?: AbortSignal, request?: BrowserRuntimeCreateRequest): Promise<boolean>;
  resolve(externalId: string, signal?: AbortSignal): Promise<BrowserContextPort | undefined>;
  release(externalId: string, reason: string, signal?: AbortSignal): Promise<boolean>;
  heartbeat?(externalId: string, signal?: AbortSignal): Promise<void>;
  /** Probe the real driver and declare only capabilities it can enforce. */
  health?(signal?: AbortSignal): Promise<{ status: BrowserRuntimeHealthStatus; capabilities: BrowserRuntimeCapabilities; summary?: string }>;
}

export interface DurableBrowserRuntimeServiceOptions {
  readonly leaseMs?: number;
  readonly lock?: FileLockOptions;
  readonly now?: () => number;
}

interface DurableBrowserRuntimeRecord {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  idempotencyKey: string;
  request: BrowserRuntimeCreateRequest;
  state: "STARTING" | "ACTIVE" | "UNKNOWN" | "RELEASED";
  sessionId?: string;
  externalId?: string;
  initialUrl?: string;
  stateHash?: string;
  createdAt: string;
  updatedAt: string;
  leaseExpiresAt?: string;
  /** Marker proving the Control Store owner handoff reached the broker. */
  bindingTxnId?: string;
  controlSessionId?: string;
  lastSummary?: string;
}

interface DurableBrowserRuntimeLedger {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  records: DurableBrowserRuntimeRecord[];
}

/**
 * Durable service-side identity and lease manager for a real browser host.
 *
 * The host owns Playwright (or another browser driver); this class owns only
 * redacted metadata, idempotency reservations, immutable binding checks and
 * the current-process resolver. A STARTING reservation is persisted before
 * host.create runs, so a second process never guesses by creating a context.
 */
export class DurableBrowserRuntimeService implements BrowserRuntimeBrokerService, BrowserRuntimeCreateService, BrowserRuntimeHealthService, BrowserRuntimeHeartbeatService {
  public readonly actionService: BrowserRuntimeActionService;
  private readonly lockPath: string;
  private readonly lock: FileLockOptions;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly queue = new KeyedOperationQueue();
  private readonly contexts = new Map<string, BrowserContextPort>();

  public constructor(
    private readonly ledgerPath: string,
    private readonly host: BrowserRuntimeHost,
    options: DurableBrowserRuntimeServiceOptions = {},
  ) {
    if (!ledgerPath.trim()) throw new Error("Browser runtime service requires a ledger path");
    if (!host || typeof host.create !== "function" || typeof host.inspect !== "function" || typeof host.adopt !== "function" || typeof host.resolve !== "function" || typeof host.release !== "function") throw new Error("Browser runtime service requires a complete host");
    this.lockPath = `${ledgerPath}.lock`;
    this.lock = options.lock ?? {};
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isInteger(this.leaseMs) || this.leaseMs < 1_000 || this.leaseMs > 86_400_000) throw new Error("Browser runtime service leaseMs must be between 1000 and 86400000");
    this.now = options.now ?? Date.now;
    this.actionService = new BrowserRuntimeContextActionService(async (resource, signal) => await this.resolveContext(resource, signal));
  }

  public async create(request: BrowserRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<Pick<BrowserRuntimeCreateWireResponse, "state" | "sessionId" | "externalId" | "initialUrl" | "stateHash" | "summary">> {
    return await this.queue.run(`create:${idempotencyKey}`, async () => {
      const reservation = await this.reserve(request, idempotencyKey);
      if (!reservation.created) {
        const existing = reservation.record;
        assertSameRequest(existing.request, request);
        if (existing.state === "ACTIVE" && isComplete(existing) && isLeaseActive(existing, this.now())) {
          await this.touch(existing.idempotencyKey);
          return responseFromRecord(existing, "EXISTING");
        }
        if (existing.state === "RELEASED") return { state: "UNKNOWN", summary: "Browser create key was already released" };
        const recovered = await this.reconcileStarting(existing, signal);
        if (recovered) return responseFromRecord(recovered, "EXISTING");
        return { state: "UNKNOWN", summary: "Browser create is awaiting exact host reconciliation" };
      }
      try {
        const created = await this.host.create(request, idempotencyKey, signal);
        assertCreatedContext(created, request);
        await this.mutate((ledger) => {
          const record = findByKey(ledger, idempotencyKey);
          if (!record) throw new Error("Browser create reservation disappeared");
          record.state = "ACTIVE";
          record.sessionId = created.sessionId;
          record.externalId = created.externalId;
          record.initialUrl = created.initialUrl;
          record.stateHash = created.stateHash;
          record.leaseExpiresAt = this.leaseTimestamp();
          record.updatedAt = this.timestamp();
        });
        if (created.context) this.contexts.set(created.externalId, created.context);
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
   * Reconcile interrupted create reservations after a service restart. Only an
   * exact idempotency lookup that returns a complete identity can promote a
   * STARTING record; absent or ambiguous host state remains UNKNOWN/PENDING.
   */
  public async reconcile(signal?: AbortSignal): Promise<BrowserRuntimeReconcileReport> {
    const ledger = await this.readLedger();
    const report: { recovered: string[]; unknown: string[]; pending: string[] } = { recovered: [], unknown: [], pending: [] };
    for (const record of ledger.records.filter((candidate) => candidate.state === "STARTING")) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Browser runtime reconciliation aborted");
      const result = await this.queue.run(`create:${record.idempotencyKey}`, async () => await this.reconcileReservation(record, signal));
      if (result === "recovered") report.recovered.push(record.idempotencyKey);
      else if (result === "unknown") report.unknown.push(record.idempotencyKey);
      else report.pending.push(record.idempotencyKey);
    }
    return report;
  }

  public async inspect(resource: BrowserRuntimeWireResource, signal?: AbortSignal): Promise<ExternalResourceInspection> {
    const record = await this.findByExternalId(resource.externalId);
    if (!record) return { status: "UNKNOWN", binding: "UNKNOWN", externalId: resource.externalId, summary: "Browser runtime has no durable record for this handle" };
    if (!sameResourceBinding(record, resource)) return { status: "PRESENT", binding: "MISMATCH", externalId: record.externalId, summary: "Browser runtime resource binding does not match the durable create request" };
    if (record.state !== "ACTIVE" || !isLeaseActive(record, this.now()) || !record.externalId) return { status: "UNKNOWN", binding: "UNKNOWN", externalId: record.externalId, summary: "Browser runtime lease is not active" };
    const status = await this.host.inspect(record.externalId, signal);
    return status === "PRESENT"
      ? { status, binding: "MATCH", externalId: record.externalId }
      : { status, binding: "UNKNOWN", externalId: record.externalId, summary: `Browser host presence is ${status}` };
  }

  public async adopt(resource: BrowserRuntimeWireResource, signal?: AbortSignal): Promise<{ state: "CONFIRMED" | "UNKNOWN"; externalId?: string; summary?: string }> {
    const record = await this.findByExternalId(resource.externalId);
    if (!record || !sameResourceBinding(record, resource) || record.state !== "ACTIVE" || !isLeaseActive(record, this.now())) return { state: "UNKNOWN", summary: "Browser runtime cannot adopt an unbound or expired context" };
    const adopted = await this.host.adopt(resource.externalId, signal, record.request);
    if (!adopted) return { state: "UNKNOWN", summary: "Browser host did not confirm adoption" };
    if (resource.bindingTxnId) {
      const bound = await this.bind(resource, signal);
      if (bound.state !== "BOUND") return { state: "UNKNOWN", summary: bound.summary ?? "Browser runtime could not persist the binding marker" };
    }
    return { state: "CONFIRMED", externalId: resource.externalId };
  }

  /** Persist the exact Control Store handoff marker in the service ledger. */
  public async bind(resource: BrowserRuntimeWireResource, _signal?: AbortSignal): Promise<{ state: "BOUND" | "UNKNOWN"; externalId?: string; summary?: string }> {
    const record = await this.findByExternalId(resource.externalId);
    if (!record || !sameResourceBinding(record, resource) || record.state !== "ACTIVE" || !isLeaseActive(record, this.now())) return { state: "UNKNOWN", summary: "Browser runtime cannot bind an unknown or expired context" };
    if (!resource.bindingTxnId || !isHash(resource.bindingTxnId)) return { state: "UNKNOWN", summary: "Browser runtime binding marker is missing" };
    const expected = externalResourceBindingTransactionId({
      id: resource.id,
      kind: "browser-context",
      runId: resource.runId,
      generation: resource.generation,
      ownerLane: resource.ownerLane,
      effectId: resource.effectId,
      requestKey: resource.requestKey,
      policyHash: resource.policyHash,
      recipeHash: resource.recipeHash,
      scopeHash: resource.scopeHash,
    });
    if (expected !== resource.bindingTxnId) return { state: "UNKNOWN", summary: "Browser runtime binding marker does not match the immutable resource" };
    const controlSessionId = resource.id.startsWith("session:") ? resource.id.slice("session:".length) : "";
    if (!controlSessionId || controlSessionId !== record.sessionId) return { state: "UNKNOWN", summary: "Browser runtime binding marker has no exact Control Store session" };
    await this.mutate((ledger) => {
      const current = findByExternalId(ledger, resource.externalId);
      if (!current || current.state !== "ACTIVE") throw new Error("Browser runtime binding record is no longer active");
      if (current.bindingTxnId !== undefined && current.bindingTxnId !== resource.bindingTxnId) throw new Error("Browser runtime binding transaction is immutable");
      if (current.controlSessionId !== undefined && current.controlSessionId !== controlSessionId) throw new Error("Browser runtime control session binding is immutable");
      current.bindingTxnId = resource.bindingTxnId;
      current.controlSessionId = controlSessionId;
      current.updatedAt = this.timestamp();
    });
    return { state: "BOUND", externalId: resource.externalId };
  }

  public async release(resource: BrowserRuntimeWireResource, reason: string, signal?: AbortSignal): Promise<{ released: boolean; summary?: string }> {
    const record = await this.findByExternalId(resource.externalId);
    if (!record || !sameResourceBinding(record, resource)) return { released: false, summary: "Browser runtime release binding is ambiguous" };
    const status = await this.host.inspect(resource.externalId, signal);
    if (status === "ABSENT") {
      await this.markReleased(record.idempotencyKey, reason);
      return { released: true, summary: "Browser context was already absent" };
    }
    if (status !== "PRESENT" || record.state !== "ACTIVE") return { released: false, summary: "Browser context release remains UNKNOWN" };
    const released = await this.host.release(resource.externalId, reason, signal);
    if (!released) return { released: false, summary: "Browser host did not confirm release" };
    this.contexts.delete(resource.externalId);
    await this.markReleased(record.idempotencyKey, reason);
    return { released: true, summary: `Browser context released: ${boundedSummary(reason)}` };
  }

  /** Refresh the service lease only after the exact immutable binding matches. */
  public async heartbeat(resource: BrowserRuntimeWireResource, signal?: AbortSignal): Promise<{ state: "CONFIRMED"; externalId: string; expiresAt: string }> {
    const record = await this.findByExternalId(resource.externalId);
    if (!record || !sameResourceBinding(record, resource) || record.state !== "ACTIVE" || !isLeaseActive(record, this.now())) throw new Error("Browser runtime heartbeat binding is not active");
    if (resource.bindingTxnId && record.bindingTxnId !== resource.bindingTxnId) throw new Error("Browser runtime heartbeat binding marker is not persisted");
    if (this.host.heartbeat) await this.host.heartbeat(resource.externalId, signal);
    const expiresAt = this.leaseTimestamp();
    await this.mutate((ledger) => {
      const current = findByKey(ledger, record.idempotencyKey);
      if (!current || current.state !== "ACTIVE") throw new Error("Browser runtime heartbeat record is no longer active");
      current.leaseExpiresAt = expiresAt;
      current.updatedAt = this.timestamp();
    });
    return { state: "CONFIRMED", externalId: resource.externalId, expiresAt };
  }

  public async health(signal?: AbortSignal): Promise<{ status: BrowserRuntimeHealthStatus; capabilities: BrowserRuntimeCapabilities; summary?: string }> {
    if (!this.host.health) {
      return {
        status: "DEGRADED",
        capabilities: defaultCapabilities(false),
        summary: "Browser runtime host does not expose a health probe",
      };
    }
    const result = await this.host.health(signal);
    const capabilities = validateCapabilities(result.capabilities);
    if (capabilities.stableAcrossRestart && !this.host.inspectByIdempotency) {
      return {
        status: "DEGRADED",
        capabilities: { ...capabilities, stableAcrossRestart: false },
        summary: "Browser runtime host cannot reconcile an interrupted create by idempotency key",
      };
    }
    return {
      status: result.status,
      capabilities,
      ...(result.summary ? { summary: boundedSummary(result.summary) } : {}),
    };
  }

  private async resolveContext(resource: BrowserRuntimeWireResource, signal?: AbortSignal): Promise<BrowserContextPort | undefined> {
    const record = await this.findByExternalId(resource.externalId);
    if (!record || !sameResourceBinding(record, resource) || record.state !== "ACTIVE" || !isLeaseActive(record, this.now())) return undefined;
    if (resource.bindingTxnId && record.bindingTxnId !== resource.bindingTxnId) return undefined;
    const local = this.contexts.get(resource.externalId);
    return local ?? await this.host.resolve(resource.externalId, signal);
  }

  private async reconcileStarting(record: DurableBrowserRuntimeRecord, signal?: AbortSignal): Promise<DurableBrowserRuntimeRecord | undefined> {
    if (!this.host.inspectByIdempotency) return undefined;
    const result = await this.host.inspectByIdempotency(record.request, record.idempotencyKey, signal);
    if (result.status !== "PRESENT" || !result.created) return undefined;
    return await this.promoteStarting(record, result.created);
  }

  private async promoteStarting(record: DurableBrowserRuntimeRecord, created: BrowserRuntimeCreatedContext): Promise<DurableBrowserRuntimeRecord | undefined> {
    assertCreatedContext(created, record.request);
    let usable = false;
    await this.mutate((ledger) => {
      const current = findByKey(ledger, record.idempotencyKey);
      if (!current) throw new Error("Browser create reservation disappeared during reconciliation");
      assertSameRequest(current.request, record.request);
      if (current.state === "ACTIVE") {
        if (!isComplete(current) || current.sessionId !== created.sessionId || current.externalId !== created.externalId || current.initialUrl !== created.initialUrl || current.stateHash !== created.stateHash) throw new Error("Browser create reconciliation returned a different active identity");
        usable = true;
        return;
      }
      // A terminal release must never be resurrected by a stale host lookup.
      if (current.state !== "STARTING" && current.state !== "UNKNOWN") return;
      current.state = "ACTIVE";
      current.sessionId = created.sessionId;
      current.externalId = created.externalId;
      current.initialUrl = created.initialUrl;
      current.stateHash = created.stateHash;
      current.leaseExpiresAt = this.leaseTimestamp();
      current.updatedAt = this.timestamp();
      usable = true;
    });
    if (usable && created.context) this.contexts.set(created.externalId, created.context);
    return usable ? await this.findByKey(record.idempotencyKey) : undefined;
  }

  private async reconcileReservation(record: DurableBrowserRuntimeRecord, signal?: AbortSignal): Promise<"recovered" | "unknown" | "pending"> {
    if (!this.host.inspectByIdempotency) return "pending";
    try {
      const result = await this.host.inspectByIdempotency(record.request, record.idempotencyKey, signal);
      if (result.status === "PRESENT" && result.created) return await this.promoteStarting(record, result.created) ? "recovered" : "pending";
      if (result.status === "ABSENT") {
        await this.mutate((ledger) => {
          const current = findByKey(ledger, record.idempotencyKey);
          if (!current || current.state !== "STARTING") return;
          current.state = "UNKNOWN";
          current.lastSummary = "Browser host reported no exact resource for the interrupted create";
          current.updatedAt = this.timestamp();
        });
        return "unknown";
      }
      return "pending";
    } catch {
      return "pending";
    }
  }

  private async reserve(request: BrowserRuntimeCreateRequest, idempotencyKey: string): Promise<{ created: true } | { created: false; record: DurableBrowserRuntimeRecord }> {
    let result: { created: true } | { created: false; record: DurableBrowserRuntimeRecord } = { created: true };
    await withFileLock(this.lockPath, async () => {
      let ledger: DurableBrowserRuntimeLedger;
      try {
        ledger = parseLedger(JSON.parse(await readFile(this.ledgerPath, "utf8")) as unknown);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") ledger = { schemaVersion: LEDGER_SCHEMA_VERSION, records: [] };
        else if (error instanceof SyntaxError) throw new Error("Browser runtime service ledger is malformed JSON");
        else throw error;
      }
      const existing = findByKey(ledger, idempotencyKey);
      if (existing) {
        result = { created: false, record: structuredClone(existing) };
        return;
      }
      if (ledger.records.length >= MAX_RECORDS) throw new Error("Browser runtime service ledger is full");
      ledger.records.push({
        schemaVersion: LEDGER_SCHEMA_VERSION,
        idempotencyKey,
        request: structuredClone(request),
        state: "STARTING",
        createdAt: this.timestamp(),
        updatedAt: this.timestamp(),
        leaseExpiresAt: this.leaseTimestamp(),
      });
      await atomicWriteFile(this.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    }, this.lock);
    return result;
  }

  private async findByKey(idempotencyKey: string): Promise<DurableBrowserRuntimeRecord | undefined> {
    const ledger = await this.readLedger();
    const record = findByKey(ledger, idempotencyKey);
    return record ? structuredClone(record) : undefined;
  }

  private async findByExternalId(externalId: string): Promise<DurableBrowserRuntimeRecord | undefined> {
    const ledger = await this.readLedger();
    const record = ledger.records.find((candidate) => candidate.externalId === externalId);
    return record ? structuredClone(record) : undefined;
  }

  private async markReleased(idempotencyKey: string, reason: string): Promise<void> {
    await this.mutate((ledger) => {
      const record = findByKey(ledger, idempotencyKey);
      if (!record) return;
      record.state = "RELEASED";
      record.lastSummary = boundedSummary(reason);
      record.leaseExpiresAt = undefined;
      record.updatedAt = this.timestamp();
    });
  }

  private async touch(idempotencyKey: string): Promise<void> {
    await this.mutate((ledger) => {
      const record = findByKey(ledger, idempotencyKey);
      if (record?.state === "ACTIVE") {
        record.leaseExpiresAt = this.leaseTimestamp();
        record.updatedAt = this.timestamp();
      }
    });
  }

  private async readLedger(): Promise<DurableBrowserRuntimeLedger> {
    return await withFileLock(this.lockPath, async () => {
      try {
        const parsed: unknown = JSON.parse(await readFile(this.ledgerPath, "utf8"));
        return parseLedger(parsed);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: LEDGER_SCHEMA_VERSION, records: [] };
        if (error instanceof SyntaxError) throw new Error("Browser runtime service ledger is malformed JSON");
        throw error;
      }
    }, this.lock);
  }

  private async mutate(operation: (ledger: DurableBrowserRuntimeLedger) => void): Promise<void> {
    await withFileLock(this.lockPath, async () => {
      let ledger: DurableBrowserRuntimeLedger;
      try {
        ledger = parseLedger(JSON.parse(await readFile(this.ledgerPath, "utf8")) as unknown);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") ledger = { schemaVersion: LEDGER_SCHEMA_VERSION, records: [] };
        else if (error instanceof SyntaxError) throw new Error("Browser runtime service ledger is malformed JSON");
        else throw error;
      }
      operation(ledger);
      await atomicWriteFile(this.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    }, this.lock);
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private leaseTimestamp(): string {
    return new Date(this.now() + this.leaseMs).toISOString();
  }
}

function parseLedger(value: unknown): DurableBrowserRuntimeLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser runtime service ledger must be an object");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== LEDGER_SCHEMA_VERSION || !Array.isArray(input.records) || input.records.length > MAX_RECORDS) throw new Error("Browser runtime service ledger has an unsupported schema or size");
  return { schemaVersion: LEDGER_SCHEMA_VERSION, records: input.records.map(parseRecord) };
}

function parseRecord(value: unknown): DurableBrowserRuntimeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser runtime service ledger record is invalid");
  const record = value as Record<string, unknown>;
  if (typeof record.idempotencyKey !== "string" || !/^[a-f0-9]{64}$/i.test(record.idempotencyKey) || !isState(record.state) || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") throw new Error("Browser runtime service ledger record is invalid");
  if ((record.bindingTxnId !== undefined && !isHash(record.bindingTxnId)) || (record.controlSessionId !== undefined && !isSafeOpaque(record.controlSessionId))) throw new Error("Browser runtime service binding marker is invalid");
  const request = parseBrowserRuntimeCreateRequest(record.request);
  const cloned = structuredClone(record) as unknown as DurableBrowserRuntimeRecord;
  return { ...cloned, request };
}

function findByKey(ledger: DurableBrowserRuntimeLedger, key: string): DurableBrowserRuntimeRecord | undefined {
  return ledger.records.find((record) => record.idempotencyKey === key);
}

function assertSameRequest(left: BrowserRuntimeCreateRequest, right: BrowserRuntimeCreateRequest): void {
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error("Browser create idempotency key is bound to a different immutable request");
}

function sameResourceBinding(record: DurableBrowserRuntimeRecord, resource: BrowserRuntimeWireResource): boolean {
  return record.externalId === resource.externalId
    && record.sessionId !== undefined
    && resource.id === `session:${record.sessionId}`
    && record.request.runId === resource.runId
    && record.request.generation === resource.generation
    && record.request.ownerLane === resource.ownerLane
    && record.request.policyHash === resource.policyHash
    && record.request.recipeHash === resource.recipeHash
    && record.request.verificationKey === resource.requestKey
    && record.request.scopeHash === resource.scopeHash;
}

function assertCreatedContext(created: BrowserRuntimeCreatedContext, request: BrowserRuntimeCreateRequest): void {
  if (!isSafeOpaque(created.sessionId) || !isSafeOpaque(created.externalId) || !isSafeHttpUrl(created.initialUrl) || !/^[a-f0-9]{64}$/i.test(created.stateHash)) throw new Error("Browser host returned an invalid created context");
  const expected = new URL(request.target);
  const actual = new URL(created.initialUrl);
  if (expected.origin !== actual.origin) throw new Error("Browser host created context outside the requested origin");
}

function responseFromRecord(record: DurableBrowserRuntimeRecord, state: "CREATED" | "EXISTING"): Pick<BrowserRuntimeCreateWireResponse, "state" | "sessionId" | "externalId" | "initialUrl" | "stateHash" | "summary"> {
  if (!isComplete(record)) throw new Error("Browser runtime record has no complete create identity");
  return { state, sessionId: record.sessionId, externalId: record.externalId, initialUrl: record.initialUrl, stateHash: record.stateHash };
}

function responseFromCreated(created: BrowserRuntimeCreatedContext, state: "CREATED" | "EXISTING"): Pick<BrowserRuntimeCreateWireResponse, "state" | "sessionId" | "externalId" | "initialUrl" | "stateHash"> {
  return { state, sessionId: created.sessionId, externalId: created.externalId, initialUrl: created.initialUrl, stateHash: created.stateHash };
}

function isComplete(record: DurableBrowserRuntimeRecord): record is DurableBrowserRuntimeRecord & Required<Pick<DurableBrowserRuntimeRecord, "sessionId" | "externalId" | "initialUrl" | "stateHash">> {
  return Boolean(record.sessionId && record.externalId && record.initialUrl && record.stateHash);
}

function isLeaseActive(record: DurableBrowserRuntimeRecord, now: number): boolean {
  return record.leaseExpiresAt === undefined || Date.parse(record.leaseExpiresAt) > now;
}

function isState(value: unknown): value is DurableBrowserRuntimeRecord["state"] {
  return value === "STARTING" || value === "ACTIVE" || value === "UNKNOWN" || value === "RELEASED";
}

function isSafeOpaque(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function findByExternalId(ledger: DurableBrowserRuntimeLedger, externalId: string): DurableBrowserRuntimeRecord | undefined {
  return ledger.records.find((record) => record.externalId === externalId);
}

function isSafeHttpUrl(value: unknown): value is string {
  if (!isSafeOpaque(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

const BROWSER_RUNTIME_ACTIONS = ["navigate", "click", "fill", "submit", "wait"] as const;

function defaultCapabilities(stableAcrossRestart: boolean): BrowserRuntimeCapabilities {
  return { actions: BROWSER_RUNTIME_ACTIONS, maxResponseBytes: 8 * 1_048_576, stableAcrossRestart };
}

function validateCapabilities(value: BrowserRuntimeCapabilities): BrowserRuntimeCapabilities {
  if (!value || !Array.isArray(value.actions) || value.actions.length !== BROWSER_RUNTIME_ACTIONS.length || value.actions.some((action, index) => action !== BROWSER_RUNTIME_ACTIONS[index]) || !Number.isSafeInteger(value.maxResponseBytes) || value.maxResponseBytes < 1 || value.maxResponseBytes > 8 * 1_048_576 || typeof value.stableAcrossRestart !== "boolean") throw new Error("Browser runtime host returned invalid capabilities");
  return { actions: [...value.actions], maxResponseBytes: value.maxResponseBytes, stableAcrossRestart: value.stableAcrossRestart };
}

function boundedSummary(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 512);
}
