import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { access, chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { atomicWriteFile, KeyedOperationQueue, withFileLock, type FileLockOptions } from "@proofblade/atoms";
import { canonicalJson, sha256 } from "../domain/utils.js";
import type { ContainerSessionReadOptions, ContainerSessionResult } from "../container/contracts.js";
import type { ExternalResourceRecord } from "./external-resource-registry.js";
import type {
  SessionRuntimeActionService,
  SessionRuntimeCreateRequest,
  SessionRuntimePwnCreateSpec,
  SessionRuntimeWireResource,
} from "./session-runtime-wire.js";
import type {
  PwnSessionSupervisor,
} from "./pwn-session-runtime-host.js";
import type { SessionRuntimeCreatedSession, SessionRuntimeHostInspection, SessionRuntimeHostPresence } from "./session-runtime-service.js";

const SCHEMA_VERSION = 1 as const;
const MAX_RECORDS = 2_048;
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_TRANSCRIPT_BYTES = 8 * 1_048_576;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_SILENCE_MS = 250;
const WORKER_HEALTH_PATH = "/health";
const WORKER_ACTION_PATH = "/action";

/** Configuration for the durable supervisor that owns detached Pwn workers. */
export interface DurablePwnSessionSupervisorOptions {
  /** Private ledger shared by all ProofBlade service processes. */
  readonly statePath: string;
  /** A small Node worker which owns the local process or remote TCP transport and its transcript. */
  readonly workerScript: string;
  /** Defaults to the current Node executable. */
  readonly workerCommand?: string;
  readonly workerArgs?: readonly string[];
  readonly bindHost?: string;
  /** Local commands execute on the supervisor host and require explicit opt-in. */
  readonly allowLocalCommands?: boolean;
  /** Deployment-owned Docker target. When set, local Pwn commands run only inside this container. */
  readonly docker?: {
    readonly containerId: string;
    readonly allowedCommands: readonly string[];
    readonly executable?: string;
    readonly allowShellCommands?: boolean;
  };
  /** Exact deployment-owned host/port allowlist for remote raw TCP tubes. */
  readonly remoteScope?: {
    readonly allowedHosts: readonly string[];
    readonly allowedPorts: readonly number[];
  };
  readonly timeoutMs?: number;
  readonly lock?: FileLockOptions;
  readonly now?: () => number;
}

interface DurablePwnRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  idempotencyKey: string;
  request: SessionRuntimeCreateRequest;
  state: "STARTING" | "ACTIVE" | "UNKNOWN" | "RELEASED";
  sessionId: string;
  externalId: string;
  workerPort: number;
  workerToken: string;
  transcriptStatePath: string;
  stateHash: string;
  createdAt: string;
  updatedAt: string;
  lastSummary?: string;
}

interface DurablePwnLedger {
  schemaVersion: typeof SCHEMA_VERSION;
  records: DurablePwnRecord[];
}

interface WorkerHealth {
  schemaVersion: 1;
  status: "READY" | "DEGRADED";
  idempotencyKey: string;
  sessionId: string;
  externalId: string;
  exited: boolean;
  exitCode: number | null;
}

interface WorkerActionResponse {
  ok: boolean;
  delta?: string;
  waitReason?: ContainerSessionResult["waitReason"];
  exited?: boolean;
  exitCode?: number | null;
  truncated?: boolean;
  delivered?: boolean;
  summary?: string;
}

/**
 * A production-oriented Pwn supervisor backed by detached workers.
 *
 * The supervisor process owns only metadata and RPC connections. The worker
 * keeps the actual process or TCP transport alive, so restarting the ProofBlade
 * session service does not execute the Pwn command or open a second tube. A missing or
 * ambiguous worker is reported as UNKNOWN and is never replaced implicitly.
 */
export class DurablePwnSessionSupervisor implements PwnSessionSupervisor {
  public readonly actions: SessionRuntimeActionService;
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly lock: FileLockOptions;
  private readonly workerScript: string;
  private readonly workerCommand: string;
  private readonly workerArgs: readonly string[];
  private readonly bindHost: string;
  private readonly allowLocalCommands: boolean;
  private readonly docker?: { readonly containerId: string; readonly allowedCommands: readonly string[]; readonly executable: string; readonly allowShellCommands: boolean };
  private readonly remoteScope?: { readonly allowedHosts: readonly string[]; readonly allowedPorts: readonly number[] };
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly queue = new KeyedOperationQueue();

  public constructor(options: DurablePwnSessionSupervisorOptions) {
    if (!options.statePath.trim()) throw new Error("Pwn supervisor requires a state path");
    if (!options.workerScript.trim()) throw new Error("Pwn supervisor requires a worker script");
    this.statePath = resolve(options.statePath);
    this.lockPath = `${this.statePath}.lock`;
    this.lock = options.lock ?? {};
    this.workerScript = resolve(options.workerScript);
    this.workerCommand = options.workerCommand?.trim() || process.execPath;
    this.workerArgs = [...(options.workerArgs ?? [])];
    this.bindHost = options.bindHost?.trim() || "127.0.0.1";
    if (!isLoopbackHost(this.bindHost)) throw new Error("Pwn supervisor bindHost must be a loopback address");
    this.allowLocalCommands = options.allowLocalCommands ?? false;
    this.docker = options.docker ? normalizeDockerPolicy(options.docker) : undefined;
    this.remoteScope = options.remoteScope
      ? { allowedHosts: options.remoteScope.allowedHosts.map((host) => host.trim().toLowerCase()), allowedPorts: [...options.remoteScope.allowedPorts] }
      : undefined;
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
    this.now = options.now ?? Date.now;
    this.actions = {
      pwnWrite: async (resource, data, readOptions, signal) => sessionResult(await this.action(resource, "pwn_write", { data: encodeData(data), encoding: typeof data === "string" ? "utf8" : "base64", ...readOptionsFor(readOptions) }, signal)),
      pwnRead: async (resource, readOptions, signal) => sessionResult(await this.action(resource, "pwn_read", readOptionsFor(readOptions), signal)),
      pwnSignal: async (resource, signalName, signal) => await this.action(resource, "pwn_signal", { signal: signalName }, signal).then((result) => result.delivered ?? false),
      pwnClose: async (resource, signal) => {
        const result = await this.action(resource, "pwn_close", {}, signal);
        return { exitCode: result.exitCode ?? null };
      },
      httpRequest: async () => { throw new Error("Durable Pwn supervisor does not expose HTTP actions"); },
    };
  }

  public async create(request: SessionRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<SessionRuntimeCreatedSession> {
    const normalized = assertPwnRequest(request);
    this.assertRemoteScope(normalized);
    this.assertExecutionPolicy(normalized);
    assertHash(idempotencyKey, "idempotencyKey");
    return await this.queue.run(`create:${idempotencyKey}`, async () => {
      const existing = await this.findByKey(idempotencyKey);
      if (existing) {
        assertSameRequest(existing.request, normalized);
        if (existing.state === "RELEASED") throw new Error("Pwn session create key was already released");
        const health = await this.probe(existing, signal);
        if (health) {
          if (existing.state === "STARTING" || existing.state === "UNKNOWN") await this.markActive(existing.idempotencyKey);
          return describe(existing);
        }
        throw new Error("Pwn session create is awaiting exact worker reconciliation");
      }

      const reservation = await this.reserve(normalized, idempotencyKey);
      if (!reservation.created) {
        assertSameRequest(reservation.record.request, normalized);
        const health = await this.probe(reservation.record, signal);
        if (health) return describe(reservation.record);
        throw new Error("Pwn session create is awaiting exact worker reconciliation");
      }
      try {
        await this.launch(reservation.record, normalized, signal);
        if (!await this.waitForWorker(reservation.record, signal)) throw new Error("Pwn worker did not become ready");
        await this.markActive(idempotencyKey);
        const active = await this.findByKey(idempotencyKey);
        if (!active) throw new Error("Pwn supervisor reservation disappeared after worker start");
        return describe(active);
      } catch (error) {
        await this.markUnknown(idempotencyKey, error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
  }

  public async inspect(externalId: string, request: SessionRuntimeCreateRequest, signal?: AbortSignal): Promise<SessionRuntimeHostInspection> {
    const normalized = assertPwnRequest(request);
    this.assertRemoteScope(normalized);
    const record = await this.findByExternalId(externalId);
    if (!record || record.state === "RELEASED") return { status: "ABSENT", externalId };
    if (!sameRequest(record.request, normalized)) return { status: "PRESENT", externalId: record.externalId, summary: "Pwn worker request binding does not match" };
    const health = await this.probe(record, signal);
    if (!health && await this.workerExited(record)) return { status: "ABSENT", externalId: record.externalId, summary: "Pwn worker has exited" };
    return health ? { status: "PRESENT", externalId: record.externalId } : { status: "UNKNOWN", externalId: record.externalId, summary: "Pwn worker did not confirm the exact detached process" };
  }

  public async adopt(externalId: string, request: SessionRuntimeCreateRequest, signal?: AbortSignal): Promise<boolean> {
    const inspection = await this.inspect(externalId, request, signal);
    if (inspection.status !== "PRESENT") return false;
    const record = await this.findByExternalId(externalId);
    if (!record) return false;
    await this.markActive(record.idempotencyKey);
    return true;
  }

  public async release(externalId: string, request: SessionRuntimeCreateRequest, reason: string, signal?: AbortSignal): Promise<boolean> {
    const normalized = assertPwnRequest(request);
    this.assertRemoteScope(normalized);
    const record = await this.findByExternalId(externalId);
    if (!record || record.state === "RELEASED") return true;
    if (!sameRequest(record.request, normalized)) return false;
    if (!await this.probe(record, signal)) {
      if (!await this.workerExited(record)) return false;
      await this.markReleased(record.idempotencyKey, reason);
      await this.removeWorkerToken(record);
      return true;
    }
    try {
      const response = await this.workerRequest(record, { op: "close" }, signal);
      if (!response.ok) return false;
      await this.mutate((ledger) => {
        const current = findByKey(ledger, record.idempotencyKey);
        if (!current) return;
        current.state = "RELEASED";
        current.updatedAt = this.timestamp();
        current.lastSummary = bounded(reason);
      });
      await this.removeWorkerToken(record);
      return true;
    } catch {
      return false;
    }
  }

  public async inspectByIdempotency(request: SessionRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<{ status: SessionRuntimeHostPresence; created?: SessionRuntimeCreatedSession }> {
    const normalized = assertPwnRequest(request);
    this.assertRemoteScope(normalized);
    assertHash(idempotencyKey, "idempotencyKey");
    const record = await this.findByKey(idempotencyKey);
    if (!record || record.state === "RELEASED") return { status: "ABSENT" };
    if (!sameRequest(record.request, normalized)) return { status: "UNKNOWN" };
    if (!await this.probe(record, signal)) return await this.workerExited(record) ? { status: "ABSENT" } : { status: "UNKNOWN" };
    if (record.state === "STARTING" || record.state === "UNKNOWN") await this.markActive(idempotencyKey);
    return { status: "PRESENT", created: describe(record) };
  }

  public async heartbeat(externalId: string, signal?: AbortSignal): Promise<void> {
    const record = await this.findByExternalId(externalId);
    if (!record || record.state !== "ACTIVE" || !await this.probe(record, signal)) throw new Error("Pwn worker heartbeat could not confirm the exact process");
  }

  public async health(signal?: AbortSignal): Promise<{ status: "READY" | "DEGRADED" | "UNAVAILABLE"; capabilities: { readonly kinds: readonly ["pwn-session"]; readonly maxRequestBytes: number; readonly maxResponseBytes: number; readonly stableAcrossRestart: boolean }; summary?: string }> {
    try {
      await access(this.workerScript);
      const ledger = await this.readLedger();
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Pwn supervisor health probe aborted");
      if (ledger.records.some((record) => record.state === "ACTIVE" && !isSafeText(record.workerToken, 256))) throw new Error("Pwn supervisor ledger contains an invalid worker token");
      return {
        status: "READY",
        capabilities: { kinds: ["pwn-session"], maxRequestBytes: MAX_REQUEST_BYTES, maxResponseBytes: MAX_RESPONSE_BYTES, stableAcrossRestart: true },
        summary: "Detached Pwn workers persist their command and bounded transcript outside the ProofBlade service process",
      };
    } catch (error) {
      return {
        status: "UNAVAILABLE",
        capabilities: { kinds: ["pwn-session"], maxRequestBytes: MAX_REQUEST_BYTES, maxResponseBytes: MAX_RESPONSE_BYTES, stableAcrossRestart: false },
        summary: `Pwn supervisor is unavailable: ${bounded(error instanceof Error ? error.message : String(error))}`,
      };
    }
  }

  private async action(resource: SessionRuntimeWireResource, operation: "pwn_write" | "pwn_read" | "pwn_signal" | "pwn_close", body: Record<string, unknown>, signal?: AbortSignal): Promise<WorkerActionResponse> {
    const record = await this.findByExternalId(resource.externalId);
    if (!record || record.state !== "ACTIVE" || !sameResourceBinding(record, resource)) throw new Error("Pwn worker action binding is not active");
    const response = await this.workerRequest(record, { op: operation, ...body }, signal);
    if (!response.ok) throw new Error(response.summary ?? `Pwn worker ${operation} failed`);
    return response;
  }

  private async reserve(request: SessionRuntimeCreateRequest, idempotencyKey: string): Promise<{ created: true; record: DurablePwnRecord } | { created: false; record: DurablePwnRecord }> {
    let result!: { created: true; record: DurablePwnRecord } | { created: false; record: DurablePwnRecord };
    await withFileLock(this.lockPath, async () => {
      const ledger = await this.readLedgerUnlocked();
      const existing = findByKey(ledger, idempotencyKey);
      if (existing) {
        result = { created: false, record: structuredClone(existing) };
        return;
      }
      if (ledger.records.length >= MAX_RECORDS) throw new Error("Pwn supervisor ledger is full");
      const workerPort = await reserveLoopbackPort(this.bindHost);
      const externalId = `pwn-runtime-${randomUUID()}`;
      const sessionId = `pwn-session-${randomUUID()}`;
      const workerToken = randomBytes(32).toString("base64url");
      const transcriptStatePath = `${this.statePath}.${externalId}.worker.json`;
      const timestamp = this.timestamp();
      const record: DurablePwnRecord = {
        schemaVersion: SCHEMA_VERSION,
        idempotencyKey,
        request: structuredClone(request),
        state: "STARTING",
        sessionId,
        externalId,
        workerPort,
        workerToken,
        transcriptStatePath,
        stateHash: sha256(canonicalJson({ externalId, request })),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      ledger.records.push(record);
      await this.writeLedgerUnlocked(ledger);
      result = { created: true, record };
    }, this.lock);
    return result;
  }

  private async launch(record: DurablePwnRecord, request: SessionRuntimeCreateRequest, signal?: AbortSignal): Promise<void> {
    const spec = request.pwn!;
    const command = this.commandFor(spec);
    const tokenPath = workerTokenPath(record);
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, `${record.workerToken}\n`, "utf8");
    await chmod(tokenPath, 0o600).catch(() => undefined);
    const args = [
      ...this.workerArgs,
      this.workerScript,
      "--host", this.bindHost,
      "--port", String(record.workerPort),
      "--token-file", tokenPath,
      "--idempotency-key", record.idempotencyKey,
      "--session-id", record.sessionId,
      "--external-id", record.externalId,
      "--state", record.transcriptStatePath,
      ...(spec.mode === "remote"
        ? ["--endpoint", encodeBase64(spec.endpoint!)]
        : ["--command", encodeBase64(JSON.stringify(command)), ...(this.docker ? [] : spec.cwd ? ["--cwd", encodeBase64(spec.cwd)] : [])]),
    ];
    throwIfAborted(signal);
    const child = spawn(this.workerCommand, args, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
    child.unref();
  }

  private assertExecutionPolicy(request: SessionRuntimeCreateRequest & { kind: "pwn-session"; pwn: SessionRuntimePwnCreateSpec }): void {
    if (request.pwn.mode !== "local") return;
    if (this.docker) {
      const executable = request.pwn.command[0]!;
      if (!this.docker.allowedCommands.includes(executable)) throw new Error(`Pwn Docker command ${executable} is outside deployment allowlist`);
      if (!this.docker.allowShellCommands && isShellCommand(executable)) throw new Error("Pwn Docker shell commands require an explicit deployment opt-in");
      if (request.pwn.cwd !== undefined && (!request.pwn.cwd.startsWith("/") || request.pwn.cwd.includes(".."))) throw new Error("Pwn Docker cwd must be a bounded container path");
      return;
    }
    if (!this.allowLocalCommands) throw new Error("Pwn supervisor local commands require an explicit deployment opt-in");
  }

  private commandFor(spec: SessionRuntimePwnCreateSpec): readonly string[] {
    if (spec.mode !== "local" || !this.docker) return spec.command;
    return [this.docker.executable, "exec", "-i", ...(spec.cwd ? ["-w", spec.cwd] : []), this.docker.containerId, ...spec.command];
  }

  private assertRemoteScope(request: SessionRuntimeCreateRequest & { kind: "pwn-session"; pwn: SessionRuntimePwnCreateSpec }): void {
    if (request.pwn.mode !== "remote") return;
    const target = parseEndpoint(request.pwn.endpoint);
    if (!target) throw new Error("Pwn supervisor remote sessions require a valid host:port endpoint");
    const scope = this.remoteScope;
    if (!scope || scope.allowedHosts.length === 0 || scope.allowedPorts.length === 0) throw new Error("Pwn supervisor remote sessions require an explicit deployment scope");
    if (!scope.allowedHosts.some((pattern) => hostMatches(target.host, pattern))) throw new Error(`Pwn supervisor remote endpoint host ${target.host} is outside deployment scope`);
    if (!scope.allowedPorts.includes(target.port)) throw new Error(`Pwn supervisor remote endpoint port ${target.port} is outside deployment scope`);
  }

  private async removeWorkerToken(record: DurablePwnRecord): Promise<void> {
    await unlink(workerTokenPath(record)).catch(() => undefined);
  }

  private async waitForWorker(record: DurablePwnRecord, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Pwn worker start aborted");
      if (await this.probe(record, signal)) return true;
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    return false;
  }

  private async probe(record: DurablePwnRecord, signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.workerFetch(record, WORKER_HEALTH_PATH, { method: "GET" }, signal);
      if (!response.ok || response.status !== 200) return false;
      const health = await parseJson<WorkerHealth>(response, this.timeoutMs);
      return health.schemaVersion === 1
        && health.status === "READY"
        && health.idempotencyKey === record.idempotencyKey
        && health.sessionId === record.sessionId
        && health.externalId === record.externalId;
    } catch {
      return false;
    }
  }

  private async workerRequest(record: DurablePwnRecord, body: Record<string, unknown>, signal?: AbortSignal): Promise<WorkerActionResponse> {
    const response = await this.workerFetch(record, WORKER_ACTION_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, signal);
    return await parseJson<WorkerActionResponse>(response, this.timeoutMs);
  }

  private async workerFetch(record: DurablePwnRecord, path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const mergedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error("Pwn worker RPC timed out")), this.timeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${record.workerToken}`);
      headers.set("accept", "application/json");
      return await fetch(`http://${this.bindHost}:${record.workerPort}${path}`, { ...init, headers, signal: mergedSignal, redirect: "manual" });
    } finally {
      clearTimeout(timer);
    }
  }

  private async findByKey(idempotencyKey: string): Promise<DurablePwnRecord | undefined> {
    const ledger = await this.readLedger();
    const record = findByKey(ledger, idempotencyKey);
    return record ? structuredClone(record) : undefined;
  }

  private async findByExternalId(externalId: string): Promise<DurablePwnRecord | undefined> {
    const ledger = await this.readLedger();
    const record = ledger.records.find((candidate) => candidate.externalId === externalId);
    return record ? structuredClone(record) : undefined;
  }

  private async markActive(idempotencyKey: string): Promise<void> {
    await this.mutate((ledger) => {
      const record = findByKey(ledger, idempotencyKey);
      if (!record || record.state === "RELEASED") return;
      record.state = "ACTIVE";
      record.updatedAt = this.timestamp();
      record.lastSummary = undefined;
    });
  }

  private async markUnknown(idempotencyKey: string, summary: string): Promise<void> {
    await this.mutate((ledger) => {
      const record = findByKey(ledger, idempotencyKey);
      if (!record || record.state === "RELEASED") return;
      record.state = "UNKNOWN";
      record.updatedAt = this.timestamp();
      record.lastSummary = bounded(summary);
    }).catch(() => undefined);
  }

  private async markReleased(idempotencyKey: string, reason: string): Promise<void> {
    await this.mutate((ledger) => {
      const record = findByKey(ledger, idempotencyKey);
      if (!record) return;
      record.state = "RELEASED";
      record.updatedAt = this.timestamp();
      record.lastSummary = bounded(reason);
    });
  }

  private async workerExited(record: DurablePwnRecord): Promise<boolean> {
    try {
      const value = JSON.parse(await readFile(record.transcriptStatePath, "utf8")) as { schemaVersion?: unknown; exited?: unknown };
      return value.schemaVersion === 1 && value.exited === true;
    } catch {
      return false;
    }
  }

  private async readLedger(): Promise<DurablePwnLedger> {
    return await withFileLock(this.lockPath, async () => await this.readLedgerUnlocked(), this.lock);
  }

  private async readLedgerUnlocked(): Promise<DurablePwnLedger> {
    try {
      return parseLedger(JSON.parse(await readFile(this.statePath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: SCHEMA_VERSION, records: [] };
      if (error instanceof SyntaxError) throw new Error("Pwn supervisor ledger is malformed JSON");
      throw error;
    }
  }

  private async mutate(operation: (ledger: DurablePwnLedger) => void): Promise<void> {
    await withFileLock(this.lockPath, async () => {
      const ledger = await this.readLedgerUnlocked();
      operation(ledger);
      await this.writeLedgerUnlocked(ledger);
    }, this.lock);
  }

  private async writeLedgerUnlocked(ledger: DurablePwnLedger): Promise<void> {
    ledger.records.sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey));
    await mkdir(dirname(this.statePath), { recursive: true });
    await atomicWriteFile(this.statePath, `${canonicalJson({ schemaVersion: SCHEMA_VERSION, records: ledger.records.slice(-MAX_RECORDS) })}\n`);
    await chmod(this.statePath, 0o600).catch(() => undefined);
  }

  private timestamp(): string { return new Date(this.now()).toISOString(); }
}

function assertPwnRequest(request: SessionRuntimeCreateRequest): SessionRuntimeCreateRequest & { kind: "pwn-session"; pwn: SessionRuntimePwnCreateSpec } {
  if (request.kind !== "pwn-session" || !request.pwn) throw new Error("Pwn supervisor only supports complete pwn-session requests");
  if (request.pwn.command.length === 0) throw new Error("Pwn supervisor requires a non-empty command");
  if (request.pwn.mode === "remote" && !parseEndpoint(request.pwn.endpoint)) throw new Error("Pwn supervisor remote sessions require a valid host:port endpoint");
  if (request.pwn.mode === "local" && request.pwn.endpoint !== undefined) throw new Error("Pwn supervisor local sessions cannot include an endpoint");
  return request as SessionRuntimeCreateRequest & { kind: "pwn-session"; pwn: SessionRuntimePwnCreateSpec };
}

function assertSameRequest(left: SessionRuntimeCreateRequest, right: SessionRuntimeCreateRequest): void { if (!sameRequest(left, right)) throw new Error("Pwn supervisor idempotency key was reused with a different request"); }
function sameRequest(left: SessionRuntimeCreateRequest, right: SessionRuntimeCreateRequest): boolean { return canonicalJson(left) === canonicalJson(right); }
function describe(record: DurablePwnRecord): SessionRuntimeCreatedSession { return { sessionId: record.sessionId, externalId: record.externalId, stateHash: record.stateHash }; }
function workerTokenPath(record: Pick<DurablePwnRecord, "transcriptStatePath">): string { return `${record.transcriptStatePath}.token`; }
function findByKey(ledger: DurablePwnLedger, key: string): DurablePwnRecord | undefined { return ledger.records.find((record) => record.idempotencyKey === key); }
function sameResourceBinding(record: DurablePwnRecord, resource: SessionRuntimeWireResource): boolean {
  return resource.id === `session:${record.sessionId}`
    && resource.kind === "pwn-session"
    && record.externalId === resource.externalId
    && record.request.runId === resource.runId
    && record.request.generation === resource.generation
    && record.request.ownerLane === resource.ownerLane
    && record.request.requestKey === resource.requestKey
    && record.request.policyHash === resource.policyHash
    && record.request.recipeHash === resource.recipeHash
    && record.request.scopeHash === resource.scopeHash;
}
function assertHash(value: string, label: string): void { if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`Pwn supervisor ${label} must be a sha256 hex value`); }
function normalizeTimeout(value: number | undefined): number { const timeout = value ?? DEFAULT_TIMEOUT_MS; if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120_000) throw new Error("Pwn supervisor timeoutMs must be between 100 and 120000"); return timeout; }
function parseEndpoint(endpoint: string | undefined): { host: string; port: number } | undefined {
  if (typeof endpoint !== "string") return undefined;
  const match = /^([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?):(\d{1,5})$/.exec(endpoint.trim());
  if (!match) return undefined;
  const port = Number(match[2]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? { host: match[1]!.toLowerCase(), port } : undefined;
}
function hostMatches(host: string, pattern: string): boolean {
  const normalized = pattern.trim().toLowerCase();
  if (normalized === "*") return true;
  if (normalized.startsWith("*.")) return host === normalized.slice(2) || host.endsWith(normalized.slice(1));
  return host === normalized;
}
function normalizeDockerPolicy(value: NonNullable<DurablePwnSessionSupervisorOptions["docker"]>): { containerId: string; allowedCommands: readonly string[]; executable: string; allowShellCommands: boolean } {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.containerId)) throw new Error("Pwn Docker containerId is invalid");
  const allowedCommands = [...new Set(value.allowedCommands.map((command) => command.trim()).filter(Boolean))];
  if (allowedCommands.length === 0 || allowedCommands.some((command) => !isSafeText(command, 512))) throw new Error("Pwn Docker allowedCommands must contain safe non-empty values");
  const executable = value.executable?.trim() || "docker";
  if (!isSafeText(executable, 512)) throw new Error("Pwn Docker executable is invalid");
  return { containerId: value.containerId, allowedCommands, executable, allowShellCommands: value.allowShellCommands ?? false };
}
function isShellCommand(command: string): boolean {
  const name = command.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? command.toLowerCase();
  return ["sh", "bash", "dash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "pwsh", "powershell.exe"].includes(name);
}
function encodeData(data: string | Uint8Array): string { return typeof data === "string" ? data : Buffer.from(data).toString("base64"); }
function encodeBase64(value: string): string { return Buffer.from(value, "utf8").toString("base64url"); }
function readOptionsFor(options: ContainerSessionReadOptions | undefined): Record<string, number> { return { ...(options?.waitTimeoutMs === undefined ? {} : { waitTimeoutMs: options.waitTimeoutMs }), ...(options?.idleSilenceMs === undefined ? {} : { idleSilenceMs: options.idleSilenceMs }) }; }
function bounded(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 512); }
function isSafeText(value: unknown, maxLength = 512): value is string { return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value); }
function parseLedger(value: unknown): DurablePwnLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pwn supervisor ledger must be an object");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== SCHEMA_VERSION || !Array.isArray(input.records) || input.records.length > MAX_RECORDS) throw new Error("Pwn supervisor ledger has an unsupported schema or size");
  return { schemaVersion: SCHEMA_VERSION, records: input.records.map(parseRecord) };
}
function parseRecord(value: unknown): DurablePwnRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pwn supervisor ledger record is invalid");
  const input = value as Record<string, unknown>;
  if (typeof input.idempotencyKey !== "string" || !/^[a-f0-9]{64}$/i.test(input.idempotencyKey)
    || typeof input.sessionId !== "string" || !isSafeText(input.sessionId)
    || typeof input.externalId !== "string" || !isSafeText(input.externalId)
    || !["STARTING", "ACTIVE", "UNKNOWN", "RELEASED"].includes(input.state as string)
    || !Number.isSafeInteger(input.workerPort) || (input.workerPort as number) < 1 || (input.workerPort as number) > 65_535
    || !isSafeText(input.workerToken, 256) || !isSafeText(input.transcriptStatePath, 2_048)
    || !/^[a-f0-9]{64}$/i.test(String(input.stateHash)) || typeof input.createdAt !== "string" || typeof input.updatedAt !== "string") throw new Error("Pwn supervisor ledger record is invalid");
  if (input.request === undefined) throw new Error("Pwn supervisor ledger record is missing its request");
  return { ...structuredClone(input) as unknown as DurablePwnRecord, request: assertPwnRequest(input.request as SessionRuntimeCreateRequest) };
}

async function reserveLoopbackPort(host: string): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolveListen());
  });
  const address = server.address();
  await closeServer(server);
  if (!address || typeof address === "string") throw new Error("Pwn supervisor could not reserve a loopback port");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

async function parseJson<T>(response: Response, timeoutMs: number): Promise<T> {
  if (!response.ok) throw new Error(`Pwn worker returned HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Pwn worker response exceeds its byte limit");
  if (!response.body) throw new Error("Pwn worker response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Pwn worker response exceeds its byte limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")) as T; } catch { throw new Error("Pwn worker returned invalid JSON"); }
}

function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Pwn supervisor operation aborted"); }
async function delay(milliseconds: number): Promise<void> { await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds)); }
function isLoopbackHost(value: string): boolean { return value === "127.0.0.1" || value === "::1" || value === "localhost"; }
function sessionResult(value: WorkerActionResponse): ContainerSessionResult {
  return {
    delta: value.delta ?? "",
    waitReason: value.waitReason ?? "idle",
    exited: value.exited ?? false,
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
    truncated: value.truncated ?? false,
  };
}
