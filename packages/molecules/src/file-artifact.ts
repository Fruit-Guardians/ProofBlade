import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { atomicWriteFile, sha256, type ArtifactAtom } from "@proofblade/atoms";

export class FileArtifactRepository {
  private readonly root: string;

  public constructor(root: string) {
    this.root = resolve(root);
  }

  public async put(relativePath: string, content: string | Uint8Array, mime: string): Promise<ArtifactAtom> {
    const path = this.resolveInside(relativePath);
    await atomicWriteFile(path, content);
    const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
    return { path: relative(this.root, path), sha256: sha256(content), bytes, mime };
  }

  public async read(artifact: ArtifactAtom): Promise<Uint8Array> {
    const content = await readFile(this.resolveInside(artifact.path));
    if (sha256(content) !== artifact.sha256) throw new Error(`Artifact hash mismatch: ${artifact.path}`);
    return content;
  }

  private resolveInside(path: string): string {
    if (isAbsolute(path)) throw new Error("Artifact paths must be relative");
    const resolved = resolve(this.root, path);
    const rel = relative(this.root, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Artifact path escapes repository root");
    return resolved;
  }
}
