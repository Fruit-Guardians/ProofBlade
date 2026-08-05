import { basename } from "node:path";
import { snipText } from "@proofblade/molecules";
import type { ControlStore } from "../control/control-store.js";
import type { ArtifactRole, ArtifactSemanticMetadata, Evidence, RunSnapshot } from "../domain/types.js";
import { id } from "../domain/utils.js";
import type { ArtifactStore } from "../effects/artifact-store.js";

export interface RecordCodingEvidenceInput {
  name: string;
  summary: string;
  artifactIds: string[];
  tags?: string[];
  claim?: string;
  dependsOn?: string[];
}

export class CodingEvidenceGraph {
  public constructor(
    private readonly runId: string,
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
  ) {}

  public async annotateArtifact(input: {
    artifactId: string;
    name: string;
    summary: string;
    tags?: string[];
    role?: ArtifactRole;
    relatedIds?: string[];
  }): Promise<{ artifactId: string; semantic: ArtifactSemanticMetadata }> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const artifact = snapshot.artifacts[input.artifactId];
    if (!artifact) throw new Error(`Unknown artifact: ${input.artifactId}`);
    const semantic = semanticInput({
      name: input.name,
      summary: input.summary,
      tags: input.tags,
      role: input.role,
      relatedIds: input.relatedIds,
      fallback: artifact.semantic,
    });
    await this.controlStore.dispatch(this.runId, { type: "artifact_annotation", artifactId: input.artifactId, semantic, lane: "main" });
    const updated = await this.controlStore.snapshot(this.runId);
    return { artifactId: input.artifactId, semantic: updated.artifacts[input.artifactId]!.semantic! };
  }

  public async recordEvidence(input: RecordCodingEvidenceInput): Promise<{
    evidenceId: string;
    factId?: string;
    artifactIds: string[];
  }> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const artifactIds = unique(input.artifactIds);
    if (artifactIds.length === 0 || artifactIds.length > 16) throw new Error("record evidence requires 1-16 artifact ids");
    assertKnown(artifactIds, snapshot.artifacts, "artifacts");
    const dependsOn = unique(input.dependsOn ?? []);
    assertKnown(dependsOn, snapshot.evidence, "evidence");
    const name = requiredText(input.name, "Evidence name", 160);
    const summary = requiredText(input.summary, "Evidence summary", 1_000);
    const tags = normalizedTags(input.tags);
    const claim = optionalText(input.claim, "Evidence claim", 1_000);
    const factId = claim ? id("F") : undefined;
    const evidenceId = id("EV");
    const evidence: Omit<Evidence, "createdSeq"> = {
      id: evidenceId,
      kind: "observation",
      name,
      summary,
      tags,
      dependsOn,
      source: { tool: "evidence", artifactId: artifactIds[0], artifactIds, generation: snapshot.generation },
      confidence: 0.8,
      supports: factId ? [factId] : [],
      refutes: [],
    };
    await this.controlStore.dispatch(this.runId, { type: "evidence", evidence, lane: "main" });
    if (factId && claim) {
      await this.controlStore.dispatch(this.runId, {
        type: "fact",
        fact: { id: factId, statement: claim, status: "PROPOSED", evidenceIds: [evidenceId] },
        lane: "main",
      });
    }
    for (const [index, artifactId] of artifactIds.entries()) {
      const current = (await this.controlStore.snapshot(this.runId)).artifacts[artifactId]!;
      const existing = current.semantic;
      await this.controlStore.dispatch(this.runId, {
        type: "artifact_annotation",
        artifactId,
        semantic: semanticInput({
          name: existing?.annotatedBy === "agent" ? existing.name : artifactIds.length === 1 ? name : `${name} (${index + 1}/${artifactIds.length})`,
          summary: existing?.annotatedBy === "agent" ? existing.summary : summary,
          tags: [...(existing?.tags ?? []), ...tags],
          role: "supporting",
          relatedIds: [...(existing?.relatedIds ?? []), evidenceId, ...(factId ? [factId] : [])],
          fallback: existing,
        }),
        lane: "main",
      });
    }
    return { evidenceId, factId, artifactIds };
  }

  public async search(query = "", tags: string[] = []): Promise<Array<Record<string, unknown>>> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const normalizedQuery = query.trim().toLowerCase();
    const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
    const normalizedTagSet = new Set(normalizedTags(tags).map((tag) => tag.toLowerCase()));
    const rows: Array<Record<string, unknown> & { search: string; tags: string[]; createdSeq: number }> = [
      ...Object.values(snapshot.facts).map((item) => ({ kind: "fact", id: item.id, name: item.statement, summary: item.statement, status: item.status, evidenceIds: item.evidenceIds, tags: [], createdSeq: item.createdSeq, search: `${item.id} ${item.statement}`.toLowerCase() })),
      ...Object.values(snapshot.evidence).map((item) => ({ kind: "evidence", id: item.id, name: item.name ?? item.summary, summary: item.summary, artifactIds: evidenceArtifactIds(item), dependsOn: item.dependsOn ?? [], supports: item.supports, refutes: item.refutes, tags: item.tags ?? [], createdSeq: item.createdSeq, search: `${item.id} ${item.name ?? ""} ${item.summary} ${(item.tags ?? []).join(" ")}`.toLowerCase() })),
      ...Object.values(snapshot.artifacts).map((item) => ({ kind: "artifact", id: item.id, name: item.semantic?.name ?? basename(item.path), summary: item.semantic?.summary ?? `${item.mime}, ${item.bytes} bytes`, role: item.semantic?.role ?? "intermediate", relatedIds: item.semantic?.relatedIds ?? [], tags: item.semantic?.tags ?? [], createdSeq: item.semantic?.updatedSeq ?? 0, search: `${item.id} ${item.path} ${item.semantic?.name ?? ""} ${item.semantic?.summary ?? ""} ${(item.semantic?.tags ?? []).join(" ")}`.toLowerCase() })),
    ];
    return rows
      .map((row) => ({ ...row, score: queryTerms.filter((term) => row.search.includes(term)).length }))
      .filter((row) => queryTerms.length === 0 || row.score > 0)
      .filter((row) => normalizedTagSet.size === 0 || [...normalizedTagSet].every((tag) => row.tags.map((item) => item.toLowerCase()).includes(tag)))
      .sort((a, b) => b.score - a.score || b.createdSeq - a.createdSeq)
      .slice(0, 40)
      .map(({ search: _search, createdSeq: _createdSeq, score: _score, ...row }) => row);
  }

  public async readArtifact(artifactId: string, maxChars = 6_000): Promise<Record<string, unknown>> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const artifact = snapshot.artifacts[artifactId];
    if (!artifact) throw new Error(`Unknown artifact: ${artifactId}`);
    const content = await this.artifactStore.readText(this.runId, artifact);
    const visible = snipText(content, maxChars);
    return {
      artifactId,
      name: artifact.semantic?.name ?? basename(artifact.path),
      summary: artifact.semantic?.summary,
      tags: artifact.semantic?.tags ?? [],
      role: artifact.semantic?.role ?? "intermediate",
      sha256: artifact.sha256,
      output: visible.text,
      truncated: visible.truncated,
      originalChars: visible.originalChars,
    };
  }
}

function semanticInput(input: {
  name: string;
  summary: string;
  tags?: string[];
  role?: ArtifactRole;
  relatedIds?: string[];
  fallback?: ArtifactSemanticMetadata;
}): Omit<ArtifactSemanticMetadata, "updatedSeq"> {
  return {
    name: requiredText(input.name, "Artifact name", 160),
    summary: requiredText(input.summary, "Artifact summary", 1_000),
    tags: normalizedTags(input.tags ?? input.fallback?.tags),
    role: input.role ?? input.fallback?.role ?? "intermediate",
    relatedIds: unique(input.relatedIds ?? input.fallback?.relatedIds ?? []).slice(0, 32),
    annotatedBy: "agent",
  };
}

function evidenceArtifactIds(evidence: Evidence): string[] {
  return unique([...(evidence.source.artifactIds ?? []), ...(evidence.source.artifactId ? [evidence.source.artifactId] : [])]);
}

function assertKnown(ids: string[], values: Record<string, unknown>, label: string): void {
  const missing = ids.filter((id) => !values[id]);
  if (missing.length > 0) throw new Error(`Unknown ${label}: ${missing.join(", ")}`);
}

function requiredText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`${label} must contain 1-${maxLength} characters`);
  return normalized;
}

function optionalText(value: string | undefined, label: string, maxLength: number): string | undefined {
  if (value === undefined || !value.trim()) return undefined;
  return requiredText(value, label, maxLength);
}

function normalizedTags(values: string[] | undefined): string[] {
  const tags = unique((values ?? []).map((value) => value.trim()).filter(Boolean));
  if (tags.length > 16 || tags.some((tag) => tag.length > 40)) throw new Error("Tags must contain at most 16 values of 1-40 characters");
  return tags;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
