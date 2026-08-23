import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ToolPreflightService,
  challengeToolProfile,
  challengeToolProfiles,
  classifyChallengePrompt,
  profileForTargetKind,
} from "../src/runtime/challenge-tool-profile.js";
import { ProofBladeToolCatalogRegistry, TOOL_CATALOG_MANIFEST } from "../src/tools/catalog.js";

test("classifies challenge directions before a lane is created", () => {
  assert.equal(classifyChallengePrompt("Android APK native reverse challenge")?.profile.id, "mobile");
  assert.equal(classifyChallengePrompt("remote nc service with a heap overflow")?.profile.id, "pwn");
  assert.equal(classifyChallengePrompt("CTF RSA padding oracle")?.profile.id, "crypto");
  assert.equal(classifyChallengePrompt("recover flag{...} from the attachment")?.profile.id, "misc");
  assert.equal(classifyChallengePrompt("ordinary TypeScript feature") , undefined);
  assert.equal(classifyChallengePrompt("implement a binary search") , undefined);
  assert.equal(profileForTargetKind("reverse", "packed UPX ELF")?.id, "reverse");
});

test("profiles keep direction-specific tools and fallback order bounded", () => {
  const profile = challengeToolProfile("reverse");
  assert.deepEqual(profile.mcpServers, ["idalib-mcp", "jadx"]);
  assert.deepEqual(profile.requiredToolIds, ["strings", "python"]);
  assert.ok(profile.optionalToolIds.includes("file") || profile.hostToolIds.includes("file"));
  assert.ok(profile.fallbackStrategies.some((item) => item.startsWith("packed:")));
  assert.ok(!profile.hostToolIds.includes("sqlmap"));
  for (const candidate of challengeToolProfiles()) {
    assert.ok(candidate.requiredToolIds.every((id) => candidate.hostToolIds.includes(id)), `${candidate.id} required tools must be prepared`);
    assert.ok(candidate.requiredToolIds.every((id) => !candidate.optionalToolIds.includes(id)), `${candidate.id} required tools cannot be optional`);
  }
});

test("preflight probes only the selected profile and reuses its cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-preflight-"));
  try {
    const existing = join(root, "file.exe");
    await writeFile(existing, "placeholder", "utf8");
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), JSON.stringify({ schemaVersion: 1, tools: [
      { id: "file", name: "file", path: existing, description: "file" },
      { id: "unrelated", name: "unrelated", path: join(root, "missing.exe"), description: "unrelated", category: "web" },
    ] }), "utf8");
    const catalog = await ProofBladeToolCatalogRegistry.load(root);
    const mcp = { catalogHash: () => "mcp-hash", summaries: () => [] } as never;
    const profile = { ...challengeToolProfile("misc"), hostToolIds: ["file"], requiredToolIds: ["file"] };
    const service = new ToolPreflightService(root);
    const first = await service.prepare(profile, catalog, mcp);
    assert.equal(first.cacheHit, false);
    assert.deepEqual(first.tools.map((tool) => tool.id), ["file"]);
    assert.deepEqual(first.missingRequiredTools, []);
    const second = await service.prepare(profile, catalog, mcp);
    assert.equal(second.cacheHit, true);
    assert.deepEqual(second.tools, first.tools);
    const otherProfile = { ...challengeToolProfile("web"), hostToolIds: ["file"], requiredToolIds: ["file"] };
    const other = await service.prepare(otherProfile, catalog, mcp);
    assert.equal(other.cacheHit, false);
    assert.equal((await service.prepare(profile, catalog, mcp)).cacheHit, true, "profile caches must coexist");
    const all = await service.prepareAll(challengeToolProfiles().slice(0, 2), catalog, mcp);
    assert.equal(all.length, 2);
    assert.ok(all.every((item) => item.checkedAt > 0));
    const refreshed = await new ToolPreflightService(root, { maxAgeMs: 0 }).prepare(profile, catalog, mcp);
    assert.equal(refreshed.cacheHit, false, "expired health entries must be re-probed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
