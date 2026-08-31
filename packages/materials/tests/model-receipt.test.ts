import assert from "node:assert/strict";
import test from "node:test";
import { createModelReceipt, recallArtifact, selectContextCandidates } from "../src/index.js";

const artifact = { id: "A-1", runId: "R-1", generation: 2, path: "artifacts/A-1.txt", sha256: "f".repeat(64), bytes: 100, mime: "text/plain", sensitivity: "public" as const, origin: { schemaVersion: 1 as const, registeredBy: "agent" as const, tags: [] } };

test("creates bounded receipt with stable artifact reference and hash", () => {
  const receipt = createModelReceipt({ runId: "R-1", generation: 2, operationId: "O-1", title: "Large output", content: "header\n" + "x".repeat(5000), artifact, maxInlineChars: 64, maxPreviewChars: 20, generatedAt: "2026-08-31T00:00:00.000Z" });
  assert.equal(receipt.preview?.head?.length, 10);
  assert.equal(receipt.preview?.tail?.length, 10);
  assert.equal(receipt.preview?.omittedChars, 4987);
  assert.equal(receipt.refs[0]?.uri, "pb://run/R-1/artifact/A-1/content");
  assert.equal(receipt.resultHash.length, 64);
  assert.equal(receipt.presentationHash.length, 64);
});

test("path-only and secret receipts never expose inline content", () => {
  const pathOnly = createModelReceipt({ runId: "R-1", generation: 2, operationId: "O-1", title: "Path", content: "secret text", artifact, mode: "path_only" });
  assert.equal(pathOnly.preview, undefined);
  const secret = createModelReceipt({ runId: "R-1", generation: 2, operationId: "O-1", title: "Secret", content: "secret text", artifact: { ...artifact, sensitivity: "secret" }, mode: "full" });
  assert.equal(secret.preview, undefined);
  assert.equal(secret.summary, "restricted artifact receipt");
  assert.deepEqual(secret.keyFacts, []);
  assert.throws(() => createModelReceipt({ runId: "R-1", generation: 2, operationId: "O-1", title: "Too large", content: "x", maxInlineChars: 2049 }), /no greater/);
  const one = createModelReceipt({ runId: "R-1", generation: 2, operationId: "O-1", title: "One", content: "abcdef", maxInlineChars: 64, maxPreviewChars: 1 });
  assert.ok((one.preview?.head?.length ?? 0) + (one.preview?.tail?.length ?? 0) <= 1);
});

test("broker selection is deterministic and keeps required evidence within the budget", () => {
  const candidates = [
    { id: "z", uri: "pb://z", summary: "low", sourceIds: ["z"], relevance: .4, coverage: .2, novelty: .1, independentSources: 1, conflict: 0, trust: "observed" as const, estimatedTokens: 8 },
    { id: "required", uri: "pb://required", summary: "required", sourceIds: ["r"], relevance: .2, coverage: .2, novelty: .2, independentSources: 1, conflict: .1, trust: "untrusted" as const, estimatedTokens: 30, required: true },
    { id: "a", uri: "pb://a", summary: "high", sourceIds: ["a"], relevance: .9, coverage: .8, novelty: .7, independentSources: 2, conflict: .3, trust: "verified" as const, estimatedTokens: 20 },
  ];
  const result = selectContextCandidates(candidates, 50);
  assert.deepEqual(result.selected.map((item) => item.id), ["required", "a"]);
  assert.equal(result.totalTokens, 50);
  assert.equal(result.omitted[0]?.id, "z");
  assert.deepEqual(result, selectContextCandidates(candidates, 50));
  assert.throws(() => selectContextCandidates([{ ...candidates[0]!, required: true, estimatedTokens: 51 }], 50), /exceeds token budget/);
  assert.throws(() => selectContextCandidates([{ ...candidates[0]!, relevance: Number.NaN }], 50), /invalid relevance/);
});

test("recall enforces run, generation, sensitivity and bounded range before reading", async () => {
  const artifactStore = { readTextRange: async (_runId: string, _artifact: unknown, limit: number, offset: number) => ({ content: "bounded", offset, bytesRead: limit, totalBytes: 99, truncated: true }) };
  const common = { artifactStore: artifactStore as never, artifact, runId: "R-1", generation: 2, requester: "agent" as const, limit: 32 };
  const success = await recallArtifact(common);
  assert.equal(success.record.status, "SUCCEEDED");
  assert.equal(success.content, "bounded");
  assert.match(success.marker, /content_sha256=/);
  assert.equal((await recallArtifact({ ...common, generation: 3 })).record.status, "STALE");
  assert.equal((await recallArtifact({ ...common, artifact: { ...artifact, sensitivity: "secret" } })).record.status, "DENIED");
  assert.equal((await recallArtifact({ ...common, offset: -1 })).record.status, "RANGE_EXCEEDED");
  assert.equal((await recallArtifact({ ...common, limit: 6_001 })).record.status, "RANGE_EXCEEDED");
});
