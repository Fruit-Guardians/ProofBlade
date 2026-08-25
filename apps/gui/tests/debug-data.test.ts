import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DebugDataService, assistantTurnsFromEntries, assertRunId, boundedJsonByteSize, codingConversationTask, codingWorkspace, conversationMessagesFromEntries, correlateToolCalls, runKind } from "../src/debug-data.js";
import { JsonlControlStore, SingleAgentCtfLoop } from "@proofblade/materials";
import { JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AgentLanePort, AgentOutcome, HarnessEvent, ProofBladeConfig, RunSnapshot } from "@proofblade/materials";
import type { ChatStreamEvent, RunDetail } from "../src/shared.js";

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

test("[contract:hidden-context-recovery-turn] hides automatic context recovery prompts from chat", () => {
  const messages = conversationMessagesFromEntries([
    { type: "message", id: "user", message: { role: "user", content: [{ type: "text", text: "solve" }] } },
    { type: "message", id: "recovery", message: { role: "user", content: [{ type: "text", text: "[ProofBlade automatic context recovery]\nContinue the unfinished task." }] } },
    { type: "message", id: "assistant", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } },
  ]);
  assert.deepEqual(messages.map((message) => [message.role, message.text]), [["user", "solve"], ["assistant", "done"]]);
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

test("[contract:repeated-tool-failure-conversation] projects a persisted breaker termination as a normal assistant reply", () => {
  const messages = conversationMessagesFromEntries([{
    type: "message",
    id: "assistant-breaker",
    timestamp: "2026-08-05T00:00:03.000Z",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "ProofBlade repeated tool failure." },
  }], [{
    type: "assistant_message",
    payload: { text: "ProofBlade repeated tool failure. Change the approach before continuing.", stopReason: "stop", termination: "repeated_tool_failure", piEntryId: "assistant-breaker" },
  }] as HarnessEvent[]);
  assert.equal(messages[0]?.text, "ProofBlade repeated tool failure. Change the approach before continuing.");
  assert.equal(messages[0]?.stopReason, "stop");
  assert.equal(messages[0]?.error, undefined);
});

test("[contract:no-progress-conversation] projects a persisted convergence stop onto its exact tool-use entry", () => {
  const messages = conversationMessagesFromEntries([{
    type: "message",
    id: "assistant-no-progress",
    timestamp: "2026-08-05T00:00:03.000Z",
    message: { role: "assistant", content: [{ type: "toolCall", id: "read-3", name: "read", arguments: { path: "firmware.asm" } }], stopReason: "toolUse" },
  }], [{
    type: "assistant_message",
    payload: { text: "Repeated exploration produced no new information.", stopReason: "stop", termination: "no_progress", piEntryId: "assistant-no-progress" },
  }] as HarnessEvent[]);
  assert.equal(messages[0]?.text, "Repeated exploration produced no new information.");
  assert.equal(messages[0]?.stopReason, "stop");
  assert.equal(messages[0]?.error, undefined);
});

test("[contract:tool-failure-storm-conversation] projects a failure-budget stop as a normal assistant reply", () => {
  const messages = conversationMessagesFromEntries([{
    type: "message",
    id: "assistant-failure-storm",
    timestamp: "2026-08-05T00:00:03.000Z",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "raw tool failure" },
  }], [{
    type: "assistant_message",
    payload: { text: "Tool failures did not produce durable progress.", stopReason: "stop", termination: "tool_failure_storm", piEntryId: "assistant-failure-storm" },
  }] as HarnessEvent[]);
  assert.equal(messages[0]?.text, "Tool failures did not produce durable progress.");
  assert.equal(messages[0]?.stopReason, "stop");
  assert.equal(messages[0]?.error, undefined);
});

test("[contract:repeated-tool-failure-entry-link] an old breaker event cannot overwrite a later provider failure", () => {
  const messages = conversationMessagesFromEntries([
    {
      type: "message",
      id: "old-breaker",
      timestamp: "2026-08-05T00:00:03.000Z",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "old breaker raw error" },
    },
    {
      type: "message",
      id: "new-provider-failure",
      timestamp: "2026-08-05T00:01:03.000Z",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "new provider failure" },
    },
  ], [{
    type: "assistant_message",
    payload: {
      text: "breaker recovery guidance",
      stopReason: "stop",
      termination: "repeated_tool_failure",
      piEntryId: "old-breaker",
    },
  }] as HarnessEvent[]);

  assert.deepEqual(messages.map((message) => ({ id: message.id, text: message.text, stopReason: message.stopReason, error: message.error })), [
    { id: "old-breaker", text: "breaker recovery guidance", stopReason: "stop", error: undefined },
    { id: "new-provider-failure", text: "", stopReason: "error", error: "new provider failure" },
  ]);
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

test("reuses unchanged run details, invalidates durable changes, and clears the cache on close", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-detail-cache-"));
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"));
    const runId = "CHAT-CACHE-001";
    await data.createConversation({ runId, title: "cache test", workspacePath: root });

    const first = await data.getRun(runId);
    const cached = await data.getRun(runId);
    assert.equal(cached.snapshot, first.snapshot);
    assert.equal(cached.sessions, first.sessions);

    await data.checkpoint(runId, "invalidate detail cache");
    const refreshed = await data.getRun(runId);
    assert.notEqual(refreshed.snapshot, first.snapshot);
    assert.ok(refreshed.snapshot.lastSeq > first.snapshot.lastSeq);
    await data.close();
    const afterClose = await data.getRun(runId);
    assert.notEqual(afterClose.snapshot, refreshed.snapshot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded JSON byte estimation matches JSON.stringify for nested arrays", () => {
  const value = {
    outer: ["alpha", [1, true, null], { inner: ["中文", "终"] }],
    tail: [[[]], ["omega"]],
  };
  const expected = Buffer.byteLength(JSON.stringify(value), "utf8");
  assert.equal(boundedJsonByteSize(value, expected + 1), expected);
});

test("invalidates cached run details when only the Pi Session changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-session-cache-"));
  let env: NodeExecutionEnv | undefined;
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"));
    const runId = "CHAT-SESSION-CACHE-001";
    await data.createConversation({ runId, title: "session cache test", workspacePath: root });
    const eventsPath = join(root, "runs", runId, "events.jsonl");

    const first = await data.getRun(runId);
    const eventsBefore = await stat(eventsPath, { bigint: true });
    assert.equal(first.sessions.length, 0);

    const runDir = join(root, "runs", runId);
    env = new NodeExecutionEnv({ cwd: runDir });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(runDir, "pi-sessions") });
    const session = await repo.create({ id: `${runId}-chat`, cwd: root, metadata: { runId, lane: "main" } });
    await session.appendMessage({ role: "user", content: [{ type: "text", text: "session-only update" }], timestamp: Date.now() });

    const eventsAfter = await stat(eventsPath, { bigint: true });
    assert.equal(eventsAfter.size, eventsBefore.size);
    assert.equal(eventsAfter.mtimeNs, eventsBefore.mtimeNs);

    const refreshed = await data.getRun(runId);
    assert.notEqual(refreshed.sessions, first.sessions);
    assert.equal(refreshed.sessions.length, 1);
    assert.equal(refreshed.sessions[0]?.messages[0]?.text, "session-only update");
    await data.close();
  } finally {
    await env?.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("coalesces concurrent RunDetail cache misses for one Run", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-detail-single-flight-"));
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"));
    const runId = "CHAT-DETAIL-SINGLE-FLIGHT-001";
    await data.createConversation({ runId, title: "detail single flight", workspacePath: root });
    const [first, second] = await Promise.all([data.getRun(runId), data.getRun(runId)]);
    assert.equal(first.sessions, second.sessions);
    assert.equal(first.events, second.events);
    await data.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not reuse an in-flight RunDetail load after a Pi Session version change", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-detail-versioned-flight-"));
  let env: NodeExecutionEnv | undefined;
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"));
    const runId = "CHAT-DETAIL-VERSIONED-FLIGHT-001";
    await data.createConversation({ runId, title: "versioned detail single flight", workspacePath: root });
    const runDir = join(root, "runs", runId);
    env = new NodeExecutionEnv({ cwd: runDir });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(runDir, "pi-sessions") });
    const session = await repo.create({ id: `${runId}-chat`, cwd: root, metadata: { runId, lane: "main" } });
    await session.appendMessage({ role: "user", content: [{ type: "text", text: "old" }], timestamp: Date.now() });

    const originalLoadStableSessions = (data as unknown as {
      loadStableSessions: (...args: unknown[]) => Promise<{ sessions: unknown[]; version: string; stable: boolean }>;
    }).loadStableSessions.bind(data);
    let releaseFirstLoad: (() => void) | undefined;
    const firstLoadPaused = new Promise<void>((resolve) => { releaseFirstLoad = resolve; });
    let markFirstLoadWaiting: (() => void) | undefined;
    const firstLoadWaiting = new Promise<void>((resolve) => { markFirstLoadWaiting = resolve; });
    let delayed = true;
    (data as unknown as { loadStableSessions: (...args: unknown[]) => Promise<unknown> }).loadStableSessions = async (...args) => {
      const result = await originalLoadStableSessions(...args);
      if (delayed) {
        delayed = false;
        markFirstLoadWaiting?.();
        await firstLoadPaused;
      }
      return result;
    };

    const oldLoad = data.getRun(runId);
    await firstLoadWaiting;
    await session.appendMessage({ role: "assistant", content: [{ type: "text", text: "new" }], timestamp: Date.now() });
    const newLoad = data.getRun(runId);
    releaseFirstLoad?.();
    const [oldDetail, newDetail] = await Promise.all([oldLoad, newLoad]);

    assert.equal(oldDetail.sessions[0]?.messages.some((message) => message.text === "old"), true);
    assert.equal(oldDetail.sessions[0]?.messages.some((message) => message.text === "new"), false);
    assert.equal(newDetail.sessions[0]?.messages.some((message) => message.text === "new"), true);
    assert.notEqual(oldDetail.sessions, newDetail.sessions);
    await data.close();
  } finally {
    await env?.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("does not repopulate the RunDetail cache when close races an in-flight load", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-detail-close-flight-"));
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"));
    const runId = "CHAT-DETAIL-CLOSE-FLIGHT-001";
    await data.createConversation({ runId, title: "close detail single flight", workspacePath: root });
    const originalLoadStableSessions = (data as unknown as {
      loadStableSessions: (...args: unknown[]) => Promise<unknown>;
    }).loadStableSessions.bind(data);
    let releaseLoad: (() => void) | undefined;
    const loadPaused = new Promise<void>((resolve) => { releaseLoad = resolve; });
    let markLoadWaiting: (() => void) | undefined;
    const loadWaiting = new Promise<void>((resolve) => { markLoadWaiting = resolve; });
    (data as unknown as { loadStableSessions: (...args: unknown[]) => Promise<unknown> }).loadStableSessions = async (...args) => {
      const result = await originalLoadStableSessions(...args);
      markLoadWaiting?.();
      await loadPaused;
      return result;
    };

    const detailLoad = data.getRun(runId);
    await loadWaiting;
    await data.close();
    const cache = (data as unknown as { runDetailCache: { size: number; weight: number } }).runDetailCache;
    assert.equal(cache.size, 0);
    assert.equal(cache.weight, 0);
    releaseLoad?.();
    await detailLoad;
    assert.equal(cache.size, 0);
    assert.equal(cache.weight, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("drops the previous RunDetail cache entry when a replacement detail exceeds the byte limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-detail-cache-limit-"));
  let env: NodeExecutionEnv | undefined;
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"));
    const runId = "CHAT-DETAIL-CACHE-LIMIT-001";
    await data.createConversation({ runId, title: "detail cache limit", workspacePath: root });
    const first = await data.getRun(runId);
    const cache = (data as unknown as { runDetailCache: { size: number; weight: number } }).runDetailCache;
    assert.equal(cache.size, 1);
    assert.ok(first.sessions.length >= 0);

    const runDir = join(root, "runs", runId);
    env = new NodeExecutionEnv({ cwd: runDir });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(runDir, "pi-sessions") });
    const session = await repo.create({ id: `${runId}-chat`, cwd: root, metadata: { runId, lane: "main" } });
    await session.appendMessage({ role: "assistant", content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }], timestamp: Date.now() });

    const oversized = await data.getRun(runId);
    assert.ok(oversized.sessions[0]?.messages.some((message) => message.text.length > 8 * 1024 * 1024));
    assert.equal(cache.size, 0);
    assert.equal(cache.weight, 0);
    await data.close();
  } finally {
    await env?.cleanup();
    await rm(root, { recursive: true, force: true });
  }
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

test("[contract:repeated-tool-failure-chat-done] streams a breaker termination as a normal assistant reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-breaker-"));
  const message = "ProofBlade repeated tool failure. Change the approach before continuing.";
  const lane: AgentLanePort = {
    async prompt() {
      return {
        text: message,
        stopReason: "error",
        errorMessage: message,
        termination: "repeated_tool_failure",
        usage: zeroUsage(),
      };
    },
    async abort() {},
    async compact() {},
    async isIdle() { return true; },
    async close() {},
  };
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"), async () => lane);
    const runId = "CHAT-BREAKER-001";
    await data.createConversation({ runId, title: "breaker test", workspacePath: root });
    const events: ChatStreamEvent[] = [];
    await data.chat(runId, "inspect the workspace", (event) => events.push(event), undefined, undefined, root);

    assert.equal(events.some((event) => event.type === "error"), false);
    const done = events.find((event): event is Extract<ChatStreamEvent, { type: "done" }> => event.type === "done");
    assert.equal(done?.text, message);
    assert.equal(done?.stopReason, "stop");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:no-progress-chat-done] streams a convergence stop as a normal assistant reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-no-progress-"));
  const message = "Repeated exploration produced no new information.";
  const lane: AgentLanePort = {
    async prompt() { return { text: message, stopReason: "stop", termination: "no_progress", usage: zeroUsage() }; },
    async abort() {},
    async compact() {},
    async isIdle() { return true; },
    async close() {},
  };
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"), async () => lane);
    const runId = "CHAT-NO-PROGRESS-001";
    await data.createConversation({ runId, title: "convergence test", workspacePath: root });
    const events: ChatStreamEvent[] = [];
    await data.chat(runId, "continue", (event) => events.push(event), undefined, undefined, root);
    assert.equal(events.some((event) => event.type === "error"), false);
    const done = events.find((event): event is Extract<ChatStreamEvent, { type: "done" }> => event.type === "done");
    assert.equal(done?.text, message);
    assert.equal(done?.stopReason, "stop");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CTF chat automatically replans after a bounded guard termination", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-ctf-replan-"));
  const prompts: string[] = [];
  const lane: AgentLanePort = {
    async prompt(prompt) {
      prompts.push(prompt);
      return prompts.length === 1
        ? { text: "probe budget reached", stopReason: "stop", termination: "experiment_budget", usage: zeroUsage() }
        : { text: "verified flag", stopReason: "stop", usage: zeroUsage() };
    },
    async abort() {},
    async compact() {},
    async isIdle() { return true; },
    async close() {},
  };
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"), async () => lane);
    const runId = "CHAT-CTF-REPLAN-001";
    await data.createConversation({ runId, title: "ctf replan test", workspacePath: root });
    const events: ChatStreamEvent[] = [];
    await data.chat(runId, "题目描述：求解flag", (event) => events.push(event), undefined, undefined, root);

    assert.equal(prompts.length, 2);
    assert.match(prompts[1]!, /automatic CTF replan/);
    const done = events.find((event): event is Extract<ChatStreamEvent, { type: "done" }> => event.type === "done");
    assert.equal(done?.text, "verified flag");
    assert.equal(done?.stopReason, "stop");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI selects a prepared challenge profile before creating the coding lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-profile-selection-"));
  let selectedProfile: string | undefined;
  const lane: AgentLanePort = {
    async prompt() { return { text: "done", stopReason: "stop", usage: zeroUsage() }; },
    async abort() {},
    async compact() {},
    async isIdle() { return true; },
    async close() {},
  };
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"), async (options) => {
      selectedProfile = options.challengeProfile?.id;
      return lane;
    });
    const runId = "CHAT-PROFILE-001";
    await data.createConversation({ runId, title: "profile selection", workspacePath: root });
    await data.chat(runId, "Android APK native reverse challenge", () => undefined, undefined, undefined, root);
    assert.equal(selectedProfile, "mobile");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists a solve run before returning so an immediate pause aborts its coding lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-solve-pause-"));
  let releaseFactory!: () => void;
  const factoryReady = new Promise<void>((resolve) => { releaseFactory = resolve; });
  let markFactoryEntered!: () => void;
  const factoryEntered = new Promise<void>((resolve) => { markFactoryEntered = resolve; });
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let prompts = 0;
  let aborts = 0;
  const lane: AgentLanePort = {
    async prompt() {
      prompts += 1;
      return { text: "unexpected", stopReason: "stop", usage: zeroUsage() };
    },
    async abort() { aborts += 1; },
    async compact() {},
    async isIdle() { return true; },
    async close() { resolveClosed(); },
  };
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"), undefined, async () => {
      markFactoryEntered();
      await factoryReady;
      return lane;
    });
    const runId = "SOLVE-PAUSE-001";
    const started = await data.startSolve({ runId, fixtureId: "web-source-1", mode: "auto", maxTurns: 1 });
    assert.equal(started.state, "running");
    await factoryEntered;
    const paused = await data.pause(runId);
    assert.equal(paused.state, "paused");
    assert.equal((await data.getRun(runId)).snapshot.status, "PAUSED");
    await assert.rejects(
      data.startSolve({ runId, fixtureId: "web-source-1", mode: "auto", maxTurns: 1 }),
      /Run is already active/,
    );
    releaseFactory();
    await closed;
    assert.equal(aborts, 1);
    assert.equal(prompts, 0);
    assert.equal((await data.getRun(runId)).snapshot.status, "PAUSED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI Fixture solve uses the shared verifier-first Run path and replays terminal state", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-solve-replay-"));
  const runId = "GUI-REPLAY-web-source-1";
  let data: DebugDataService | undefined;
  try {
    data = new DebugDataService(root, config, join(root, "proofblade.config.json"), undefined, async (options) => {
      let proposed = false;
      return {
        async prompt() {
          if (!proposed) {
            proposed = true;
            const candidate = "PB{web_source_trace}";
            const artifact = await options.services.artifacts.putText(options.runId, candidate, { filename: "gui-candidate.txt", sensitivity: "flag_candidate" });
            await options.services.control.dispatch(options.runId, {
              type: "completion_proposed",
              completion: { id: "C-GUI-REPLAY", purpose: "harness_verification", candidateHash: hash(candidate), artifactId: artifact.id },
              lane: "executor",
            });
          }
          return { text: "候选已提交验证。", stopReason: "stop", usage: zeroUsage() };
        },
        async abort() {},
        async compact() {},
        async isIdle() { return true; },
        async close() {},
      };
    });

    await data.startSolve({ runId, fixtureId: "web-source-1", mode: "auto", maxTurns: 1 });
    const store = new JsonlControlStore(join(root, "runs"));
    let snapshot;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      snapshot = await store.replay(runId);
      if (["SUCCEEDED", "FAILED", "PAUSED", "EXHAUSTED"].includes(snapshot.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const detail = await data.getRun(runId);
    assert.equal(detail?.snapshot.status, "SUCCEEDED");
    assert.equal(detail?.snapshot.domainPhase, "SUBMIT");
    assert.ok(Object.values(detail?.snapshot.workItems ?? {}).some((item) => item.status === "SUCCEEDED"));
    assert.ok(Object.values(detail?.snapshot.effects ?? {}).some((effect) => effect.producerLane === "verifier" && effect.operation === "fixture_score" && effect.verification?.accepted === true));
    assert.ok(Object.values(detail?.snapshot.evidence ?? {}).some((item) => item.kind === "reproduction" && item.provenance.recordedBy === "verifier"));

    const replayed = await store.replay(runId);
    assert.equal(replayed.status, detail?.snapshot.status);
    assert.equal(replayed.domainPhase, detail?.snapshot.domainPhase);
    assert.equal(Object.keys(replayed.effects).length, Object.keys(detail?.snapshot.effects ?? {}).length);
    assert.equal(Object.keys(replayed.evidence).length, Object.keys(detail?.snapshot.evidence ?? {}).length);
  } finally {
    await data?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI CTF input stages attachments and completes through the shared reproduction path", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-ctf-workspace-"));
  const source = join(root, "source");
  const candidate = "PB{gui_workspace_reproduction}";
  const command = process.platform === "win32" ? "type attachments\\answer.txt" : "cat attachments/answer.txt";
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "answer.txt"), `${candidate}\n`, "utf8");
  let data: DebugDataService | undefined;
  try {
    data = new DebugDataService(root, config, join(root, "proofblade.config.json"), undefined, async ({ claimVerifier, fixture, runId }) => ({
      async prompt() {
        await claimVerifier.record({ candidate, command, cwd: fixture.path, toolCallId: `${runId}-verify` });
        return { text: `verified ${candidate}`, stopReason: "stop", usage: zeroUsage() };
      },
      async abort() {},
      async compact() {},
      async isIdle() { return true; },
      async close() {},
    }));
    const runId = "GUI-CTF-WORKSPACE-001";
    await data.startCtfSolve({ runId, objective: "从附件中恢复候选。", workspacePath: source, attachmentPaths: ["answer.txt"], targetKind: "misc", verificationCommand: command, mode: "auto", maxTurns: 1 });
    let detail: RunDetail | undefined;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      detail = await data.getRun(runId);
      if (["SUCCEEDED", "FAILED", "PAUSED", "EXHAUSTED"].includes(detail.snapshot.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(detail?.snapshot.status, "SUCCEEDED");
    assert.equal(detail?.snapshot.task.target, "LOCAL_WORKSPACE:misc");
    assert.deepEqual(detail?.snapshot.task.inputs.map((item) => item.path), ["attachments/answer.txt"]);
    assert.ok(Object.values(detail?.snapshot.effects ?? {}).some((effect) => effect.operation === "claim_reproduction" && effect.producerLane === "verifier"));
    assert.equal(Object.values(detail?.snapshot.effects ?? {}).some((effect) => effect.operation === "fixture_score"), false);
    assert.ok(Object.values(detail?.snapshot.artifacts ?? {}).some((artifact) => artifact.path.endsWith("report.md")));
  } finally {
    await data?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI CTF chat resumes the same RunCoordinator loop with the latest user instruction", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-ctf-chat-"));
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  const prompts: string[] = [];
  let data: DebugDataService | undefined;
  try {
    data = new DebugDataService(root, config, join(root, "proofblade.config.json"), undefined, async () => ({
      async prompt(prompt) {
        prompts.push(prompt);
        return { text: "本轮只完成了侦察", stopReason: "stop", usage: zeroUsage() };
      },
      async abort() {},
      async compact() {},
      async isIdle() { return true; },
      async close() {},
    }));
    const runId = "GUI-CTF-CHAT-001";
    const command = process.platform === "win32" ? "type challenge.md" : "cat challenge.md";
    await data.startCtfSolve({ runId, objective: "分析附件并提出下一步。", workspacePath: source, verificationCommand: command, mode: "assist", maxTurns: 1 });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await data.getRun(runId)).snapshot.status === "PAUSED") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal((await data.getRun(runId)).snapshot.status, "PAUSED");
    const events: ChatStreamEvent[] = [];
    await data.chat(runId, "继续检查附件中的约束", (event) => events.push(event));
    assert.equal(prompts.length, 2);
    assert.match(prompts[1]!, /继续检查附件中的约束/);
    assert.ok(events.some((event) => event.type === "paused"));
  } finally {
    await data?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:shutdown-awaits-active-runs] [contract:coding-abort-exactly-once] [contract:solver-abort-exactly-once] GUI close aborts each Coding lane once and awaits it", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-solve-close-"));
  let releasePrompt!: () => void;
  let closeFinished!: () => void;
  let markPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
  const closed = new Promise<void>((resolve) => { closeFinished = resolve; });
  let aborts = 0;
  const lane: AgentLanePort = {
    async prompt() {
      markPromptStarted();
      await new Promise<void>((resolve) => { releasePrompt = resolve; });
      return { text: "aborted", stopReason: "aborted", usage: zeroUsage() };
    },
    async abort() { aborts += 1; releasePrompt(); },
    async compact() {},
    async isIdle() { return false; },
    async close() { closeFinished(); },
  };
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"), undefined, async () => lane);
    const runId = "SOLVE-CLOSE-001";
    await data.startSolve({ runId, fixtureId: "web-source-1", mode: "auto", maxTurns: 1 });
    await promptStarted;
    const closing = data.close();
    releasePrompt();
    await closing;
    await closed;
    assert.equal(aborts, 1);
    await assert.rejects(data.startSolve({ runId: "SOLVE-CLOSE-NEW", fixtureId: "web-source-1", mode: "auto" }), /GUI is shutting down/);
  } finally {
    releasePrompt?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI close reports Lane abort failures as AggregateError", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-abort-failure-"));
  let releasePrompt!: () => void;
  let markPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
  const lane: AgentLanePort = {
    async prompt() {
      markPromptStarted();
      await new Promise<void>((resolve) => { releasePrompt = resolve; });
      return { text: "aborted", stopReason: "aborted", usage: zeroUsage() };
    },
    async abort() {
      releasePrompt?.();
      throw new Error("injected lane abort failure");
    },
    async compact() {},
    async isIdle() { return false; },
    async close() {},
  };
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"), async () => lane);
    const runId = "CHAT-ABORT-FAILURE-001";
    await data.createConversation({ runId, title: "abort failure", workspacePath: root });
    const chat = data.chat(runId, "inspect", () => undefined, undefined, undefined, root);
    await promptStarted;
    await assert.rejects(data.close(), (error: unknown) => error instanceof AggregateError && error.errors.some((item) => String(item).includes("injected lane abort failure")));
    await chat;
  } finally {
    releasePrompt?.();
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

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
