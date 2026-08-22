import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BinaryCapabilityBackend } from "../src/capabilities/backend.js";

test("Binary Core v1 analyzes ELF structure and bounded content", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-binary-core-"));
  try {
    await writeFile(join(root, "sample.elf"), makeElf64());
    await writeFile(join(root, "packed.bin"), Buffer.concat([Buffer.from("MZ"), Buffer.from("UPX!UPX0UPX1", "ascii") ]));
    const backend = new BinaryCapabilityBackend();
    const context = { runId: "BINARY-TEST", fixture: { fixtureId: "fixture", generation: 1, path: root, privatePath: join(root, ".proofblade") }, runsRoot: root, artifacts: {} };
    const invoke = async (operation: string, input: Record<string, unknown>) => {
      const plan = backend.prepareExecution({ capabilityId: "proofblade.binary", operation, input }, {
        name: operation,
        description: operation,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        readOnly: true,
        sideEffect: "none",
        replay: "pure",
        outputPolicy: "summary",
        executionMode: "sequential",
      }, context);
      const result = await plan.execute!(new AbortController().signal);
      assert.equal(result.exitCode, 0, result.stderr);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };

    const identity = await invoke("identify", { path: "sample.elf" });
    assert.deepEqual(identity, { format: "elf", size: 608, bits: 64, endian: "little", machine: 62, architecture: "x86_64", entryPoint: "0x401000" });
    const sectionResult = await invoke("sections", { path: "sample.elf" });
    assert.deepEqual((sectionResult.sections as Array<Record<string, unknown>>).map((section) => section.name), ["", ".shstrtab", ".text"]);
    const range = await invoke("read_range", { path: "sample.elf", offset: 0, length: 4 });
    assert.equal(range.hex, "7f454c46");
    const extracted = await invoke("strings", { path: "sample.elf", minLength: 5 });
    assert.ok((extracted.strings as Array<Record<string, unknown>>).some((item) => item.value === "HELLO"));
    const elf = await invoke("inspect_elf", { path: "sample.elf" });
    assert.equal((elf.identity as { architecture: string }).architecture, "x86_64");
    assert.deepEqual(elf.checksec, { pie: false, nx: null, relro: false, canary: false });
    const packed = await invoke("packed_probe", { path: "packed.bin" });
    assert.equal(packed.packed, true);
    assert.deepEqual((packed.markers as Array<{ marker: string }>).map((item) => item.marker), ["UPX!", "UPX0", "UPX1"]);
    assert.throws(() => backend.prepareExecution({ capabilityId: "proofblade.binary", operation: "identify", input: { path: ".proofblade/secret" } }, {
      name: "identify", description: "identify", parameters: { type: "object", properties: {}, additionalProperties: false }, readOnly: true, sideEffect: "none", replay: "pure", outputPolicy: "summary", executionMode: "sequential",
    }, context), /private fixture/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gdb_batch accepts bounded analysis commands and rejects shell escape commands", () => {
  const backend = new BinaryCapabilityBackend();
  const context = { runId: "GDB-BATCH", fixture: { fixtureId: "fixture", generation: 1, path: ".", privatePath: ".proofblade" }, runsRoot: ".", artifacts: {} };
  const operation = { name: "gdb_batch", description: "gdb", parameters: { type: "object", properties: {}, additionalProperties: false }, readOnly: true, sideEffect: "process" as const, replay: "idempotent" as const, outputPolicy: "artifact" as const, executionMode: "sequential" as const };
  assert.doesNotThrow(() => backend.prepareExecution({ capabilityId: "proofblade.binary", operation: "gdb_batch", input: { path: "sample.elf", commands: ["break main", "run", "info registers", "x/8gx $rsp"] } }, operation, context));
  assert.throws(() => backend.prepareExecution({ capabilityId: "proofblade.binary", operation: "gdb_batch", input: { path: "sample.elf", commands: ["shell cat /etc/passwd"] } }, operation, context), /non-shell commands/);
});

test("Binary Core v1 identifies PE32 sections", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-binary-pe-"));
  try {
    await writeFile(join(root, "sample.exe"), makePe32());
    const backend = new BinaryCapabilityBackend();
    const operation = { name: "sections", description: "sections", parameters: { type: "object", properties: {}, additionalProperties: false }, readOnly: true, sideEffect: "none", replay: "pure" as const, outputPolicy: "summary" as const, executionMode: "sequential" as const };
    const identifyOperation = { ...operation, name: "identify" };
    const identifyPlan = backend.prepareExecution({ capabilityId: "proofblade.binary", operation: "identify", input: { path: "sample.exe" } }, identifyOperation, { runId: "BINARY-PE", fixture: { fixtureId: "fixture", generation: 1, path: root, privatePath: join(root, ".proofblade") }, runsRoot: root, artifacts: {} });
    const identifyResult = await identifyPlan.execute!(new AbortController().signal);
    assert.equal(identifyResult.exitCode, 0, identifyResult.stderr);
    assert.equal((JSON.parse(identifyResult.stdout) as { entryPoint: string }).entryPoint, "0x401000");
    const plan = backend.prepareExecution({ capabilityId: "proofblade.binary", operation: "sections", input: { path: "sample.exe" } }, operation, { runId: "BINARY-PE", fixture: { fixtureId: "fixture", generation: 1, path: root, privatePath: join(root, ".proofblade") }, runsRoot: root, artifacts: {} });
    const result = await plan.execute!(new AbortController().signal);
    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { format: string; sections: Array<{ name: string; size: number }> };
    assert.equal(output.format, "pe");
    assert.deepEqual(output.sections, [{ index: 0, name: ".text", offset: 0x200, size: 0x40, address: "0x401000", characteristics: ["code", "execute", "read"] }]);
    const symbolOperation = { ...operation, name: "symbols" };
    const symbolPlan = backend.prepareExecution({ capabilityId: "proofblade.binary", operation: "symbols", input: { path: "sample.exe" } }, symbolOperation, { runId: "BINARY-PE", fixture: { fixtureId: "fixture", generation: 1, path: root, privatePath: join(root, ".proofblade") }, runsRoot: root, artifacts: {} });
    const symbolResult = await symbolPlan.execute!(new AbortController().signal);
    assert.equal(symbolResult.exitCode, 0, symbolResult.stderr);
    assert.deepEqual((JSON.parse(symbolResult.stdout) as { symbols: Array<{ name: string; value: string }> }).symbols, [{ index: 0, name: "func", value: "0x123", size: 0, section: 1, storageClass: 2 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Binary Core v1 blocks case variants of its private fixture directory", async () => {
  const backend = new BinaryCapabilityBackend();
  const operation = { name: "strings", description: "strings", parameters: { type: "object", properties: {}, additionalProperties: false }, readOnly: true, sideEffect: "none", replay: "pure" as const, outputPolicy: "summary" as const, executionMode: "sequential" as const };
  assert.throws(() => backend.prepareExecution({ capabilityId: "proofblade.binary", operation: "strings", input: { path: ".PROOFBLADE/secret.bin" } }, operation, {
    runId: "BINARY-PRIVATE", fixture: { fixtureId: "fixture", generation: 1, path: "fixture", privatePath: "fixture/.proofblade" }, runsRoot: "fixture", artifacts: {},
  }), /private fixture/);
});

test("Binary Core v1 rejects directory links that escape the fixture", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-binary-link-root-"));
  const outside = await mkdtemp(join(tmpdir(), "proofblade-binary-link-outside-"));
  try {
    await mkdir(join(root, ".proofblade"));
    await writeFile(join(outside, "secret.bin"), "flag{outside}");
    try {
      await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && ["EPERM", "ENOTSUP"].includes(String(error.code))) {
        context.skip(`directory links are unavailable: ${String(error.code)}`);
        return;
      }
      throw error;
    }

    const backend = new BinaryCapabilityBackend();
    const operation = { name: "strings", description: "strings", parameters: { type: "object", properties: {}, additionalProperties: false }, readOnly: true, sideEffect: "none", replay: "pure" as const, outputPolicy: "summary" as const, executionMode: "sequential" as const };
    const plan = backend.prepareExecution({ capabilityId: "proofblade.binary", operation: "strings", input: { path: "linked/secret.bin" } }, operation, {
      runId: "BINARY-LINK", fixture: { fixtureId: "fixture", generation: 1, path: root, privatePath: join(root, ".proofblade") }, runsRoot: root, artifacts: {},
    });
    const result = await plan.execute!(new AbortController().signal);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /escapes the fixture/);
    assert.doesNotMatch(result.stdout, /flag\{outside\}/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Binary Core v1 rejects hard links to private fixture files", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-binary-hardlink-"));
  try {
    const privateRoot = join(root, ".proofblade");
    await mkdir(privateRoot);
    await writeFile(join(privateRoot, "secret.bin"), "flag{private}");
    await link(join(privateRoot, "secret.bin"), join(root, "visible.bin"));

    const backend = new BinaryCapabilityBackend();
    const operation = { name: "strings", description: "strings", parameters: { type: "object", properties: {}, additionalProperties: false }, readOnly: true, sideEffect: "none", replay: "pure" as const, outputPolicy: "summary" as const, executionMode: "sequential" as const };
    const plan = backend.prepareExecution({ capabilityId: "proofblade.binary", operation: "strings", input: { path: "visible.bin" } }, operation, {
      runId: "BINARY-HARDLINK", fixture: { fixtureId: "fixture", generation: 1, path: root, privatePath: privateRoot }, runsRoot: root, artifacts: {},
    });
    const result = await plan.execute!(new AbortController().signal);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /hard-linked file/);
    assert.doesNotMatch(result.stdout, /flag\{private\}/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function makeElf64(): Buffer {
  const bytes = Buffer.alloc(608);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.writeBigUInt64LE(0x401000n, 24);
  bytes.writeBigUInt64LE(0x100n, 40);
  bytes.writeUInt16LE(64, 58);
  bytes.writeUInt16LE(3, 60);
  bytes.writeUInt16LE(1, 62);
  const names = Buffer.from("\0.shstrtab\0.text\0", "ascii");
  names.copy(bytes, 0x80);
  bytes.writeUInt32LE(1, 0x140);
  bytes.writeUInt32LE(3, 0x144);
  bytes.writeBigUInt64LE(0x80n, 0x158);
  bytes.writeBigUInt64LE(BigInt(names.length), 0x160);
  bytes.writeUInt32LE(11, 0x180);
  bytes.writeUInt32LE(1, 0x184);
  bytes.writeBigUInt64LE(6n, 0x188);
  bytes.writeBigUInt64LE(0x401000n, 0x190);
  bytes.writeBigUInt64LE(0xc0n, 0x198);
  bytes.writeBigUInt64LE(5n, 0x1a0);
  Buffer.from("HELLO", "ascii").copy(bytes, 0xc0);
  return bytes;
}

function makePe32(): Buffer {
  const bytes = Buffer.alloc(0x240);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "ascii");
  bytes.writeUInt16LE(0x14c, 0x84);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(0xe0, 0x94);
  bytes.writeUInt16LE(0x10b, 0x98);
  bytes.writeUInt32LE(0x1000, 0xa8);
  bytes.writeUInt32LE(0x400000, 0xb4);
  bytes.write(".text\0\0\0", 0x178, "ascii");
  bytes.writeUInt32LE(0x40, 0x180);
  bytes.writeUInt32LE(0x1000, 0x184);
  bytes.writeUInt32LE(0x40, 0x188);
  bytes.writeUInt32LE(0x200, 0x18c);
  bytes.writeUInt32LE(0x60000020, 0x19c);
  bytes.writeUInt32LE(0x200, 0x8c);
  bytes.writeUInt32LE(1, 0x90);
  bytes.write("func\0\0\0\0", 0x200, "ascii");
  bytes.writeUInt32LE(0x123, 0x208);
  bytes.writeUInt16LE(1, 0x20c);
  bytes.writeUInt16LE(0x20, 0x20e);
  bytes[0x210] = 2;
  bytes[0x211] = 0;
  bytes.writeUInt32LE(4, 0x212);
  return bytes;
}
