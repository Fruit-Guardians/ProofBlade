import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "../src/config.js";
import { createServices } from "../src/app/demo.js";
import { fixtureTask } from "../src/app/fixture-task.js";
import { McpProjectRegistry } from "../src/mcp/registry.js";
import { ProofBladeToolRuntime } from "../src/tools/runtime.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "TEST_API_KEY",
      contextWindow: 4096,
      maxTokens: 512,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      input: ["text"],
    },
  },
};

test("MCP stdio is lazy, filtered, journaled, redacted, observed, and closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-mcp-"));
  const marker = join(root, "mcp-started.txt");
  try {
    await writeMcpConfig(root, marker);
    const direct = McpProjectRegistry.load(root);
    assert.equal(direct.summaries()[0]?.status, "configured");
    assert.deepEqual(direct.capabilityManifests().map((item) => item.id), ["mcp.echo"]);
    await assert.rejects(() => access(marker));
    await direct.close();

    const services = createServices(root, config);
    const runId = "MCP-001";
    const task = fixtureTask(runId, "web-source-1", root, config);
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.control.dispatch(runId, { type: "fixture_reset", generation });
    const runtime = new ProofBladeToolRuntime(runId, fixture, services.runsRoot, services.control, services.artifacts, services.journal, root);

    const catalog = runtime.listCapabilities();
    assert.ok(catalog.capabilities.some((item) => item.id === "mcp.echo"));
    await assert.rejects(() => access(marker));

    const described = await runtime.invokeCapability({ capabilityId: "mcp.echo", operation: "describe", input: {} });
    assert.match(described.output, /Echo bounded test input/);
    assert.doesNotMatch(described.output, /excluded by the project allowlist/);
    await access(marker);

    const called = await runtime.invokeCapability({
      capabilityId: "mcp.echo",
      operation: "call",
      input: { tool: "echo", arguments: { text: "hello", token: "ARG-SECRET-456" } },
    });
    assert.match(called.output, /hello/);
    assert.doesNotMatch(called.output, /ARG-SECRET-456|ENV-SECRET-123/);
    assert.match(called.output, /\[REDACTED\]/);
    assert.ok(called.observationId);
    assert.ok(called.evidenceId);

    const snapshot = await services.control.snapshot(runId);
    const serialized = JSON.stringify({ effects: snapshot.effects, artifacts: snapshot.artifacts });
    assert.doesNotMatch(serialized, /ARG-SECRET-456|ENV-SECRET-123/);
    const artifact = snapshot.artifacts[called.artifactId]!;
    const artifactText = await services.artifacts.readText(runId, artifact);
    assert.doesNotMatch(artifactText, /ARG-SECRET-456|ENV-SECRET-123/);
    assert.match(artifactText, /\[REDACTED\]/);
    await assert.rejects(() => runtime.invokeCapability({ capabilityId: "mcp.echo", operation: "call", input: { tool: "hidden", arguments: {} } }));

    const resources = runtime.resourceSnapshot({ version: 1, skillCatalogHash: "skills", skills: [], mcpCatalogHash: "", mcpServers: [] });
    assert.equal(resources.mcpServers[0]?.name, "echo");
    assert.doesNotMatch(JSON.stringify(resources), /ENV-SECRET-123/);
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeMcpConfig(root: string, marker: string): Promise<void> {
  const serverPath = resolve(import.meta.dirname, "fixtures", "mcp-echo-server.mjs");
  await writeFile(join(root, ".mcp.json"), JSON.stringify({
    mcpServers: {
      echo: {
        command: process.execPath,
        args: [serverPath],
        cwd: ".",
        description: "Synthetic echo MCP server",
        env: { MCP_MARKER: marker, MCP_SECRET: "ENV-SECRET-123" },
        includeTools: ["echo"],
        requestTimeoutMs: 10_000,
        readOnly: true,
      },
    },
  }, null, 2), "utf8");
}
