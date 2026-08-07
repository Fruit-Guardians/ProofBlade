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
    const directManifest = direct.capabilityManifests()[0]!;
    assert.equal(directManifest.id, "mcp.echo");
    assert.equal(directManifest.operations.find((operation) => operation.name === "describe")?.replay, "manual");
    assert.equal(direct.resolveInvocation("mcp.echo", "describe", {}).replay, "manual");
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
    assert.match(described.output, /agent_call_tool/);
    assert.match(described.output, /nestedTools/);
    assert.match(described.output, /page_eval/);
    assert.doesNotMatch(described.output, /run_node/);
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

    const effectsBeforeRejectedDispatch = Object.keys((await services.control.snapshot(runId)).effects).length;
    await assert.rejects(
      () => runtime.invokeCapability({
        capabilityId: "mcp.echo",
        operation: "call",
        input: { tool: "agent_call_tool", arguments: { name: "run_node", args: { code: "unsafe()" } } },
      }),
      /nested tool is not allowed/,
    );
    await assert.rejects(
      () => runtime.invokeCapability({
        capabilityId: "mcp.echo",
        operation: "call",
        input: { tool: "agent_call_tool", arguments: { name: "toString", args: {} } },
      }),
      /nested tool is not allowed/,
    );
    assert.equal(Object.keys((await services.control.snapshot(runId)).effects).length, effectsBeforeRejectedDispatch);

    const nested = await runtime.invokeCapability({
      capabilityId: "mcp.echo",
      operation: "call",
      input: {
        tool: "agent_call_tool",
        arguments: { name: "page_eval", args: { expression: "xyz", token: "NESTED-TOKEN-789" } },
      },
    });
    assert.doesNotMatch(nested.output, /xyz|NESTED-TOKEN-789/);
    assert.match(nested.output, /\[REDACTED\]/);
    const nestedSnapshot = await services.control.snapshot(runId);
    const nestedEffect = nestedSnapshot.effects[nested.effectId]!;
    assert.equal(nestedEffect.replayPolicy, "forbidden-replay");
    assert.equal((nestedEffect.args.mcp as { outerTool: string }).outerTool, "agent_call_tool");
    assert.equal((nestedEffect.args.mcp as { innerTool: string }).innerTool, "page_eval");
    assert.equal(((nestedEffect.args.mcp as { policy: { sideEffect: string } }).policy.sideEffect), "network");
    const nestedSerialized = JSON.stringify({ effect: nestedEffect, artifact: nestedSnapshot.artifacts[nested.artifactId] });
    assert.doesNotMatch(nestedSerialized, /xyz|NESTED-TOKEN-789/);
    assert.equal(nestedSnapshot.artifacts[nested.artifactId]?.sensitivity, "secret");
    const nestedArtifactText = await services.artifacts.readText(runId, nestedSnapshot.artifacts[nested.artifactId]!);
    assert.doesNotMatch(nestedArtifactText, /xyz|NESTED-TOKEN-789/);
    assert.match(nestedArtifactText, /\[REDACTED\]/);

    const secretJobStart = await runtime.runBackground({
      capabilityId: "mcp.echo",
      operation: "call",
      input: {
        tool: "agent_call_tool",
        arguments: { name: "page_eval", args: { expression: "bgx", token: "BACKGROUND-TOKEN-012" } },
      },
    });
    const queuedSecretJob = await runtime.jobStatus(String(secretJobStart.jobId));
    assert.equal(queuedSecretJob.argsRedacted, true);
    assert.doesNotMatch(JSON.stringify(queuedSecretJob.args), /bgx|BACKGROUND-TOKEN-012/);
    const completedSecretJob = await runtime.waitJob(String(secretJobStart.jobId), 10_000);
    assert.equal(completedSecretJob.status, "SUCCEEDED");
    const backgroundSnapshot = await services.control.snapshot(runId);
    const backgroundEffect = backgroundSnapshot.effects[completedSecretJob.effectId!]!;
    const backgroundArtifact = backgroundSnapshot.artifacts[completedSecretJob.artifactId!]!;
    assert.equal(backgroundArtifact.sensitivity, "secret");
    assert.doesNotMatch(JSON.stringify({ job: completedSecretJob, effect: backgroundEffect, artifact: backgroundArtifact }), /bgx|BACKGROUND-TOKEN-012/);
    assert.doesNotMatch(await services.artifacts.readText(runId, backgroundArtifact), /bgx|BACKGROUND-TOKEN-012/);
    assert.doesNotMatch(await readFile(join(root, "runs", runId, "events.jsonl"), "utf8"), /bgx|BACKGROUND-TOKEN-012/);

    const safeJob = await runtime.runBackground({
      capabilityId: "mcp.echo",
      operation: "call",
      input: { tool: "agent_call_tool", arguments: { name: "page_info", args: {} } },
    });
    assert.equal(safeJob.replayPolicy, "pure");
    const completedJob = await runtime.waitJob(String(safeJob.jobId), 10_000);
    assert.equal(completedJob.status, "SUCCEEDED");

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
        includeTools: ["echo", "agent_tools", "agent_call_tool"],
        requestTimeoutMs: 10_000,
        readOnly: true,
        replay: "pure",
        nestedToolPolicy: {
          dispatcherTool: "agent_call_tool",
          toolField: "name",
          argumentsField: "args",
          includeTools: ["page_info", "page_eval"],
          tools: {
            page_info: { readOnly: true, sideEffect: "none", replay: "pure", sensitivity: "public" },
            page_eval: {
              readOnly: false,
              sideEffect: "network",
              replay: "forbidden-replay",
              sensitivity: "secret",
              resourceKeys: ["browser:current-tab"],
              redactArguments: ["expression"],
            },
            run_node: { readOnly: false, sideEffect: "process", replay: "forbidden-replay", sensitivity: "target" },
          },
        },
      },
    },
  }, null, 2), "utf8");
}
