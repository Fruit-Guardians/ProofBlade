import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicArtifactIndex } from "../src/knowledge/deterministic-index.js";

test("deterministic Artifact index reuses content and invalidates changed hashes", () => {
  const index = new DeterministicArtifactIndex();
  const first = index.set("A-1", "hash-a", "EntryPoint verify_magic");
  assert.equal(first.normalizedText, "entrypoint verify_magic");
  assert.equal(index.get("A-1", "hash-a")?.artifactId, "A-1");
  assert.equal(index.get("A-1", "hash-b"), undefined);
  index.set("A-1", "hash-b", "EntryPoint reveal_flag");
  assert.deepEqual(index.search(["reveal_flag"]), ["A-1"]);
  assert.deepEqual(index.search(["verify_magic"]), []);
  assert.equal(index.size(), 1);
  index.clear();
  assert.equal(index.size(), 0);
});

test("deterministic Artifact index evicts least-recently-used entries within its byte budget", () => {
  const index = new DeterministicArtifactIndex({ maxEntries: 2, maxBytes: 12, maxEntryBytes: 12 });
  index.set("A-1", "h1", "one");
  index.set("A-2", "h2", "two");
  assert.equal(index.get("A-1", "h1")?.artifactId, "A-1", "a hit refreshes LRU order");
  index.set("A-3", "h3", "tri");
  assert.equal(index.get("A-2", "h2"), undefined);
  assert.equal(index.get("A-1", "h1")?.artifactId, "A-1");
  assert.equal(index.size(), 2);
  assert.ok(index.bytes() <= 12);
});

test("deterministic Artifact index does not retain an oversized artifact", () => {
  const index = new DeterministicArtifactIndex({ maxEntries: 2, maxBytes: 8, maxEntryBytes: 8 });
  const entry = index.set("A-large", "large", "x".repeat(32));
  assert.equal(entry.artifactId, "A-large");
  assert.equal(index.get("A-large", "large"), undefined);
  assert.equal(index.size(), 0);
  assert.equal(index.bytes(), 0);
});

test("deterministic Artifact index enforces UTF-8 byte eviction and replacement accounting", () => {
  const index = new DeterministicArtifactIndex({ maxEntries: 10, maxBytes: 10, maxEntryBytes: 32 });
  index.set("A-utf8-1", "h1", "中文"); // 6 UTF-8 bytes
  index.set("A-utf8-2", "h2", "😀"); // 4 UTF-8 bytes, exactly fills the budget
  assert.equal(index.bytes(), 10);
  index.set("A-utf8-3", "h3", "z"); // evicts the oldest entry by maxBytes
  assert.equal(index.get("A-utf8-1", "h1"), undefined);
  assert.equal(index.get("A-utf8-2", "h2")?.artifactId, "A-utf8-2");
  assert.equal(index.get("A-utf8-3", "h3")?.artifactId, "A-utf8-3");
  assert.equal(index.bytes(), 5);

  index.set("A-utf8-2", "h2-replaced", "ab");
  assert.equal(index.bytes(), 3, "replacing an entry removes its previous UTF-8 byte count first");
  assert.equal(index.get("A-utf8-2", "h2-replaced")?.artifactId, "A-utf8-2");
});
