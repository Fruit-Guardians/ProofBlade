import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ArtifactRef } from "../domain/types.js";
import { id, redactSecrets, sha256 } from "../domain/utils.js";
import type { ControlStore } from "../control/control-store.js";

export interface ArtifactMeta {
  mime?: string;
  sensitivity?: ArtifactRef["sensitivity"];
  sourceEffectId?: string;
  filename?: string;
  truncated?: boolean;
}

export class ArtifactStore {
  public constructor(private readonly runsRoot: string, private readonly controlStore: ControlStore) {}

  public async putText(runId: string, content: string, meta: ArtifactMeta = {}): Promise<ArtifactRef> {
    const redacted = redactSecrets(content);
    const bytes = Buffer.byteLength(redacted, "utf8");
    const digest = sha256(redacted);
    const artifactId = id("A");
    const filename = sanitizeFilename(meta.filename ?? `${artifactId}.txt`);
    const relativePath = join("artifacts", `${artifactId}-${filename}`);
    const absolutePath = join(this.runsRoot, runId, relativePath);
    await mkdir(join(this.runsRoot, runId, "artifacts"), { recursive: true });
    await writeFile(absolutePath, redacted, "utf8");
    const artifact: ArtifactRef = {
      id: artifactId,
      path: relativePath,
      sha256: digest,
      bytes,
      mime: meta.mime ?? "text/plain",
      sensitivity: meta.sensitivity ?? "public",
      sourceEffectId: meta.sourceEffectId,
      truncated: meta.truncated,
    };
    await this.controlStore.dispatch(runId, { type: "artifact", artifact, lane: "executor" });
    return artifact;
  }

  public async readText(runId: string, artifact: ArtifactRef): Promise<string> {
    const value = await readFile(join(this.runsRoot, runId, artifact.path), "utf8");
    if (sha256(value) !== artifact.sha256) throw new Error(`Artifact hash mismatch: ${artifact.id}`);
    return value;
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
