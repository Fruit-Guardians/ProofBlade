import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DebugDataService, assistantTurnsFromEntries, assertRunId, codingConversationTask, codingWorkspace, conversationMessagesFromEntries, correlateToolCalls, runKind } from "../src/debug-data.js";
import { SingleAgentCtfLoop, fixtureTask } from "@proofblade/materials";
import type { AgentLanePort, AgentOutcome, AppServices, HarnessEvent, ProofBladeConfig, RunSnapshot, SolverLaneFactory } from "@proofblade/materials";
import type { ChatStreamEvent } from "../src/shared.js";

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

test("marks a legacy challenge answer without reproduction metadata as unverified", () => {
  const legacy = conversationMessagesFromEntries([
    { type: "message", id: "legacy-user", message: { role: "user", content: [{ type: "text", text: "完成这道题，并得到flag" }] } },
    { type: "message", id: "legacy-tool-turn", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "正在检查文件" }] } },
    { type: "message", id: "legacy-answer", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "最终答案：LCTF2026EV-ARM-GW-042" }] } },
  ]);
  assert.equal(legacy[1]?.claimVerification, undefined);
  assert.equal(legacy[2]?.claimVerification?.status, "unverified");
  assert.equal(legacy[2]?.claimVerification?.reason, "历史消息没有候选复现记录。");
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

test("pauses an active coding lane and persists a resumable run state", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-pause-"));
  let releasePrompt: ((outcome: AgentOutcome) => void) | undefined;
  let markPromptStarted: (() => void) | undefined;
  const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
  const promptResult = new Promise<AgentOutcome>((resolve) => { releasePrompt = resolve; });
  let aborts = 0;
  const lane: AgentLanePort = {
    async prompt() { markPromptStarted?.(); return await promptResult; },
    async abort() {
      aborts += 1;
      releasePrompt?.({ text: "partial", stopReason: "aborted", usage: zeroUsage() });
    },
    async compact() {},
    async isIdle() { return false; },
    async close() {},
  };
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"), async () => lane);
    const runId = "CHAT-PAUSE-001";
    await data.createConversation({ runId, title: "pause test", workspacePath: root });
    const events: ChatStreamEvent[] = [];
    const chat = data.chat(runId, "inspect the workspace", (event) => events.push(event), undefined, undefined, root);
    await promptStarted;
    const paused = await data.pause(runId);
    await chat;

    assert.equal(aborts, 1);
    assert.equal(paused.state, "paused");
    assert.equal((await data.getRun(runId)).snapshot.status, "PAUSED");
    assert.deepEqual(events.filter((event) => event.type === "stopping" || event.type === "paused").map((event) => event.type), ["stopping", "paused"]);
    assert.equal(events.some((event) => event.type === "done" || event.type === "error"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI close aborts and awaits startSolve before closing its HTTP Fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-solve-close-"));
  let releasePrompt: (() => void) | undefined;
  const solveLane: SolverLaneFactory = async () => ({
    async prompt() {
      return await new Promise<AgentOutcome>((resolve) => {
        releasePrompt = () => resolve({ text: "aborted", stopReason: "aborted", usage: zeroUsage() });
      });
    },
    async compact() {},
    async abort() { releasePrompt?.(); },
    async isIdle() { return false; },
    async close() {},
  });
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"), undefined, (projectRoot, solveConfig, services) => new SingleAgentCtfLoop(projectRoot, solveConfig, services, solveLane));
    const services = (data as unknown as { services: AppServices }).services;
    const runId = "GUI-SOLVE-CLOSE-web-source-1";
    const fixture = await services.sandbox.build(fixtureTask(runId, "web-source-1", root, config));
    assert.ok(fixture.endpoint);
    await data.startSolve({ runId, fixtureId: "web-source-1", mode: "assist", maxTurns: 1 });
    assert.equal((await fetch(`${fixture.endpoint}/.proofblade/health`)).status, 200);
    await data.close();
    await assert.rejects(fetch(`${fixture.endpoint}/.proofblade/health`, { signal: AbortSignal.timeout(1_000) }));
    await assert.rejects(data.startSolve({ runId: "GUI-SOLVE-CLOSE-NEW", fixtureId: "web-source-1", mode: "assist" }), /shutting down/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI close reports Lane abort failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-abort-failure-"));
  let promptStarted: (() => void) | undefined;
  let releasePrompt: (() => void) | undefined;
  const lane: AgentLanePort = {
    async prompt() {
      promptStarted?.();
      return await new Promise<AgentOutcome>((resolve) => { releasePrompt = () => resolve({ text: "aborted", stopReason: "aborted", usage: zeroUsage() }); });
    },
    async abort() {
      releasePrompt?.();
      throw new Error("injected lane abort failure");
    },
    async compact() {},
    async isIdle() { return false; },
    async close() {},
  };
  const started = new Promise<void>((resolve) => { promptStarted = resolve; });
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"), async () => lane);
    const runId = "GUI-ABORT-FAILURE-001";
    await data.createConversation({ runId, title: "abort failure", workspacePath: root });
    const chat = data.chat(runId, "inspect", () => undefined, undefined, undefined, root);
    await started;
    await assert.rejects(data.close(), (error: unknown) => error instanceof AggregateError && error.errors.some((item) => String(item).includes("injected lane abort failure")));
    await chat;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "TEST_API_KEY",
      contextWindow: 4096,
      maxTokens: 512,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      input: ["text"],
    },
  },
};

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
