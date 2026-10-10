import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ConversationPreferences, WorkspaceSettings } from "../src/shared.js";
import { WorkspaceSettingsStore } from "../src/workspace-settings.js";

const defaults: ConversationPreferences = {
  title: "新对话",
  workspacePath: "D:/workspace",
  profileId: "default",
  model: "model-a",
  thinkingLevel: "low",
  enabledTools: ["read", "bash", "edit", "write"],
  enabledSkills: ["evidence-triage"],
    enabledMcpServers: [],
    projectPrompt: "",
};

const capabilities: WorkspaceSettings["capabilities"] = {
  tools: [{ name: "read", description: "Read a file", schemaChars: 120 }],
  skills: [{ name: "evidence-triage", description: "Triage evidence", disabled: false }],
  mcpServers: [{ name: "local", description: "Local tools", status: "configured", disabled: false }],
  providerNative: { default: [] },
};

test("persists folders and per-conversation provider and capability choices", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const tempRoot = join(root, "tmp");
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, "workspace-settings-"));
  const path = join(dir, "gui-workspace.json");

  try {
    const store = await WorkspaceSettingsStore.create(path);
    const folder = await store.createFolder("Research");
    const duplicate = await store.createFolder("Research");
    assert.equal(folder.id, "research");
    assert.equal(duplicate.id, "research-2");

    const saved = await store.saveConversation("CHAT-1", {
      title: "研究会话",
      contextCompactionThreshold: 60,
      folderId: folder.id,
      workspacePath: "D:/cases/research",
      profileId: "relay-b",
      model: "model-b",
      thinkingLevel: "medium",
      enabledTools: ["read", "read"],
      enabledSkills: [],
      enabledMcpServers: ["local"],
      projectPrompt: "Use Chinese and run tests before claiming success.",
    }, defaults);
    assert.deepEqual(saved.enabledTools, ["read"]);

    const reloaded = await WorkspaceSettingsStore.create(path);
    const publicSettings = reloaded.publicSettings(capabilities, defaults);
    assert.equal(publicSettings.localPath, path);
    assert.equal(publicSettings.conversations["CHAT-1"]?.profileId, "relay-b");
    assert.equal(publicSettings.conversations["CHAT-1"]?.model, "model-b");
    assert.equal(publicSettings.conversations["CHAT-1"]?.workspacePath, "D:/cases/research");
    assert.equal(publicSettings.conversations["CHAT-1"]?.title, "研究会话");
    assert.equal(publicSettings.conversations["CHAT-1"]?.contextCompactionThreshold, 60);
    assert.deepEqual(publicSettings.conversations["CHAT-1"]?.enabledMcpServers, ["local"]);
    assert.equal(publicSettings.conversations["CHAT-1"]?.projectPrompt, "Use Chinese and run tests before claiming success.");

    assert.equal((await reloaded.renameFolder(folder.id, "Cases")).name, "Cases");
    await reloaded.removeFolder(folder.id);
    assert.equal(reloaded.preferences("CHAT-1", defaults).folderId, undefined);
    await reloaded.removeConversation("CHAT-1");
    assert.equal(reloaded.preferences("CHAT-1", defaults).title, "新对话");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("creating a conversation without capability defaults leaves the capability lists to the read path", async () => {
  // PLAN-240 item C. POST /api/conversations no longer loads the workspace
  // capability catalog, so it saves a conversation without capability-derived
  // defaults. The lists must then come from the *current* defaults at read time,
  // not from a frozen create-time copy -- otherwise a capability change after
  // creation would be silently masked.
  const root = resolve(import.meta.dirname, "../../..");
  const tempRoot = join(root, "tmp");
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, "workspace-settings-noscan-"));
  const path = join(dir, "gui-workspace.json");

  try {
    const store = await WorkspaceSettingsStore.create(path);
    const runId = "CHAT-NOSCAN-1";
    await store.saveConversation(runId, { title: "新建对话", workspacePath: "D:/cases/a" });

    // Nothing capability-derived is persisted.
    const raw = JSON.parse(await readFile(path, "utf8")) as { conversations: Record<string, Record<string, unknown>> };
    const stored = raw.conversations[runId];
    assert.ok(stored, "the conversation must be persisted");
    assert.equal("enabledTools" in stored, false, "tool list must not be materialized at creation");
    assert.equal("enabledSkills" in stored, false, "skill list must not be materialized at creation");
    assert.equal("enabledMcpServers" in stored, false, "MCP list must not be materialized at creation");
    assert.equal(stored.title, "新建对话");
    assert.equal(stored.workspacePath, "D:/cases/a");

    // Reading resolves them from whatever the defaults are at that moment.
    assert.deepEqual(store.preferences(runId, defaults).enabledTools, ["read", "bash", "edit", "write"]);
    assert.deepEqual(store.preferences(runId, defaults).enabledSkills, ["evidence-triage"]);

    // A later capability change reaches the conversation instead of being
    // masked by a create-time snapshot.
    const grown: ConversationPreferences = { ...defaults, enabledTools: ["read", "bash", "grep"], enabledMcpServers: ["local"] };
    assert.deepEqual(store.preferences(runId, grown).enabledTools, ["read", "bash", "grep"]);
    assert.deepEqual(store.preferences(runId, grown).enabledMcpServers, ["local"]);

    // Explicit choices still win over the defaults.
    await store.saveConversation(runId, { enabledTools: ["read"] }, defaults);
    assert.deepEqual(store.preferences(runId, grown).enabledTools, ["read"]);

    // Folder validation does not depend on capability defaults.
    await assert.rejects(() => store.saveConversation("CHAT-NOSCAN-2", { folderId: "missing" }), /文件夹不存在/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renaming does not materialize capability defaults and stale automatic names cannot win", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proofblade-workspace-rename-"));
  const path = join(dir, "gui-workspace.json");
  try {
    const store = await WorkspaceSettingsStore.create(path);
    const runId = "CHAT-RENAME-1";
    await store.saveConversation(runId, { title: "新对话", workspacePath: "D:/cases/a" });

    const manual = await store.renameConversation(runId, "用户设置的标题");
    assert.equal(manual.renamed, true);
    const staleAutomatic = await store.renameConversation(runId, "自动标题", { expectedTitle: "新对话" });
    assert.equal(staleAutomatic.renamed, false);
    assert.equal(store.storedConversation(runId).title, "用户设置的标题");

    const concurrentRunId = "CHAT-RENAME-2";
    await store.saveConversation(concurrentRunId, { title: "新对话", workspacePath: "D:/cases/b" });
    const [automatic, concurrentManual] = await Promise.all([
      store.renameConversation(concurrentRunId, "自动标题", { expectedTitle: "新对话" }),
      store.renameConversation(concurrentRunId, "并发手动标题"),
    ]);
    assert.equal(automatic.renamed, true);
    assert.equal(concurrentManual.renamed, true);
    assert.equal(store.storedConversation(concurrentRunId).title, "并发手动标题");

    const raw = JSON.parse(await readFile(path, "utf8")) as { conversations: Record<string, Record<string, unknown>> };
    const stored = raw.conversations[runId]!;
    assert.equal("enabledTools" in stored, false);
    assert.equal("enabledSkills" in stored, false);
    assert.equal("enabledMcpServers" in stored, false);

    const grown = { ...defaults, enabledTools: [...defaults.enabledTools, "grep"], enabledSkills: [...defaults.enabledSkills, "new-skill"], enabledMcpServers: ["local"] };
    assert.deepEqual(store.preferences(runId, grown).enabledTools, grown.enabledTools);
    assert.deepEqual(store.preferences(runId, grown).enabledSkills, grown.enabledSkills);
    assert.deepEqual(store.preferences(runId, grown).enabledMcpServers, grown.enabledMcpServers);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
