import type { ControlStore } from "../control/control-store.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { ArtifactRef, KnowledgeProjection, RunSnapshot } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import { projectKnowledge } from "./projection.js";

export interface ConsolidateInput {
  artifactIds?: string[];
  policy?: "deduplicate" | "summarize" | "all";
  maxArtifacts?: number;
}

export interface ConsolidateResult {
  operationId: string;
  status: "FINISHED" | "REPLAYED";
  artifactId: string;
  sourceArtifactIds: string[];
  evidenceIds: string[];
  policyHash: string;
  beforeHash: string;
  afterHash: string;
  projection: KnowledgeProjection;
}

/**
 * Deterministic, provider-free consolidation. It creates a navigable L0/L1
 * index over existing sources; it never upgrades trust or deletes raw bytes.
 */
export class EvidenceConsolidator {
  public constructor(private readonly controlStore: ControlStore, private readonly artifactStore: ArtifactStore) {}

  public async consolidate(runId: string, input: ConsolidateInput = {}): Promise<ConsolidateResult> {
    return await this.controlStore.withConsolidationLock(runId, async () => await this.consolidateLocked(runId, input));
  }

  private async consolidateLocked(runId: string, input: ConsolidateInput): Promise<ConsolidateResult> {
    const snapshot = await this.controlStore.snapshot(runId);
    const policy = input.policy ?? "all";
    const policyHash = sha256(canonicalJson({ policy, maxArtifacts: input.maxArtifacts ?? 32 }));
    const selected = selectArtifacts(snapshot, input);
    const evidenceIds = evidenceForArtifacts(snapshot, selected);
    const operationId = `CONSOLIDATE-${snapshot.generation}-${sha256(canonicalJson({ sourceArtifactIds: selected.map((item) => item.id), evidenceIds, policyHash })).slice(0, 32)}`;
    const events = await this.controlStore.events(runId);
    const completed = [...events].reverse().find((event) => event.type === "consolidate_finished" && event.payload?.operationId === operationId);
    if (completed && typeof completed.payload?.result === "object" && completed.payload.result !== null) {
      const persisted = completed.payload.result as Omit<ConsolidateResult, "status" | "projection"> & { projection?: { uri?: string } };
      if (!persisted.projection?.uri) throw new Error(`Consolidation ${operationId} has an invalid completion record`);
      return { ...persisted, status: "REPLAYED", projection: projectKnowledge(snapshot, persisted.projection.uri) };
    }

    const beforeHash = snapshot.projectionHash ?? sha256(canonicalJson(snapshot));
    await this.controlStore.append(runId, [{ schemaVersion: 1, lane: "main", correlationId: operationId, actor: "orchestrator", type: "consolidate_started", payload: { operationId, generation: snapshot.generation, sourceArtifactIds: selected.map((item) => item.id), evidenceIds, policyHash } }]);
    try {
      const content = JSON.stringify({
        schemaVersion: 1,
        operationId,
        generation: snapshot.generation,
        policy,
        policyHash,
        sources: selected.map((artifact) => ({ id: artifact.id, uri: `pb://run/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifact.id)}`, path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes })),
        evidenceIds,
        negativeResults: Object.values(snapshot.hypotheses).filter((item) => item.status === "REJECTED").map((item) => item.id).sort(),
      }, null, 2);
      const artifact = await this.artifactStore.putText(runId, content, {
        filename: `consolidate-${operationId}.json`, mime: "application/json", sensitivity: "public",
        semantic: { name: "Evidence consolidation", summary: `Deterministic index for ${selected.length} source Artifacts.`, tags: ["consolidation", "knowledge"], role: "supporting", relatedIds: evidenceIds, annotatedBy: "harness" },
      });
      const afterSnapshot = await this.controlStore.snapshot(runId);
      const projection = projectKnowledge(afterSnapshot, `pb://run/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifact.id)}`);
      const result: ConsolidateResult = { operationId, status: "FINISHED", artifactId: artifact.id, sourceArtifactIds: selected.map((item) => item.id), evidenceIds, policyHash, beforeHash, afterHash: afterSnapshot.projectionHash ?? sha256(canonicalJson(afterSnapshot)), projection };
      await this.controlStore.append(runId, [{ schemaVersion: 1, lane: "main", correlationId: operationId, actor: "orchestrator", type: "consolidate_summary", payload: { operationId, artifactId: artifact.id, sourceArtifactIds: result.sourceArtifactIds, evidenceIds, l0: projection.levels.L0, l1Hash: sha256(projection.levels.L1), policyHash } }]);
      await this.controlStore.append(runId, [{ schemaVersion: 1, lane: "main", correlationId: operationId, actor: "orchestrator", type: "consolidate_finished", payload: { operationId, result: { ...result, projection: { uri: projection.uri } } } }]);
      return result;
    } catch (error) {
      await this.controlStore.append(runId, [{ schemaVersion: 1, lane: "main", correlationId: operationId, actor: "orchestrator", type: "consolidate_failed", payload: { operationId, reason: String(error).slice(0, 1_000) } }]).catch(() => undefined);
      throw error;
    }
  }

  public async orphanOperations(runId: string): Promise<string[]> {
    const events = await this.controlStore.events(runId);
    const started = new Set(events.filter((event) => event.type === "consolidate_started").map((event) => String(event.payload?.operationId)));
    const finished = new Set(events.filter((event) => event.type === "consolidate_finished" || event.type === "consolidate_failed").map((event) => String(event.payload?.operationId)));
    return [...started].filter((operationId) => !finished.has(operationId)).sort();
  }
}

function selectArtifacts(snapshot: RunSnapshot, input: ConsolidateInput): ArtifactRef[] {
  const limit = input.maxArtifacts ?? 32;
  if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error("Consolidation maxArtifacts must be an integer from 1 to 128");
  const all = Object.values(snapshot.artifacts).filter((artifact) => artifact.runId === snapshot.runId && artifact.generation === snapshot.generation);
  const selected = input.artifactIds
    ? input.artifactIds.map((artifactId) => {
      const artifact = snapshot.artifacts[artifactId];
      if (!artifact || artifact.runId !== snapshot.runId || artifact.generation !== snapshot.generation) throw new Error(`Unknown current artifact: ${artifactId}`);
      return artifact;
    })
    : all.filter((artifact) => artifact.origin.tags.some((tag) => ["read", "bash", "command-output", "file-content"].includes(tag)));
  return [...new Map(selected.map((artifact) => [artifact.sha256, artifact])).values()].sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit);
}

function evidenceForArtifacts(snapshot: RunSnapshot, artifacts: ArtifactRef[]): string[] {
  const ids = new Set(artifacts.map((artifact) => artifact.id));
  return Object.values(snapshot.evidence).filter((evidence) => {
    const sources = new Set([...(evidence.source.artifactIds ?? []), ...(evidence.source.artifactId ? [evidence.source.artifactId] : [])]);
    return [...sources].some((sourceId) => ids.has(sourceId));
  }).map((evidence) => evidence.id).sort();
}
