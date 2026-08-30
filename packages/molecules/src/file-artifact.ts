import { open, readFile } from "node:fs/promises";
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

  /**
   * Read only a bounded byte range. This intentionally does not verify the
   * complete artifact hash; callers that need full integrity verification must
   * use read(). The size metadata is still checked before returning the range.
   */
  public async readRange(artifact: ArtifactAtom, offset = 0, maxBytes = 1_048_576): Promise<{ content: Uint8Array; totalBytes: number; truncated: boolean }> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Artifact range offset must be a non-negative safe integer");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 10_000_000) throw new Error("Artifact range maxBytes must be a bounded positive integer");
    const handle = await open(this.resolveInside(artifact.path), "r");
    try {
      const stat = await handle.stat();
      if (stat.size !== artifact.bytes) throw new Error(`Artifact size mismatch: ${artifact.path}`);
      const length = Math.min(maxBytes, Math.max(0, stat.size - offset));
      const buffer = Buffer.alloc(length);
      const result = length === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, length, offset);
      const bytesRead = result.bytesRead;
      return { content: buffer.subarray(0, bytesRead), totalBytes: stat.size, truncated: offset + bytesRead < stat.size };
    } finally {
      await handle.close();
    }
  }

  private resolveInside(path: string): string {
    if (isAbsolute(path)) throw new Error("Artifact paths must be relative");
    const resolved = resolve(this.root, path);
    const rel = relative(this.root, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Artifact path escapes repository root");
    return resolved;
  }
}
