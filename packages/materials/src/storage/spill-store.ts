import type { ArtifactRef, ArtifactRole } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import type { ArtifactMeta, ArtifactStore } from "../effects/artifact-store.js";
import { snipText } from "@proofblade/molecules";

export type ToolResultState = "success" | "error";
export type DurableToolContentState = "inline" | "spilled" | "spill_failed";

export interface CanonicalToolValue {
  state: ToolResultState;
  value: unknown;
  resultHash: string;
}

export interface ModelToolPresentation {
  content: string;
  summary: string;
  resultHash: string;
  truncated: boolean;
  originalChars: number;
}

export interface DurableToolContent {
  state: DurableToolContentState;
  resultHash: string;
  contentHash: string;
  bytes: number;
  artifactId?: string;
  error?: string;
}

export interface ToolResultTriple {
  canonical: CanonicalToolValue;
  presentation: ModelToolPresentation;
  durable: DurableToolContent;
}

export interface SpillInput {
  state?: ToolResultState;
  value: unknown;
  /** Optional unstructured bytes returned by the Tool; defaults to canonical JSON. */
  durableContent?: string;
  /** Text deliberately shown to the model; defaults to durableContent. */
  modelContent?: string;
  summary?: string;
  operation: string;
  sourceEffectId?: string;
  sensitivity?: ArtifactMeta["sensitivity"];
  artifactRole?: ArtifactRole;
  spillThresholdChars?: number;
  presentationMaxChars?: number;
}

export interface SpillArtifactWriter {
  putText(runId: string, content: string, meta?: ArtifactMeta): Promise<ArtifactRef>;
  readText(runId: string, artifact: ArtifactRef): Promise<string>;
}

/**
 * Keep one Tool result in three linked forms: exact value, bounded model view,
 * and optional durable Artifact. A failed spill never becomes a fake success.
 */
export class SpillStore {
  public constructor(private readonly artifacts: SpillArtifactWriter) {}

  public async persist(runId: string, input: SpillInput): Promise<ToolResultTriple> {
    const state = input.state ?? "success";
    const canonical: CanonicalToolValue = {
      state,
      value: structuredClone(input.value),
      resultHash: sha256(canonicalJson({ state, value: input.value })),
    };
    const durableContent = input.durableContent ?? stringifyValue(input.value);
    const presentationSource = input.modelContent ?? durableContent;
    const presentationMaxChars = input.presentationMaxChars ?? 4_000;
    if (!Number.isInteger(presentationMaxChars) || presentationMaxChars < 64 || presentationMaxChars > 64_000) throw new Error("Tool presentation max chars must be an integer from 64 to 64000");
    const presented = snipText(presentationSource, presentationMaxChars);
    const presentation: ModelToolPresentation = {
      content: presented.text,
      summary: (input.summary ?? firstLine(presentationSource)).slice(0, 500),
      resultHash: canonical.resultHash,
      truncated: presented.truncated,
      originalChars: presented.originalChars,
    };
    const threshold = input.spillThresholdChars ?? 8_192;
    if (!Number.isInteger(threshold) || threshold < 64 || threshold > 10_000_000) throw new Error("Spill threshold must be a bounded integer");
    const contentHash = sha256(durableContent);
    if (durableContent.length <= threshold) {
      return { canonical, presentation, durable: { state: "inline", resultHash: canonical.resultHash, contentHash, bytes: Buffer.byteLength(durableContent, "utf8") } };
    }
    try {
      const artifact = await this.artifacts.putText(runId, durableContent, {
        filename: `spill-${canonical.resultHash.slice(0, 16)}.json`,
        mime: "application/json",
        sensitivity: input.sensitivity ?? "public",
        sourceEffectId: input.sourceEffectId,
        semantic: {
          name: `${input.operation} durable output`,
          summary: input.summary ?? "Large Tool output stored outside the model context.",
          tags: ["spill", "tool-output"],
          role: input.artifactRole ?? "intermediate",
          relatedIds: [],
          annotatedBy: "harness",
        },
      });
      return { canonical, presentation, durable: { state: "spilled", resultHash: canonical.resultHash, contentHash: artifact.sha256, bytes: artifact.bytes, artifactId: artifact.id } };
    } catch (error) {
      return { canonical, presentation, durable: { state: "spill_failed", resultHash: canonical.resultHash, contentHash, bytes: Buffer.byteLength(durableContent, "utf8"), error: String(error).slice(0, 500) } };
    }
  }

  public async read(runId: string, result: ToolResultTriple, snapshotArtifacts: Record<string, ArtifactRef>): Promise<string | undefined> {
    if (result.durable.state !== "spilled" || !result.durable.artifactId) return undefined;
    const artifact = snapshotArtifacts[result.durable.artifactId];
    if (!artifact) throw new Error(`Spilled Artifact is missing: ${result.durable.artifactId}`);
    const content = await this.artifacts.readText(runId, artifact);
    if (sha256(content) !== result.durable.contentHash || artifact.sha256 !== result.durable.contentHash) throw new Error(`Spilled Artifact hash mismatch: ${artifact.id}`);
    return content;
  }
}

function stringifyValue(value: unknown): string {
  const serialized = canonicalJson(value);
  return serialized === undefined ? String(value) : serialized;
}

function firstLine(value: string): string {
  return value.replace(/\r?\n/g, " ").trim().slice(0, 500) || "Tool returned an empty result.";
}
