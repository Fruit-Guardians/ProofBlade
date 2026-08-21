import type { ControlStore } from "../control/control-store.js";
import { buildHandoffDraft, handoffKnowledgeVersion } from "../domain/handoff.js";
import type { HandoffRecord } from "../domain/types.js";
import { id } from "../domain/utils.js";

/**
 * The first planner is deterministic. It owns the planner lane and emits the
 * same structured handoff that a future configured planner model will use.
 * Keeping this boundary model-free makes local runs cheap and replayable.
 */
export class PlannerCoordinator {
  public constructor(private readonly controlStore: ControlStore) {}

  public async prepare(runId: string): Promise<HandoffRecord> {
    let snapshot = await this.controlStore.snapshot(runId);
    const hasActiveWork = Object.values(snapshot.workItems).some((item) => ["PLANNED", "READY", "RUNNING", "BLOCKED"].includes(item.status));
    if (!hasActiveWork) {
      await this.controlStore.dispatch(runId, {
        type: "work_item_created",
        workItem: {
          id: id("WI"),
          runId,
          title: "Advance the current target investigation",
          objective: snapshot.task.objective,
          role: "executor",
          status: "READY",
          dependsOn: [],
          evidenceIds: [],
          artifactIds: [],
          attempt: 0,
          maxAttempts: 3,
        },
        lane: "planner",
      });
      snapshot = await this.controlStore.snapshot(runId);
    }
    const currentVersion = handoffKnowledgeVersion(snapshot);
    const active = Object.values(snapshot.handoffs)
      .filter((handoff) => handoff.status === "PROPOSED" || handoff.status === "ACCEPTED")
      .sort((a, b) => b.createdSeq - a.createdSeq)[0];
    if (active && active.knowledgeVersion === currentVersion && active.phase === snapshot.phase && active.domainPhase === snapshot.domainPhase) {
      if (active.status === "PROPOSED") await this.accept(runId, active.id);
      return (await this.controlStore.snapshot(runId)).handoffs[active.id]!;
    }
    if (active) {
      await this.controlStore.dispatch(runId, {
        type: "handoff_superseded",
        handoffId: active.id,
        reason: `Knowledge changed from ${active.knowledgeVersion} to ${currentVersion}.`,
        lane: "planner",
      });
    }
    const draft = buildHandoffDraft(snapshot, id("HO"));
    await this.controlStore.dispatch(runId, { type: "handoff_proposed", handoff: draft, lane: "planner" });
    await this.accept(runId, draft.id);
    return (await this.controlStore.snapshot(runId)).handoffs[draft.id]!;
  }

  public async accept(runId: string, handoffId: string): Promise<HandoffRecord> {
    await this.controlStore.dispatch(runId, { type: "handoff_accepted", handoffId, lane: "executor" });
    return (await this.controlStore.snapshot(runId)).handoffs[handoffId]!;
  }
}
