import assert from "node:assert/strict";
import test from "node:test";
import { assistantTurnsFromEntries, assertRunId, codingConversationTask, codingWorkspace, conversationMessagesFromEntries, correlateToolCalls, runKind } from "../src/debug-data.js";
import type { HarnessEvent, RunSnapshot } from "@proofblade/materials";

const entries = [
  { type: "message", id: "user-1", timestamp: "2026-08-05T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "inspect" }] } },
  { type: "message", id: "assistant-1", timestamp: "2026-08-05T00:00:01.000Z", message: { role: "assistant", provider: "test", model: "fixture", stopReason: "toolUse", content: [{ type: "text", text: "checking" }, { type: "toolCall", id: "call-1", name: "inspect_target", arguments: { path: "input.txt" } }] } },
  { type: "message", id: "result-1", timestamp: "2026-08-05T00:00:02.000Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "inspect_target", details: { artifactId: "A-1", evidenceId: "EV-1" }, isError: false } },
];

const snapshot = {
  artifacts: { "A-1": { id: "A-1", path: "artifacts/A-1.txt", sha256: "hash", bytes: 1, mime: "text/plain", sensitivity: "public" } },
  evidence: { "EV-1": { id: "EV-1", kind: "observation", summary: "found", source: { artifactId: "A-1" }, confidence: 1, supports: [], refutes: [], createdSeq: 2 } },
  effects: {},
} as unknown as RunSnapshot;

const events = [
  { type: "tool_call_recorded", payload: { toolCallId: "call-1", toolName: "inspect_target" } },
  { type: "tool_result_recorded", payload: { toolCallId: "call-1", toolName: "inspect_target", isError: false } },
] as HarnessEvent[];

test("correlates a Pi tool call with result, telemetry, artifact, and evidence", () => {
  const turns = assistantTurnsFromEntries(entries);
  const calls = correlateToolCalls(entries, events, snapshot, turns);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.text, "checking");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.id, "call-1");
  assert.equal(calls[0]?.status, "success");
  assert.match(calls[0]?.presentation.input ?? "", /input\.txt/);
  assert.match(calls[0]?.presentation.output ?? "", /artifactId/);
  assert.equal(calls[0]?.telemetry.call?.type, "tool_call_recorded");
  assert.deepEqual(calls[0]?.links.artifacts.map((item) => item.id), ["A-1"]);
  assert.deepEqual(calls[0]?.links.evidence.map((item) => item.id), ["EV-1"]);
});

test("marks a tool call without a result as pending", () => {
  const calls = correlateToolCalls(entries.slice(0, 2), [], snapshot);
  assert.equal(calls[0]?.status, "pending");
});

test("projects user and assistant Pi entries into a conversation without tool-result bubbles", () => {
  const messages = conversationMessagesFromEntries(entries);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[0]?.text, "inspect");
  assert.equal(messages[1]?.role, "assistant");
  assert.deepEqual(messages[1]?.toolCallIds, ["call-1"]);
});

test("projects persisted provider failures into assistant conversation messages", () => {
  const messages = conversationMessagesFromEntries([{
    type: "message",
    id: "assistant-error",
    timestamp: "2026-08-05T00:00:03.000Z",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." },
  }]);
  assert.equal(messages[0]?.stopReason, "error");
  assert.equal(messages[0]?.error, "Connection error.");
});

test("projects durable claim verification onto the matching assistant message", () => {
  const projected = conversationMessagesFromEntries(entries, [{
    type: "assistant_message",
    payload: { text: "checking", claimVerification: { required: true, status: "unverified", reason: "missing reproduction" } },
  }] as HarnessEvent[]);
  assert.equal(projected[1]?.claimVerification?.status, "unverified");
  assert.equal(projected[1]?.claimVerification?.reason, "missing reproduction");
});

test("rejects path-like run identifiers", () => {
  assert.doesNotThrow(() => assertRunId("RUN-001.safe"));
  assert.throws(() => assertRunId("../runs/other"));
});

test("creates ordinary coding conversations without fixture semantics", () => {
  const task = codingConversationTask("CHAT-001", "普通对话", "D:/workspace");
  assert.equal(runKind(task), "chat");
  assert.equal(task.mode, "coding_assistant");
  assert.equal(task.target, "D:/workspace");
  assert.deepEqual(task.success_criteria, []);
  assert.equal(task.verification.required_reproductions, 0);
  assert.equal(runKind({ mode: "ctf_solve" }), "fixture");
  assert.equal(codingWorkspace(task, "D:/selected", "D:/fallback"), "D:/selected");
  assert.equal(codingWorkspace(task, undefined, "D:/fallback"), "D:/workspace");
});
