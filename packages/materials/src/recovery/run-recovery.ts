import type { ControlStore, FixtureControlPort, VerificationRecoveryControlPort } from "../control/control-store.js";
import { LeaseManager } from "../control/lease-manager.js";
import type { EffectJournal } from "../effects/effect-journal.js";
import type { Lease, TaskContract } from "../domain/types.js";
import type { FixtureHealth, FixtureRef, SandboxPort } from "../sandbox/fixture.js";
import type { SessionRegistry } from "../container/session-registry.js";
import { resolveExternalResourceAdapters, type ExternalResourceAdapter, type ExternalResourceAdapterSource, type ExternalResourceReconcileResult, type ExternalResourceRegistry } from "./external-resource-registry.js";
import type { SessionRuntimeBindingSource, SessionRuntimeHandoff } from "./session-resource-adapter.js";
import type { BrowserRuntimeBindingSource, BrowserRuntimeHandoff } from "../web/browser-resource-adapter.js";
import { resolveVerificationRecoveryAdapters, SandboxClaimRecoveryAdapter, VerificationRecoveryAdapterRegistry, VerificationRecoveryService, type VerificationRecoveryAdapterSource, type VerificationRecoveryReport } from "./verification-recovery.js";
import { classifyExternalBinding } from "./binding-transaction.js";
import { BindingTransactionCoordinator, type BindingTransactionRecoveryReport } from "./binding-transaction-coordinator.js";

export interface RunRecoveryResult {
  fixture: FixtureRef;
  fixtureHealth: FixtureHealth;
  fixtureAction: "none" | "reset";
  projectionRepaired: boolean;
  expiredLeases: Lease[];
  reconciledEffects: string[];
  reconciledJobs: string[];
  supersededSessions: number;
  externalResources?: ExternalResourceReconcileResult;
  bindingTransactions?: BindingTransactionRecoveryReport;
  /** Broker bindings retained for the next process-local lane to adopt. */
  sessionHandoffs: SessionRuntimeHandoff[];
  /** Broker bindings retained for the verifier that will resume a browser replay. */
  browserHandoffs: BrowserRuntimeHandoff[];
  verification: VerificationRecoveryReport;
}

export class RunRecoveryService {
  public constructor(
    private readonly controlStore: ControlStore,
    private readonly effectJournal: EffectJournal,
    private readonly sandbox: SandboxPort,
    private readonly fixtureControl?: FixtureControlPort,
    /** Optional process-local registry used to supersede sessions not handed off by a broker. */
    private readonly sessionRegistry?: SessionRegistry,
    private readonly verificationRecovery?: VerificationRecoveryControlPort,
    /** Optional static adapters or a factory bound to the recovered fixture. */
    private readonly verificationAdapters?: VerificationRecoveryAdapterSource,
    /** Optional durable registry for non-ControlStore external resources. */
    private readonly externalResources?: ExternalResourceRegistry,
    /** Adapters are resolved after the current Run generation is known. */
    private readonly externalResourceAdapters?: ExternalResourceAdapterSource,
  ) {}

  public async recover(runId: string, task?: TaskContract, now = Date.now()): Promise<RunRecoveryResult> {
    const projection = await this.controlStore.reconcileProjection(runId);
    let snapshot = await this.controlStore.snapshot(runId);
    const expiredLeases = await new LeaseManager(this.controlStore).reapExpired(runId, now);
    const fixtureResult = await this.sandbox.reconcileFixture(
      task ?? snapshot.task,
      snapshot.generation,
      this.fixtureControl ? async () => await this.fixtureControl!.assertResetAllowed(runId) : undefined,
    );
    const reconciledJobs: string[] = [];
    if (fixtureResult.action === "reset") {
      if (this.fixtureControl) await this.fixtureControl.reset(runId, fixtureResult.generation);
      snapshot = await this.controlStore.snapshot(runId);
      for (const job of Object.values(snapshot.jobs)) {
        if (job.status !== "QUEUED" && job.status !== "RUNNING") continue;
        await this.controlStore.dispatch(runId, {
          type: "job_reconciled",
          jobId: job.id,
          reason: `Fixture lifecycle changed from ${fixtureResult.health.status}; generation ${fixtureResult.generation} requires an explicit retry.`,
          lane: "main",
        });
        reconciledJobs.push(job.id);
      }
    }
    // External resources must be reconciled before local sessions are
    // superseded. A successful broker adoption returns a process-local binding
    // for the lane; a missing/ambiguous binding remains UNKNOWN and is not
    // protected from orphan cleanup.
    snapshot = await this.controlStore.snapshot(runId);
    const resolvedExternalAdapters = this.externalResources
      ? await resolveExternalResourceAdapters(this.externalResourceAdapters, { runId, generation: snapshot.generation })
      : [];
    const bindingCoordinator = this.externalResources
      ? new BindingTransactionCoordinator(this.controlStore, this.externalResources)
      : undefined;
    const unboundExternalResources = this.externalResources
      ? await releaseUnboundSessionResources(snapshot, this.externalResources, resolvedExternalAdapters, runId, bindingCoordinator)
      : { released: [], failed: [] };
    const externalResources = this.externalResources
      ? await this.externalResources.reconcileRun(runId, snapshot.generation, resolvedExternalAdapters, undefined, { skipIds: unboundExternalResources.failed })
      : undefined;
    if (externalResources) {
      externalResources.examined += unboundExternalResources.released.length;
      externalResources.released.unshift(...unboundExternalResources.released);
      externalResources.failed.unshift(...unboundExternalResources.failed);
    }
    // A Control Store owner must not be promoted to BOUND from a STARTED or
    // UNKNOWN resource. Inspect/adopt has to prove the exact external handle
    // first; otherwise a missing or ambiguous host could be mistaken for a
    // recoverable session. The coordinator is intentionally run after the
    // external-resource reconcile pass for this reason.
    const bindingTransactions = bindingCoordinator
      ? await bindingCoordinator.recover(runId, snapshot.generation)
      : undefined;
    if (this.externalResources) await repairControlBindingMarkers(snapshot, this.externalResources, runId);
    const sessionHandoffs = this.externalResources && externalResources
      ? await collectSessionHandoffs(this.externalResources, externalResources.adopted, resolvedExternalAdapters)
      : [];
    let browserHandoffs = this.externalResources && externalResources
      ? await collectBrowserHandoffs(this.externalResources, externalResources.adopted, resolvedExternalAdapters)
      : [];
    // Generic sandbox recovery may safely rerun ordinary pure Effects, but it
    // must not guess about verifier-owned external work. Those requests are
    // inspected by the dedicated recovery service below and resumed only by a
    // verifier/backend with an explicit reconciliation primitive.
    const reconciledEffects = await this.effectJournal.reconcile(runId, { skipVerifierEffects: true });
    snapshot = await this.controlStore.snapshot(runId);
    const configuredAdapters = await resolveVerificationRecoveryAdapters(this.verificationAdapters, {
      runId,
      task: task ?? snapshot.task,
      snapshot,
      fixture: fixtureResult.fixture,
    });
    const adapterRegistry = configuredAdapters.get("claim")
      ? configuredAdapters
      : new VerificationRecoveryAdapterRegistry([...configuredAdapters.list(), new SandboxClaimRecoveryAdapter(this.sandbox)]);
    const verification = await new VerificationRecoveryService(this.controlStore, this.effectJournal, adapterRegistry, this.verificationRecovery).reconcile(runId);
    const browserCleanup = await releaseFinishedBrowserHandoffs(this.controlStore, this.externalResources, browserHandoffs, resolvedExternalAdapters, runId);
    browserHandoffs = browserCleanup.handoffs;
    if (externalResources) {
      for (const resourceId of browserCleanup.released) if (!externalResources.released.includes(resourceId)) externalResources.released.push(resourceId);
      for (const resourceId of browserCleanup.failed) if (!externalResources.failed.includes(resourceId)) externalResources.failed.push(resourceId);
    }
    snapshot = await this.controlStore.snapshot(runId);
    const protectedSessionIds = new Set([
      ...sessionHandoffs.map((handoff) => sessionIdFromResourceId(handoff.resourceId)),
      ...browserHandoffs.map((handoff) => sessionIdFromResourceId(handoff.resourceId)),
    ].filter((id): id is string => id !== undefined));
    let supersededSessions = this.sessionRegistry ? await this.sessionRegistry.supersedeOrphans("process restart orphaned the session", protectedSessionIds) : 0;
    if (!this.sessionRegistry) {
      for (const session of Object.values(snapshot.sessions)) {
        if (session.status !== "OPEN" || protectedSessionIds.has(session.id)) continue;
        await this.controlStore.dispatch(runId, { type: "session_superseded", sessionId: session.id, reason: "process restart orphaned the session", lane: session.ownerLane });
        supersededSessions += 1;
      }
    }
    return {
      fixture: fixtureResult.fixture,
      fixtureHealth: fixtureResult.health,
      fixtureAction: fixtureResult.action,
      projectionRepaired: projection.repaired,
      expiredLeases,
      reconciledEffects,
      reconciledJobs,
      supersededSessions,
      ...(externalResources ? { externalResources } : {}),
      ...(bindingTransactions ? { bindingTransactions } : {}),
      sessionHandoffs,
      browserHandoffs,
      verification,
    };
  }
}

async function releaseFinishedBrowserHandoffs(
  controlStore: ControlStore,
  registry: ExternalResourceRegistry | undefined,
  handoffs: BrowserRuntimeHandoff[],
  adapters: readonly ExternalResourceAdapter[],
  runId: string,
): Promise<{ handoffs: BrowserRuntimeHandoff[]; released: string[]; failed: string[] }> {
  if (!registry || handoffs.length === 0) return { handoffs, released: [], failed: [] };
  const snapshot = await controlStore.snapshot(runId);
  const finishedSessionIds = new Set(Object.values(snapshot.effects)
    .filter((effect) => effect.producerLane === "verifier" && effect.operation === "verification_replay" && effect.status === "FINISHED" && effect.sessionId)
    .map((effect) => effect.sessionId!));
  if (finishedSessionIds.size === 0) return { handoffs, released: [], failed: [] };
  const browserAdapter = adapters.find((adapter) => adapter.kind === "browser-context");
  if (!browserAdapter) return { handoffs, released: [], failed: [] };
  const retained: BrowserRuntimeHandoff[] = [];
  const released: string[] = [];
  const failed: string[] = [];
  for (const handoff of handoffs) {
    const sessionId = sessionIdFromResourceId(handoff.resourceId);
    if (!sessionId || !finishedSessionIds.has(sessionId)) {
      retained.push(handoff);
      continue;
    }
    const didRelease = await registry.release(handoff.resourceId, browserAdapter, "verifier replay reached a durable terminal result");
    if (!didRelease) {
      retained.push(handoff);
      failed.push(handoff.resourceId);
      continue;
    }
    released.push(handoff.resourceId);
    const current = (await controlStore.snapshot(runId)).sessions[sessionId];
    if (current && current.status === "OPEN") {
      await controlStore.dispatch(runId, { type: "session_closed", sessionId, reason: "verifier replay reached a durable terminal result", exitCode: 0, lane: current.ownerLane });
    }
  }
  return { handoffs: retained, released, failed };
}

async function collectSessionHandoffs(
  registry: ExternalResourceRegistry,
  adoptedResourceIds: readonly string[],
  adapters: readonly ExternalResourceAdapter[],
): Promise<SessionRuntimeHandoff[]> {
  const adopted = new Set(adoptedResourceIds);
  const records = new Map((await registry.records()).map((record) => [record.id, record]));
  const handoffs: SessionRuntimeHandoff[] = [];
  for (const adapter of adapters) {
    if (!isSessionRuntimeBindingSource(adapter)) continue;
    for (const resourceId of adopted) {
      const record = records.get(resourceId);
      if (!record || (record.kind !== "pwn-session" && record.kind !== "http-session")) continue;
      const binding = adapter.takeBinding(resourceId);
      if (!binding) continue;
      handoffs.push({ resourceId, record, binding });
    }
  }
  return handoffs;
}

async function collectBrowserHandoffs(
  registry: ExternalResourceRegistry,
  adoptedResourceIds: readonly string[],
  adapters: readonly ExternalResourceAdapter[],
): Promise<BrowserRuntimeHandoff[]> {
  const adopted = new Set(adoptedResourceIds);
  const records = new Map((await registry.records()).map((record) => [record.id, record]));
  const handoffs: BrowserRuntimeHandoff[] = [];
  for (const adapter of adapters) {
    if (!isBrowserRuntimeBindingSource(adapter)) continue;
    for (const resourceId of adopted) {
      const record = records.get(resourceId);
      if (!record || record.kind !== "browser-context") continue;
      const binding = adapter.takeBinding(resourceId);
      if (!binding) continue;
      handoffs.push({ resourceId, record, binding });
    }
  }
  return handoffs;
}

function isSessionRuntimeBindingSource(value: ExternalResourceAdapter): value is ExternalResourceAdapter & SessionRuntimeBindingSource {
  return typeof (value as Partial<SessionRuntimeBindingSource>).takeBinding === "function";
}

function isBrowserRuntimeBindingSource(value: ExternalResourceAdapter): value is ExternalResourceAdapter & BrowserRuntimeBindingSource {
  return typeof (value as Partial<BrowserRuntimeBindingSource>).takeBinding === "function"
    && value.kind === "browser-context";
}

function sessionIdFromResourceId(resourceId: string): string | undefined {
  return resourceId.startsWith("session:") ? resourceId.slice("session:".length) : undefined;
}

/**
 * A session resource can be durably STARTED just before its Control Store
 * `session_opened` event. If recovery finds no matching session record, the
 * external action has no durable owner and must be released or left UNKNOWN;
 * it must never be adopted into a new lane.
 */
async function releaseUnboundSessionResources(
  snapshot: Awaited<ReturnType<ControlStore["snapshot"]>>,
  registry: ExternalResourceRegistry,
  adapters: readonly ExternalResourceAdapter[],
  runId: string,
  bindingCoordinator?: BindingTransactionCoordinator,
): Promise<{ released: string[]; failed: string[] }> {
  const adapterByKind = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
  const released: string[] = [];
  const failed: string[] = [];
  for (const record of await registry.records(runId)) {
    const sessionId = sessionIdFromResourceId(record.id);
    if (!sessionId) continue;
    const decision = classifyExternalBinding({ resource: record, controlSession: snapshot.sessions[sessionId] });
    if (decision.action === "NONE" || decision.action === "ADOPT" || decision.action === "RECONCILE") continue;
    if (decision.action === "MANUAL") {
      await registry.markUnknown(record.id, decision.reason);
      failed.push(record.id);
      continue;
    }
    if (record.state === "PROPOSED") {
      await registry.markReleased(record.id, "session start never committed to the Control Store");
      await markBindingReleased(bindingCoordinator, record.bindingTxnId);
      released.push(record.id);
      continue;
    }
    const adapter = adapterByKind.get(record.kind);
    if (!adapter) {
      await registry.markUnknown(record.id, "session resource has no durable Control Store owner or recovery adapter");
      failed.push(record.id);
      continue;
    }
    if (await registry.release(record.id, adapter, "session start never committed to the Control Store")) {
      await markBindingReleased(bindingCoordinator, record.bindingTxnId);
      released.push(record.id);
    } else failed.push(record.id);
  }
  return { released, failed };
}

async function markBindingReleased(coordinator: BindingTransactionCoordinator | undefined, bindingTxnId: string | undefined): Promise<void> {
  if (!coordinator || !bindingTxnId) return;
  await coordinator.markReleased(bindingTxnId).catch(() => undefined);
}

/**
 * Finish the durable owner marker after a crash between Control Store commit
 * and External Resource finalization. This is deliberately a metadata-only
 * repair: the pure classifier must prove the exact OPEN owner before the
 * marker is written, and no external backend is contacted here.
 */
async function repairControlBindingMarkers(
  snapshot: Awaited<ReturnType<ControlStore["snapshot"]>>,
  registry: ExternalResourceRegistry,
  runId: string,
): Promise<void> {
  for (const resource of await registry.records(runId)) {
    const sessionId = sessionIdFromResourceId(resource.id);
    if (!sessionId || resource.controlSessionId !== undefined) continue;
    // Legacy records have no BindingTransactionCoordinator intent to carry
    // the handoff state. Their immutable identity is not proof that the
    // external handle still exists, so only a prior backend confirmation may
    // authorize repairing the missing marker.
    if (resource.state !== "CONFIRMED") continue;
    const session = snapshot.sessions[sessionId];
    const decision = classifyExternalBinding({ resource, controlSession: session });
    if (decision.action !== "RECONCILE" || !session || session.status !== "OPEN") continue;
    try {
      await registry.markControlBound(resource.id, session.id, decision.bindingTxnId);
    } catch {
      // A concurrent owner change or an immutable binding mismatch remains
      // recoverable through the normal UNKNOWN/MANUAL path; never guess here.
    }
  }
}
