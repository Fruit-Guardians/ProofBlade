import assert from "node:assert/strict";
import test from "node:test";
import { SIDEBAR_COLLAPSED_STORAGE_KEY, conversationTitleFromPrompt, inspectorStateAfterRunChange, shouldAutoNameConversation, sidebarCollapsedFromStorage } from "../src/ui-state.js";

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

test("conversation titles are derived from the first prompt without leaking markdown", () => {
  assert.equal(conversationTitleFromPrompt("  # 排查历史对话为什么加载很慢  "), "排查历史对话为什么加载很慢");
  assert.equal(conversationTitleFromPrompt("先分析这个问题。 后面再修改"), "先分析这个问题。");
  assert.equal(conversationTitleFromPrompt("```ts\nconsole.log('x')\n```\n解释结果"), "代码片段 解释结果");
  assert.equal(conversationTitleFromPrompt("这是一个非常长的标题，需要被稳定截断", 8), "这是一个非常长的…");
  assert.equal(shouldAutoNameConversation(undefined), true);
  assert.equal(shouldAutoNameConversation("新对话"), true);
  assert.equal(shouldAutoNameConversation("漏洞复现"), false);
});
