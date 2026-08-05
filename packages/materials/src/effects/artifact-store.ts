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

export class ArtifactStore {
  public constructor(private readonly runsRoot: string, private readonly controlStore: ControlStore) {}

  public async putText(runId: string, content: string, meta: ArtifactMeta = {}): Promise<ArtifactRef> {
    const redacted = redactSecrets(content);
    const artifactId = id("A");
    const filename = sanitizeFilename(meta.filename ?? `${artifactId}.txt`);
    const relativePath = join("artifacts", `${artifactId}-${filename}`);
    const repository = new FileArtifactRepository(join(this.runsRoot, runId));
    const stored = await repository.put(relativePath, redacted, meta.mime ?? "text/plain");
    const artifact: ArtifactRef = {
      id: artifactId,
      ...stored,
      sensitivity: meta.sensitivity ?? "public",
      sourceEffectId: meta.sourceEffectId,
      truncated: meta.truncated,
      semantic: meta.semantic ? { ...meta.semantic, updatedSeq: 0 } : undefined,
    };
    await this.controlStore.dispatch(runId, { type: "artifact", artifact, lane: "executor" });
    return artifact;
  }

  public async readText(runId: string, artifact: ArtifactRef): Promise<string> {
    const repository = new FileArtifactRepository(join(this.runsRoot, runId));
    return Buffer.from(await repository.read(artifact)).toString("utf8");
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

function sanitizeFilename(filename: string): string {
  return basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96) || "artifact.txt";
}
