import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ToolPreflightService,
  actionBundleForPhase,
  assertToolPreparationPublished,
  securityToolProfile,
  securityToolProfiles,
  securityToolCatalogSpecs,
  classifySecurityTask,
  preflightFromRunToolPreparation,
  profileForTargetKind,
  securityProfileForTask,
  runToolPreparationFromPreflight,
  withFirstClassMcpToolExposure,
} from "../src/runtime/security-tool-profile.js";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { ProofBladeToolCatalogRegistry, TOOL_CATALOG_MANIFEST } from "../src/tools/catalog.js";

test("classifies security domains before a lane is created", () => {
  assert.equal(classifySecurityTask("Android APK native reverse challenge")?.profile.id, "mobile");
  assert.equal(classifySecurityTask("remote nc service with a heap overflow")?.profile.id, "pwn");
  assert.equal(classifySecurityTask("CTF RSA padding oracle")?.profile.id, "crypto");
  assert.equal(classifySecurityTask("recover flag{...} from the attachment")?.profile.id, "misc");
  assert.equal(classifySecurityTask("ordinary TypeScript feature") , undefined);
  assert.equal(classifySecurityTask("implement a binary search") , undefined);
  assert.equal(profileForTargetKind("reverse", "packed UPX ELF")?.id, "reverse");
  assert.equal(profileForTargetKind("misc", "REAL_EVALUATION:forensics-pcap")?.id, "misc");
  assert.equal(profileForTargetKind("misc", "REAL_EVALUATION:malware-yara")?.id, "misc");
  assert.equal(profileForTargetKind("unknown", "remote nc service with a format string"), undefined);
  assert.equal(profileForTargetKind("mixed", "HTTP endpoint with JWT and SSRF"), undefined);
  assert.equal(profileForTargetKind("unknown", "ordinary project refactor"), undefined);
});

test("explicit security task labels select tooling without inspecting task prose", () => {
  assert.equal(securityProfileForTask({ target_kind: "reverse" })?.id, "reverse");
  assert.equal(securityProfileForTask({ target_kind: "pwn" })?.id, "pwn");
  assert.equal(securityProfileForTask({ target_kind: "web" })?.id, "web");
  assert.equal(securityProfileForTask({ target_kind: "unknown" }), undefined);
  assert.equal(securityProfileForTask({ target_kind: "mixed" }), undefined);

  const explicit = securityToolProfile("mobile");
  assert.equal(securityProfileForTask({ target_kind: "reverse" }, explicit)?.id, "mobile");
});

test("profiles keep direction-specific tools and fallback order bounded", () => {
  const profile = securityToolProfile("reverse");
  assert.deepEqual(profile.mcpServers, ["idalib-mcp", "jadx"]);
  assert.deepEqual(profile.requiredToolIds, ["strings", "python"]);
  assert.ok(profile.optionalToolIds.includes("file") || profile.hostToolIds.includes("file"));
  assert.ok(profile.fallbackStrategies.some((item) => item.startsWith("packed:")));
  assert.ok(!profile.hostToolIds.includes("sqlmap"));
  for (const candidate of securityToolProfiles()) {
    assert.ok(candidate.firstAction.length > 40, `${candidate.id} needs a concrete first action contract`);
    assert.ok(candidate.firstActionPlan.maxCalls >= 1 && candidate.firstActionPlan.maxCalls <= 16);
    assert.ok(candidate.firstActionPlan.allowedToolNames.length > 0);
    assert.deepEqual(candidate.actionBundles.map((bundle) => bundle.domainPhase), ["RECON", "TARGET_MODEL", "HYPOTHESIS", "EXPERIMENT", "REPRODUCE"]);
    assert.ok(candidate.actionBundles.every((bundle) => bundle.maxCalls >= 1 && bundle.toolNames.length > 0), `${candidate.id} action bundles must be bounded and executable`);
    assert.ok(candidate.requiredToolIds.every((id) => candidate.hostToolIds.includes(id)), `${candidate.id} required tools must be prepared`);
    assert.ok(candidate.requiredToolIds.every((id) => !candidate.optionalToolIds.includes(id)), `${candidate.id} required tools cannot be optional`);
  }
  assert.match(profile.firstAction, /file.*strings/i);
  assert.equal(actionBundleForPhase(securityToolProfile("pwn"), "EXPERIMENT")?.id, "pwn-experiment");
  assert.ok(actionBundleForPhase(securityToolProfile("web"), "REPRODUCE")?.toolNames.includes("web_reproduce"));
});

test("every profile tool id has a reviewed bootstrap definition", () => {
  const defined = new Set(securityToolCatalogSpecs().map((spec) => spec.id));
  for (const profile of securityToolProfiles()) {
    for (const toolId of profile.hostToolIds) {
      assert.ok(defined.has(toolId), `${profile.id} tool ${toolId} must have a bootstrap definition`);
    }
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
    const profile = { ...securityToolProfile("misc"), hostToolIds: ["file"], requiredToolIds: ["file"] };
    const service = new ToolPreflightService(root);
    const first = await service.prepare(profile, catalog, mcp);
    assert.equal(first.cacheHit, false);
    assert.equal(first.runtime, "host");
    assert.equal(first.runtimeKey, "host");
    assert.equal(first.toolCatalogHash, catalog.catalogHash());
    assert.equal(first.mcpCatalogHash, "mcp-hash");
    assert.deepEqual(first.firstActionPlan, profile.firstActionPlan);
    assert.deepEqual(first.actionBundles, profile.actionBundles);
    assert.deepEqual(first.tools.map((tool) => tool.id), ["file"]);
    assert.deepEqual(first.missingRequiredTools, []);
    const second = await service.prepare(profile, catalog, mcp);
    assert.equal(second.cacheHit, true);
    assert.deepEqual(second.tools, first.tools);
    const otherProfile = { ...securityToolProfile("web"), hostToolIds: ["file"], requiredToolIds: ["file"] };
    const other = await service.prepare(otherProfile, catalog, mcp);
    assert.equal(other.cacheHit, false);
    assert.equal((await service.prepare(profile, catalog, mcp)).cacheHit, true, "profile caches must coexist");
    const all = await service.prepareAll(securityToolProfiles().slice(0, 2), catalog, mcp);
    assert.equal(all.length, 2);
    assert.ok(all.every((item) => item.checkedAt > 0));
    const refreshed = await new ToolPreflightService(root, { maxAgeMs: 0 }).prepare(profile, catalog, mcp);
    assert.equal(refreshed.cacheHit, false, "expired health entries must be re-probed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("container preflight probes the execution backend and reuses an image-bound cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-container-preflight-"));
  try {
    const calls: string[] = [];
    const env = {
      async exec(command: string) {
        calls.push(command);
        return { ok: true as const, value: { stdout: "", stderr: "", exitCode: 0 } };
      },
    } as unknown as ExecutionEnv;
    const mcp = { catalogHash: () => "mcp-container", summaries: () => [] } as never;
    const profile = { ...securityToolProfile("misc"), hostToolIds: ["python", "z3"], requiredToolIds: ["python", "z3"], optionalToolIds: [] };
    const service = new ToolPreflightService(root);
    const first = await service.prepareInExecution(profile, env, mcp, { runtimeKey: "container:sha256:image" });
    assert.equal(first.runtime, "container");
    assert.equal(first.runtimeKey, "container:sha256:image");
    assert.equal(first.missingRequiredTools.length, 0);
    assert.ok(calls.every((command) => command.includes("command -v")), "probes must execute inside the supplied backend");
    const second = await service.prepareInExecution(profile, env, mcp, { runtimeKey: "container:sha256:image" });
    assert.equal(second.cacheHit, true);
    assert.equal(calls.length, 2, "a matching image cache must avoid a second container probe");
    const preparation = runToolPreparationFromPreflight(first, profile, 1);
    assert.equal(preparation.health, "ready");
    assert.deepEqual(preparation.firstActionPlan, profile.firstActionPlan);
    assert.deepEqual(preparation.actionBundles, profile.actionBundles);
    assert.deepEqual(preflightFromRunToolPreparation(preparation).actionBundles, profile.actionBundles);
    assert.equal(preflightFromRunToolPreparation(preparation).runtimeKey, preparation.runtimeKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preflight publication is a durable gate, not a local cache hint", () => {
  const profile = securityToolProfile("web");
  const preflight = {
    profileId: profile.id,
    targetKind: profile.targetKind,
    runtime: "host" as const,
    runtimeKey: "host",
    cacheKey: "cache-key",
    toolCatalogHash: "catalog-hash",
    mcpCatalogHash: "mcp-hash",
    cacheHit: false,
    checkedAt: 1,
    tools: [],
    mcpServers: [],
    missingRequiredTools: [],
    missingOptionalTools: [],
    fallbackStrategies: profile.fallbackStrategies,
    firstActionPlan: profile.firstActionPlan,
    actionBundles: profile.actionBundles,
  };
  const preparation = runToolPreparationFromPreflight(preflight, profile, 2);
  assert.throws(() => assertToolPreparationPublished({ generation: 2 }, preparation), /not durably published/);
  assert.doesNotThrow(() => assertToolPreparationPublished({ generation: 2, toolPreparation: preparation }, preparation));
  assert.throws(() => assertToolPreparationPublished({ generation: 3, toolPreparation: preparation }, preparation), /generation is stale/);
  assert.throws(() => assertToolPreparationPublished({ generation: 2, toolPreparation: { ...preparation, hash: "f".repeat(64) } }, preparation), /does not match/);
});

test("first-class MCP exposure is a hash-bound durable preflight field", () => {
  const profile = securityToolProfile("misc");
  const preparation = runToolPreparationFromPreflight({
    profileId: profile.id,
    targetKind: profile.targetKind,
    runtime: "host",
    runtimeKey: "host",
    cacheKey: "cache-key",
    toolCatalogHash: "catalog-hash",
    mcpCatalogHash: "mcp-hash",
    cacheHit: false,
    checkedAt: 1,
    tools: [],
    mcpServers: [],
    missingRequiredTools: [],
    missingOptionalTools: [],
    fallbackStrategies: profile.fallbackStrategies,
    firstActionPlan: profile.firstActionPlan,
    actionBundles: profile.actionBundles,
  }, profile, 2);
  const exposed = withFirstClassMcpToolExposure(preparation, { exposed: 3, omitted: 2, truncated: true });
  assert.deepEqual(exposed.firstClassMcpTools, { exposed: 3, omitted: 2, truncated: true });
  assert.notEqual(exposed.hash, preparation.hash);
  assert.doesNotThrow(() => assertToolPreparationPublished({ generation: 2, toolPreparation: exposed }, exposed));
});

test("concurrent preflight writers preserve every cache entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-preflight-concurrent-"));
  try {
    const existing = join(root, "file.exe");
    await writeFile(existing, "placeholder", "utf8");
    await writeFile(join(root, TOOL_CATALOG_MANIFEST), JSON.stringify({ schemaVersion: 1, tools: [
      { id: "file", name: "file", path: existing, description: "file" },
    ] }), "utf8");
    const catalog = await ProofBladeToolCatalogRegistry.load(root);
    const mcp = { catalogHash: () => "mcp-concurrent", summaries: () => [] } as never;
    const profiles = ["web", "pwn", "crypto", "reverse"].map((id) => ({ ...securityToolProfile(id as "web" | "pwn" | "crypto" | "reverse"), hostToolIds: ["file"], requiredToolIds: ["file"], optionalToolIds: [] }));
    const service = new ToolPreflightService(root);
    await Promise.all(profiles.map((profile) => service.prepare(profile, catalog, mcp)));
    const cache = JSON.parse(await readFile(join(root, ".proofblade", "tool-health.json"), "utf8")) as { entries: Record<string, unknown> };
    assert.equal(Object.keys(cache.entries).length, profiles.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
