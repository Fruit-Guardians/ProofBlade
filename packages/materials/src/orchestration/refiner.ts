import type { ControlStore } from "../control/control-store.js";
import { buildHandoffDraft, hashHandoff } from "../domain/handoff.js";
import type { HandoffAction, HandoffRecord } from "../domain/types.js";
import { id } from "../domain/utils.js";

export type HandoffDeltaOperation =
  | { op: "add"; action: HandoffAction; afterId?: string }
  | { op: "remove"; id: string }
  | { op: "modify"; id: string; patch: Partial<Omit<HandoffAction, "id">> }
  | { op: "reorder"; id: string; afterId?: string };

/** Apply id-based deltas without rewriting the whole planner handoff. */
export function applyHandoffDelta(actions: HandoffAction[], operations: HandoffDeltaOperation[]): HandoffAction[] {
  if (operations.length > 32) throw new Error("Handoff delta allows at most 32 operations");
  const next = actions.map((action) => structuredClone(action));
  for (const operation of operations) {
    if (operation.op === "add") {
      if (next.some((action) => action.id === operation.action.id)) throw new Error(`Handoff action already exists: ${operation.action.id}`);
      insertAfter(next, structuredClone(operation.action), operation.afterId);
      continue;
    }
    const index = next.findIndex((action) => action.id === operation.id);
    if (index < 0) throw new Error(`Unknown handoff action: ${operation.id}`);
    if (operation.op === "remove") { next.splice(index, 1); continue; }
    if (operation.op === "modify") { next[index] = { ...next[index]!, ...structuredClone(operation.patch), id: operation.id }; continue; }
    const [action] = next.splice(index, 1);
    insertAfter(next, action!, operation.afterId);
  }
  if (next.length < 1 || next.length > 16 || new Set(next.map((action) => action.id)).size !== next.length) throw new Error("Refined handoff requires 1-16 unique actions");
  return next;
}

export class RefinerCoordinator {
  public constructor(private readonly controlStore: ControlStore) {}

  public async refine(runId: string, operations: HandoffDeltaOperation[], failedActionId?: string): Promise<HandoffRecord> {
    const snapshot = await this.controlStore.snapshot(runId);
    const active = Object.values(snapshot.handoffs).filter((item) => item.status === "ACCEPTED" || item.status === "PROPOSED").sort((a, b) => b.createdSeq - a.createdSeq)[0];
    const base = active ?? buildHandoffDraft(snapshot, id("HO"));
    const nextActions = applyHandoffDelta(base.nextActions, operations);
    const draft = {
      ...buildHandoffDraft(snapshot, id("HO")),
      nextActions,
      prohibitedRepeats: [...new Set([...base.prohibitedRepeats, ...(failedActionId ? [failedActionId] : [])])].slice(-16),
      status: "PROPOSED" as const,
    };
    const materialized = { ...draft, hash: hashHandoff(draft) };
    if (active) await this.controlStore.dispatch(runId, { type: "handoff_superseded", handoffId: active.id, reason: "Refiner produced an evidence-backed delta.", lane: "planner" });
    await this.controlStore.dispatch(runId, { type: "handoff_proposed", handoff: materialized, lane: "planner" });
    await this.controlStore.dispatch(runId, { type: "handoff_accepted", handoffId: materialized.id, lane: "executor" });
    return (await this.controlStore.snapshot(runId)).handoffs[materialized.id]!;
  }

  public async refineAfterFailure(runId: string, reason: string): Promise<HandoffRecord> {
    const snapshot = await this.controlStore.snapshot(runId);
    const active = Object.values(snapshot.handoffs).filter((item) => item.status === "ACCEPTED" || item.status === "PROPOSED").sort((a, b) => b.createdSeq - a.createdSeq)[0];
    const first = active?.nextActions[0] ?? buildHandoffDraft(snapshot, "HO-PREVIEW").nextActions[0]!;
    return await this.refine(runId, [{ op: "modify", id: first.id, patch: { description: `${first.description} Alternative required after failure: ${reason}`.slice(0, 1_000) } }], first.id);
  }
}

function insertAfter(actions: HandoffAction[], action: HandoffAction, afterId?: string): void {
  if (afterId === undefined) { actions.unshift(action); return; }
  const index = actions.findIndex((candidate) => candidate.id === afterId);
  if (index < 0) throw new Error(`Unknown afterId: ${afterId}`);
  actions.splice(index + 1, 0, action);
}
