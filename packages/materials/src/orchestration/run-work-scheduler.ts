import type { ControlStore } from "../control/control-store.js";
import type { Intent as SchedulerIntent } from "../domain/intent.js";
import type { PrimaryFailureCategory, RunSnapshot, TaskContract, WorkItem } from "../domain/types.js";
import { id } from "../domain/utils.js";
import { maxReplansFor } from "../domain/phase-budget.js";

/**
 * Durable execution lifecycle shared by every ProofBlade run entrypoint.
 *
 * IntentScheduler chooses an objective, while this class owns the single
 * executor work graph: claim, lease recovery, and terminal settlement.  The
 * separation keeps policy decisions replayable without allowing Competition
 * and Fixture/Evaluation to grow independent scheduler state machines.
 */
export class RunWorkScheduler {
  public constructor(private readonly control: ControlStore) {}

  /** Selects or creates one executor item and acquires its durable lease. */
  public async claim(
    runId: string,
    task: TaskContract,
    turn: number,
    schedulerIntent?: SchedulerIntent,
  ): Promise<WorkItem> {
    let snapshot = await this.control.snapshot(runId);
    const active = Object.values(snapshot.workItems)
      .filter((item) => item.status === "RUNNING" && item.ownerLane === "executor" && item.lease && Date.parse(item.lease.expiresAt) > Date.now())
      .sort((a, b) => b.updatedSeq - a.updatedSeq)[0];
    if (active) return active;

    // Recover expired executor work before selecting READY work.  Otherwise a
    // crashed item would remain RUNNING forever while newer items advance.
    let candidate = Object.values(snapshot.workItems)
      .filter((item) => item.status === "RUNNING" && item.ownerLane === "executor" && (!item.lease || Date.parse(item.lease.expiresAt) <= Date.now()))
      .sort((a, b) => a.updatedSeq - b.updatedSeq)[0];
    if (!candidate) {
      candidate = Object.values(snapshot.workItems)
        .filter((item) => item.status === "READY")
        .sort((a, b) => a.createdSeq - b.createdSeq)[0];
    }
    if (!candidate) {
      const planned = Object.values(snapshot.workItems)
        .filter((item) => item.status === "PLANNED")
        .sort((a, b) => a.createdSeq - b.createdSeq)[0];
      if (planned) {
        await this.control.dispatch(runId, { type: "work_item_ready", workItemId: planned.id, lane: "executor" });
        candidate = (await this.control.snapshot(runId)).workItems[planned.id];
      }
    }
    if (!candidate) {
      const blocked = Object.values(snapshot.workItems)
        .filter((item) => item.status === "BLOCKED")
        .sort((a, b) => a.updatedSeq - b.updatedSeq)[0];
      if (blocked) {
        await this.control.dispatch(runId, { type: "work_item_ready", workItemId: blocked.id, lane: "executor" });
        candidate = (await this.control.snapshot(runId)).workItems[blocked.id];
      }
    }
    if (!candidate) {
      const previous = Object.values(snapshot.workItems).sort((a, b) => b.updatedSeq - a.updatedSeq)[0];
      const created: Omit<WorkItem, "createdSeq" | "updatedSeq"> = {
        id: id("WI"),
        runId,
        ...(schedulerIntent ? { schedulerIntentId: schedulerIntent.id } : {}),
        ...(previous && (previous.status === "BLOCKED" || previous.status === "FAILED") ? { parentId: previous.id } : {}),
        title: schedulerIntent?.objective ?? `Advance target investigation (turn ${turn})`,
        objective: schedulerIntent?.objective ?? task.objective,
        role: "executor",
        status: "READY",
        dependsOn: [],
        evidenceIds: [],
        artifactIds: [],
        attempt: 0,
        maxAttempts: 3,
      };
      await this.control.dispatch(runId, { type: "work_item_created", workItem: created, lane: "executor" });
      candidate = (await this.control.snapshot(runId)).workItems[created.id];
    }
    if (!candidate) throw new Error(`Unable to create or select executor work item for ${runId}`);
    const leaseExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await this.control.dispatch(runId, {
      type: "work_item_claimed",
      workItemId: candidate.id,
      ownerLane: "executor",
      leaseExpiresAt,
      lane: "executor",
    });
    snapshot = await this.control.snapshot(runId);
    const claimed = snapshot.workItems[candidate.id];
    if (!claimed) throw new Error(`Claimed work item disappeared during ${runId} recovery`);
    return claimed;
  }

  /** Marks a running item complete, attaching any accepted completion evidence. */
  public async complete(runId: string, workItemId: string | undefined, snapshot?: RunSnapshot): Promise<void> {
    if (!workItemId) return;
    const current = snapshot ?? await this.control.snapshot(runId);
    if (current.workItems[workItemId]?.status !== "RUNNING") return;
    const completion = Object.values(current.completions).find((item) => item.status === "ACCEPTED");
    await this.control.dispatch(runId, {
      type: "work_item_completed",
      workItemId,
      evidenceIds: completion?.evidenceIds ?? [],
      artifactIds: completion?.artifactId ? [completion.artifactId] : [],
      lane: "executor",
    });
  }

  /** Atomically closes a submission work item with the competition phase move. */
  public async completeForSubmission(runId: string, workItemId: string | undefined): Promise<void> {
    await this.control.dispatchTransaction(runId, (snapshot) => {
      if (["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"].includes(snapshot.status)) return { commands: [], project: () => undefined };
      const completion = Object.values(snapshot.completions).find((item) => item.status === "ACCEPTED");
      if (!completion) throw new Error("Cannot complete submission work without an accepted completion");
      const commands = [
        { type: "set_domain_phase" as const, domainPhase: "SUBMIT" as const, lane: "executor" as const },
        ...(workItemId && snapshot.workItems[workItemId]?.status === "RUNNING" ? [{
          type: "work_item_completed" as const,
          workItemId,
          evidenceIds: completion.evidenceIds,
          artifactIds: [completion.artifactId],
          lane: "executor" as const,
        }] : []),
      ];
      return { commands, project: () => undefined };
    });
  }

  /** Settles a turn as success when it produced progress, otherwise as failure. */
  public async settle(
    runId: string,
    workItemId: string | undefined,
    progressed: boolean,
    evidenceIds: string[] = [],
    artifactIds: string[] = [],
  ): Promise<void> {
    if (!workItemId) return;
    const snapshot = await this.control.snapshot(runId);
    if (snapshot.workItems[workItemId]?.status !== "RUNNING") return;
    if (progressed) {
      await this.control.dispatch(runId, {
        type: "work_item_completed",
        workItemId,
        evidenceIds,
        artifactIds,
        lane: "executor",
      });
      return;
    }
    await this.control.dispatch(runId, {
      type: "work_item_failed",
      workItemId,
      reason: "Coding turn produced no durable progress",
      lane: "executor",
    });
  }

  /** Marks a running item failed without mutating an already-settled item. */
  public async fail(runId: string, workItemId: string | undefined, reason: string): Promise<void> {
    if (!workItemId) return;
    const snapshot = await this.control.snapshot(runId);
    if (snapshot.workItems[workItemId]?.status !== "RUNNING") return;
    await this.control.dispatch(runId, { type: "work_item_failed", workItemId, reason, lane: "executor" });
  }

  /** Blocks a running item while retaining it for a later recovery decision. */
  public async block(runId: string, workItemId: string | undefined, reason: string): Promise<void> {
    if (!workItemId) return;
    const snapshot = await this.control.snapshot(runId);
    if (snapshot.workItems[workItemId]?.status !== "RUNNING") return;
    await this.control.dispatch(runId, { type: "work_item_blocked", workItemId, reason, lane: "executor" });
  }

  /** Blocks the current item and atomically queues its child replan item. */
  public async blockAndQueue(
    runId: string,
    task: TaskContract,
    workItemId: string | undefined,
    reason: string,
    category: PrimaryFailureCategory = "wrong_hypothesis",
  ): Promise<void> {
    if (!workItemId) return;
    const snapshot = await this.control.snapshot(runId);
    if (snapshot.workItems[workItemId]?.status !== "RUNNING") return;
    if (snapshot.replanCount >= maxReplansFor(snapshot.task.target_kind, snapshot.task.constraints.max_replans)) {
      await this.control.dispatchBatch(runId, [
        { type: "work_item_failed", workItemId, reason: `Replan budget exhausted: ${reason}`, lane: "executor" },
        { type: "exhaust", reason: `Replan budget exhausted after ${snapshot.replanCount} replans.`, lane: "executor" },
      ]);
      return;
    }
    const previousRepeatKeys = Object.values(snapshot.experiments)
      .filter((experiment) => experiment.generation === snapshot.generation && experiment.domainPhase === snapshot.domainPhase)
      .slice(-16)
      .map((experiment) => experiment.repeatKey);
    const created: Omit<WorkItem, "createdSeq" | "updatedSeq"> = {
      id: id("WI"),
      runId,
      parentId: workItemId,
      title: `Replan after ${reason}`,
      objective: task.objective,
      role: "executor",
      status: "READY",
      dependsOn: [],
      evidenceIds: [],
      artifactIds: [],
      attempt: 0,
      maxAttempts: 3,
    };
    const replanId = id("RP");
    await this.control.dispatchBatch(runId, [
      { type: "work_item_blocked", workItemId, reason, lane: "executor" },
      { type: "work_item_created", workItem: created, lane: "executor" },
      {
        type: "replan_requested",
        replan: {
          id: replanId,
          domainPhase: snapshot.domainPhase,
          category,
          reason,
          sourceWorkItemId: workItemId,
          nextWorkItemId: created.id,
          prohibitedRepeatKeys: previousRepeatKeys,
        },
        lane: "executor",
      },
    ]);
  }
}
