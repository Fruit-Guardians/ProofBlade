import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "../src/config.js";
import { McpCapabilityBackend } from "../src/capabilities/backend.js";
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
    await services.fixtureControl.reset(runId, generation);
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

test("MCP toolchain profiles keep host paths out of summaries and gate unavailable servers", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-mcp-toolchain-"));
  const target = join(root, "ida64.exe");
  const pathEnvironment = "PROOFBLADE_TEST_IDA_PATH";
  const previous = process.env[pathEnvironment];
  let ready: McpProjectRegistry | undefined;
  try {
    delete process.env[pathEnvironment];
    await writeFile(target, "synthetic executable", "utf8");
    const serverPath = resolve(import.meta.dirname, "fixtures", "mcp-echo-server.mjs");
    await writeFile(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: {
        ida: {
          command: process.execPath,
          args: [serverPath],
          includeTools: ["echo"],
          requestTimeoutMs: 5_000,
          readOnly: true,
          replay: "pure",
          toolchain: {
            kind: "ida-pro",
            pathEnvironment,
            injectEnvironment: "MCP_SECRET",
            pathKind: "file",
          },
        },
      },
    }), "utf8");

    const missing = McpProjectRegistry.load(root);
    const unavailable = missing.summaries()[0]!;
    assert.equal(unavailable.status, "unavailable");
    assert.deepEqual(unavailable.toolchain && {
      kind: unavailable.toolchain.kind,
      state: unavailable.toolchain.state,
      pathEnvironment: unavailable.toolchain.pathEnvironment,
      injectEnvironment: unavailable.toolchain.injectEnvironment,
    }, { kind: "ida-pro", state: "missing", pathEnvironment, injectEnvironment: "MCP_SECRET" });
    assert.doesNotMatch(JSON.stringify(unavailable), new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const unavailableBackend = new McpCapabilityBackend(missing).availability({ capabilityId: "mcp.ida", operation: "call", input: {} });
    assert.equal(unavailableBackend.available, false);
    assert.match(unavailableBackend.reason ?? "", new RegExp(pathEnvironment));
    await missing.close();

    process.env[pathEnvironment] = target;
    ready = McpProjectRegistry.load(root);
    assert.equal(ready.summaries()[0]?.status, "configured");
    assert.equal(ready.summaries()[0]?.toolchain?.state, "ready");
    const result = await ready.execute("mcp.ida", "call", { tool: "echo", arguments: { text: "toolchain" } });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /toolchain/);
    assert.match(result.stdout, /\[REDACTED\]/);
    assert.doesNotMatch(result.stdout, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await ready.close();
    ready = undefined;

    await writeFile(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: {
        invalid: {
          command: process.execPath,
          env: { MCP_SECRET: "not-allowed" },
          toolchain: { kind: "custom", pathEnvironment, injectEnvironment: "MCP_SECRET" },
        },
      },
    }), "utf8");
    assert.throws(() => McpProjectRegistry.load(root), /injectEnvironment must not also be declared in env/);
  } finally {
    await ready?.close().catch(() => undefined);
    if (previous === undefined) delete process.env[pathEnvironment];
    else process.env[pathEnvironment] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP schemas persist across registry instances and invalidate on config changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-mcp-schema-cache-"));
  const marker = join(root, "mcp-started.txt");
  try {
    await writeMcpConfig(root, marker);
    const first = McpProjectRegistry.load(root);
    const initial = await first.describeServer("echo");
    assert.ok(initial.tools.some((tool) => tool.name === "echo"));
    await access(marker);
    await first.close();
    await rm(marker, { force: true });

    const cached = McpProjectRegistry.load(root);
    const reused = await cached.describeServer("echo");
    assert.deepEqual(reused.tools.map((tool) => tool.name), initial.tools.map((tool) => tool.name));
    await assert.rejects(() => access(marker), /ENOENT/);
    await cached.close();

    const configPath = join(root, ".mcp.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
    config.mcpServers.echo.description = "changed config invalidates schema";
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
    const invalidated = McpProjectRegistry.load(root);
    await invalidated.describeServer("echo");
    await access(marker);
    await invalidated.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP close aborts a pending handshake and leaves no child process", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-mcp-close-"));
  let registry: McpProjectRegistry | undefined;
  try {
    await writeFile(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: {
        hanging: {
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
          requestTimeoutMs: 120_000,
        },
      },
    }), "utf8");
    registry = McpProjectRegistry.load(root);
    const pending = registry.describeServer("hanging");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    await registry.close();
    assert.ok(Date.now() - started < 2_000);
    await assert.rejects(() => pending, /aborted|closing|closed|cancelled|terminated|timeout/i);
    registry = undefined;
  } finally {
    await registry?.close().catch(() => undefined);
    // Windows can briefly keep a just-closed child cwd locked after the
    // process-exit assertion; bounded fs.rm retries cover that release window.
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

test("MCP toolchain profiles default JADX, Ghidra, and Rizin homes to directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-mcp-toolchain-directories-"));
  const profiles = [
    { name: "jadx", kind: "jadx", pathEnvironment: "PROOFBLADE_TEST_JADX_HOME" },
    { name: "ghidra", kind: "ghidra", pathEnvironment: "PROOFBLADE_TEST_GHIDRA_HOME" },
    { name: "rizin", kind: "rizin", pathEnvironment: "PROOFBLADE_TEST_RIZIN_HOME" },
  ] as const;
  const previous = new Map(profiles.map((profile) => [profile.pathEnvironment, process.env[profile.pathEnvironment]]));
  try {
    const mcpServers: Record<string, unknown> = {};
    for (const profile of profiles) {
      const installation = join(root, profile.kind);
      await mkdir(installation);
      process.env[profile.pathEnvironment] = installation;
      mcpServers[profile.name] = {
        command: process.execPath,
        toolchain: { kind: profile.kind, pathEnvironment: profile.pathEnvironment },
      };
    }
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers }), "utf8");
    const registry = McpProjectRegistry.load(root);
    const backend = new McpCapabilityBackend(registry);
    for (const profile of profiles) {
      const summary = registry.summaries().find((item) => item.name === profile.name)!;
      assert.equal(summary.status, "configured");
      assert.equal(summary.toolchain?.state, "ready");
      assert.equal(backend.availability({ capabilityId: summary.capabilityId, operation: "call", input: {} }).available, true);
    }
    await registry.close();
  } finally {
    for (const profile of profiles) {
      const value = previous.get(profile.pathEnvironment);
      if (value === undefined) delete process.env[profile.pathEnvironment];
      else process.env[profile.pathEnvironment] = value;
    }
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
