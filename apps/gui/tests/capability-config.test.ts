import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpProjectRegistry, ProofBladeSkillRegistry } from "@proofblade/materials";
import { addProjectMcpServer, createProjectSkill, renameConversation, updateConversationPreferences } from "../src/api.js";
import { CapabilityConfigStore } from "../src/capability-config.js";

test("GUI API helpers preserve capability and conversation mutation payloads", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({
      name: requests.length === 1 ? "review-helper" : "local-tools",
      path: requests.length === 1 ? "skills/review-helper/SKILL.md" : ".mcp.json",
    }), { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await createProjectSkill({ name: "review-helper", description: "Review changes", instructions: "Inspect the diff." });
    await addProjectMcpServer({ name: "local-tools", description: "Local tools", transport: "stdio", command: "node", args: ["server.mjs"], readOnly: true });
    await updateConversationPreferences("CHAT /1", { folderId: null });
    await renameConversation("CHAT /1", "自动标题", { expectedTitle: "新对话" });
    assert.equal(requests[0]?.url, "/api/capabilities/skills");
    assert.equal(requests[0]?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { name: "review-helper", description: "Review changes", instructions: "Inspect the diff." });
    assert.equal(requests[1]?.url, "/api/capabilities/mcp");
    assert.equal(requests[1]?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), { name: "local-tools", description: "Local tools", transport: "stdio", command: "node", args: ["server.mjs"], readOnly: true });
    assert.equal(requests[2]?.url, "/api/conversations/CHAT%20%2F1/preferences");
    assert.deepEqual(JSON.parse(String(requests[2]?.init?.body)), { folderId: null });
    assert.equal(requests[3]?.url, "/api/conversations/CHAT%20%2F1");
    assert.deepEqual(JSON.parse(String(requests[3]?.init?.body)), { title: "自动标题", expectedTitle: "新对话" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("creates a project Skill that the production registry can discover", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-skill-"));
  try {
    ProofBladeSkillRegistry.resetCache();
    const store = new CapabilityConfigStore(root);
    const created = await store.createSkill({
      name: "review-helper",
      description: "Review a change before handoff",
      instructions: "Inspect the diff, run focused checks, and report remaining risks.",
    });
    assert.deepEqual(created, { name: "review-helper", path: "skills/review-helper/SKILL.md" });
    const content = await readFile(join(root, created.path), "utf8");
    assert.match(content, /name: review-helper/);
    const registry = await ProofBladeSkillRegistry.load(root, "skills");
    assert.equal(registry.list().some((skill) => skill.name === "review-helper"), true);
    await assert.rejects(() => store.createSkill({ name: "review-helper", description: "Duplicate", instructions: "Duplicate body" }), /already exists/);
  } finally {
    ProofBladeSkillRegistry.resetCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("adds a validated MCP server without replacing existing project config", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-mcp-"));
  try {
    await writeFile(join(root, ".mcp.json"), `${JSON.stringify({ mcpServers: { existing: { url: "http://127.0.0.1:3000/mcp" } } }, null, 2)}\n`, "utf8");
    const store = new CapabilityConfigStore(root);
    const created = await store.addMcpServer({
      name: "local-tools",
      description: "Local read-only tools",
      transport: "stdio",
      command: "node",
      args: ["server.mjs"],
      readOnly: true,
    });
    assert.deepEqual(created, { name: "local-tools", path: ".mcp.json" });
    const parsed = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { command?: string; readOnly?: boolean }> };
    assert.deepEqual(Object.keys(parsed.mcpServers).sort(), ["existing", "local-tools"]);
    assert.equal(parsed.mcpServers["local-tools"]?.command, "node");
    assert.equal(parsed.mcpServers["local-tools"]?.readOnly, true);
    const registry = McpProjectRegistry.load(root);
    try {
      assert.deepEqual(registry.summaries().map((server) => server.name), ["existing", "local-tools"]);
    } finally {
      await registry.close();
    }
    await assert.rejects(() => store.addMcpServer({ name: "local-tools", description: "Duplicate", transport: "http", url: "http://127.0.0.1:4000/mcp", readOnly: true }), /already exists/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
