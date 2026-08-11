import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FirmwareCapabilityBackend } from "../src/capabilities/backend.js";
import { listBundledCapabilities } from "../src/capabilities/catalog.js";
import { executeFirmwareCapability, validateFirmwareInput } from "../src/capabilities/firmware.js";

test("Firmware Core v1 scans partitions, filesystems, entropy, and embedded archives", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-firmware-core-"));
  try {
    await writeFile(join(root, "image.bin"), makeFirmwareImage());
    const invoke = async (operation: string, input: Record<string, unknown>) => {
      const result = await executeFirmwareCapability(operation, input as { path: string }, root, new AbortController().signal);
      assert.equal(result.exitCode, 0, result.stderr);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };

    const scan = await invoke("scan", { path: "image.bin" });
    const formats = (scan.findings as Array<Record<string, unknown>>).map((item) => item.format);
    assert.ok(formats.includes("uimage"));
    assert.ok(formats.includes("squashfs"));
    assert.ok(formats.includes("tar"));

    const partitions = await invoke("partitions", { path: "image.bin" });
    assert.deepEqual(partitions.partitions, [{ index: 0, type: "linux", offset: 512, size: 4_096, source: "mbr" }]);

    const filesystems = await invoke("filesystems", { path: "image.bin" });
    const squashfs = (filesystems.filesystems as Array<Record<string, unknown>>).find((item) => item.format === "squashfs");
    assert.deepEqual(squashfs?.metadata, { endian: "little", blockSize: 4_096, version: "4.0", bytesUsed: 4_096 });

    const entropy = await invoke("entropy", { path: "image.bin", blockSize: 256, maxResults: 128 });
    assert.equal(entropy.globalEntropy, 0.5719);
    assert.ok(Number(entropy.maxEntropy) > 7.5);
    assert.ok(Number(entropy.lowEntropyBytes) > 0);

    const tree = await invoke("file_tree", { path: "image.bin" });
    const archive = (tree.archives as Array<Record<string, unknown>>).find((item) => item.format === "tar");
    assert.equal(archive?.offset, 4_096);
    assert.deepEqual(archive?.entries, [{ path: "etc/config.txt", type: "file", size: 16 }]);

    const extracted = await invoke("extract", { path: "image.bin", archiveOffset: 4_096, entryPath: "etc/config.txt" });
    assert.equal(extracted.contentEncoding, "utf8");
    assert.equal(extracted.content, "mode=production\n");
    assert.equal(extracted.truncated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Firmware Core v1 validates read-only archive extraction and exposes every catalog operation", async () => {
  assert.throws(() => validateFirmwareInput("extract", { path: "image.bin", archiveOffset: 0, entryPath: "../scorer.json" }), /relative archive path/);
  assert.throws(() => validateFirmwareInput("extract", { path: "image.bin", archiveOffset: 0, entryPath: "dir\\file" }), /relative archive path/);
  assert.throws(() => validateFirmwareInput("entropy", { path: "image.bin", blockSize: 128 }), /blockSize/);
  assert.throws(() => validateFirmwareInput("scan", { path: ".PROOFBLADE/image.bin" }), /private fixture/);

  const backend = new FirmwareCapabilityBackend();
  for (const operation of ["scan", "partitions", "filesystems", "entropy", "file_tree", "extract"]) assert.equal(backend.handles("proofblade.firmware", operation), true);
  assert.equal(backend.handles("proofblade.firmware", "write"), false);

  const firmware = listBundledCapabilities().find((candidate) => candidate.id === "proofblade.firmware");
  assert.ok(firmware);
  assert.deepEqual(firmware.operations.map((operation) => operation.name), ["entropy", "extract", "file_tree", "filesystems", "partitions", "scan"]);
  assert.ok(firmware.operations.every((operation) => operation.readOnly && operation.replay === "pure" && operation.sideEffect === "none"));
});

test("Firmware Core v1 reads embedded ASCII newc CPIO entries without host extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-firmware-cpio-"));
  try {
    await writeFile(join(root, "rootfs.cpio"), makeCpioArchive("init", "#!/bin/sh\necho ready\n"));
    const signal = new AbortController().signal;
    const treeResult = await executeFirmwareCapability("file_tree", { path: "rootfs.cpio" }, root, signal);
    assert.equal(treeResult.exitCode, 0, treeResult.stderr);
    const tree = JSON.parse(treeResult.stdout) as { archives: Array<{ format: string; offset: number; entries: Array<{ path: string }> }> };
    assert.deepEqual(tree.archives, [{ format: "cpio-newc", offset: 0, size: 264, entryCount: 1, truncated: false, entries: [{ path: "init", type: "file", size: 21 }] }]);

    const extractResult = await executeFirmwareCapability("extract", { path: "rootfs.cpio", archiveOffset: 0, entryPath: "init" }, root, signal);
    assert.equal(extractResult.exitCode, 0, extractResult.stderr);
    const extracted = JSON.parse(extractResult.stdout) as { content: string; contentEncoding: string };
    assert.equal(extracted.contentEncoding, "utf8");
    assert.equal(extracted.content, "#!/bin/sh\necho ready\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Firmware Core v1 keeps GPT LBA arithmetic within safe byte offsets", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-firmware-gpt-"));
  try {
    await writeFile(join(root, "disk.img"), makeGptImage());
    const result = await executeFirmwareCapability("partitions", { path: "disk.img" }, root, new AbortController().signal);
    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { tables: Array<Record<string, unknown>>; partitions: Array<Record<string, unknown>> };
    assert.deepEqual(output.tables, [{ format: "gpt", offset: 512, firstUsableLba: 34, lastUsableLba: 100, partitionCount: 1, entrySize: 128 }]);
    assert.deepEqual(output.partitions, [{ index: 0, type: "gpt", offset: 17_408, size: 3_584, source: "gpt", name: "rootfs" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Firmware Core v1 bounds archive parsing before extracting an entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-firmware-extract-bound-"));
  try {
    const entries = Array.from({ length: 10_001 }, (_, index) => cpioEntry(`f${index}`, "", 0o100644));
    await writeFile(join(root, "large.cpio"), Buffer.concat([...entries, cpioEntry("TRAILER!!!", "", 0)]));
    const result = await executeFirmwareCapability("extract", { path: "large.cpio", archiveOffset: 0, entryPath: "missing" }, root, new AbortController().signal);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /first 10000 entries/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Firmware Core v1 bounds dense archive and TRX discovery before allocating result objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-firmware-discovery-bound-"));
  try {
    await writeFile(join(root, "magic.bin"), Buffer.from("070701".repeat(100_000), "ascii"));
    const treeResult = await executeFirmwareCapability("file_tree", { path: "magic.bin", maxResults: 1 }, root, new AbortController().signal);
    assert.equal(treeResult.exitCode, 0, treeResult.stderr);
    const tree = JSON.parse(treeResult.stdout) as { archives: unknown[]; truncated: boolean };
    assert.deepEqual(tree.archives, []);
    assert.equal(tree.truncated, true);

    const trx = Buffer.alloc(28 * 2_100);
    for (let offset = 0; offset < trx.length; offset += 28) {
      trx.write("HDR0", offset, "ascii");
      trx.writeUInt32LE(28, offset + 4);
      trx.writeUInt32LE(16, offset + 16);
    }
    await writeFile(join(root, "trx.bin"), trx);
    const partitionsResult = await executeFirmwareCapability("partitions", { path: "trx.bin" }, root, new AbortController().signal);
    assert.equal(partitionsResult.exitCode, 0, partitionsResult.stderr);
    const partitions = JSON.parse(partitionsResult.stdout) as { partitions: unknown[]; truncated: boolean };
    assert.ok(partitions.partitions.length <= 2_000);
    assert.equal(partitions.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Firmware Core v1 does not mark an archive truncated at its exact result limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-firmware-exact-limit-"));
  try {
    const tar = Buffer.alloc(2_048);
    makeTar(tar, 0, "one.txt", "x");
    await writeFile(join(root, "one.tar"), tar);
    await writeFile(join(root, "one.cpio"), Buffer.concat([cpioEntry("one", "x", 0o100644), cpioEntry("TRAILER!!!", "", 0)]));

    for (const path of ["one.tar", "one.cpio"]) {
      const result = await executeFirmwareCapability("file_tree", { path, maxResults: 1 }, root, new AbortController().signal);
      assert.equal(result.exitCode, 0, result.stderr);
      const output = JSON.parse(result.stdout) as { archives: Array<{ truncated: boolean }>; truncated: boolean };
      assert.equal(output.truncated, false);
      assert.deepEqual(output.archives.map((archive) => archive.truncated), [false]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function makeFirmwareImage(): Buffer {
  const image = Buffer.alloc(8_192);
  image.writeUInt32LE(0x12345678, 440);
  image[446 + 4] = 0x83;
  image.writeUInt32LE(1, 446 + 8);
  image.writeUInt32LE(8, 446 + 12);
  image[510] = 0x55;
  image[511] = 0xaa;

  image.write("hsqs", 512, "ascii");
  image.writeUInt32LE(17, 516);
  image.writeUInt32LE(4_096, 524);
  image.writeUInt16LE(4, 540);
  image.writeUInt16LE(0, 542);
  image.writeBigUInt64LE(4_096n, 552);

  image.writeUInt32BE(0x27051956, 1_024);
  image.writeUInt32BE(64, 1_036);
  image[1_053] = 2;
  image[1_054] = 5;
  image[1_055] = 1;
  image.write("kernel", 1_056, "ascii");

  makeTar(image, 4_096, "etc/config.txt", "mode=production\n");
  for (let index = 6_144; index < 6_400; index += 1) image[index] = index & 0xff;
  return image;
}

function makeTar(image: Buffer, offset: number, path: string, content: string): void {
  const header = Buffer.alloc(512);
  header.write(path, 0, "ascii");
  header.write("0000644\0", 100, "ascii");
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header[156] = 0x30;
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  header.copy(image, offset);
  image.write(content, offset + 512, "utf8");
}

function makeCpioArchive(path: string, content: string): Buffer {
  return Buffer.concat([
    cpioEntry(path, content, 0o100644),
    cpioEntry("TRAILER!!!", "", 0),
  ]);
}

function cpioEntry(path: string, content: string, mode: number): Buffer {
  const body = Buffer.from(content, "utf8");
  const name = Buffer.from(`${path}\0`, "utf8");
  const fields = [1, mode, 0, 0, 1, 0, body.length, 0, 0, 0, 0, name.length, 0].map((value) => value.toString(16).padStart(8, "0"));
  const header = Buffer.from(`070701${fields.join("")}`, "ascii");
  const padName = Buffer.alloc((4 - ((header.length + name.length) % 4)) % 4);
  const padBody = Buffer.alloc((4 - (body.length % 4)) % 4);
  return Buffer.concat([header, name, padName, body, padBody]);
}

function makeGptImage(): Buffer {
  const image = Buffer.alloc(8_192);
  image.write("EFI PART", 512, "ascii");
  image.writeUInt32LE(92, 524);
  image.writeBigUInt64LE(34n, 552);
  image.writeBigUInt64LE(100n, 560);
  image.writeBigUInt64LE(2n, 584);
  image.writeUInt32LE(1, 592);
  image.writeUInt32LE(128, 596);
  image[1_024] = 1;
  image.writeBigUInt64LE(34n, 1_056);
  image.writeBigUInt64LE(40n, 1_064);
  image.write("rootfs", 1_080, "utf16le");
  return image;
}
