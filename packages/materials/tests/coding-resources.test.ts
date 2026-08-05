import assert from "node:assert/strict";
import test from "node:test";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core/node";
import { canonicalJson, sha256 } from "@proofblade/atoms";
import type { McpProjectRegistry, McpServerSummary } from "../src/mcp/registry.js";
import {
  codingActiveToolNames,
  codingProviderToolContractSnapshot,
  createCodingTools,
  type CodingResourceContext,
} from "../src/runtime/coding-resources.js";
import type { ProofBladeSkillRegistry } from "../src/skills/registry.js";

test("coding provider tools keep one stable Skill and MCP proxy contract", () => {
  const snapshot = codingProviderToolContractSnapshot();
  assert.deepEqual(snapshot.map((tool) => tool.name), ["read", "bash", "edit", "write", "load_skill", "mcp_call"]);
  assert.equal(sha256(canonicalJson(snapshot)), "b55ba6a6040823808e013e23e8113171360b9b300343c3a89ed0602ae27293ca");
  assert.equal(snapshot.some((tool) => ["list_mcp_servers", "describe_mcp_server", "call_mcp_tool"].includes(tool.name)), false);

  const withoutResources = codingActiveToolNames({ tools: ["read", "bash"], skills: [], mcpServers: [] });
  const withResources = codingActiveToolNames({ tools: ["read", "bash"], skills: ["triage"], mcpServers: ["echo", "browser"] });
  assert.deepEqual(withoutResources, ["read", "bash", "load_skill", "mcp_call"]);
  assert.deepEqual(withResources, withoutResources);
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

async function executeTool(name: string, params: Record<string, unknown>, context: CodingResourceContext): Promise<{ details: unknown; isError: boolean }> {
  const tool = createCodingTools().find((candidate) => candidate.name === name);
  assert.ok(tool, `Missing coding tool: ${name}`);
  const result = await (tool as AgentHarnessTool<CodingResourceContext>).execute("test-call", params, new AbortController().signal, () => undefined, context);
  return result as { details: unknown; isError: boolean };
}
