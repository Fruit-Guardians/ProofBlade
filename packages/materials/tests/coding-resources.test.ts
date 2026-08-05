import assert from "node:assert/strict";
import test from "node:test";
import { NodeExecutionEnv, type AgentHarnessTool } from "@earendil-works/pi-agent-core/node";
import { canonicalJson, sha256 } from "@proofblade/atoms";
import type { McpProjectRegistry, McpServerSummary } from "../src/mcp/registry.js";
import {
  codingActiveToolNames,
  codingProviderToolContractSnapshot,
  createCodingTools,
  type CodingResourceContext,
} from "../src/runtime/coding-resources.js";
import type { ProofBladeSkillRegistry } from "../src/skills/registry.js";
import type { OutputRewritePort } from "@proofblade/molecules";
import { createServices, demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { CodingClaimVerifier, requiresClaimVerification } from "../src/verification/claim-verification.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

test("coding provider tools keep one stable Skill and MCP proxy contract", () => {
  const snapshot = codingProviderToolContractSnapshot();
  assert.deepEqual(snapshot.map((tool) => tool.name), ["read", "bash", "edit", "write", "verify_claim", "load_skill", "mcp_call"]);
  assert.equal(sha256(canonicalJson(snapshot)), "a98846eb2565138efdf1dfb44ca04156e45c6ed9fffb1a6cc2a118e00e2e43b9");
  assert.equal(snapshot.some((tool) => ["list_mcp_servers", "describe_mcp_server", "call_mcp_tool"].includes(tool.name)), false);

  const withoutResources = codingActiveToolNames({ tools: ["read", "bash"], skills: [], mcpServers: [] });
  const withResources = codingActiveToolNames({ tools: ["read", "bash"], skills: ["triage"], mcpServers: ["echo", "browser"] });
  assert.deepEqual(withoutResources, ["read", "bash", "verify_claim", "load_skill", "mcp_call"]);
  assert.deepEqual(withResources, withoutResources);
});

test("coding claim verification rejects decoys and persists a matching reproduction", async () => {
  assert.equal(requiresClaimVerification("完成这道题，并得到flag"), true);
  assert.equal(requiresClaimVerification("分析这些文件", "结果是 flag{derived}"), true);
  assert.equal(requiresClaimVerification("修复 feature flag 的布尔判断"), false);
  assert.equal(requiresClaimVerification("你好"), false);

  const root = resolve(import.meta.dirname, "../../..", "tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "coding-claim-"));
  const config = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: { thinkingLevel: "off" } },
  } as unknown as ProofBladeConfig;
  const services = createServices(dir, config);
  const runId = "CODING-CLAIM-TEST";
  await services.control.createRun(runId, demoTask(runId, dir, config));
  const candidate = "flag{3d02c696a47d9e524d37241e33098bd0}";
  await writeFile(join(dir, "decoy.txt"), "LCTF2026EV-ARM-GW-042\n", "utf8");
  await writeFile(join(dir, "protected.bin"), Buffer.from(candidate, "utf8").map((byte) => byte ^ 0x5a));
  await writeFile(join(dir, "solve.mjs"), "import { readFileSync } from 'node:fs';\nconst data = readFileSync('protected.bin');\nprocess.stdout.write(Buffer.from(data.map((byte) => byte ^ 0x5a)).toString('utf8'));\n", "utf8");
  const env = new NodeExecutionEnv({ cwd: dir });
  const verifier = new CodingClaimVerifier(runId, services.control, services.artifacts);
  const context = {
    env,
    skills: {},
    mcp: {},
    enabledSkills: new Set<string>(),
    enabledMcpServers: new Set<string>(),
    claimVerifier: verifier,
  } as unknown as CodingResourceContext;
  try {
    await assert.rejects(
      () => executeTool("verify_claim", { candidate, command: `echo ${candidate}` }, context),
      /embeds the candidate literal/,
    );
    const result = await executeTool("verify_claim", { candidate, command: "node solve.mjs" }, context);
    const details = result.details as Record<string, unknown>;
    assert.equal(details.verified, true);
    const snapshot = await services.control.snapshot(runId);
    assert.equal(Object.values(snapshot.evidence).filter((item) => item.kind === "reproduction").length, 1);
    assert.equal(Object.values(snapshot.completions).filter((item) => item.status === "ACCEPTED").length, 1);
    assert.equal(Object.values(snapshot.facts).filter((item) => item.status === "CONFIRMED").length, 1);
    assert.ok(snapshot.artifacts[String(details.artifactId)]);
    assert.equal(verifier.project("完成这道题，并得到flag", `最终结果：${candidate}`).status, "verified");
    assert.equal(verifier.project("完成这道题，并得到flag", "最终结果：LCTF2026EV-ARM-GW-042").status, "unverified");
  } finally {
    await env.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

test("coding resource proxies enforce conversation enablement and route MCP lazily", async () => {
  const calls: Array<{ kind: string; value: unknown }> = [];
  const summaries: McpServerSummary[] = [
    { name: "echo", capabilityId: "mcp.echo", description: "Echo service", disabled: false, status: "configured", configHash: "echo-hash" },
    { name: "browser", capabilityId: "mcp.browser", description: "Browser service", disabled: false, status: "configured", configHash: "browser-hash" },
  ];
  const mcp = {
    summaries: () => summaries,
    describe: async (server: string) => {
      calls.push({ kind: "describe", value: server });
      return [{ name: "echo_text", description: "Echo text", inputSchema: { type: "object" }, readOnlyHint: true }];
    },
    execute: async (capabilityId: string, operation: string, input: Record<string, unknown>) => {
      calls.push({ kind: "execute", value: { capabilityId, operation, input } });
      return { stdout: "called", stderr: "", exitCode: 0, durationMs: 1 };
    },
  } as unknown as McpProjectRegistry;
  const skills = {
    loadForModel: (name: string, maxChars?: number) => ({ name, maxChars, content: "loaded" }),
  } as unknown as ProofBladeSkillRegistry;
  const context = {
    skills,
    mcp,
    enabledSkills: new Set<string>(),
    enabledMcpServers: new Set(["echo"]),
  } as unknown as CodingResourceContext;

  const listed = await executeTool("mcp_call", { operation: "list" }, context);
  assert.deepEqual((listed.details as { servers: McpServerSummary[] }).servers.map((server) => server.name), ["echo"]);
  assert.deepEqual(calls, []);

  const described = await executeTool("mcp_call", { operation: "describe", server: "echo" }, context);
  assert.equal((described.details as { server: string }).server, "echo");
  assert.deepEqual(calls, [{ kind: "describe", value: "echo" }]);
  await assert.rejects(() => executeTool("mcp_call", { operation: "describe", server: "browser" }, context), /not enabled/);
  await assert.rejects(() => executeTool("mcp_call", { operation: "list", server: "echo" }, context), /does not accept/);
  await assert.rejects(() => executeTool("mcp_call", { operation: "delete", server: "echo" }, context), /Unsupported MCP operation/);

  const called = await executeTool("mcp_call", { operation: "call", server: "echo", tool: "echo_text", arguments: { text: "hello" } }, context);
  assert.equal((called.details as { stdout: string }).stdout, "called");
  assert.deepEqual(calls.at(-1), { kind: "execute", value: { capabilityId: "mcp.echo", operation: "call", input: { tool: "echo_text", arguments: { text: "hello" } } } });

  await assert.rejects(() => executeTool("load_skill", { name: "triage" }, context), /not enabled/);
  context.enabledSkills.add("triage");
  const loaded = await executeTool("load_skill", { name: "triage", maxChars: 2_000 }, context);
  assert.deepEqual(loaded.details, { name: "triage", maxChars: 2_000, content: "loaded" });
});

test("coding bash archives raw output before returning RTK-compressed content", async () => {
  const root = resolve(import.meta.dirname, "../../..", "tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "coding-rtk-"));
  const config = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: { thinkingLevel: "off" } },
  } as unknown as ProofBladeConfig;
  const services = createServices(dir, config);
  const runId = "RTK-CODING-TEST";
  await services.control.createRun(runId, demoTask(runId, dir, config));
  const commands: string[] = [];
  const env = {
    cwd: dir,
    async exec(command: string, options?: { env?: Record<string, string>; onStdout?: (chunk: string) => void }) {
      commands.push(command);
      assert.equal(options?.env?.RTK_TEE_DIR, "tee-dir");
      options?.onStdout?.("6 tests passed\n");
      return { ok: true as const, value: { stdout: "6 tests passed\n", stderr: "", exitCode: 0 } };
    },
  };
  const raw = "PASS verbose diagnostic\n".repeat(200);
  const port: OutputRewritePort = {
    async prepare(input) {
      return {
        requestedProvider: "rtk",
        provider: "rtk",
        providerVersion: "0.42.4",
        applied: true,
        command: "rtk test npm test",
        originalCommandHash: `original-${input.command.length}`,
        rewrittenCommandHash: "rewritten",
        executionEnv: { RTK_TEE_DIR: "tee-dir" },
      };
    },
    async finalize(ticket, visibleOutput) {
      return { ticket, rawOutput: raw, rawCapture: "rtk-tee", rawBytes: Buffer.byteLength(raw), visibleBytes: Buffer.byteLength(visibleOutput), rawTruncated: false };
    },
  };
  const context = {
    env,
    skills: {},
    mcp: {},
    enabledSkills: new Set<string>(),
    enabledMcpServers: new Set<string>(),
    outputRewrite: { port, artifactStore: services.artifacts, runId },
  } as unknown as CodingResourceContext;
  try {
    const result = await executeTool("bash", { command: "npm test" }, context);
    assert.deepEqual(commands, ["rtk test npm test"]);
    const rewrite = (result.details as { outputRewrite: Record<string, unknown> }).outputRewrite;
    assert.equal(rewrite.provider, "rtk");
    assert.equal(rewrite.rawCapture, "rtk-tee");
    assert.ok(Number(rewrite.savedBytes) > 4_000);
    assert.ok(Number(rewrite.savingsRate) > 0.9);
    const artifactId = String(rewrite.artifactId);
    const snapshot = await services.control.snapshot(runId);
    assert.ok(snapshot.artifacts[artifactId]);
    assert.equal(await services.artifacts.readText(runId, snapshot.artifacts[artifactId]!), raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function executeTool(name: string, params: Record<string, unknown>, context: CodingResourceContext): Promise<{ details: unknown; isError: boolean }> {
  const tool = createCodingTools().find((candidate) => candidate.name === name);
  assert.ok(tool, `Missing coding tool: ${name}`);
  const result = await (tool as AgentHarnessTool<CodingResourceContext>).execute("test-call", params, new AbortController().signal, () => undefined, context);
  return result as { details: unknown; isError: boolean };
}
