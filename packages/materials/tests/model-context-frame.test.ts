import assert from "node:assert/strict";
import test from "node:test";
import { buildModelContextFrame } from "../src/context/model-context-frame.js";

test("context frame captures final provider messages without persisting message bodies", () => {
  const frame = buildModelContextFrame({
    runId: "FRAME-1",
    generation: 3,
    requestId: "PR-1",
    epochId: "RE-1",
    provider: "aihub",
    model: "gpt-5.6-terra",
    api: "openai-responses",
    payload: {
      input: [
        { role: "system", content: "stable instructions" },
        { role: "user", content: "inspect A-123 and EV-456" },
        { role: "tool", content: "secret candidate PB{hidden}" },
      ],
    },
    contextManifestHash: "a".repeat(64),
    createdAt: "2026-09-02T00:00:00.000Z",
  });
  assert.equal(frame.messageCount, 3);
  assert.equal(frame.generation, 3);
  assert.equal(frame.finalMessages[1]?.source, "user");
  assert.deepEqual(frame.finalMessages[1]?.artifactRefs, ["A-123"]);
  assert.deepEqual(frame.finalMessages[1]?.evidenceRefs, ["EV-456"]);
  assert.equal(JSON.stringify(frame).includes("PB{hidden}"), false);
  assert.equal(frame.frameHash.length, 64);
});

test("context frame supports chat-completions messages and records omitted items", () => {
  const frame = buildModelContextFrame({
    runId: "FRAME-2",
    generation: 0,
    requestId: "PR-2",
    provider: "local",
    model: "test",
    api: "openai-completions",
    payload: { messages: [{ role: "user", content: "hello" }] },
    omittedItems: [{ itemId: "old", role: "tool", source: "artifact", sourceIds: ["A-old"], contentHash: "b".repeat(64), visibleChars: 10, estimatedTokens: 3, included: true, artifactRefs: ["A-old"], evidenceRefs: [] }],
    createdAt: "2026-09-02T00:00:00.000Z",
  });
  assert.equal(frame.finalMessages[0]?.contentHash, frame.sourceMessages[0]?.contentHash);
  assert.equal(frame.omittedItems[0]?.included, false);
  assert.equal(frame.omittedItems[0]?.itemId, "old");
  const repeated = buildModelContextFrame({
    runId: "FRAME-OTHER",
    generation: 9,
    requestId: "PR-OTHER",
    provider: "local",
    model: "test",
    api: "openai-completions",
    payload: { messages: [{ role: "user", content: "hello" }] },
    createdAt: "2027-01-01T00:00:00.000Z",
  });
  const noOmitted = buildModelContextFrame({
    runId: "FRAME-2",
    generation: 0,
    requestId: "PR-2",
    provider: "local",
    model: "test",
    api: "openai-completions",
    payload: { messages: [{ role: "user", content: "hello" }] },
    createdAt: "2026-09-02T00:00:00.000Z",
  });
  assert.equal(noOmitted.frameHash, repeated.frameHash);
});
