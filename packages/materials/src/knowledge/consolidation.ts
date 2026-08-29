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

export const CONSOLIDATION_EVIDENCE_ID_LIMIT = 32;
export const CONSOLIDATION_NEGATIVE_RESULT_ID_LIMIT = 64;
export const CONSOLIDATION_RECOVERY_CANDIDATE_LIMIT = 16;

export interface ConsolidationSetClosure {
  count: number;
  hash: string;
}

export interface ConsolidationClosure {
  sourceArtifactIds: string[];
  evidence: ConsolidationSetClosure;
  rejectedHypotheses: ConsolidationSetClosure;
  policyHash: string;
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
  projectionHash: string;
  closure: ConsolidationClosure;
  projection: KnowledgeProjection;
}

export class ConsolidationInterruptedError extends Error {
  public constructor(public readonly point: "after_start" | "after_artifact") {
    super(`Simulated consolidation interruption at ${point}`);
    this.name = "ConsolidationInterruptedError";
  }
}

/**
 * Deterministic, provider-free consolidation. It creates a navigable L0/L1
 * index over existing sources; it never upgrades trust or deletes raw bytes.
 */
export class EvidenceConsolidator {
  public constructor(
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
    private readonly injectFault?: (point: "after_start" | "after_artifact", operationId: string) => Promise<void> | void,
  ) {}

  public async consolidate(runId: string, input: ConsolidateInput = {}): Promise<ConsolidateResult> {
    return await this.controlStore.withConsolidationLock(runId, async () => await this.consolidateLocked(runId, input));
  }

  private async consolidateLocked(runId: string, input: ConsolidateInput): Promise<ConsolidateResult> {
    const snapshot = await this.controlStore.snapshot(runId);
    const policy = input.policy ?? "all";
    const policyHash = sha256(canonicalJson({ policy, maxArtifacts: input.maxArtifacts ?? 32 }));
    const selected = selectArtifacts(snapshot, input);
    const sourceArtifactIds = selected.map((item) => item.id);
    const evidenceSet = closeIdSet(evidenceForArtifacts(snapshot, selected), CONSOLIDATION_EVIDENCE_ID_LIMIT);
    const rejectedHypothesisSet = closeIdSet(rejectedHypotheses(snapshot), CONSOLIDATION_NEGATIVE_RESULT_ID_LIMIT);
    const evidenceIds = evidenceSet.ids;
    const negativeResults = rejectedHypothesisSet.ids;
    const closure: ConsolidationClosure = {
      sourceArtifactIds,
      evidence: evidenceSet.closure,
      rejectedHypotheses: rejectedHypothesisSet.closure,
      policyHash,
    };
    const operationId = `CONSOLIDATE-${snapshot.generation}-${sha256(canonicalJson(closure)).slice(0, 32)}`;
    const events = await this.controlStore.events(runId);
    const completed = [...events].reverse().find((event) => event.type === "consolidate_finished" && event.payload?.operationId === operationId);
    if (completed && typeof completed.payload?.result === "object" && completed.payload.result !== null) {
      const persisted = completed.payload.result as Omit<ConsolidateResult, "status" | "projection"> & { projection?: { uri?: string } };
      if (!persisted.projection?.uri) throw new Error(`Consolidation ${operationId} has an invalid completion record`);
      const projection = projectKnowledge(snapshot, persisted.projection.uri);
      validateCompletedResult(persisted, operationId, closure, evidenceIds, negativeResults, projection, events);
      return { ...persisted, status: "REPLAYED", projection };
    }

    const existingStart = events.find((event) => event.type === "consolidate_started" && event.payload?.operationId === operationId);
    let beforeHash: string;
    if (existingStart) {
      beforeHash = validateStartedEvent(existingStart.payload, operationId, snapshot.generation, closure, evidenceIds, negativeResults);
    } else {
      beforeHash = snapshot.projectionHash ?? sha256(canonicalJson(snapshot));
      await this.controlStore.append(runId, [{
        schemaVersion: 1,
        lane: "main",
        correlationId: operationId,
        actor: "orchestrator",
        type: "consolidate_started",
        payload: { operationId, generation: snapshot.generation, sourceArtifactIds, evidenceIds, negativeResults, policyHash, closure, beforeHash },
      }]);
      await this.injectFault?.("after_start", operationId);
    }
    try {
      const contentRecord = {
        schemaVersion: 1,
        operationId,
        generation: snapshot.generation,
        policy,
        policyHash,
        beforeHash,
        closure,
        sources: selected.map((artifact) => ({ id: artifact.id, uri: `pb://run/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifact.id)}`, path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes })),
        evidenceIds,
        negativeResults,
      };
      const content = JSON.stringify(contentRecord, null, 2);
      const current = await this.controlStore.snapshot(runId);
      const artifact = await findRecoverableArtifact(runId, current, this.artifactStore, operationId, contentRecord)
        ?? await this.artifactStore.putText(runId, content, {
          filename: consolidationFilename(operationId), mime: "application/json", sensitivity: "public",
          semantic: { name: "Evidence consolidation", summary: `Deterministic index for ${selected.length} source Artifacts.`, tags: ["consolidation", "knowledge"], role: "supporting", relatedIds: evidenceIds, annotatedBy: "harness" },
        });
      await this.injectFault?.("after_artifact", operationId);
      const afterSnapshot = await this.controlStore.snapshot(runId);
      const projection = projectKnowledge(afterSnapshot, `pb://run/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifact.id)}`);
      const l1Hash = sha256(projection.levels.L1);
      const projectionHash = consolidationProjectionHash(projection, closure, evidenceIds, negativeResults);
      const result: ConsolidateResult = { operationId, status: "FINISHED", artifactId: artifact.id, sourceArtifactIds, evidenceIds, policyHash, beforeHash, afterHash: afterSnapshot.projectionHash ?? sha256(canonicalJson(afterSnapshot)), projectionHash, closure, projection };
      await this.controlStore.append(runId, [
        { schemaVersion: 1, lane: "main", correlationId: operationId, actor: "orchestrator", type: "consolidate_summary", payload: { operationId, artifactId: artifact.id, sourceArtifactIds, evidenceIds, negativeResults, l0: projection.levels.L0, l1Hash, policyHash, closure, projectionHash } },
        { schemaVersion: 1, lane: "main", correlationId: operationId, actor: "orchestrator", type: "consolidate_finished", payload: { operationId, result: { ...result, projection: { uri: projection.uri } } } },
      ]);
      return result;
    } catch (error) {
      if (error instanceof ConsolidationInterruptedError) throw error;
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

async function findRecoverableArtifact(runId: string, snapshot: RunSnapshot, artifactStore: ArtifactStore, operationId: string, expected: Record<string, unknown>): Promise<ArtifactRef | undefined> {
  const filename = consolidationFilename(operationId);
  const eligible = Object.values(snapshot.artifacts)
    .filter((item) => item.generation === snapshot.generation && item.semantic?.tags.includes("consolidation"))
    .sort((left, right) => left.id.localeCompare(right.id));
  const exact = eligible.filter((artifact) => artifactPathFilename(artifact) === `${artifact.id}-${filename}`);
  const candidates = (exact.length > 0 ? exact : eligible).slice(0, CONSOLIDATION_RECOVERY_CANDIDATE_LIMIT);
  for (const artifact of candidates) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await artifactStore.readText(runId, artifact)) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.operationId !== operationId) continue;
    if (canonicalJson(parsed) !== canonicalJson(expected)) throw new Error(`Consolidation ${operationId} draft does not match its durable inputs`);
    return artifact;
  }
  return undefined;
}

function validateStartedEvent(
  payload: Record<string, unknown> | undefined,
  operationId: string,
  generation: number,
  closure: ConsolidationClosure,
  evidenceIds: string[],
  negativeResults: string[],
): string {
  if (!payload || payload.operationId !== operationId || payload.generation !== generation
    || payload.policyHash !== closure.policyHash
    || canonicalJson(payload.sourceArtifactIds) !== canonicalJson(closure.sourceArtifactIds)
    || canonicalJson(payload.evidenceIds) !== canonicalJson(evidenceIds)
    || canonicalJson(payload.negativeResults) !== canonicalJson(negativeResults)
    || canonicalJson(payload.closure) !== canonicalJson(closure)
    || typeof payload.beforeHash !== "string" || !/^[a-f0-9]{64}$/.test(payload.beforeHash)) {
    throw new Error("Consolidation start record does not match durable inputs");
  }
  return payload.beforeHash;
}

function validateCompletedResult(
  result: Omit<ConsolidateResult, "status" | "projection"> & { projection?: { uri?: string } },
  operationId: string,
  closure: ConsolidationClosure,
  evidenceIds: string[],
  negativeResults: string[],
  projection: KnowledgeProjection,
  events: Awaited<ReturnType<ControlStore["events"]>>,
): void {
  const summary = [...events].reverse().find((event) => event.type === "consolidate_summary" && event.payload?.operationId === operationId);
  const expectedHash = consolidationProjectionHash(projection, closure, evidenceIds, negativeResults);
  if (result.operationId !== operationId || result.policyHash !== closure.policyHash
    || canonicalJson(result.sourceArtifactIds) !== canonicalJson(closure.sourceArtifactIds)
    || canonicalJson(result.evidenceIds) !== canonicalJson(evidenceIds)
    || canonicalJson(result.closure) !== canonicalJson(closure)
    || result.projectionHash !== expectedHash || summary?.payload?.projectionHash !== expectedHash
    || canonicalJson(summary.payload?.negativeResults) !== canonicalJson(negativeResults)
    || canonicalJson(summary.payload?.closure) !== canonicalJson(closure)
    || summary.payload?.l0 !== projection.levels.L0 || summary.payload?.l1Hash !== sha256(projection.levels.L1)) {
    throw new Error(`Consolidation ${operationId} completion is not bound to its sources and projection`);
  }
}

function consolidationProjectionHash(projection: KnowledgeProjection, closure: ConsolidationClosure, evidenceIds: string[], negativeResults: string[]): string {
  return sha256(canonicalJson({ uri: projection.uri, l0: projection.levels.L0, l1Hash: sha256(projection.levels.L1), closure, evidenceIds, negativeResults }));
}

function consolidationFilename(operationId: string): string {
  return `consolidate-${operationId}.json`;
}

function artifactPathFilename(artifact: ArtifactRef): string {
  return artifact.path.replaceAll("\\", "/").split("/").at(-1) ?? "";
}

function closeIdSet(ids: string[], limit: number): { ids: string[]; closure: ConsolidationSetClosure } {
  const complete = [...new Set(ids)].sort();
  return { ids: complete.slice(0, limit), closure: { count: complete.length, hash: sha256(canonicalJson(complete)) } };
}

function rejectedHypotheses(snapshot: RunSnapshot): string[] {
  return Object.values(snapshot.hypotheses)
    .filter((item) => item.runId === snapshot.runId && item.generation === snapshot.generation && item.status === "REJECTED")
    .map((item) => item.id);
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
