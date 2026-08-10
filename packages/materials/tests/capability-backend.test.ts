import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { CapabilityOperationAtom } from "@proofblade/molecules";
import {
  CapabilityBackendResolver,
  McpCapabilityBackend,
  type CapabilityBackend,
  type CapabilityBackendKind,
  type CapabilityBackendRequest,
} from "../src/capabilities/backend.js";

const operation: CapabilityOperationAtom = {
  name: "identify",
  description: "Identify an input.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  readOnly: true,
  sideEffect: "none",
  replay: "pure",
  outputPolicy: "summary",
  executionMode: "sequential",
};

test("capability backend resolution is deterministic and falls back only before execution", () => {
  const resolver = new CapabilityBackendResolver([
    fakeBackend("preferred-unavailable", 10, false, "tool not installed"),
    fakeBackend("fallback-b", 20, true),
    fakeBackend("fallback-a", 20, true),
  ]);
  const request = { capabilityId: "binary.inspect", operation: "identify", input: {} };

  assert.equal(resolver.resolve(request).backend.id, "fallback-a");
  assert.equal(resolver.resolve({ ...request, backendId: "fallback-b" }).backend.id, "fallback-b");
  assert.throws(() => resolver.resolve({ ...request, backendId: "preferred-unavailable" }), /tool not installed/);
  assert.throws(() => resolver.resolve({ ...request, backendId: "fallback-a", backendVersion: "old" }), /version changed/);
  assert.deepEqual(resolver.statuses().map((status) => status.id), ["preferred-unavailable", "fallback-a", "fallback-b"]);
});

test("capability backend ids are unique and bound backends must handle the logical operation", () => {
  assert.throws(() => new CapabilityBackendResolver([
    fakeBackend("duplicate", 10, true),
    fakeBackend("duplicate", 20, true),
  ]), /Duplicate capability backend id/);

  const resolver = new CapabilityBackendResolver([fakeBackend("other", 10, true, undefined, "other.capability")]);
  assert.throws(() => resolver.resolve({ capabilityId: "binary.inspect", operation: "identify", input: {}, backendId: "other" }), /does not handle/);
});

test("MCP backend filters operations, exposes its binding catalog version, and fails over after connection failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-mcp-backend-"));
  let registry: import("../src/mcp/registry.js").McpProjectRegistry | undefined;
  try {
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: {
      bad: { command: "proofblade-command-that-does-not-exist-for-test" },
    } }));
    const { McpProjectRegistry } = await import("../src/mcp/registry.js");
    registry = McpProjectRegistry.load(root);
    const backend = new McpCapabilityBackend(registry);
    assert.equal(backend.handles("mcp.bad", "describe"), true);
    assert.equal(backend.handles("mcp.bad", "call"), true);
    assert.equal(backend.handles("mcp.bad", "bogus"), false);
    assert.equal(backend.status().version, registry.catalogHash());

    await assert.rejects(() => registry.describe("bad"));
    assert.equal(backend.status().available, false);
    const resolver = new CapabilityBackendResolver([
      backend,
      fakeBackend("mcp-fallback", 200, true, undefined, "mcp.bad", "call"),
    ]);
    assert.equal(resolver.resolve({ capabilityId: "mcp.bad", operation: "call", input: {} }).backend.id, "mcp-fallback");
  } finally {
    await registry?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP backend retries a recovered server through the same registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-mcp-retry-"));
  let registry: import("../src/mcp/registry.js").McpProjectRegistry | undefined;
  try {
    const marker = join(root, "attempted.txt");
    const echoServer = pathToFileURL(join(import.meta.dirname, "fixtures", "mcp-echo-server.mjs")).href;
    const flakyServer = join(root, "flaky-server.mjs");
    await writeFile(flakyServer, [
      'import { existsSync, writeFileSync } from "node:fs";',
      'const marker = process.env.MCP_ATTEMPTS;',
      'if (marker && !existsSync(marker)) { writeFileSync(marker, "failed", "utf8"); process.exit(42); }',
      `await import(${JSON.stringify(echoServer)});`,
      "",
    ].join("\n"));
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: {
      flaky: { command: process.execPath, args: [flakyServer], env: { MCP_ATTEMPTS: marker } },
    } }));

    const { McpProjectRegistry, MCP_FAILURE_RETRY_DELAY_MS } = await import("../src/mcp/registry.js");
    registry = McpProjectRegistry.load(root);
    const backend = new McpCapabilityBackend(registry);
    assert.equal(backend.availability({ capabilityId: "mcp.flaky", operation: "describe", input: {} }).available, true);

    await assert.rejects(() => registry!.describe("flaky"));
    assert.equal(registry!.summaries()[0]?.status, "failed");
    assert.ok(registry!.retryAfterMs("mcp.flaky") > 0);
    assert.equal(
      registry!.retryAfterMs("mcp.flaky", Date.now() + MCP_FAILURE_RETRY_DELAY_MS),
      0,
    );
    assert.equal(backend.availability({ capabilityId: "mcp.flaky", operation: "describe", input: {} }).available, false);

    // Once the cooldown expires, the same backend may try the recovered service.
    await new Promise((resolve) => setTimeout(resolve, MCP_FAILURE_RETRY_DELAY_MS + 25));
    assert.equal(backend.availability({ capabilityId: "mcp.flaky", operation: "describe", input: {} }).available, true);
    const described = await registry!.describe("flaky");
    assert.equal(described[0]?.name, "agent_call_tool");
    assert.equal(registry!.summaries()[0]?.status, "connected");

    // Explicit reset remains available for an operator to retry before cooldown.
    registry!.resetFailures("mcp.flaky");
    assert.equal(registry!.retryAfterMs("mcp.flaky"), 0);
  } finally {
    await registry?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP registry rebuilds a connection after an established server exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-mcp-transport-retry-"));
  let registry: import("../src/mcp/registry.js").McpProjectRegistry | undefined;
  try {
    const marker = join(root, "crash-marker.txt");
    const serverPath = join(import.meta.dirname, "fixtures", "mcp-crash-after-list-server.mjs");
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: {
      crashy: { command: process.execPath, args: [serverPath], env: { MCP_CRASH_MARKER: marker } },
    } }));

    const { McpProjectRegistry } = await import("../src/mcp/registry.js");
    registry = McpProjectRegistry.load(root);
    const firstDescription = await registry.describe("crashy");
    assert.equal(firstDescription[0]?.name, "echo");
    await waitForProcessExit(marker);

    const staleCall = await registry.execute("mcp.crashy", "call", { tool: "echo", arguments: { text: "stale" } });
    assert.equal(staleCall.exitCode, 1);
    assert.equal(registry.summaries()[0]?.status, "failed");
    assert.ok(registry.retryAfterMs("mcp.crashy") > 0);

    registry.resetFailures("mcp.crashy");
    const recoveredCall = await registry.execute("mcp.crashy", "call", { tool: "echo", arguments: { text: "recovered" } });
    assert.equal(recoveredCall.exitCode, 0);
    assert.match(recoveredCall.stdout, /recovered/);
    assert.equal(registry.summaries()[0]?.status, "connected");
  } finally {
    await registry?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function fakeBackend(
  id: string,
  priority: number,
  available: boolean,
  reason?: string,
  capabilityId = "binary.inspect",
  operationName = operation.name,
): CapabilityBackend {
  const kind: CapabilityBackendKind = "local-process";
  return {
    id,
    kind,
    priority,
    status: () => ({ id, kind, priority, version: "1.0.0", available, reason }),
    handles: (candidate, candidateOperation) => candidate === capabilityId && candidateOperation === operationName,
    availability: () => ({ available, reason }),
    versionFor: (_request: CapabilityBackendRequest) => "1.0.0",
    preparePersistence: (request) => ({ operation, input: request.input, argsRedacted: false }),
    prepareExecution: () => ({ operation: "fake", args: {}, cwd: ".", replayPolicy: "pure" }),
  };
}

async function waitForProcessExit(marker: string): Promise<void> {
  let pid: number | undefined;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = await readFile(marker, "utf8").catch(() => "");
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      pid = parsed;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(pid, "Timed out waiting for the MCP server PID");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for MCP server ${pid} to exit`);
}
