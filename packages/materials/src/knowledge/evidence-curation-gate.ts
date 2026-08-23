import type { ControlStore } from "../control/control-store.js";
import type { ArtifactRef } from "../domain/types.js";

export interface EvidenceCurationStatus {
  stage: "clear" | "checkpoint" | "required";
  pendingCount: number;
  viewedCount: number;
  reviewedCount: number;
  promotedCount: number;
  unviewedCount: number;
  pendingArtifacts: Array<{ id: string; name: string; role: string; curationState: "viewed" | "unviewed" }>;
}

export interface EvidenceCurationPolicy {
  checkpointArtifacts: number;
  requiredArtifacts: number;
  listedArtifacts: number;
}

const DEFAULT_POLICY: Readonly<EvidenceCurationPolicy> = {
  checkpointArtifacts: 4,
  requiredArtifacts: 8,
  listedArtifacts: 8,
};

/** Keeps exploratory Artifact production bounded without promoting routine output to Evidence. */
export class EvidenceCurationGate {
  public constructor(
    private readonly runId: string,
    private readonly controlStore: ControlStore,
    private readonly policy: EvidenceCurationPolicy = DEFAULT_POLICY,
  ) {
    if (policy.checkpointArtifacts < 1 || policy.requiredArtifacts <= policy.checkpointArtifacts || policy.listedArtifacts < 1) {
      throw new Error("Invalid evidence curation policy");
    }
  }

  public async inspect(): Promise<EvidenceCurationStatus> {
    const [snapshot, events] = await Promise.all([this.controlStore.snapshot(this.runId), this.controlStore.events(this.runId)]);
    const currentEvidence = Object.values(snapshot.evidence).filter((evidence) => evidence.provenance?.runId === snapshot.runId && evidence.provenance.generation === snapshot.generation);
    const currentArtifacts = Object.values(snapshot.artifacts).filter((artifact) => artifact.runId === snapshot.runId && artifact.generation === snapshot.generation);
    const promoted = new Set(currentEvidence.flatMap((evidence) => [
      ...(evidence.source.artifactIds ?? []),
      ...(evidence.source.artifactId ? [evidence.source.artifactId] : []),
    ]));
    const promotedHashes = new Set([...promoted].flatMap((artifactId) => snapshot.artifacts[artifactId]?.sha256 ? [snapshot.artifacts[artifactId]!.sha256] : []));
    // Registration metadata is not a review. Only an explicit trusted
    // artifact_annotated event from the harness/user can move bytes to reviewed.
    const reviewedArtifactIds = new Set(events.flatMap((event) => {
      if (event.type !== "artifact_annotated") return [];
      const payload = event.payload ?? {};
      const semantic = payload.semantic as { annotatedBy?: string } | undefined;
      return semantic?.annotatedBy === "harness" || semantic?.annotatedBy === "user" ? [String(payload.artifactId)] : [];
    }));
    const reviewedHashes = new Set([...reviewedArtifactIds].flatMap((artifactId) => snapshot.artifacts[artifactId]?.sha256 ? [snapshot.artifacts[artifactId]!.sha256] : []));
    const viewedHashes = new Set(currentArtifacts.filter((artifact) => artifact.semantic?.annotatedBy === "agent").map((artifact) => artifact.sha256));
    const byHash = new Map<string, ArtifactRef>();
    for (const artifact of currentArtifacts.filter(isInvestigationArtifact).sort((left, right) => (left.semantic?.updatedSeq ?? 0) - (right.semantic?.updatedSeq ?? 0))) {
      if (!byHash.has(artifact.sha256)) byHash.set(artifact.sha256, artifact);
    }
    const classified = [...byHash.entries()].map(([hash, artifact]) => ({
      artifact,
      state: promotedHashes.has(hash) ? "promoted" as const : reviewedHashes.has(hash) ? "reviewed" as const : viewedHashes.has(hash) ? "viewed" as const : "unviewed" as const,
    }));
    const pending = classified.flatMap((item) => item.state === "viewed" || item.state === "unviewed"
      ? [{ artifact: item.artifact, state: item.state }]
      : []);
    return {
      stage: pending.length >= this.policy.requiredArtifacts
        ? "required"
        : pending.length >= this.policy.checkpointArtifacts
          ? "checkpoint"
          : "clear",
      pendingCount: pending.length,
      viewedCount: classified.filter((item) => item.state === "viewed").length,
      reviewedCount: classified.filter((item) => item.state === "reviewed").length,
      promotedCount: classified.filter((item) => item.state === "promoted").length,
      unviewedCount: classified.filter((item) => item.state === "unviewed").length,
      pendingArtifacts: pending.slice(0, this.policy.listedArtifacts).map(({ artifact, state }) => ({
        id: artifact.id,
        name: artifact.semantic?.name ?? artifact.path,
        role: artifact.semantic?.role ?? "intermediate",
        curationState: state,
      })),
    };
  }

  /**
   * Advisory: report a "required" curation backlog as a nudge string instead of
   * throwing. Throwing hard-stopped the next bash/read mid-solve — on
   * artifact-heavy challenges (crypto/reverse/pwn emit many outputs) the backlog
   * hits the limit fast and interrupted a legitimate multi-step solve, the same
   * way the experiment budget did. Callers append the returned notice to their
   * tool output so the model keeps control and curates when it chooses. Returns
   * undefined below the "required" threshold.
   */
  public async assertInvestigationAllowed(): Promise<string | undefined> {
    const status = await this.inspect();
    if (status.stage !== "required") return undefined;
    return this.format(status, true);
  }

  public async checkpointNotice(): Promise<string | undefined> {
    const status = await this.inspect();
    return status.stage === "clear" ? undefined : this.format(status, status.stage === "required");
  }

  private format(status: EvidenceCurationStatus, required: boolean): string {
    const artifacts = status.pendingArtifacts.map((artifact) => `${artifact.id} (${artifact.name}; ${artifact.curationState})`).join(", ");
    return [
      `[ProofBlade evidence curation ${required ? "required" : "checkpoint"}: ${status.pendingCount} unreviewed investigation artifacts]`,
      `Curate: ${artifacts || "use evidence search"}. Viewed=${status.viewedCount}; reviewed=${status.reviewedCount}; promoted=${status.promotedCount}; unviewed=${status.unviewedCount}.`,
      "Use evidence record to promote findings that advance or refute a hypothesis. Agent annotation marks an artifact viewed but does not clear this gate; routine/noise output requires trusted user/harness review.",
      required ? "Further read/bash calls are paused until at least one pending artifact is curated." : "Curate these artifacts before the exploration backlog reaches the hard limit.",
    ].join("\n");
  }
}

function isInvestigationArtifact(artifact: ArtifactRef): boolean {
  const tags = new Set(artifact.origin.tags);
  const operation = artifact.origin.operation ?? "";
  return tags.has("read") || tags.has("bash") || tags.has("command-output") || tags.has("file-content")
    || operation === "artifact_read" || operation === "coding_read" || operation === "coding_bash";
}
