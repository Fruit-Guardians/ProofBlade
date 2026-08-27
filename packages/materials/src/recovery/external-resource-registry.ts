import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile, KeyedOperationQueue, withFileLock, type FileLockOptions } from "@proofblade/atoms";
import type { Lane } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";

const LEDGER_SCHEMA_VERSION = 1 as const;
const MAX_RECORDS = 2_048;
const MAX_SUMMARY_LENGTH = 1_024;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;

export type ExternalResourceKind = "container" | "pwn-session" | "http-session" | "browser-context" | "platform-environment";
export type ExternalResourceState = "PROPOSED" | "STARTED" | "CONFIRMED" | "UNKNOWN" | "RELEASED";
export type ExternalResourceInspectionStatus = "PRESENT" | "ABSENT" | "UNKNOWN";
export type ExternalResourceBinding = "MATCH" | "MISMATCH" | "UNKNOWN";

/** Durable identity and immutable binding for one external resource. */
export interface ExternalResourceRecord {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  id: string;
  kind: ExternalResourceKind;
  runId: string;
  generation: number;
  ownerLane: Lane;
  state: ExternalResourceState;
  externalId?: string;
  effectId?: string;
  requestKey?: string;
  policyHash?: string;
  recipeHash?: string;
  scopeHash?: string;
  /** Stable transaction identity for the external-start/control-owner handshake. */
  bindingTxnId?: string;
  /** Durable binding marker written after the Control Store owner event. */
  controlSessionId?: string;
  createdAt: string;
  updatedAt: string;
  inspectCount: number;
  lastSummary?: string;
  lastError?: string;
  releasedAt?: string;
  releaseReason?: string;
}

export interface ExternalResourceRegistration {
  id: string;
  kind: ExternalResourceKind;
  runId: string;
  generation: number;
  ownerLane: Lane;
  externalId?: string;
  effectId?: string;
  requestKey?: string;
  policyHash?: string;
  recipeHash?: string;
  scopeHash?: string;
  /** Optional caller-supplied stable binding transaction id. */
  bindingTxnId?: string;
}

export interface ExternalResourceInspection {
  status: ExternalResourceInspectionStatus;
  /** The backend must only return MATCH after validating the immutable binding. */
  binding: ExternalResourceBinding;
  externalId?: string;
  summary?: string;
}

export interface ExternalResourceAdapter {
  readonly kind: ExternalResourceKind;
  inspect(record: ExternalResourceRecord, signal?: AbortSignal): Promise<ExternalResourceInspection>;
  /** Adopt only a PRESENT/MATCH resource. UNKNOWN is a deliberate fail-closed result. */
  adopt(record: ExternalResourceRecord, inspection: ExternalResourceInspection, signal?: AbortSignal): Promise<{ state: "CONFIRMED" | "UNKNOWN"; summary?: string }>;
  /** Release must be idempotent: an already absent resource counts as released. */
  release(record: ExternalResourceRecord, reason: string, signal?: AbortSignal): Promise<{ released: boolean; summary?: string }>;
}

export interface ExternalResourceAdapterContext {
  runId: string;
  generation: number;
}

export type ExternalResourceAdapterSource =
  | readonly ExternalResourceAdapter[]
  | ((context: ExternalResourceAdapterContext) => readonly ExternalResourceAdapter[] | Promise<readonly ExternalResourceAdapter[]>);

export async function resolveExternalResourceAdapters(
  source: ExternalResourceAdapterSource | undefined,
  context: ExternalResourceAdapterContext,
): Promise<readonly ExternalResourceAdapter[]> {
  if (!source) return [];
  return typeof source === "function" ? await source(context) : source;
}

export interface ExternalResourceReconcileResult {
  examined: number;
  adopted: string[];
  released: string[];
  unknown: string[];
  failed: string[];
}

export interface ExternalResourceReconcileOptions {
  /** Resource ids already handled by a higher-level crash-boundary check. */
  readonly skipIds?: readonly string[];
}

interface ExternalResourceLedger {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  records: ExternalResourceRecord[];
}

interface RegistryOptions {
  historyLimit?: number;
  lock?: FileLockOptions;
  now?: () => number;
}

/**
 * Cross-process ledger for resources whose lifetime is not represented by a
 * Node object. The registry stores only bounded identifiers and hashes; raw
 * credentials, URLs, cookies, command lines, and response bodies remain in
 * the owning Artifact/ControlStore.
 */
export class ExternalResourceRegistry {
  private readonly queue = new KeyedOperationQueue();
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  private readonly historyLimit: number;
  private readonly lock: FileLockOptions;
  private readonly now: () => number;
  private recordsById = new Map<string, ExternalResourceRecord>();

  public constructor(ledgerPath: string, options: RegistryOptions = {}) {
    if (!ledgerPath.trim()) throw new Error("External resource registry requires a ledger path");
    this.ledgerPath = ledgerPath;
    this.lockPath = `${ledgerPath}.lock`;
    this.historyLimit = clamp(options.historyLimit ?? 512, 16, MAX_RECORDS);
    this.lock = options.lock ?? {};
    this.now = options.now ?? Date.now;
  }

  /** Companion path used by the cross-ledger binding transaction journal. */
  public get bindingTransactionsPath(): string {
    return `${this.ledgerPath}.transactions.json`;
  }

  public async get(id: string): Promise<ExternalResourceRecord | undefined> {
    return await this.serial(async () => await this.withLedgerLock(async () => {
      return clone(this.recordsById.get(id));
    }));
  }

  public async records(runId?: string): Promise<ExternalResourceRecord[]> {
    return await this.serial(async () => await this.withLedgerLock(async () => {
      return [...this.recordsById.values()]
        .filter((record) => runId === undefined || record.runId === runId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((record) => structuredClone(record));
    }));
  }

  /** Register a resource before an external action starts. Repeating the exact binding is idempotent. */
  public async register(input: ExternalResourceRegistration): Promise<ExternalResourceRecord> {
    validateRegistration(input);
    return await this.serial(async () => await this.withLedgerLock(async () => {
      const existing = this.recordsById.get(input.id);
      if (existing) {
        assertSameBinding(existing, input);
        const bindingTxnId = input.bindingTxnId ?? externalResourceBindingTransactionId(input);
        if (existing.bindingTxnId === undefined) {
          existing.bindingTxnId = bindingTxnId;
          existing.updatedAt = new Date(this.now()).toISOString();
          await this.persist();
        }
        return structuredClone(existing);
      }
      const timestamp = new Date(this.now()).toISOString();
      const record: ExternalResourceRecord = {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        ...input,
        bindingTxnId: input.bindingTxnId ?? externalResourceBindingTransactionId(input),
        state: "PROPOSED",
        createdAt: timestamp,
        updatedAt: timestamp,
        inspectCount: 0,
      };
      this.recordsById.set(record.id, record);
      await this.persist();
      return structuredClone(record);
    }));
  }

  /**
   * Register a resource and record that its external action has started in
   * one locked ledger mutation. This closes the registration-to-start gap for
   * resources whose opaque handle is already known before the owner writes its
   * Control Store session record.
   */
  public async registerStarted(input: ExternalResourceRegistration & { readonly externalId: string }): Promise<ExternalResourceRecord> {
    validateRegistration(input);
    if (!input.externalId.trim()) throw new Error("External resource externalId cannot be empty");
    return await this.serial(async () => await this.withLedgerLock(async () => {
      const existing = this.recordsById.get(input.id);
      if (existing) {
        assertSameBinding(existing, input);
        const bindingTxnId = input.bindingTxnId ?? externalResourceBindingTransactionId(input);
        let changed = false;
        if (existing.bindingTxnId === undefined) {
          existing.bindingTxnId = bindingTxnId;
          changed = true;
        } else if (existing.bindingTxnId !== bindingTxnId) throw new Error(`External resource ${input.id} binding transaction mismatch`);
        if (existing.externalId !== undefined && existing.externalId !== input.externalId) throw new Error(`External resource ${input.id} binding mismatch for externalId`);
        if (existing.state === "RELEASED") throw new Error(`External resource ${input.id} is already released`);
        if (existing.state === "PROPOSED" || existing.state === "UNKNOWN") {
          existing.externalId = boundedText(input.externalId, "externalId");
          existing.state = "STARTED";
          existing.updatedAt = new Date(this.now()).toISOString();
          delete existing.lastError;
          changed = true;
        }
        if (changed) {
          existing.updatedAt = new Date(this.now()).toISOString();
          await this.persist();
        }
        return structuredClone(existing);
      }
      if (this.recordsById.size >= MAX_RECORDS) throw new Error("External resource ledger is full");
      const timestamp = new Date(this.now()).toISOString();
      const record: ExternalResourceRecord = {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        ...input,
        bindingTxnId: input.bindingTxnId ?? externalResourceBindingTransactionId(input),
        externalId: boundedText(input.externalId, "externalId"),
        state: "STARTED",
        createdAt: timestamp,
        updatedAt: timestamp,
        inspectCount: 0,
      };
      this.recordsById.set(record.id, record);
      await this.persist();
      return structuredClone(record);
    }));
  }

  /**
   * Commit the second half of a cross-ledger session open. The Control Store
   * session event is written first; this marker makes that relationship
   * durable and lets recovery distinguish an unbound external handle from a
   * session that is safe to adopt.
   */
  public async markControlBound(id: string, sessionId: string, bindingTxnId?: string): Promise<ExternalResourceRecord> {
    const boundedSessionId = boundedText(sessionId, "controlSessionId");
    return await this.serial(async () => await this.withLedgerLock(async () => {
      const current = this.recordsById.get(id);
      if (!current) throw new Error(`Unknown external resource: ${id}`);
      if (current.state === "RELEASED") throw new Error(`External resource ${id} is already released`);
      if (!id.startsWith("session:") || id.slice("session:".length) !== boundedSessionId) throw new Error(`External resource ${id} control session binding mismatch`);
      if (bindingTxnId !== undefined && current.bindingTxnId !== bindingTxnId) throw new Error(`External resource ${id} binding transaction mismatch`);
      if (current.controlSessionId !== undefined && current.controlSessionId !== boundedSessionId) throw new Error(`External resource ${id} control session binding is immutable`);
      current.controlSessionId = boundedSessionId;
      current.updatedAt = new Date(this.now()).toISOString();
      await this.persist();
      return structuredClone(current);
    }));
  }

  public async markStarted(id: string, externalId?: string): Promise<ExternalResourceRecord> {
    return await this.transition(id, "STARTED", { externalId });
  }

  public async markConfirmed(id: string, summary?: string): Promise<ExternalResourceRecord> {
    return await this.transition(id, "CONFIRMED", { summary });
  }

  public async markUnknown(id: string, reason: string): Promise<ExternalResourceRecord | undefined> {
    const bounded = boundedText(reason, "unknown resource");
    return await this.serial(async () => await this.withLedgerLock(async () => {
      const current = this.recordsById.get(id);
      if (!current || current.state === "RELEASED") return clone(current);
      current.state = "UNKNOWN";
      current.lastError = bounded;
      current.lastSummary = bounded;
      current.updatedAt = new Date(this.now()).toISOString();
      await this.persist();
      return structuredClone(current);
    }));
  }

  /** Mark a resource released when its owner has already closed it successfully. */
  public async markReleased(id: string, reason = "released"): Promise<ExternalResourceRecord | undefined> {
    return await this.serial(async () => await this.withLedgerLock(async () => {
      const current = this.recordsById.get(id);
      if (!current) return undefined;
      if (current.state === "RELEASED") return structuredClone(current);
      setReleased(current, reason, this.now());
      await this.persist();
      return structuredClone(current);
    }));
  }

  /**
   * Inspect every non-terminal resource for one Run. A stale generation is
   * released only when the backend proves the external binding matches this
   * exact durable record. Missing adapters and ambiguous observations remain
   * UNKNOWN and never trigger a blind replay or delete.
   */
  public async reconcileRun(
    runId: string,
    currentGeneration: number,
    adapters: readonly ExternalResourceAdapter[] = [],
    signal?: AbortSignal,
    options: ExternalResourceReconcileOptions = {},
  ): Promise<ExternalResourceReconcileResult> {
    const adapterByKind = new Map<ExternalResourceKind, ExternalResourceAdapter>();
    for (const adapter of adapters) {
      if (adapterByKind.has(adapter.kind)) throw new Error(`Duplicate external resource adapter for ${adapter.kind}`);
      adapterByKind.set(adapter.kind, adapter);
    }
    const candidates = (await this.records(runId)).filter((record) => record.state !== "RELEASED");
    const skipped = new Set(options.skipIds ?? []);
    const result: ExternalResourceReconcileResult = { examined: candidates.length, adopted: [], released: [], unknown: [], failed: [] };
    for (const record of candidates) {
      throwIfAborted(signal);
      if (skipped.has(record.id)) continue;
      if (record.state === "PROPOSED") {
        await this.markReleased(record.id, "proposal never started an external action");
        result.released.push(record.id);
        continue;
      }
      const adapter = adapterByKind.get(record.kind);
      if (!adapter) {
        await this.markUnknown(record.id, `No adapter is registered for ${record.kind}`);
        result.unknown.push(record.id);
        continue;
      }
      const inspection = await this.inspect(record.id, adapter, signal);
      if (inspection.status === "ABSENT") {
        await this.markReleased(record.id, "backend confirmed the resource is absent");
        result.released.push(record.id);
        continue;
      }
      if (inspection.status !== "PRESENT" || inspection.binding !== "MATCH") {
        await this.markUnknown(record.id, inspection.summary ?? "backend could not confirm the exact resource binding");
        result.unknown.push(record.id);
        continue;
      }
      if (record.generation !== currentGeneration) {
        const released = await this.release(record.id, adapter, `stale generation ${record.generation}; current generation is ${currentGeneration}`, signal);
        (released ? result.released : result.failed).push(record.id);
        continue;
      }
      const adopted = await this.adopt(record.id, adapter, inspection, signal);
      if (adopted === "CONFIRMED") result.adopted.push(record.id);
      else result.unknown.push(record.id);
    }
    return result;
  }

  /** Inspect and adopt one resource without changing its immutable binding. */
  public async inspectAndAdopt(id: string, adapter: ExternalResourceAdapter, signal?: AbortSignal): Promise<ExternalResourceRecord | undefined> {
    const record = await this.get(id);
    if (!record || record.state === "RELEASED") return record;
    const inspection = await this.inspect(id, adapter, signal);
    if (inspection.status !== "PRESENT" || inspection.binding !== "MATCH") {
      return await this.markUnknown(id, inspection.summary ?? "resource binding is not confirmed");
    }
    return await this.adopt(id, adapter, inspection, signal).then(async (state) => state === "CONFIRMED" ? await this.get(id) : await this.markUnknown(id, "resource adoption remained ambiguous"));
  }

  /** Release one resource through its backend; failures remain retryable UNKNOWN. */
  public async release(id: string, adapter: ExternalResourceAdapter, reason = "released", signal?: AbortSignal): Promise<boolean> {
    const record = await this.get(id);
    if (!record || record.state === "RELEASED") return true;
    if (record.kind !== adapter.kind) throw new Error(`External resource adapter kind mismatch for ${id}`);
    try {
      const outcome = await adapter.release(record, boundedText(reason, "released"), signal);
      if (!outcome.released) {
        await this.markUnknown(id, outcome.summary ?? "backend did not confirm release");
        return false;
      }
      await this.markReleased(id, outcome.summary ?? reason);
      return true;
    } catch (error) {
      await this.markUnknown(id, error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private async inspect(id: string, adapter: ExternalResourceAdapter, signal?: AbortSignal): Promise<ExternalResourceInspection> {
    const record = await this.get(id);
    if (!record) return { status: "ABSENT", binding: "UNKNOWN", summary: "resource record is absent" };
    if (record.kind !== adapter.kind) throw new Error(`External resource adapter kind mismatch for ${id}`);
    try {
      const inspection = validateInspection(await adapter.inspect(record, signal));
      await this.serial(async () => await this.withLedgerLock(async () => {
        const current = this.recordsById.get(id);
        if (!current || current.state === "RELEASED") return;
        current.inspectCount += 1;
        current.updatedAt = new Date(this.now()).toISOString();
        if (inspection.externalId) current.externalId = inspection.externalId;
        if (inspection.summary) current.lastSummary = boundedText(inspection.summary, "inspection");
        await this.persist();
      }));
      return inspection;
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      await this.markUnknown(id, summary);
      return { status: "UNKNOWN", binding: "UNKNOWN", summary };
    }
  }

  private async adopt(id: string, adapter: ExternalResourceAdapter, inspection: ExternalResourceInspection, signal?: AbortSignal): Promise<"CONFIRMED" | "UNKNOWN"> {
    const record = await this.get(id);
    if (!record || record.state === "RELEASED") return "UNKNOWN";
    try {
      const outcome = await adapter.adopt(record, inspection, signal);
      if (outcome.state === "CONFIRMED") {
        await this.markConfirmed(id, outcome.summary);
        return "CONFIRMED";
      }
      await this.markUnknown(id, outcome.summary ?? "backend refused adoption");
      return "UNKNOWN";
    } catch (error) {
      await this.markUnknown(id, error instanceof Error ? error.message : String(error));
      return "UNKNOWN";
    }
  }

  private async transition(id: string, state: "STARTED" | "CONFIRMED", updates: { externalId?: string; summary?: string }): Promise<ExternalResourceRecord> {
    return await this.serial(async () => await this.withLedgerLock(async () => {
      const current = this.recordsById.get(id);
      if (!current) throw new Error(`Unknown external resource: ${id}`);
      if (current.state === "RELEASED") throw new Error(`External resource ${id} is already released`);
      if (state === "STARTED" && current.state !== "PROPOSED" && current.state !== "UNKNOWN" && current.state !== "STARTED") throw new Error(`Cannot start external resource ${id} from ${current.state}`);
      if (state === "CONFIRMED" && !["STARTED", "CONFIRMED", "UNKNOWN"].includes(current.state)) throw new Error(`Cannot confirm external resource ${id} from ${current.state}`);
      current.state = state;
      if (updates.externalId !== undefined) current.externalId = boundedText(updates.externalId, "externalId");
      if (updates.summary !== undefined) current.lastSummary = boundedText(updates.summary, "summary");
      delete current.lastError;
      current.updatedAt = new Date(this.now()).toISOString();
      await this.persist();
      return structuredClone(current);
    }));
  }

  private async load(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.ledgerPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.recordsById.clear();
        return;
      }
      throw new Error(`External resource ledger is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isLedger(parsed)) throw new Error("External resource ledger has an unsupported schema");
    this.recordsById.clear();
    for (const record of parsed.records) this.recordsById.set(record.id, structuredClone(record));
  }

  private async persist(): Promise<void> {
    const records = [...this.recordsById.values()]
      .sort((left, right) => {
        const leftTerminal = left.state === "RELEASED" ? 1 : 0;
        const rightTerminal = right.state === "RELEASED" ? 1 : 0;
        return leftTerminal - rightTerminal || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
      })
      .slice(0, MAX_RECORDS);
    const active = records.filter((record) => record.state !== "RELEASED");
    const released = records.filter((record) => record.state === "RELEASED").slice(0, this.historyLimit);
    const retained = [...active, ...released];
    this.recordsById = new Map(retained.map((record) => [record.id, record]));
    await atomicWriteFile(this.ledgerPath, `${canonicalJson({ schemaVersion: LEDGER_SCHEMA_VERSION, records: retained })}\n`);
  }

  private async withLedgerLock<T>(operation: () => Promise<T>): Promise<T> {
    return await withFileLock(this.lockPath, async () => {
      await this.load();
      return await operation();
    }, this.lock);
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.run(this.ledgerPath, operation);
    return await run;
  }
}

function validateRegistration(input: ExternalResourceRegistration): void {
  for (const [name, value] of Object.entries(input)) {
    if (name === "generation") continue;
    if (value === undefined) continue;
    if (typeof value === "string" && (value.length === 0 || value.length > 512)) throw new Error(`External resource ${name} is outside the bounded length`);
  }
  if (!Number.isInteger(input.generation) || input.generation < 0) throw new Error("External resource generation must be a non-negative integer");
  if (input.policyHash !== undefined && !HASH_PATTERN.test(input.policyHash)) throw new Error("External resource policyHash must be a sha256 hash");
  if (input.recipeHash !== undefined && !HASH_PATTERN.test(input.recipeHash)) throw new Error("External resource recipeHash must be a sha256 hash");
  if (input.scopeHash !== undefined && !HASH_PATTERN.test(input.scopeHash)) throw new Error("External resource scopeHash must be a sha256 hash");
  if (input.bindingTxnId !== undefined && !HASH_PATTERN.test(input.bindingTxnId)) throw new Error("External resource bindingTxnId must be a sha256 hash");
}

function assertSameBinding(record: ExternalResourceRecord, input: ExternalResourceRegistration): void {
  const fields = ["kind", "runId", "generation", "ownerLane", "effectId", "requestKey", "policyHash", "recipeHash", "scopeHash"] as const;
  for (const field of fields) {
    if (record[field] !== input[field]) throw new Error(`External resource ${input.id} binding mismatch for ${field}`);
  }
  if (record.bindingTxnId !== undefined && input.bindingTxnId !== undefined && record.bindingTxnId !== input.bindingTxnId) {
    throw new Error(`External resource ${input.id} binding transaction mismatch`);
  }
}

function validateInspection(value: ExternalResourceInspection): ExternalResourceInspection {
  if (!value || !["PRESENT", "ABSENT", "UNKNOWN"].includes(value.status) || !["MATCH", "MISMATCH", "UNKNOWN"].includes(value.binding)) throw new Error("External resource inspection has an invalid status");
  if (value.status === "PRESENT" && value.binding !== "MATCH" && value.binding !== "MISMATCH") throw new Error("Present external resource inspection must declare MATCH or MISMATCH binding");
  if (value.status === "ABSENT" && value.binding === "MATCH") throw new Error("Absent external resource cannot have MATCH binding");
  return { ...value, ...(value.externalId === undefined ? {} : { externalId: boundedText(value.externalId, "externalId") }), ...(value.summary === undefined ? {} : { summary: boundedText(value.summary, "summary") }) };
}

function setReleased(record: ExternalResourceRecord, reason: string, now: number): void {
  record.state = "RELEASED";
  record.updatedAt = new Date(now).toISOString();
  record.releasedAt = record.updatedAt;
  record.releaseReason = boundedText(reason, "release reason");
  delete record.lastError;
}

function boundedText(value: string, label: string): string {
  const text = String(value).trim();
  if (!text) throw new Error(`External resource ${label} cannot be empty`);
  return text.slice(0, MAX_SUMMARY_LENGTH);
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function isLedger(value: unknown): value is ExternalResourceLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.schemaVersion === LEDGER_SCHEMA_VERSION && Array.isArray(input.records) && input.records.length <= MAX_RECORDS && input.records.every(isRecord);
}

function isRecord(value: unknown): value is ExternalResourceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.schemaVersion === LEDGER_SCHEMA_VERSION
    && typeof input.id === "string" && input.id.length > 0 && input.id.length <= 512
    && ["container", "pwn-session", "http-session", "browser-context", "platform-environment"].includes(input.kind as string)
    && typeof input.runId === "string" && input.runId.length > 0 && input.runId.length <= 512
    && Number.isInteger(input.generation) && (input.generation as number) >= 0
    && ["main", "planner", "executor", "verifier", "system"].includes(input.ownerLane as string)
    && ["PROPOSED", "STARTED", "CONFIRMED", "UNKNOWN", "RELEASED"].includes(input.state as string)
    && (input.externalId === undefined || boundedField(input.externalId))
    && optionalBounded(input.effectId) && optionalBounded(input.requestKey)
    && optionalHash(input.policyHash) && optionalHash(input.recipeHash) && optionalHash(input.scopeHash)
    && optionalHash(input.bindingTxnId)
    && optionalBounded(input.controlSessionId)
    && typeof input.createdAt === "string" && typeof input.updatedAt === "string"
    && Number.isInteger(input.inspectCount) && (input.inspectCount as number) >= 0
    && optionalBounded(input.lastSummary) && optionalBounded(input.lastError) && optionalBounded(input.releasedAt) && optionalBounded(input.releaseReason);
}

function optionalBounded(value: unknown): boolean {
  return value === undefined || boundedField(value);
}

function boundedField(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024;
}

function optionalHash(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && HASH_PATTERN.test(value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(Number.isFinite(value) ? value : min)));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("External resource reconciliation aborted");
}

/** Stable binding hash useful for adapter labels and logs without raw values. */
export function externalResourceBindingHash(record: Pick<ExternalResourceRecord, "runId" | "generation" | "kind" | "id" | "effectId" | "requestKey" | "policyHash" | "recipeHash" | "scopeHash">): string {
  return sha256(canonicalJson(record));
}

/**
 * Derive the stable identity of the external-start/control-owner handshake.
 * The external handle is deliberately excluded: it is unknown before the
 * backend starts, while this id must be available for idempotency and crash
 * recovery before any side effect is issued.
 */
export function externalResourceBindingTransactionId(
  input: Pick<ExternalResourceRegistration, "id" | "kind" | "runId" | "generation" | "ownerLane" | "effectId" | "requestKey" | "policyHash" | "recipeHash" | "scopeHash">,
): string {
  return sha256(canonicalJson({
    schemaVersion: 1,
    binding: "external-resource",
    id: input.id,
    kind: input.kind,
    runId: input.runId,
    generation: input.generation,
    ownerLane: input.ownerLane,
    ...(input.effectId === undefined ? {} : { effectId: input.effectId }),
    ...(input.requestKey === undefined ? {} : { requestKey: input.requestKey }),
    ...(input.policyHash === undefined ? {} : { policyHash: input.policyHash }),
    ...(input.recipeHash === undefined ? {} : { recipeHash: input.recipeHash }),
    ...(input.scopeHash === undefined ? {} : { scopeHash: input.scopeHash }),
  }));
}
