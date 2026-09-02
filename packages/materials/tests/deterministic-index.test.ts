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
