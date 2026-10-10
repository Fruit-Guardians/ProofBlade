import assert from "node:assert/strict";
import test from "node:test";
import { SIDEBAR_COLLAPSED_STORAGE_KEY, automaticConversationRename, conversationFolderPatch, conversationTitleFromPrompt, inspectorStateAfterRunChange, shouldAutoNameConversation, sidebarCollapsedFromStorage, toolDebuggerTarget, workspaceStateAfterRunSelection } from "../src/ui-state.js";

test("sidebar collapse preference only accepts the persisted true value", () => {
  assert.equal(SIDEBAR_COLLAPSED_STORAGE_KEY, "proofblade.sidebarCollapsed");
  assert.equal(sidebarCollapsedFromStorage("true"), true);
  assert.equal(sidebarCollapsedFromStorage("false"), false);
  assert.equal(sidebarCollapsedFromStorage(null), false);
  assert.equal(sidebarCollapsedFromStorage(undefined), false);
});

test("switching Runs closes and resets the unified inspector", () => {
  assert.deepEqual(inspectorStateAfterRunChange(), {
    open: false,
    tab: "overview",
    selectedToolId: undefined,
  });
});

test("selecting a Run always returns to the conversation workspace", () => {
  assert.deepEqual(workspaceStateAfterRunSelection("CHAT-1"), { runId: "CHAT-1", workspaceView: "conversation", leftOpen: false });
});

test("the uncategorized folder selection is sent as an explicit clear", () => {
  assert.deepEqual(conversationFolderPatch(""), { folderId: null });
  assert.deepEqual(conversationFolderPatch("research"), { folderId: "research" });
});

test("conversation titles are derived from the first prompt without leaking markdown", () => {
  assert.equal(conversationTitleFromPrompt("  # 排查历史对话为什么加载很慢  "), "排查历史对话为什么加载很慢");
  assert.equal(conversationTitleFromPrompt("先分析这个问题。 后面再修改"), "先分析这个问题。");
  assert.equal(conversationTitleFromPrompt("```ts\nconsole.log('x')\n```\n解释结果"), "代码片段 解释结果");
  assert.equal(conversationTitleFromPrompt("这是一个非常长的标题，需要被稳定截断", 8), "这是一个非常长的…");
  assert.equal(shouldAutoNameConversation(undefined), true);
  assert.equal(shouldAutoNameConversation("新对话"), true);
  assert.equal(shouldAutoNameConversation("漏洞复现"), false);
});

test("automatic naming waits for the workspace record and preserves its expected title", () => {
  assert.equal(automaticConversationRename(undefined, "排查加载问题"), undefined);
  assert.deepEqual(automaticConversationRename({ title: "新对话" }, "排查加载问题"), { title: "排查加载问题", expectedTitle: "新对话" });
  assert.deepEqual(automaticConversationRename({}, "排查加载问题"), { title: "排查加载问题", expectedTitle: null });
  assert.equal(automaticConversationRename({ title: "用户标题" }, "排查加载问题"), undefined);
});

test("a preferred deep Tool call initializes its own Session and assistant turn", () => {
  const sessions = [
    {
      id: "session-a",
      assistantTurns: [{ entryId: "turn-a1" }, { entryId: "turn-a2" }],
      toolCalls: [
        { id: "call-a1", assistantEntryId: "turn-a1" },
        { id: "call-a2", assistantEntryId: "turn-a2" },
      ],
    },
    {
      id: "session-b",
      assistantTurns: [{ entryId: "turn-b1" }],
      toolCalls: [{ id: "call-b1", assistantEntryId: "turn-b1" }],
    },
  ];
  assert.deepEqual(toolDebuggerTarget(sessions, "call-a2"), { sessionId: "session-a", turnId: "turn-a2", callId: "call-a2" });
  assert.deepEqual(toolDebuggerTarget(sessions, "call-b1"), { sessionId: "session-b", turnId: "turn-b1", callId: "call-b1" });
  assert.deepEqual(toolDebuggerTarget(sessions, "missing"), { sessionId: "session-a", turnId: "turn-a1", callId: "call-a1" });
});
