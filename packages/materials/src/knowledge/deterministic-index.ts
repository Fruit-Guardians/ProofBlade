import { sha256 } from "../domain/utils.js";

export interface IndexedArtifactText {
  artifactId: string;
  contentHash: string;
  normalizedText: string;
  terms: ReadonlySet<string>;
}

/**
 * Run-scoped deterministic text index. It is a derived cache: the Artifact
 * Store remains canonical, and a hash change always invalidates the entry.
 */
export class DeterministicArtifactIndex {
  private readonly entries = new Map<string, IndexedArtifactText>();

  public clear(): void {
    this.entries.clear();
  }

  public get(artifactId: string, contentHash: string): IndexedArtifactText | undefined {
    const entry = this.entries.get(artifactId);
    return entry?.contentHash === contentHash ? entry : undefined;
  }

  public set(artifactId: string, contentHash: string, content: string): IndexedArtifactText {
    const normalizedText = content.toLowerCase();
    const entry: IndexedArtifactText = { artifactId, contentHash, normalizedText, terms: new Set(tokenize(normalizedText)) };
    this.entries.set(artifactId, entry);
    return entry;
  }

  public search(terms: readonly string[]): string[] {
    return [...this.entries.values()]
      .filter((entry) => terms.every((term) => entry.terms.has(term) || entry.normalizedText.includes(term)))
      .map((entry) => entry.artifactId)
      .sort();
  }

  public size(): number {
    return this.entries.size;
  }
}

export function contentIndexHash(content: string): string {
  return sha256(content);
}

function tokenize(value: string): string[] {
  return value.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 0);
}
