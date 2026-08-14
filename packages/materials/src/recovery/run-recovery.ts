import type { ControlStore } from "../control/control-store.js";
import { LeaseManager } from "../control/lease-manager.js";
import type { EffectJournal } from "../effects/effect-journal.js";
import type { Lease, TaskContract } from "../domain/types.js";
import type { FixtureHealth, FixtureRef, SandboxPort } from "../sandbox/fixture.js";

export interface RunRecoveryResult {
  fixture: FixtureRef;
  fixtureHealth: FixtureHealth;
  fixtureAction: "none" | "reset";
  expiredLeases: Lease[];
  reconciledEffects: string[];
  reconciledJobs: string[];
}

export class RunRecoveryService {
  public constructor(
    private readonly controlStore: ControlStore,
    private readonly effectJournal: EffectJournal,
    private readonly sandbox: SandboxPort,
  ) {}

  public async recover(runId: string, task?: TaskContract, now = Date.now()): Promise<RunRecoveryResult> {
    let snapshot = await this.controlStore.snapshot(runId);
    const expiredLeases = await new LeaseManager(this.controlStore).reapExpired(runId, now);
    const fixtureResult = await this.sandbox.reconcileFixture(task ?? snapshot.task, snapshot.generation);
    const reconciledJobs: string[] = [];
    if (fixtureResult.action === "reset") {
      await this.controlStore.dispatch(runId, { type: "fixture_reset", generation: fixtureResult.generation, lane: "main" });
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
    };
  }
}
