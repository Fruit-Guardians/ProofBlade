import type { ControlStore, FixtureControlPort } from "../control/control-store.js";
import { LeaseManager } from "../control/lease-manager.js";
import type { EffectJournal } from "../effects/effect-journal.js";
import type { Lease, TaskContract } from "../domain/types.js";
import type { FixtureHealth, FixtureRef, SandboxPort } from "../sandbox/fixture.js";
import type { SessionRegistry } from "../container/session-registry.js";

export interface RunRecoveryResult {
  fixture: FixtureRef;
  fixtureHealth: FixtureHealth;
  fixtureAction: "none" | "reset";
  expiredLeases: Lease[];
  reconciledEffects: string[];
  reconciledJobs: string[];
  supersededSessions: number;
}

export class RunRecoveryService {
  public constructor(
    private readonly controlStore: ControlStore,
    private readonly effectJournal: EffectJournal,
    private readonly sandbox: SandboxPort,
    private readonly fixtureControl?: FixtureControlPort,
    /**
     * Optional: a fresh SessionRegistry for this process.  A persistent session's
     * docker-exec child dies with the process that spawned it, so on restart any
     * durably-OPEN session is an orphan.  A fresh registry's live map is empty,
     * so supersedeOrphans marks all of them SUPERSEDED — the dead sockets are not
     * revived; a fresh reproduce re-establishes the connection.
     */
    private readonly sessionRegistry?: SessionRegistry,
  ) {}

  public async recover(runId: string, task?: TaskContract, now = Date.now()): Promise<RunRecoveryResult> {
    let snapshot = await this.controlStore.snapshot(runId);
    const expiredLeases = await new LeaseManager(this.controlStore).reapExpired(runId, now);
    // A fresh registry can distinguish live handles from orphaned container
    // sessions. HTTP/browser backends do not have a shared registry yet, so a
    // recovery without one must conservatively supersede every durably OPEN
    // session; no in-memory cookie or browser context can be trusted after a
    // process restart.
    let supersededSessions = this.sessionRegistry ? await this.sessionRegistry.supersedeOrphans() : 0;
    if (!this.sessionRegistry) {
      for (const session of Object.values(snapshot.sessions)) {
        if (session.status !== "OPEN") continue;
        await this.controlStore.dispatch(runId, { type: "session_superseded", sessionId: session.id, reason: "process restart orphaned the session", lane: session.ownerLane });
        supersededSessions += 1;
      }
    }
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
    const reconciledEffects = await this.effectJournal.reconcile(runId);
    return {
      fixture: fixtureResult.fixture,
      fixtureHealth: fixtureResult.health,
      fixtureAction: fixtureResult.action,
      expiredLeases,
      reconciledEffects,
      reconciledJobs,
      supersededSessions,
    };
  }
}
