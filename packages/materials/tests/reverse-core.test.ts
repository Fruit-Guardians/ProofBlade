import assert from "node:assert/strict";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import type { CapabilityOperationAtom } from "@proofblade/molecules";
import { McpReverseCapabilityBackend, RizinCapabilityBackend, type CapabilityBackend } from "../src/capabilities/backend.js";
import { createRizinAvailability } from "../src/capabilities/reverse.js";
import { McpProjectRegistry } from "../src/mcp/registry.js";
import type { RawEffectResult } from "../src/domain/types.js";

test("Rizin deep reverse Backend normalizes functions, disassembly, and xrefs", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-reverse-core-"));
  const calls: string[] = [];
  try {
    await writeFile(join(root, "sample.bin"), Buffer.from("synthetic binary"));
    const runner = async (_executable: string, args: string[], _cwd: string, signal: AbortSignal): Promise<RawEffectResult> => {
      const command = String(args[args.indexOf("-c") + 1]);
      calls.push(command);
      if (signal.aborted) return { stdout: "", stderr: "aborted", exitCode: null, durationMs: 1 };
      if (command === "aflj") return result(JSON.stringify([
        { offset: 0x401020, name: "sym.main", realsz: 48, type: "fcn" },
        { offset: 0x401000, name: "entry0", size: 32, type: "fcn" },
      ]));
      if (command.startsWith("pdj")) return result(JSON.stringify([
        { offset: 0x401000, bytes: "554889e5", opcode: "push rbp", type: "push" },
        { offset: 0x401001, bytes: "4889e5", opcode: "mov rbp, rsp", type: "mov" },
      ]));
      if (command.startsWith("axtj")) return result(JSON.stringify([{ from: 0x401020, to: 0x401000, type: "CALL" }]));
      return result(JSON.stringify([{ from: 0x401030, to: 0x401000, type: "JMP" }]));
    };
    const backend = new RizinCapabilityBackend({ executable: "rz-test", version: "0.8.1", runner });
    assert.deepEqual(backend.status(), { id: "proofblade-rizin", kind: "local-process", version: "rizin-0.8.1-adapter-1", priority: 80, available: true });
    const context = { runId: "REVERSE-TEST", fixture: { fixtureId: "fixture", generation: 1, path: root, privatePath: join(root, ".proofblade") }, runsRoot: root, artifacts: {} };

    const functions = await invoke(backend, "functions", { path: "sample.bin", maxResults: 10 }, context);
    assert.deepEqual(functions, { format: "rizin", functions: [
      { index: 0, address: "0x401000", name: "entry0", size: 32, type: "fcn" },
      { index: 1, address: "0x401020", name: "sym.main", size: 48, type: "fcn" },
    ] });

    const disassembly = await invoke(backend, "disassemble", { path: "sample.bin", address: "0x401000", maxInstructions: 8 }, context);
    assert.deepEqual(disassembly, { format: "rizin", address: "0x401000", instructions: [
      { address: "0x401000", bytes: "554889e5", mnemonic: "push", operands: "rbp", type: "push" },
      { address: "0x401001", bytes: "4889e5", mnemonic: "mov", operands: "rbp, rsp", type: "mov" },
    ] });

    const xrefs = await invoke(backend, "xrefs", { path: "sample.bin", address: "0x401000", direction: "both", maxResults: 10 }, context);
    assert.deepEqual(xrefs, { format: "rizin", address: "0x401000", direction: "both", xrefs: [
      { from: "0x401020", to: "0x401000", type: "CALL" },
      { from: "0x401030", to: "0x401000", type: "JMP" },
    ] });
    assert.equal(calls.length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Rizin deep reverse Backend rejects unsafe addresses before execution", () => {
  const backend = new RizinCapabilityBackend({ executable: "rz-test", runner: async () => result("[]") });
  const operation = operationFor("disassemble");
  assert.throws(() => backend.prepareExecution({ capabilityId: "proofblade.binary", operation: "disassemble", input: { path: "sample.bin", address: "0x401000; q" } }, operation, contextFor("fixture")), /hexadecimal address/);
  assert.throws(() => backend.prepareExecution({ capabilityId: "proofblade.binary", operation: "bogus", input: { path: "sample.bin", address: "0x401000" } }, operation, contextFor("fixture")), /Unsupported reverse operation/);
  assert.equal(backend.handles("proofblade.binary", "functions"), true);
  assert.equal(backend.handles("proofblade.binary", "identify"), false);
});

test("Rizin availability resolves relative executable paths for tmpdir execution", () => {
  const requested = relative(process.cwd(), process.execPath);
  const availability = createRizinAvailability({ executable: requested });
  assert.equal(availability.available, true, availability.reason);
  assert.equal(isAbsolute(availability.executable ?? ""), true);
});

test("Rizin availability resolves executables found through relative PATH directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-rizin-path-"));
  const executable = join(root, process.platform === "win32" ? "rz.EXE" : "rz");
  const previousPath = process.env.PATH;
  const previousPathExt = process.env.PATHEXT;
  try {
    await copyFile(process.execPath, executable);
    if (process.platform !== "win32") await chmod(executable, 0o755);
    process.env.PATH = relative(process.cwd(), root) || ".";
    if (process.platform === "win32") process.env.PATHEXT = ".EXE";

    const availability = createRizinAvailability();
    assert.equal(availability.available, true, availability.reason);
    assert.equal(resolve(availability.executable ?? ""), resolve(executable));
    assert.equal(isAbsolute(availability.executable ?? ""), true);
    const executed = await availability.runner(availability.executable!, ["-v"], tmpdir(), new AbortController().signal);
    assert.equal(executed.exitCode, 0, executed.stderr);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = previousPathExt;
    await rm(root, { recursive: true, force: true });
  }
});

test("Rizin process runner preserves spawn errors when stderr is empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-rizin-runner-"));
  try {
    const availability = createRizinAvailability({ executable: process.execPath });
    const result = await availability.runner(join(root, "missing-rizin-executable"), [], root, new AbortController().signal);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /ENOENT|not found|spawn/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP reverse adapter maps and normalizes the logical operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-mcp-reverse-"));
  const fixtureRoot = join(root, "runs", "REVERSE-TEST", "fixture");
  const pathMarker = join(root, "staged-paths.txt");
  let registry: McpProjectRegistry | undefined;
  try {
    const serverPath = resolve(import.meta.dirname, "fixtures", "mcp-reverse-server.mjs");
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(join(fixtureRoot, "sample.bin"), "synthetic binary");
    await writeFile(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: {
        reverse: {
          command: process.execPath,
          args: [serverPath],
          env: { MCP_PATH_MARKER: pathMarker },
          readOnly: true,
          replay: "pure",
          includeTools: ["reverse"],
        },
      },
      binaryReverse: {
        functions: { server: "reverse", tool: "reverse", arguments: { operation: "functions", path: "$path", limit: "$maxResults" }, output: "functions" },
        disassemble: { server: "reverse", tool: "reverse", arguments: { operation: "disassemble", path: "$path", address: "$address", limit: "$maxInstructions" }, output: "disassemble" },
        xrefs: { server: "reverse", tool: "reverse", arguments: { operation: "xrefs", path: "$path", address: "$address", direction: "$direction" }, output: "xrefs" },
      },
    }, null, 2), "utf8");
    registry = McpProjectRegistry.load(root);
    const backend = new McpReverseCapabilityBackend(registry);
    assert.equal(backend.status().available, true);
    assert.equal(backend.handles("proofblade.binary", "functions"), true);
    assert.equal(backend.handles("proofblade.binary", "identify"), false);
    const context = contextFor(fixtureRoot);
    const effectPlan = backend.prepareExecution({ capabilityId: "proofblade.binary", operation: "functions", input: { path: "sample.bin" } }, operationFor("functions"), context);
    assert.equal((((effectPlan.args.input as Record<string, unknown>).arguments as Record<string, unknown>).path), "sample.bin");

    const functions = await invoke(backend, "functions", { path: "sample.bin", maxResults: 10 }, context);
    assert.deepEqual(functions, { format: "mcp", functions: [
      { index: 0, address: "0x401000", name: "entry0", size: 32, type: "fcn" },
      { index: 1, address: "0x401020", name: "sym.main", size: 48, type: "fcn" },
    ] });
    const disassembly = await invoke(backend, "disassemble", { path: "sample.bin", address: "0x401000", maxInstructions: 8 }, context);
    assert.equal((disassembly.instructions as Array<unknown>)[0] && ((disassembly.instructions as Array<Record<string, unknown>>)[0]?.address), "0x401000");
    const xrefs = await invoke(backend, "xrefs", { path: "sample.bin", address: "0x401000", direction: "both", maxResults: 10 }, context);
    assert.deepEqual(xrefs.xrefs, [
      { from: "0x401020", to: "0x401000", type: "CALL" },
      { from: "0x401030", to: "0x401000", type: "JMP" },
    ]);
    const failed = await registry.execute("mcp.reverse", "call", { tool: "reverse", arguments: { operation: "functions", path: "missing.bin" } });
    assert.equal(failed.exitCode, 1);
    assert.match(failed.stderr, /MCP reverse path must be an existing absolute staged file/);
    await assertStagedPathsCleaned(pathMarker, fixtureRoot, 3);
  } finally {
    await registry?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP reverse adapter supports an explicitly matched nested dispatcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-mcp-reverse-nested-"));
  const fixtureRoot = join(root, "runs", "REVERSE-TEST", "fixture");
  const pathMarker = join(root, "staged-paths.txt");
  let registry: McpProjectRegistry | undefined;
  try {
    const serverPath = resolve(import.meta.dirname, "fixtures", "mcp-reverse-server.mjs");
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(join(fixtureRoot, "sample.bin"), "synthetic binary");
    await writeFile(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: {
        nested: {
          command: process.execPath,
          args: [serverPath],
          env: { MCP_PATH_MARKER: pathMarker },
          readOnly: true,
          replay: "pure",
          includeTools: ["dispatch"],
          nestedToolPolicy: {
            dispatcherTool: "dispatch",
            toolField: "name",
            argumentsField: "args",
            tools: { functions: { readOnly: true, sideEffect: "none", replay: "pure" } },
          },
        },
      },
      binaryReverse: {
        functions: { server: "nested", tool: "dispatch", arguments: { path: "$path" }, output: "functions", nestedTool: { name: "functions", toolField: "name", argumentsField: "args" } },
      },
    }, null, 2), "utf8");
    registry = McpProjectRegistry.load(root);
    const backend = new McpReverseCapabilityBackend(registry);
    const context = contextFor(fixtureRoot);
    const effectPlan = backend.prepareExecution({ capabilityId: "proofblade.binary", operation: "functions", input: { path: "sample.bin" } }, operationFor("functions"), context);
    const nestedArguments = ((effectPlan.args.input as Record<string, unknown>).arguments as Record<string, unknown>).args as Record<string, unknown>;
    assert.equal(nestedArguments.path, "sample.bin");
    const functions = await invoke(backend, "functions", { path: "sample.bin" }, context);
    assert.equal((functions.functions as Array<Record<string, unknown>>)[0]?.address, "0x401000");
    await assertStagedPathsCleaned(pathMarker, fixtureRoot, 1);
  } finally {
    await registry?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function invoke(backend: CapabilityBackend, operation: string, input: Record<string, unknown>, context: ReturnType<typeof contextFor>): Promise<Record<string, unknown>> {
  const plan = backend.prepareExecution({ capabilityId: "proofblade.binary", operation, input }, operationFor(operation), context);
  const result = await plan.execute!(new AbortController().signal);
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function operationFor(name: string): CapabilityOperationAtom {
  return { name, description: name, parameters: { type: "object", properties: {}, additionalProperties: false }, readOnly: true, sideEffect: "process", replay: "pure", outputPolicy: "summary", executionMode: "sequential" };
}

function contextFor(path: string) {
  return { runId: "REVERSE-TEST", fixture: { fixtureId: "fixture", generation: 1, path, privatePath: join(path, ".proofblade") }, runsRoot: path, artifacts: {} };
}

async function assertStagedPathsCleaned(marker: string, fixtureRoot: string, count: number): Promise<void> {
  const paths = (await readFile(marker, "utf8")).split(/\r?\n/).filter(Boolean);
  assert.equal(paths.length, count);
  for (const path of paths) {
    assert.equal(isAbsolute(path), true);
    assert.notEqual(resolve(path), resolve(fixtureRoot, "sample.bin"));
    await assert.rejects(() => access(path));
  }
}

function result(stdout: string): RawEffectResult {
  return { stdout, stderr: "", exitCode: 0, durationMs: 1 };
}
