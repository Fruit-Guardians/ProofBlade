import { basename, join } from "node:path";
import type { ArtifactRef, ArtifactSemanticMetadata } from "../domain/types.js";
import { id, redactSecrets } from "../domain/utils.js";
import type { ControlStore } from "../control/control-store.js";
import { FileArtifactRepository } from "@proofblade/molecules";

export interface ArtifactMeta {
  mime?: string;
  sensitivity?: ArtifactRef["sensitivity"];
  sourceEffectId?: string;
  filename?: string;
  truncated?: boolean;
  semantic?: Omit<ArtifactSemanticMetadata, "updatedSeq">;
}

export interface ArtifactTextRange {
  content: string;
  offset: number;
  bytesRead: number;
  totalBytes: number;
  truncated: boolean;
}

export class ArtifactStore {
  public constructor(private readonly runsRoot: string, private readonly controlStore: ControlStore) {}

  public async putText(runId: string, content: string, meta: ArtifactMeta = {}): Promise<ArtifactRef> {
    const artifact = await this.stageText(runId, content, meta);
    await this.controlStore.dispatch(runId, { type: "artifact", generation: artifact.generation, artifact, lane: "executor" });
    return (await this.controlStore.snapshot(runId)).artifacts[artifact.id] ?? artifact;
  }

  /**
   * Store bytes without adding them to the Run. Registration remains a separate
   * capability-gated step; an unregistered file is never Evidence provenance.
   */
  public async stageText(runId: string, content: string, meta: ArtifactMeta = {}): Promise<ArtifactRef> {
    const snapshot = await this.controlStore.snapshot(runId);
    const generation = snapshot.generation;
    const redacted = redactSecrets(content);
    const artifactId = id("A");
    const filename = sanitizeFilename(meta.filename ?? `${artifactId}.txt`);
    const relativePath = join("artifacts", `${artifactId}-${filename}`);
    const repository = new FileArtifactRepository(join(this.runsRoot, runId));
    const stored = await repository.put(relativePath, redacted, meta.mime ?? "text/plain");
    const artifact: ArtifactRef = {
      id: artifactId,
      runId,
      generation,
      origin: {
        schemaVersion: 1,
        registeredBy: "agent",
        operation: meta.sourceEffectId ? snapshot.effects[meta.sourceEffectId]?.operation : undefined,
        tags: [...(meta.semantic?.tags ?? [])],
      },
      ...stored,
      sensitivity: meta.sensitivity ?? "public",
      sourceEffectId: meta.sourceEffectId,
      truncated: meta.truncated,
      semantic: meta.semantic ? { ...meta.semantic, updatedSeq: 0 } : undefined,
    };
    return artifact;
  }

  public async readText(runId: string, artifact: ArtifactRef): Promise<string> {
    const repository = new FileArtifactRepository(join(this.runsRoot, runId));
    return Buffer.from(await repository.read(artifact)).toString("utf8");
  }

  /** Read a bounded UTF-8 prefix without allocating the complete Artifact. */
  public async readTextRange(runId: string, artifact: ArtifactRef, maxBytes: number, offset = 0): Promise<ArtifactTextRange> {
    const repository = new FileArtifactRepository(join(this.runsRoot, runId));
    const range = await repository.readRange(artifact, offset, maxBytes);
    return {
      content: decodeUtf8Range(range.content, offset, range.truncated),
      offset,
      bytesRead: range.content.byteLength,
      totalBytes: range.totalBytes,
      truncated: range.truncated,
    };
  }

  public async verify(runId: string, artifact: ArtifactRef): Promise<boolean> {
    try {
      await this.readText(runId, artifact);
      return true;
    } catch {
      return false;
    }
  }
}

function decodeUtf8Range(content: Uint8Array, offset: number, truncated: boolean): string {
  const buffer = Buffer.from(content);
  let start = 0;
  if (offset > 0) {
    while (start < buffer.length && isUtf8ContinuationByte(buffer[start]!)) start += 1;
  }
  if (!truncated) return buffer.subarray(start).toString("utf8");

  let end = buffer.length;
  while (end > start && isIncompleteUtf8Suffix(buffer.subarray(start, end))) end -= 1;
  return buffer.subarray(start, end).toString("utf8");
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function isIncompleteUtf8Suffix(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  let lead = buffer.length - 1;
  while (lead > 0 && isUtf8ContinuationByte(buffer[lead]!)) lead -= 1;
  const expected = utf8SequenceLength(buffer[lead]!);
  return buffer.length - lead < expected;
}

function utf8SequenceLength(byte: number): number {
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 1;
}

function sanitizeFilename(filename: string): string {
  return basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96) || "artifact.txt";
}
