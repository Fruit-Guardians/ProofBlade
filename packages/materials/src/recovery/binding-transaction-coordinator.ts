import { readFile } from "node:fs/promises";
import { atomicWriteFile, KeyedOperationQueue, withFileLock, type FileLockOptions } from "@proofblade/atoms";
import type { ControlStore } from "../control/control-store.js";
import type { Lane, SessionRecord } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import {
  ExternalResourceRegistry,
  type ExternalResourceKind,
  type ExternalResourceRecord,
  type ExternalResourceRegistration,
} from "./external-resource-registry.js";

const SCHEMA_VERSION = 1 as const;
const MAX_INTENTS = 2_048;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const SESSION_KINDS = new Set<ExternalResourceKind>(["pwn-session", "http-session", "browser-context"]);

export type BindingTransactionState = "PREPARED" | "EXTERNAL_CONFIRMED" | "CONTROL_COMMITTED" | "BOUND" | "UNKNOWN" | "RELEASED";
export type BindingTransactionFaultPoint = "after_external_started" | "after_intent" | "after_external_confirmed" | "after_control_commit" | "after_finalize";

/** Durable intent for one external session to Control Store owner handoff. */
export interface BindingTransactionIntent {
  schemaVersion: typeof SCHEMA_VERSION;
  bindingTxnId: string;
  resourceId: string;
  sessionId: string;
  runId: string;
  generation: number;
  kind: Extract<ExternalResourceKind, "pwn-session" | "http-session" | "browser-context">;
  ownerLane: Lane;
  externalId: string;
  requestKey?: string;
  policyHash?: string;
  recipeHash?: string;
  scopeHash?: string;
  identityHash: string;
  state: BindingTransactionState;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface BindingTransactionPrepareInput {
  sessionId: string;
  resource: ExternalResourceRegistration & { readonly externalId: string };
}

export type SessionOpenedInput = Omit<SessionRecord, "createdSeq" | "updatedSeq" | "status" | "interactions"> & { interactions?: number };

export interface BindingTransactionRecoveryReport {
  repaired: string[];
  bound: string[];
  releaseCandidates: string[];
  manual: string[];
}

interface BindingTransactionFile {
  schemaVersion: typeof SCHEMA_VERSION;
  intents: BindingTransactionIntent[];
}

interface CoordinatorOptions {
  ledgerPath?: string;
  lock?: FileLockOptions;
  now?: () => number;
  /** Optional deployment fault hook used by recovery integration tests. */
  fault?: (point: BindingTransactionFaultPoint) => void | Promise<void>;
}

/**
 * Coordinates the durable handoff between the external-resource ledger and
 * the Control Store. It is a two-phase protocol, not a claim of filesystem
 * multi-file atomicity: every phase is durable, replayable and idempotent.
 */
export class BindingTransactionCoordinator {
  private readonly queue = new KeyedOperationQueue();
  private readonly phaseQueue = new KeyedOperationQueue();
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  private readonly lock: FileLockOptions;
  private readonly now: () => number;

  public constructor(
    private readonly controlStore: ControlStore,
    private readonly externalResources: ExternalResourceRegistry,
    options: CoordinatorOptions = {},
  ) {
    this.ledgerPath = options.ledgerPath ?? externalResources.bindingTransactionsPath;
    this.lockPath = `${this.ledgerPath}.lock`;
    this.lock = options.lock ?? {};
    this.now = options.now ?? Date.now;
    this.fault = options.fault;
  }

  private readonly fault?: (point: BindingTransactionFaultPoint) => void | Promise<void>;

  /** Persist the immutable handoff intent after the external handle is known. */
  public async prepare(input: BindingTransactionPrepareInput): Promise<BindingTransactionIntent> {
    validatePrepareInput(input);
    const resourceId = input.resource.id;
    if (resourceId !== `session:${input.sessionId}`) throw new Error("Binding transaction resource and session ids must match");
    const started = await this.externalResources.registerStarted(input.resource);
    await this.fault?.("after_external_started");
    const identityHash = bindingTransactionIdentityHash(started, input.sessionId);
    const intent = await this.mutate(async (file) => {
      const existing = file.intents.find((intent) => intent.bindingTxnId === started.bindingTxnId);
      if (existing) {
        assertSameIntent(existing, started, input.sessionId, identityHash);
        return structuredClone(existing);
      }
      if (file.intents.length >= MAX_INTENTS) throw new Error("Binding transaction journal is full");
      const timestamp = new Date(this.now()).toISOString();
      const intent: BindingTransactionIntent = {
        schemaVersion: SCHEMA_VERSION,
        bindingTxnId: started.bindingTxnId!,
        resourceId,
        sessionId: input.sessionId,
        runId: started.runId,
        generation: started.generation,
        kind: started.kind as BindingTransactionIntent["kind"],
        ownerLane: started.ownerLane,
        externalId: started.externalId!,
        ...(started.requestKey ? { requestKey: started.requestKey } : {}),
        ...(started.policyHash ? { policyHash: started.policyHash } : {}),
        ...(started.recipeHash ? { recipeHash: started.recipeHash } : {}),
        ...(started.scopeHash ? { scopeHash: started.scopeHash } : {}),
        identityHash,
        state: "PREPARED",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      file.intents.push(intent);
      return structuredClone(intent);
    });
    await this.fault?.("after_intent");
    return intent;
  }

  /** Write the Control Store owner event exactly once for a prepared intent. */
  public async commitControl(intentOrId: BindingTransactionIntent | string, session: SessionOpenedInput): Promise<BindingTransactionIntent> {
    const bindingTxnId = typeof intentOrId === "string" ? intentOrId : intentOrId.bindingTxnId;
    return await this.phaseQueue.run(`commit:${bindingTxnId}`, async () => await this.commitControlInternal(intentOrId, session));
  }

  /**
   * Persist that a backend inspect/adopt confirmed the exact external handle.
   * This is deliberately separate from the Control Store commit: the two
   * ledgers cannot share one filesystem transaction, so recovery needs a
   * durable marker for the externally-confirmed half of the handoff.
   */
  public async markExternalConfirmed(intentOrId: BindingTransactionIntent | string): Promise<BindingTransactionIntent> {
    const intent = await this.requireIntent(intentOrId);
    if (intent.state === "BOUND" || intent.state === "EXTERNAL_CONFIRMED") return intent;
    if (intent.state === "RELEASED") throw new Error(`Binding transaction ${intent.bindingTxnId} is already released`);
    const resource = await this.externalResources.get(intent.resourceId);
    if (!resource) throw new Error(`Binding transaction ${intent.bindingTxnId} has no external resource`);
    assertIntentResource(intent, resource);
    if (resource.state !== "CONFIRMED") throw new Error(`Binding transaction ${intent.bindingTxnId} requires a confirmed external resource`);
    if (intent.state === "CONTROL_COMMITTED") return intent;
    const confirmed = await this.transition(intent.bindingTxnId, "EXTERNAL_CONFIRMED");
    await this.fault?.("after_external_confirmed");
    return confirmed;
  }

  private async commitControlInternal(intentOrId: BindingTransactionIntent | string, session: SessionOpenedInput): Promise<BindingTransactionIntent> {
    const intent = await this.requireIntent(intentOrId);
    if (session.id !== intent.sessionId || session.runId !== intent.runId || session.generation !== intent.generation) {
      throw new Error(`Binding transaction ${intent.bindingTxnId} session identity mismatch`);
    }
    const resource = await this.externalResources.get(intent.resourceId);
    if (!resource) throw new Error(`Binding transaction ${intent.bindingTxnId} has no external resource`);
    assertIntentResource(intent, resource);
    if (session.externalId !== intent.externalId) throw new Error(`Binding transaction ${intent.bindingTxnId} external handle mismatch`);
    const identityHash = bindingTransactionIdentityHash(resource, intent.sessionId);
    if (identityHash !== intent.identityHash) throw new Error(`Binding transaction ${intent.bindingTxnId} identity hash mismatch`);
    // Use ControlStore's transaction callback so the existence check and the
    // owner event are performed under the same cross-process Run lock. A
    // process-local queue alone cannot prevent two service processes from
    // both observing an empty projection and appending duplicate owners.
    await this.controlStore.dispatchBindingTransaction(intent.runId, (snapshot) => {
      const existing = snapshot.sessions[intent.sessionId];
      if (existing) {
        assertSessionMatchesIntent(existing, intent);
        if (existing.status !== "OPEN") throw new Error(`Binding transaction ${intent.bindingTxnId} owner is ${existing.status}`);
        return { commands: [], project: () => undefined };
      }
      return {
        commands: [{
          type: "session_opened" as const,
          session: {
            ...session,
            bindingTxnId: intent.bindingTxnId,
            bindingIdentityHash: intent.identityHash,
            bindingState: "FINALIZING",
          },
          lane: session.ownerLane,
        }],
        project: () => undefined,
      };
    });
    await this.fault?.("after_control_commit");
    return await this.transition(intent.bindingTxnId, "CONTROL_COMMITTED");
  }

  /** Finalize the registry marker after the Control Store owner is durable. */
  public async finalize(intentOrId: BindingTransactionIntent | string): Promise<BindingTransactionIntent> {
    let intent = await this.requireIntent(intentOrId);
    if (intent.state === "BOUND") return intent;
    const snapshot = await this.controlStore.snapshot(intent.runId);
    const session = snapshot.sessions[intent.sessionId];
    if (!session || session.status !== "OPEN") throw new Error(`Binding transaction ${intent.bindingTxnId} has no OPEN Control Store owner`);
    assertSessionMatchesIntent(session, intent);
    if (intent.state === "PREPARED" || intent.state === "EXTERNAL_CONFIRMED") {
      intent = await this.transition(intent.bindingTxnId, "CONTROL_COMMITTED");
    }
    const resource = await this.externalResources.get(intent.resourceId);
    if (!resource || resource.controlSessionId !== intent.sessionId) {
      await this.externalResources.markControlBound(intent.resourceId, intent.sessionId, intent.bindingTxnId);
    }
    await this.completeControlBinding(intent);
    await this.fault?.("after_finalize");
    return await this.transition(intent.bindingTxnId, "BOUND");
  }

  /** Mark a binding terminal after its exact external resource was released. */
  public async markReleased(intentOrId: BindingTransactionIntent | string): Promise<BindingTransactionIntent> {
    const intent = await this.requireIntent(intentOrId);
    if (intent.state === "RELEASED") return intent;
    if (intent.state === "BOUND") throw new Error(`Binding transaction ${intent.bindingTxnId} is already bound`);
    return await this.transition(intent.bindingTxnId, "RELEASED");
  }

  public async get(bindingTxnId: string): Promise<BindingTransactionIntent | undefined> {
    return await this.read(async (file) => {
      const intent = file.intents.find((value) => value.bindingTxnId === bindingTxnId);
      return intent ? structuredClone(intent) : undefined;
    });
  }

  public async intents(runId?: string): Promise<BindingTransactionIntent[]> {
    return await this.read(async (file) => file.intents.filter((intent) => runId === undefined || intent.runId === runId).map((intent) => structuredClone(intent)));
  }

  /** Repair only durable metadata, leaving backend inspect/adopt/release to recovery. */
  public async recover(runId: string, currentGeneration: number): Promise<BindingTransactionRecoveryReport> {
    const snapshot = await this.controlStore.snapshot(runId);
    const report: BindingTransactionRecoveryReport = { repaired: [], bound: [], releaseCandidates: [], manual: [] };
    for (const intent of await this.intents(runId)) {
      if (intent.state === "BOUND" || intent.state === "RELEASED") continue;
      const resource = await this.externalResources.get(intent.resourceId);
      const session = snapshot.sessions[intent.sessionId];
      if (!resource || intent.generation !== currentGeneration || resource.generation !== currentGeneration) {
        report.manual.push(intent.bindingTxnId);
        continue;
      }
      if (!session) {
        if (resource.externalId && resource.state !== "PROPOSED") report.releaseCandidates.push(intent.bindingTxnId);
        else report.manual.push(intent.bindingTxnId);
        continue;
      }
      try {
        assertIntentResource(intent, resource);
        assertSessionMatchesIntent(session, intent);
      } catch {
        report.manual.push(intent.bindingTxnId);
        continue;
      }
      if (session.status !== "OPEN") {
        report.releaseCandidates.push(intent.bindingTxnId);
        continue;
      }
      if (resource.controlSessionId === intent.sessionId) {
        try {
          if (session.bindingState === "FINALIZING") await this.completeControlBinding(intent);
          await this.transition(intent.bindingTxnId, "BOUND");
          report.bound.push(intent.bindingTxnId);
        } catch {
          report.manual.push(intent.bindingTxnId);
        }
        continue;
      }
      // The Control Store owner event may be durable while the external
      // handle is still STARTED/UNKNOWN. That is not proof that the host
      // survived a restart. Only a backend inspect/adopt pass may promote
      // the missing control-session marker; otherwise leave the transaction
      // in manual recovery and never fabricate a BOUND relationship.
      if (resource.state !== "CONFIRMED") {
        report.manual.push(intent.bindingTxnId);
        continue;
      }
      let confirmed = intent;
      if (confirmed.state === "PREPARED" || confirmed.state === "UNKNOWN") confirmed = await this.markExternalConfirmed(confirmed);
      if (confirmed.state === "EXTERNAL_CONFIRMED") await this.transition(confirmed.bindingTxnId, "CONTROL_COMMITTED");
      try {
        await this.externalResources.markControlBound(intent.resourceId, intent.sessionId, intent.bindingTxnId);
        if (session.bindingState === "FINALIZING") await this.completeControlBinding(intent);
        await this.transition(intent.bindingTxnId, "BOUND");
        report.repaired.push(intent.bindingTxnId);
      } catch {
        report.manual.push(intent.bindingTxnId);
      }
    }
    return report;
  }

  private async requireIntent(intentOrId: BindingTransactionIntent | string): Promise<BindingTransactionIntent> {
    const intent = typeof intentOrId === "string" ? await this.get(intentOrId) : intentOrId;
    if (!intent) throw new Error(`Unknown binding transaction: ${typeof intentOrId === "string" ? intentOrId : intentOrId.bindingTxnId}`);
    return intent;
  }

  /**
   * Complete the Control Store half of the handoff under the Run lock.  The
   * reducer re-checks OPEN plus the immutable binding markers, so a concurrent
   * close cannot turn an external marker into a falsely BOUND session.
   */
  private async completeControlBinding(intent: BindingTransactionIntent): Promise<void> {
    await this.controlStore.dispatchBindingTransaction(intent.runId, (snapshot) => {
      const session = snapshot.sessions[intent.sessionId];
      if (!session) throw new Error(`Binding transaction ${intent.bindingTxnId} has no Control Store owner`);
      assertSessionMatchesIntent(session, intent);
      if (session.status !== "OPEN") throw new Error(`Binding transaction ${intent.bindingTxnId} owner is ${session.status}`);
      if (session.bindingState === "BOUND") return { commands: [], project: () => undefined };
      if (session.bindingState !== "FINALIZING") throw new Error(`Binding transaction ${intent.bindingTxnId} owner is not FINALIZING`);
      return {
        commands: [{
          type: "session_binding_completed" as const,
          sessionId: intent.sessionId,
          bindingTxnId: intent.bindingTxnId,
          bindingIdentityHash: intent.identityHash,
          lane: session.ownerLane,
        }],
        project: () => undefined,
      };
    });
  }

  private async transition(bindingTxnId: string, state: BindingTransactionState, error?: string): Promise<BindingTransactionIntent> {
    return await this.mutate(async (file) => {
      const intent = file.intents.find((value) => value.bindingTxnId === bindingTxnId);
      if (!intent) throw new Error(`Unknown binding transaction: ${bindingTxnId}`);
      if ((intent.state === "BOUND" && state !== "BOUND") || (intent.state === "RELEASED" && state !== "RELEASED")) return structuredClone(intent);
      if (intent.state === state && error === undefined) return structuredClone(intent);
      if (!isAllowedTransition(intent.state, state)) throw new Error(`Binding transaction ${bindingTxnId} cannot transition ${intent.state} to ${state}`);
      intent.state = state;
      intent.updatedAt = new Date(this.now()).toISOString();
      if (error) intent.lastError = bounded(error);
      else if (state === "BOUND") delete intent.lastError;
      return structuredClone(intent);
    });
  }

  private async read<TResult>(operation: (file: BindingTransactionFile) => Promise<TResult>): Promise<TResult> {
    return await this.queue.run(this.ledgerPath, async () => await withFileLock(this.lockPath, async () => await operation(await this.load()), this.lock));
  }

  private async mutate<TResult>(operation: (file: BindingTransactionFile) => Promise<TResult>): Promise<TResult> {
    return await this.queue.run(this.ledgerPath, async () => await withFileLock(this.lockPath, async () => {
      const file = await this.load();
      const result = await operation(file);
      await this.persist(file);
      return result;
    }, this.lock));
  }

  private async load(): Promise<BindingTransactionFile> {
    try {
      const parsed = JSON.parse(await readFile(this.ledgerPath, "utf8")) as unknown;
      if (!isFile(parsed)) throw new Error("Binding transaction journal has an unsupported schema");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: SCHEMA_VERSION, intents: [] };
      throw new Error(`Binding transaction journal is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async persist(file: BindingTransactionFile): Promise<void> {
    file.intents.sort((left, right) => left.bindingTxnId.localeCompare(right.bindingTxnId));
    await atomicWriteFile(this.ledgerPath, `${canonicalJson({ schemaVersion: SCHEMA_VERSION, intents: file.intents.slice(-MAX_INTENTS) })}\n`);
  }
}

export function bindingTransactionIdentityHash(
  resource: Pick<ExternalResourceRecord, "id" | "kind" | "runId" | "generation" | "ownerLane" | "externalId" | "requestKey" | "policyHash" | "recipeHash" | "scopeHash">,
  sessionId: string,
): string {
  return sha256(canonicalJson({
    schemaVersion: SCHEMA_VERSION,
    binding: "session-handoff",
    resourceId: resource.id,
    sessionId,
    kind: resource.kind,
    runId: resource.runId,
    generation: resource.generation,
    ownerLane: resource.ownerLane,
    externalId: resource.externalId,
    ...(resource.requestKey ? { requestKey: resource.requestKey } : {}),
    ...(resource.policyHash ? { policyHash: resource.policyHash } : {}),
    ...(resource.recipeHash ? { recipeHash: resource.recipeHash } : {}),
    ...(resource.scopeHash ? { scopeHash: resource.scopeHash } : {}),
  }));
}

function validatePrepareInput(input: BindingTransactionPrepareInput): void {
  if (!input.sessionId.trim() || input.sessionId.length > 512 || /[\u0000-\u001f\u007f]/.test(input.sessionId)) throw new Error("Binding transaction session id is invalid");
  if (!SESSION_KINDS.has(input.resource.kind)) throw new Error(`Binding transactions do not support ${input.resource.kind}`);
  if (!input.resource.externalId.trim()) throw new Error("Binding transaction external id is required");
}

function assertSameIntent(intent: BindingTransactionIntent, resource: ExternalResourceRecord, sessionId: string, identityHash: string): void {
  if (intent.resourceId !== resource.id || intent.sessionId !== sessionId || intent.identityHash !== identityHash) throw new Error(`Binding transaction ${intent.bindingTxnId} immutable identity mismatch`);
  assertIntentResource(intent, resource);
}

function assertIntentResource(intent: BindingTransactionIntent, resource: ExternalResourceRecord): void {
  if (resource.id !== intent.resourceId || resource.kind !== intent.kind || resource.runId !== intent.runId || resource.generation !== intent.generation || resource.ownerLane !== intent.ownerLane || resource.externalId !== intent.externalId || resource.bindingTxnId !== intent.bindingTxnId) {
    throw new Error(`Binding transaction ${intent.bindingTxnId} resource identity mismatch`);
  }
  if (bindingTransactionIdentityHash(resource, intent.sessionId) !== intent.identityHash) throw new Error(`Binding transaction ${intent.bindingTxnId} identity hash mismatch`);
}

function assertSessionMatchesIntent(session: Pick<SessionRecord, "id" | "runId" | "kind" | "ownerLane" | "generation" | "status" | "externalId" | "bindingTxnId" | "bindingIdentityHash">, intent: BindingTransactionIntent): void {
  const expectedKind = intent.kind === "pwn-session" ? ["pwn-local", "pwn-remote"] : intent.kind === "http-session" ? ["http"] : ["browser"];
  if (session.id !== intent.sessionId || session.runId !== intent.runId || session.generation !== intent.generation || session.ownerLane !== intent.ownerLane || !expectedKind.includes(session.kind) || session.externalId !== intent.externalId || session.bindingTxnId !== intent.bindingTxnId || (session.bindingIdentityHash !== undefined && session.bindingIdentityHash !== intent.identityHash)) {
    throw new Error(`Binding transaction ${intent.bindingTxnId} Control Store identity mismatch`);
  }
}

function isAllowedTransition(from: BindingTransactionState, to: BindingTransactionState): boolean {
  if (from === "PREPARED") return to === "EXTERNAL_CONFIRMED" || to === "CONTROL_COMMITTED" || to === "UNKNOWN" || to === "RELEASED";
  if (from === "EXTERNAL_CONFIRMED") return to === "CONTROL_COMMITTED" || to === "BOUND" || to === "UNKNOWN" || to === "RELEASED";
  if (from === "CONTROL_COMMITTED") return to === "BOUND" || to === "UNKNOWN" || to === "RELEASED";
  if (from === "UNKNOWN") return to === "EXTERNAL_CONFIRMED" || to === "CONTROL_COMMITTED" || to === "BOUND" || to === "UNKNOWN" || to === "RELEASED";
  if (from === "RELEASED") return to === "RELEASED";
  return to === "BOUND";
}

function isFile(value: unknown): value is BindingTransactionFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.schemaVersion === SCHEMA_VERSION && Array.isArray(input.intents) && input.intents.length <= MAX_INTENTS && input.intents.every(isIntent);
}

function isIntent(value: unknown): value is BindingTransactionIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.schemaVersion === SCHEMA_VERSION
    && typeof input.bindingTxnId === "string" && HASH_PATTERN.test(input.bindingTxnId)
    && typeof input.resourceId === "string" && input.resourceId.length > 0
    && typeof input.sessionId === "string" && input.sessionId.length > 0
    && typeof input.runId === "string" && input.runId.length > 0
    && Number.isInteger(input.generation) && (input.generation as number) >= 0
    && SESSION_KINDS.has(input.kind as ExternalResourceKind)
    && ["main", "planner", "executor", "verifier", "system"].includes(input.ownerLane as string)
    && typeof input.externalId === "string" && input.externalId.length > 0
    && HASH_PATTERN.test(String(input.identityHash))
    && ["PREPARED", "EXTERNAL_CONFIRMED", "CONTROL_COMMITTED", "BOUND", "UNKNOWN", "RELEASED"].includes(input.state as string)
    && typeof input.createdAt === "string" && typeof input.updatedAt === "string";
}

function bounded(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1_024);
}
