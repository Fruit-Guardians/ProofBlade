import type { ArtifactStore } from "../effects/artifact-store.js";
import type { ControlStore } from "../control/control-store.js";
import type { ContextManifest, RunSnapshot } from "../domain/types.js";
import { id } from "../domain/utils.js";
import { snipText } from "@proofblade/molecules";

export interface CreatedCheckpoint {
  checkpointId: string;
  artifactId: string;
  content: string;
}

export class CheckpointService {
  public constructor(private readonly controlStore: ControlStore, private readonly artifactStore: ArtifactStore) {}

  public async create(runId: string, reason: string, manifest?: ContextManifest): Promise<CreatedCheckpoint> {
    const snapshot = await this.controlStore.snapshot(runId);
    const existing = Object.values(snapshot.checkpoints).find((item) =>
      item.reason === reason
      && ((item.snapshotSeq === snapshot.lastSeq && item.contextManifestHash === manifest?.hash) || item.createdSeq === snapshot.lastSeq),
    );
    if (existing) {
      const artifact = snapshot.artifacts[existing.artifactId];
      if (!artifact) throw new Error(`Checkpoint artifact missing: ${existing.artifactId}`);
      return { checkpointId: existing.id, artifactId: artifact.id, content: await this.artifactStore.readText(runId, artifact) };
    }
    const checkpointId = id("CP");
    const content = checkpointText(snapshot, checkpointId, reason, manifest);
    const artifact = await this.artifactStore.putText(runId, content, { filename: `checkpoint-${checkpointId}.md`, mime: "text/markdown" });
    await this.controlStore.dispatch(runId, {
      type: "checkpoint",
      checkpoint: { id: checkpointId, artifactId: artifact.id, snapshotSeq: snapshot.lastSeq, reason, contextManifestHash: manifest?.hash },
      lane: "main",
    });
    return { checkpointId, artifactId: artifact.id, content };
  }
}

function checkpointText(snapshot: RunSnapshot, checkpointId: string, reason: string, manifest?: ContextManifest): string {
  const confirmed = Object.values(snapshot.facts).filter((item) => item.status === "CONFIRMED").sort(bySeq);
  const rejected = Object.values(snapshot.hypotheses).filter((item) => item.status === "REJECTED").sort(bySeq);
  const completed = Object.values(snapshot.effects).filter((item) => item.status === "FINISHED" || item.status === "RECONCILED").sort(bySeq);
  const next = Object.values(snapshot.intents).filter((item) => item.status === "OPEN" || item.status === "CLAIMED").sort((a, b) => b.priority - a.priority);
  const observations = Object.values(snapshot.observations).sort(bySeq).slice(-24);
  const evidence = Object.values(snapshot.evidence).sort(bySeq).slice(-24);
  const activeEffects = Object.values(snapshot.effects).filter((item) => item.status === "PROPOSED" || item.status === "STARTED" || item.status === "UNKNOWN").sort(bySeq);
  const jobs = Object.values(snapshot.jobs).filter((item) => ["QUEUED", "RUNNING", "UNKNOWN"].includes(item.status)).sort(bySeq);
  const handoffs = Object.values(snapshot.handoffs).filter((item) => item.status === "PROPOSED" || item.status === "ACCEPTED").sort(bySeq);
  return [
    "## Task",
    `- checkpoint_id: ${checkpointId}`,
    `- reason: ${reason}`,
    `- task_id: ${snapshot.task.task_id}`,
    `- phase: ${snapshot.phase}`,
    `- objective: ${snapshot.task.objective}`,
    `- standing_instruction_hash: ${manifest?.memory.standingInstructionHash ?? "not-compiled"}`,
    `- cache_prefix_hash: ${manifest?.cache?.prefixHash ?? "not-compiled"}`,
    `- cache_prefix_tokens: ${manifest?.cache?.prefixTokens ?? 0}`,
    "",
    "## Memory layers",
    "- standing instructions: L0 is immutable and remains in the stable prompt prefix",
    `- confirmed facts: ${confirmed.length}`,
    `- rejected hypotheses: ${rejected.length}`,
    "",
    "## Confirmed facts",
    ...orNone(confirmed.map((item) => `- ${item.id}: ${safeValue(item.statement)} (evidence: ${item.evidenceIds.join(", ")})`)),
    "",
    "## Rejected hypotheses",
    ...orNone(rejected.map((item) => `- ${item.id}: ${safeValue(item.statement)} (evidence: ${item.evidenceIds.join(", ")})`)),
    "",
    "## Observation and evidence index",
    ...orNone(observations.map((item) => `- observation ${item.id}: artifact=${item.source.artifactId}, operation=${item.source.operation}, ${safeValue(item.summary)}`)),
    ...orNone(evidence.map((item) => `- evidence ${item.id}: ${safeValue(item.name ?? item.summary)}, artifacts=${[...(item.source.artifactIds ?? []), ...(item.source.artifactId ? [item.source.artifactId] : [])].join(",") || "none"}, depends_on=${(item.dependsOn ?? []).join(",") || "none"}, ${safeValue(item.summary)}`)),
    "",
    "## Artifacts",
    ...orNone(Object.values(snapshot.artifacts).sort((a, b) => a.id.localeCompare(b.id)).map((item) => `- ${item.id}: ${safeValue(item.semantic?.name ?? item.path)}, role=${item.semantic?.role ?? "intermediate"}, tags=${item.semantic?.tags.join(",") || "none"}, path=${item.path}, sha256=${item.sha256}`)),
    "",
    "## Actions already completed",
    ...orNone(completed.map((item) => `- ${item.operation}: effect=${item.id}, outcome=${item.outcome ?? "unknown"}, artifact=${item.artifactId ?? "none"}`)),
    "",
    "## In-flight effects and leases",
    ...orNone(activeEffects.map((item) => `- effect ${item.id}: ${item.operation}, status=${item.status}, policy=${item.replayPolicy}`)),
    ...orNone(jobs.map((item) => `- job ${item.id}: ${item.capabilityId}.${item.operation}, status=${item.status}, replay=${item.replayPolicy}, artifact=${item.artifactId ?? "none"}`)),
    ...orNone(handoffs.map((item) => `- handoff ${item.id}: ${item.sourceLane}->${item.targetLane}, status=${item.status}, knowledge=${item.knowledgeVersion}, hash=${item.hash}`)),
    ...orNone(Object.values(snapshot.leases).map((item) => `- lease ${item.resourceKey}: owner=${item.ownerLane}, generation=${item.generation}, expires=${item.expiresAt}`)),
    "",
    "## Next actions",
    ...orNone(next.map((item, index) => `${index + 1}. ${item.id}: ${item.title}`)),
    "",
    "## Context maintenance",
    `- manifest_hash: ${manifest?.hash ?? "not-compiled"}`,
    `- stage: ${manifest?.maintenance.stage ?? "checkpoint"}`,
    `- budget: ${manifest ? `${manifest.budget.estimatedInput}/${manifest.budget.availableInput} (${manifest.budget.ratio.toFixed(3)})` : "not-compiled"}`,
    `- dropped_entries: ${manifest?.dropped.length ?? 0}`,
    "",
    "## Blockers / human input",
    ...(snapshot.status === "NEED_HUMAN" || snapshot.status === "PAUSED" ? [`- ${snapshot.terminalReason ?? snapshot.status}`] : ["- none"]),
    "",
  ].join("\n");
}

function safeValue(value: string): string {
  return snipText(value.replace(/\r?\n/g, " "), 480).text.replace(/<\/(?:untrusted|task-memory)-/gi, "<\\/$1-");
}

function orNone(values: string[]): string[] {
  return values.length > 0 ? values : ["- none"];
}

function bySeq(a: { createdSeq: number }, b: { createdSeq: number }): number {
  return a.createdSeq - b.createdSeq;
}
