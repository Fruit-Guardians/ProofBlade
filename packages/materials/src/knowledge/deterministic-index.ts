import { sha256 } from "../domain/utils.js";

export interface IndexedArtifactText {
  artifactId: string;
  contentHash: string;
  normalizedText: string;
  terms: ReadonlySet<string>;
}

export interface DeterministicArtifactIndexLimits {
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024;

/**
 * Run-scoped deterministic text index. It is a derived cache: the Artifact
 * Store remains canonical, and a hash change always invalidates the entry.
 */
export class DeterministicArtifactIndex {
  private readonly entries = new Map<string, { entry: IndexedArtifactText; bytes: number }>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private totalBytes = 0;

  public constructor(limits: DeterministicArtifactIndexLimits = {}) {
    this.maxEntries = positiveInteger(limits.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries");
    this.maxBytes = positiveInteger(limits.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
    this.maxEntryBytes = positiveInteger(limits.maxEntryBytes, DEFAULT_MAX_ENTRY_BYTES, "maxEntryBytes");
  }

  public clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  public get(artifactId: string, contentHash: string): IndexedArtifactText | undefined {
    const cached = this.entries.get(artifactId);
    if (!cached || cached.entry.contentHash !== contentHash) return undefined;
    this.entries.delete(artifactId);
    this.entries.set(artifactId, cached);
    return cached.entry;
  }

  public set(artifactId: string, contentHash: string, content: string): IndexedArtifactText {
    const normalizedText = content.toLowerCase();
    const entry: IndexedArtifactText = { artifactId, contentHash, normalizedText, terms: new Set(tokenize(normalizedText)) };
    const bytes = Buffer.byteLength(normalizedText, "utf8");
    this.remove(artifactId);
    if (bytes > this.maxEntryBytes || bytes > this.maxBytes) return entry;
    this.entries.set(artifactId, { entry, bytes });
    this.totalBytes += bytes;
    this.evict();
    return entry;
  }

  public search(terms: readonly string[]): string[] {
    return [...this.entries.values()]
      .map((cached) => cached.entry)
      .filter((entry) => terms.every((term) => entry.terms.has(term) || entry.normalizedText.includes(term)))
      .map((entry) => entry.artifactId)
      .sort();
  }

  public size(): number {
    return this.entries.size;
  }

  public bytes(): number {
    return this.totalBytes;
  }

  private remove(artifactId: string): void {
    const previous = this.entries.get(artifactId);
    if (!previous) return;
    this.entries.delete(artifactId);
    this.totalBytes -= previous.bytes;
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldestId = this.entries.keys().next().value as string | undefined;
      if (!oldestId) return;
      this.remove(oldestId);
    }
  }
}

export function contentIndexHash(content: string): string {
  return sha256(content);
}

function tokenize(value: string): string[] {
  return value.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 0);
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer`);
  return resolved;
}
