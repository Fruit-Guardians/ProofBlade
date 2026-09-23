import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { conversationPreferencesInput } from "../src/conversation-preferences.js";
import type { ConversationPreferences, WorkspaceSettings } from "../src/shared.js";
import { WorkspaceSettingsStore } from "../src/workspace-settings.js";

/**
 * Preference writes must stay edits.
 *
 * The GUI hands the route a resolved `ConversationPreferences` on every read —
 * including `enabledTools`/`enabledSkills`/`enabledMcpServers` already expanded
 * from the workspace catalog. A route that persisted that whole object would
 * freeze the three capability lists on the first unrelated edit, and a Skill,
 * MCP server or tool added to the workspace afterwards would stay invisible to
 * that conversation forever. These tests pin the rule that closes that loop:
 * only what the request edited is written, and an absent list keeps resolving
 * against the current catalog.
 */

const resolved: ConversationPreferences = {
  title: "新对话",
  workspacePath: "D:/workspace",
  profileId: "default",
  model: "model-a",
  thinkingLevel: "low",
  enabledTools: ["read", "bash"],
  enabledSkills: ["evidence-triage"],
  enabledMcpServers: ["local"],
  projectPrompt: "",
};

const capabilities: WorkspaceSettings["capabilities"] = {
  tools: [{ name: "read", description: "Read a file", schemaChars: 120 }],
  skills: [{ name: "evidence-triage", description: "Triage evidence", disabled: false }],
  mcpServers: [{ name: "local", description: "Local tools", status: "configured", disabled: false }],
  providerNative: { default: [] },
};

test("a model change persists only the model, not the resolved capability lists", () => {
  const patch = conversationPreferencesInput({ model: "model-b" }, resolved);

  assert.deepEqual(patch, { model: "model-b" });
  for (const field of ["enabledTools", "enabledSkills", "enabledMcpServers"] as const) {
    assert.equal(field in patch, false, `${field} must not be written by an unrelated edit`);
  }
});

test("an explicitly edited capability list is written, including an empty one", () => {
  // The capability panel is the one place allowed to freeze a list, and "turn
  // everything off" has to be expressible — hence `[]` is an edit, not an absence.
  const patch = conversationPreferencesInput({ enabledSkills: [] }, resolved);
  assert.deepEqual(patch, { enabledSkills: [] });
});

test("clearing a folder reaches the write as a present key", () => {
  // `folderId: null` means "move to uncategorised". Dropping the key would make
  // the route treat the request as a no-op and leave the assignment in place.
  const cleared = conversationPreferencesInput({ folderId: null }, { ...resolved, folderId: "research" });
  assert.equal("folderId" in cleared, true);
  assert.equal(cleared.folderId, undefined);

  // Nothing to clear: the request stays a no-op.
  assert.deepEqual(conversationPreferencesInput({ folderId: null }, resolved), {});
});

test("an empty body edits nothing", () => {
  assert.deepEqual(conversationPreferencesInput({}, resolved), {});
});

test("a preference save does not freeze the capability lists for later edits", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const tempRoot = join(root, "tmp");
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, "conversation-preferences-"));
  const path = join(dir, "gui-workspace.json");
  try {
    const store = await WorkspaceSettingsStore.create(path);
    const runId = "GUI-PREF-1";
    await store.saveConversation(runId, { title: "新对话", workspacePath: "D:/workspace" });

    // A later model change, routed through the same edit-only patch.
    const patch = conversationPreferencesInput({ model: "model-b" }, store.preferences(runId, resolved));
    assert.deepEqual(patch, { model: "model-b" });
    await store.saveConversation(runId, patch);

    // The stored record must still hold no capability list.
    const stored = store.storedConversation(runId) as Record<string, unknown>;
    for (const field of ["enabledTools", "enabledSkills", "enabledMcpServers"]) {
      assert.equal(field in stored, false, `${field} must stay unresolved after a normal edit`);
    }

    // Which is what lets a skill added to the workspace afterwards be visible:
    // the read path still resolves the lists from the current catalog.
    const grown = { ...resolved, enabledSkills: ["evidence-triage", "new-skill"] };
    const after = store.preferences(runId, grown);
    assert.deepEqual(after.enabledSkills, ["evidence-triage", "new-skill"]);
    assert.equal(after.model, "model-b");

    // And the file on disk agrees, so this is not an in-memory illusion.
    const file = JSON.parse(await readFile(path, "utf8")) as { conversations: Record<string, Record<string, unknown>> };
    assert.equal("enabledTools" in file.conversations[runId]!, false);
    assert.equal(file.conversations[runId]!.model, "model-b");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an explicit capability edit is persisted and then shadows the catalog", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const tempRoot = join(root, "tmp");
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, "conversation-preferences-pin-"));
  const path = join(dir, "gui-workspace.json");
  try {
    const store = await WorkspaceSettingsStore.create(path);
    const runId = "GUI-PREF-2";
    await store.saveConversation(runId, { enabledSkills: [] }, resolved);

    const stored = store.storedConversation(runId) as Record<string, unknown>;
    assert.deepEqual(stored.enabledSkills, [], "an explicit edit must be stored");
    // A deliberate "none enabled" choice survives a catalog that now offers more.
    assert.deepEqual(store.preferences(runId, { ...resolved, enabledSkills: ["evidence-triage", "new-skill"] }).enabledSkills, []);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an explicit capability edit is still filtered against the current catalog", () => {
  // Storing an edit does not mean trusting it: the read path intersects stored
  // names with the live catalog, so a removed skill cannot come back from disk.
  const allowed = new Set(capabilities.skills.filter((skill) => !skill.disabled).map((skill) => skill.name));
  const patch = conversationPreferencesInput({ enabledSkills: ["evidence-triage", "removed-skill"] }, resolved);
  assert.deepEqual((patch.enabledSkills ?? []).filter((name) => allowed.has(name)), ["evidence-triage"]);
});

test("creating a conversation does not load the capability catalog", async () => {
  // The create route's whole point is that an empty conversation has not asked
  // for the workspace catalog yet, so this is a source-shape guard: the route
  // reads no catalog and writes no resolved list. A behavioural test would need
  // the whole HTTP server; naming what the route must not do is the honest
  // version of this one.
  const source = await readFile(join(import.meta.dirname, "../src/server.ts"), "utf8");
  const start = source.indexOf('if (method === "POST" && url.pathname === "/api/conversations")');
  assert.ok(start > 0, "the create-conversation route must exist");
  const relativeEnd = source.slice(start).search(/\r?\n  }\r?\n/);
  const end = relativeEnd < 0 ? -1 : start + relativeEnd;
  assert.ok(end > start, "the create-conversation route must have a body");
  const route = source.slice(start, end);

  assert.equal(/capabilityCatalog\(|defaultPreferences\(|normalizedPreferences\(/.test(route), false, "the create route must not load the capability catalog");
  assert.match(route, /data\.createConversation\(/, "the route must still create the conversation");
  assert.match(route, /saveConversation\(/, "the route must still record the conversation in workspace settings");
  // And it must not hand `saveConversation` capability defaults, which would
  // materialize the lists at create time.
  assert.doesNotMatch(route, /saveConversation\([^)]*\bdefaults\b/, "create must not pass capability defaults");
});
