import assert from "node:assert/strict";
import test from "node:test";
import { createModelReceipt, recallArtifact, renderModelReceipt, selectContextCandidates } from "../src/index.js";
import { boundModelText } from "../src/domain/text-bounds.js";
import { sha256 } from "../src/domain/utils.js";

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
});

test("result candidate receipts keep candidate content restricted", () => {
  const candidate = createModelReceipt({
    runId: "R-1",
    generation: 2,
    operationId: "O-CANDIDATE",
    title: "Security result",
    content: "derived exploit result",
    artifact: { ...artifact, sensitivity: "result_candidate" },
    mode: "full",
  });
  assert.equal(candidate.preview, undefined);
  const renderedCandidate = renderModelReceipt(candidate);
  assert.match(renderedCandidate, /visible=restricted/);
  assert.match(renderedCandidate, /summary=restricted artifact receipt/);
  assert.doesNotMatch(renderedCandidate, /derived exploit result/);

  const legacy = createModelReceipt({
    runId: "R-1",
    generation: 2,
    operationId: "O-LEGACY",
    title: "Legacy result",
    content: "legacy candidate",
    artifact: { ...artifact, sensitivity: "flag_candidate" },
    mode: "full",
  });
  assert.equal(legacy.preview, undefined);
});

test("rendered receipts expose an explicit Artifact recall path", () => {
  const receipt = createModelReceipt({ runId: "R-1", generation: 2, operationId: "bash-1", title: "Large output", summary: "Large output archived", content: "x".repeat(5000), artifact, maxInlineChars: 64, maxPreviewChars: 20 });
  const rendered = renderModelReceipt(receipt);
  assert.match(rendered, /visible=bounded/);
  assert.match(rendered, /artifact=pb:\/\/run\/R-1\/artifact\/A-1\/content/);
  assert.match(rendered, /next=recall/);
  assert.match(rendered, /omitted_chars=4980/);
  assert.match(rendered, new RegExp(`content_sha256=${artifact.sha256}`));
  assert.doesNotMatch(rendered, /x{100}/);
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
});

test("broker omits required candidates that exceed the hard token budget", () => {
  const result = selectContextCandidates([
    { id: "oversized-required", uri: "pb://required", summary: "required", sourceIds: ["r"], relevance: 1, coverage: 1, novelty: 1, independentSources: 1, conflict: 0, trust: "verified" as const, estimatedTokens: 51, required: true },
    { id: "fits", uri: "pb://fits", summary: "fits", sourceIds: ["f"], relevance: .5, coverage: .5, novelty: .5, independentSources: 1, conflict: 0, trust: "observed" as const, estimatedTokens: 20 },
  ], 50);
  assert.deepEqual(result.selected.map((item) => item.id), ["fits"]);
  assert.deepEqual(result.omitted, [{ id: "oversized-required", reason: "required_token_budget" }]);
  assert.ok(result.totalTokens <= 50);
});

test("recall enforces run, generation, sensitivity and bounded range before reading", async () => {
  const recalledArtifact = { ...artifact, sha256: sha256("complete artifact") };
  const artifactStore = {
    readText: async () => "complete artifact",
    readTextRange: async (_runId: string, _artifact: unknown, limit: number, offset: number) => ({ content: "bounded", offset, bytesRead: limit, totalBytes: 99, truncated: true }),
  };
  const common = { artifactStore: artifactStore as never, artifact: recalledArtifact, runId: "R-1", generation: 2, requester: "agent" as const, limit: 32 };
  const success = await recallArtifact(common);
  assert.equal(success.record.status, "SUCCEEDED");
  assert.equal(success.content, "bounded");
  assert.match(success.marker, /content_sha256=/);
  assert.equal((await recallArtifact({ ...common, generation: 3 })).record.status, "STALE");
  assert.equal((await recallArtifact({ ...common, artifact: { ...artifact, sensitivity: "secret" } })).record.status, "DENIED");
  assert.equal((await recallArtifact({ ...common, offset: -1 })).record.status, "RANGE_EXCEEDED");
});

test("recall rejects a tampered Artifact before reading its visible range", async () => {
  let rangeReads = 0;
  const recalledArtifact = { ...artifact, sha256: sha256("complete artifact") };
  const artifactStore = {
    readText: async () => "tampered artifact",
    readTextRange: async () => {
      rangeReads += 1;
      return { content: "must not be exposed", offset: 0, bytesRead: 19, totalBytes: 19, truncated: false };
    },
  };
  const result = await recallArtifact({ artifactStore: artifactStore as never, artifact: recalledArtifact, runId: "R-1", generation: 2, requester: "agent" });
  assert.equal(result.record.status, "HASH_MISMATCH");
  assert.equal(rangeReads, 0);
  assert.equal(result.content, undefined);
});

test("model-facing context bounds use the token budget even for oversized dynamic text", () => {
  const bounded = boundModelText("context block\n" + "x".repeat(100_000), 100_000, 10_000);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.text.length < 100_000);
});
