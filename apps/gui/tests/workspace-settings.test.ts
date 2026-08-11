import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ConversationPreferences, WorkspaceSettings } from "../src/shared.js";
import { WorkspaceSettingsStore } from "../src/workspace-settings.js";

const defaults: ConversationPreferences = {
  workspacePath: "D:/workspace",
  profileId: "default",
  model: "model-a",
  thinkingLevel: "low",
  enabledTools: ["read", "bash", "edit", "write"],
  enabledSkills: ["evidence-triage"],
  enabledMcpServers: [],
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
      folderId: folder.id,
      workspacePath: "D:/cases/research",
      profileId: "relay-b",
      model: "model-b",
      thinkingLevel: "medium",
      enabledTools: ["read", "read"],
      enabledSkills: [],
      enabledMcpServers: ["local"],
    }, defaults);
    assert.deepEqual(saved.enabledTools, ["read"]);

    const reloaded = await WorkspaceSettingsStore.create(path);
    const publicSettings = reloaded.publicSettings(capabilities, defaults);
    assert.equal(publicSettings.localPath, path);
    assert.equal(publicSettings.conversations["CHAT-1"]?.profileId, "relay-b");
    assert.equal(publicSettings.conversations["CHAT-1"]?.model, "model-b");
    assert.equal(publicSettings.conversations["CHAT-1"]?.workspacePath, "D:/cases/research");
    assert.deepEqual(publicSettings.conversations["CHAT-1"]?.enabledMcpServers, ["local"]);

    assert.equal((await reloaded.renameFolder(folder.id, "Cases")).name, "Cases");
    await reloaded.removeFolder(folder.id);
    assert.equal(reloaded.preferences("CHAT-1", defaults).folderId, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
