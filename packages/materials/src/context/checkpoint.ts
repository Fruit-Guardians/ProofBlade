import type { ArtifactStore } from "../effects/artifact-store.js";
import type { ControlStore } from "../control/control-store.js";
import type { ContextManifest, RunSnapshot } from "../domain/types.js";
import { id } from "../domain/utils.js";

export interface CreatedCheckpoint {
  checkpointId: string;
  artifactId: string;
  content: string;
}

export class CheckpointService {
  public constructor(private readonly controlStore: ControlStore, private readonly artifactStore: ArtifactStore) {}

  public async create(runId: string, reason: string, manifest?: ContextManifest): Promise<CreatedCheckpoint> {
    const snapshot = await this.controlStore.snapshot(runId);
    const existing = Object.values(snapshot.checkpoints).find((item) => item.snapshotSeq === snapshot.lastSeq && item.reason === reason && item.contextManifestHash === manifest?.hash);
    if (existing) {
      const artifact = snapshot.artifacts[existing.artifactId];
      if (!artifact) throw new Error(`Checkpoint artifact missing: ${existing.artifactId}`);
      return { checkpointId: existing.id, artifactId: artifact.id, content: await this.artifactStore.readText(runId, artifact) };
    }
    const checkpointId = id("CP");
    const content = checkpointText(snapshot, checkpointId, reason);
    const artifact = await this.artifactStore.putText(runId, content, { filename: `checkpoint-${checkpointId}.md`, mime: "text/markdown" });
    await this.controlStore.dispatch(runId, {
      type: "checkpoint",
      checkpoint: { id: checkpointId, artifactId: artifact.id, snapshotSeq: snapshot.lastSeq, reason, contextManifestHash: manifest?.hash },
      lane: "main",
    });
    return { checkpointId, artifactId: artifact.id, content };
  }
}

function checkpointText(snapshot: RunSnapshot, checkpointId: string, reason: string): string {
  const confirmed = Object.values(snapshot.facts).filter((item) => item.status === "CONFIRMED").sort(bySeq);
  const rejected = Object.values(snapshot.hypotheses).filter((item) => item.status === "REJECTED").sort(bySeq);
  const completed = Object.values(snapshot.effects).filter((item) => item.status === "FINISHED" || item.status === "RECONCILED").sort(bySeq);
  const next = Object.values(snapshot.intents).filter((item) => item.status === "OPEN" || item.status === "CLAIMED").sort((a, b) => b.priority - a.priority);
  return [
    "## Task",
    `- checkpoint_id: ${checkpointId}`,
    `- reason: ${reason}`,
    `- task_id: ${snapshot.task.task_id}`,
    `- phase: ${snapshot.phase}`,
    `- objective: ${snapshot.task.objective}`,
    "",
    "## Confirmed facts",
    ...orNone(confirmed.map((item) => `- ${item.id}: ${item.statement} (evidence: ${item.evidenceIds.join(", ")})`)),
    "",
    "## Rejected hypotheses",
    ...orNone(rejected.map((item) => `- ${item.id}: ${item.statement} (evidence: ${item.evidenceIds.join(", ")})`)),
    "",
    "## Artifacts",
    ...orNone(Object.values(snapshot.artifacts).map((item) => `- ${item.id}: path=${item.path}, sha256=${item.sha256}`)),
    "",
    "## Actions already completed",
    ...orNone(completed.map((item) => `- ${item.operation}: effect=${item.id}, outcome=${item.outcome ?? "unknown"}, artifact=${item.artifactId ?? "none"}`)),
    "",
    "## Next actions",
    ...orNone(next.map((item, index) => `${index + 1}. ${item.id}: ${item.title}`)),
    "",
    "## Blockers / human input",
    ...(snapshot.status === "NEED_HUMAN" || snapshot.status === "PAUSED" ? [`- ${snapshot.terminalReason ?? snapshot.status}`] : ["- none"]),
    "",
  ].join("\n");
}

function orNone(values: string[]): string[] {
  return values.length > 0 ? values : ["- none"];
}

function bySeq(a: { createdSeq: number }, b: { createdSeq: number }): number {
  return a.createdSeq - b.createdSeq;
}
