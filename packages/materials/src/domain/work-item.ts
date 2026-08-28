import type { CompletionProposal, RunSnapshot, WorkItem } from "./types.js";

/**
 * Find the replayable executor WorkItem that closed an accepted completion.
 *
 * A successful Run must be explainable by the accepted candidate artifact and
 * the exact verifier Evidence on a completed WorkItem; a terminal verifier
 * event by itself is not a sufficient execution record.
 */
export function completedWorkItemForCompletion(
  snapshot: RunSnapshot,
  completion: CompletionProposal,
  evidenceIds: readonly string[],
): WorkItem | undefined {
  return Object.values(snapshot.workItems).find((item) =>
    item.runId === snapshot.runId
    && item.ownerLane === "executor"
    && item.status === "SUCCEEDED"
    && item.artifactIds.includes(completion.artifactId)
    && evidenceIds.every((evidenceId) => item.evidenceIds.includes(evidenceId))
  );
}
