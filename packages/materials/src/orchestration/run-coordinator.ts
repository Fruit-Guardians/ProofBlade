import type { ControlStore, VerifierControlPort } from "../control/control-store.js";
import { pathToPhase } from "../control/phase-machine.js";
import type { DomainPhase, Phase, PrimaryFailureCategory, RunSnapshot, RunToolPreparation, TaskContract, WorkItem } from "../domain/types.js";
import type { FixtureRef } from "../sandbox/fixture.js";
import { isTerminal } from "../domain/utils.js";
import type { IndependentVerifier, VerificationOutcome } from "../verification/verifier.js";
import { RunWorkScheduler } from "./run-work-scheduler.js";
import type { Intent as SchedulerIntent } from "../domain/intent.js";
import { completedWorkItemForCompletion } from "../domain/work-item.js";
import { RunEventIngress, type RunEventDrainResult, type RunEventInput, type SafePoint } from "./event-ingress.js";

/**
 * The verifier capability needed by the shared run state machine.
 *
 * `IndependentVerifier` is deliberately accepted through a small structural
 * type so GUI, Fixture, and Competition callers can share this coordinator
 * without exposing verifier control to the model lane.
 */
export type RunVerifier = Pick<IndependentVerifier, "verify">;

export interface RunCoordinatorOptions {
  scheduler?: RunWorkScheduler;
  verifier?: RunVerifier;
}

/**
 * Durable orchestration boundary shared by every ProofBlade entrypoint.
 *
 * This class owns phase movement and the verifier-first terminal transition.
 * Policy (planner/refiner, assist mode, platform API calls) remains in the
 * caller, while all state-machine mutations are routed through one replayable
 * path.
 */
export class RunCoordinator {
  private readonly scheduler: RunWorkScheduler;
  private readonly ingress: RunEventIngress;

  public constructor(
    private readonly control: ControlStore,
    private readonly verifierControl?: VerifierControlPort,
    options: RunCoordinatorOptions = {},
  ) {
    this.scheduler = options.scheduler ?? new RunWorkScheduler(control);
    this.verifier = options.verifier;
    this.ingress = new RunEventIngress(control);
  }

  private readonly verifier?: RunVerifier;

  /** Append an external signal without mutating the in-memory lane. */
  public async enqueueEvent(runId: string, input: RunEventInput): Promise<void> {
    await this.ingress.enqueue(runId, input);
  }

  /**
   * Consume a bounded batch at a safe point. User control events are applied
   * through the normal ControlStore command path; other signals are returned
   * as structured actions for the lane that owns their policy.
   */
  public async drainEvents(runId: string, safePoint: SafePoint, maxEvents = 32): Promise<RunEventDrainResult> {
    const drained = await this.ingress.drain(runId, safePoint, maxEvents);
    for (const action of drained.admitted) {
      if (action.source !== "user") continue;
      if (action.kind === "user.pause") await this.control.dispatch(runId, { type: "pause", reason: String(action.payload.reason ?? "Paused by user."), lane: "main" });
      else if (action.kind === "user.resume") await this.control.dispatch(runId, { type: "resume", lane: "main" });
      else if (action.kind === "user.cancel") await this.control.dispatch(runId, { type: "cancel", reason: String(action.payload.reason ?? "Cancelled by user."), lane: "main" });
    }
    return drained;
  }

  /** Move the durable competition projection, tolerating an idempotent race. */
  public async setDomainPhase(runId: string, domainPhase: DomainPhase): Promise<void> {
    const genericPhase = genericPhaseForDomain(domainPhase);
    try {
      await this.control.dispatchTransaction(runId, (snapshot) => {
        const commands = [
          ...(snapshot.domainPhase === domainPhase ? [] : [{ type: "set_domain_phase" as const, domainPhase, lane: "executor" as const }]),
          ...pathToPhase(snapshot.phase, genericPhase).map((phase) => ({ type: "start_phase" as const, phase, lane: "executor" as const })),
        ];
        return { commands, project: () => undefined };
      });
    } catch (error) {
      const current = await this.control.snapshot(runId);
      if (current.domainPhase !== domainPhase || current.phase !== genericPhase) throw error;
    }
  }

  /** Advance the generic Run phase through the legal transition path. */
  public async moveToPhase(runId: string, phase: Phase): Promise<void> {
    const snapshot = await this.control.snapshot(runId);
    for (const next of pathToPhase(snapshot.phase, phase)) {
      await this.control.dispatch(runId, { type: "start_phase", phase: next });
    }
  }

  /** Select the durable investigation phase for a bounded model turn. */
  public domainPhaseForTurn(turn: number): DomainPhase {
    if (turn <= 1) return "RECON";
    if (turn === 2) return "TARGET_MODEL";
    if (turn === 3) return "HYPOTHESIS";
    return "EXPERIMENT";
  }

  /** Persist the bounded tool readiness snapshot before a model turn. */
  public async recordToolPreparation(runId: string, preparation: RunToolPreparation): Promise<void> {
    const snapshot = await this.control.snapshot(runId);
    if (snapshot.toolPreparation?.hash === preparation.hash) return;
    await this.control.dispatch(runId, { type: "record_tool_preparation", preparation, lane: "executor" });
  }

  /** Claim one durable executor WorkItem for a model turn. */
  public async claim(runId: string, task: TaskContract, turn: number, intent?: SchedulerIntent): Promise<WorkItem> {
    return this.scheduler.claim(runId, task, turn, intent);
  }

  public async settle(runId: string, workItemId: string | undefined, progressed: boolean, evidenceIds: string[] = [], artifactIds: string[] = []): Promise<void> {
    await this.scheduler.settle(runId, workItemId, progressed, evidenceIds, artifactIds);
  }

  public async fail(runId: string, workItemId: string | undefined, reason: string): Promise<void> {
    await this.scheduler.fail(runId, workItemId, reason);
  }

  public async block(runId: string, workItemId: string | undefined, reason: string): Promise<void> {
    await this.scheduler.block(runId, workItemId, reason);
  }

  public async blockAndQueue(runId: string, task: TaskContract, workItemId: string | undefined, reason: string, category?: PrimaryFailureCategory): Promise<void> {
    await this.scheduler.blockAndQueue(runId, task, workItemId, reason, category);
  }

  /**
   * Start the reproduction phase and run the independent verifier.  A model
   * completion is never considered final merely because it was proposed.
   */
  public async verifyCompletion(
    runId: string,
    fixture: FixtureRef,
    completionId: string,
    signal?: AbortSignal,
  ): Promise<VerificationOutcome> {
    if (!this.verifier) throw new Error("RunCoordinator has no independent verifier");
    await this.setDomainPhase(runId, "REPRODUCE");
    await this.moveToPhase(runId, "verification");
    return this.verifier.verify(runId, fixture, completionId, signal);
  }

  /**
   * Commit an already verifier-accepted completion.  The WorkItem and domain
   * projection are settled before the verifier-only finish command makes the
  * Run terminal, because terminal Runs reject further graph mutations.
  */
  public async finishAccepted(runId: string, workItemId: string | undefined, completionId: string, reason: string): Promise<void> {
    if (!this.verifierControl) throw new Error("RunCoordinator cannot finish an accepted completion without verifier control");
    let snapshot = await this.control.snapshot(runId);
    if (snapshot.status === "SUCCEEDED") return;
    if (isTerminal(snapshot.status)) throw new Error(`Cannot finish accepted completion in terminal run ${snapshot.status}`);
    const completion = snapshot.completions[completionId];
    if (!completion || completion.status !== "ACCEPTED") throw new Error(`Completion ${completionId} is not ACCEPTED`);
    // Recovery may be called without the in-memory WorkItem id. Reconnect to
    // the current executor item, or to an already-settled item whose artifact
    // and Evidence prove that it belongs to this completion. Never allow a
    // verifier terminal event with no durable WorkItem edge.
    let resolvedWorkItemId = workItemId;
    if (!resolvedWorkItemId) {
      const active = Object.values(snapshot.workItems)
        .filter((item) => item.status === "RUNNING" && item.ownerLane === "executor")
        .sort((left, right) => right.updatedSeq - left.updatedSeq)[0];
      resolvedWorkItemId = active?.id ?? completedWorkItemForCompletion(snapshot, completion, completion.evidenceIds)?.id;
    }
    if (!resolvedWorkItemId) throw new Error("Cannot finish an accepted completion without a durable executor WorkItem");
    // A crash can occur after the SUBMIT projection and WorkItem settlement but
    // before verifier.finish.  SUBMIT is monotonic, so do not backtrack to
    // REPORT during recovery; the verifier finish is the only missing edge.
    if (snapshot.domainPhase !== "SUBMIT") {
      await this.moveToPhase(runId, "report");
      await this.setDomainPhase(runId, "REPORT");
      if (snapshot.task.verification.kind === "platform_submission") {
        // completeForSubmission includes the phase change in the same durable
        // transaction as WorkItem completion; do not emit a duplicate event.
        await this.scheduler.completeForSubmission(runId, resolvedWorkItemId);
      } else {
        await this.setDomainPhase(runId, "SUBMIT");
        await this.scheduler.complete(runId, resolvedWorkItemId, await this.control.snapshot(runId));
      }
    }
    // Recovery may observe SUBMIT after the phase projection was committed but
    // before WorkItem settlement. Repair that durable graph edge before the
    // verifier closes the Run; terminal Runs reject all later graph mutations.
    snapshot = await this.control.snapshot(runId);
    if (snapshot.workItems[resolvedWorkItemId]?.status === "RUNNING") {
      if (snapshot.task.verification.kind === "platform_submission") {
        await this.scheduler.completeForSubmission(runId, resolvedWorkItemId);
      } else {
        await this.scheduler.complete(runId, resolvedWorkItemId, snapshot);
      }
    }
    await this.verifierControl.finish(runId, { completionId, reason });
  }
}

/**
 * Project the CTF-specific phase into the generic harness phase.  The generic
 * projection keeps TARGET_MODEL explicit so GUI, metrics and replay can
 * distinguish target modeling from raw reconnaissance. SUBMIT remains the
 * terminal edge of report. Keeping this mapping in the coordinator prevents
 * local and Competition callers from maintaining divergent projections.
 */
function genericPhaseForDomain(domainPhase: DomainPhase): Phase {
  switch (domainPhase) {
    case "INTAKE": return "intake";
    case "RECON": return "reconnaissance";
    case "TARGET_MODEL": return "target_model";
    case "HYPOTHESIS": return "hypothesis";
    case "EXPERIMENT": return "experiment";
    case "REPRODUCE": return "verification";
    case "REPORT":
    case "SUBMIT": return "report";
  }
}
