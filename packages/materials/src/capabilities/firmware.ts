import { createHash } from "node:crypto";
import type { RawEffectResult } from "../domain/types.js";
import { readVisibleBinaryFile, validateBinaryInput } from "./binary.js";

const DEFAULT_SCAN_RESULTS = 200;
const DEFAULT_TREE_RESULTS = 500;
const DEFAULT_ENTROPY_RESULTS = 128;
const DEFAULT_EXTRACT_BYTES = 12_000;
const MAX_SCAN_RESULTS = 2_000;
const MAX_TREE_RESULTS = 4_000;
const MAX_ENTROPY_RESULTS = 4_096;
const MAX_EXTRACT_BYTES = 65_536;
const MAX_EXTRACT_ENTRIES = 10_000;
const MAX_PARTITION_RESULTS = 2_000;
const MAX_TRX_CONTAINERS = Math.ceil(MAX_PARTITION_RESULTS / 3);
const MAX_ARCHIVE_CANDIDATES = MAX_TREE_RESULTS;
const DEFAULT_ENTROPY_BLOCK_SIZE = 4_096;
const MAX_ENTROPY_BLOCK_SIZE = 1_048_576;
const TAR_BLOCK_SIZE = 512;

export type FirmwareOperation = "scan" | "partitions" | "filesystems" | "entropy" | "file_tree" | "extract";

export interface FirmwareCapabilityInput extends Record<string, unknown> {
  path: string;
  maxResults?: number;
  blockSize?: number;
  archiveOffset?: number;
  entryPath?: string;
  maxBytes?: number;
}

interface FirmwareFinding {
  kind: "container" | "compression" | "filesystem" | "archive" | "executable";
  format: string;
  offset: number;
  size?: number;
  description: string;
  metadata?: Record<string, unknown>;
}

interface FirmwarePartition {
  index: number;
  type: string;
  offset: number;
  size: number;
  source: "mbr" | "gpt" | "trx";
  name?: string;
}

interface ArchiveEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "hardlink" | "char" | "block" | "fifo" | "other";
  size: number;
  dataOffset: number;
}

interface ParsedArchive {
  format: "tar" | "cpio-newc";
  offset: number;
  size: number;
  entries: ArchiveEntry[];
  truncated: boolean;
}

interface SignatureDefinition {
  bytes: Buffer;
  find: (bytes: Buffer, offset: number) => FirmwareFinding | undefined;
}

/**
 * A deliberately read-only firmware primitive. It identifies bounded, stable
 * structures and exposes archive entries through Effect Artifacts; it never
 * expands an image onto the host filesystem.
 */
export async function executeFirmwareCapability(operation: string, input: FirmwareCapabilityInput, fixtureRoot: string, signal: AbortSignal): Promise<RawEffectResult> {
  const started = Date.now();
  try {
    validateFirmwareInput(operation, input);
    throwIfAborted(signal);
    const bytes = await readVisibleBinaryFile(fixtureRoot, input.path);
    throwIfAborted(signal);
    const value = firmwareOperation(operation);
    const output = value === "scan" ? scanFirmware(bytes, input.maxResults ?? DEFAULT_SCAN_RESULTS, signal)
      : value === "partitions" ? inspectPartitions(bytes, signal)
        : value === "filesystems" ? inspectFilesystems(bytes, input.maxResults ?? DEFAULT_SCAN_RESULTS, signal)
          : value === "entropy" ? inspectEntropy(bytes, input.blockSize ?? DEFAULT_ENTROPY_BLOCK_SIZE, input.maxResults ?? DEFAULT_ENTROPY_RESULTS, signal)
            : value === "file_tree" ? inspectFileTree(bytes, input.maxResults ?? DEFAULT_TREE_RESULTS, signal)
              : extractArchiveEntry(bytes, input.archiveOffset!, input.entryPath!, input.maxBytes ?? DEFAULT_EXTRACT_BYTES, signal);
    throwIfAborted(signal);
    return { stdout: JSON.stringify(output, null, 2), stderr: "", exitCode: 0, durationMs: Date.now() - started };
  } catch (error) {
    return { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: signal.aborted ? null : 1, durationMs: Date.now() - started };
  }
}

export function firmwareOperation(operation: string): FirmwareOperation {
  if (operation === "scan" || operation === "partitions" || operation === "filesystems" || operation === "entropy" || operation === "file_tree" || operation === "extract") return operation;
  throw new Error(`Unsupported firmware operation: ${operation}`);
}

export function validateFirmwareInput(operation: string, input: Record<string, unknown>): asserts input is FirmwareCapabilityInput {
  const normalized = firmwareOperation(operation);
  validateBinaryInput("identify", input);
  if (normalized === "scan" || normalized === "filesystems") assertInteger(input.maxResults, "maxResults", 1, MAX_SCAN_RESULTS);
  if (normalized === "file_tree") assertInteger(input.maxResults, "maxResults", 1, MAX_TREE_RESULTS);
  if (normalized === "entropy") {
    assertInteger(input.blockSize, "blockSize", 256, MAX_ENTROPY_BLOCK_SIZE);
    assertInteger(input.maxResults, "maxResults", 1, MAX_ENTROPY_RESULTS);
  }
  if (normalized === "extract") {
    assertInteger(input.archiveOffset, "archiveOffset", 0, Number.MAX_SAFE_INTEGER, true);
    if (typeof input.entryPath !== "string" || !isSafeArchiveEntryPath(input.entryPath)) throw new Error("Firmware extract entryPath must be a non-empty relative archive path");
    assertInteger(input.maxBytes, "maxBytes", 1, MAX_EXTRACT_BYTES);
  }
}

function scanFirmware(bytes: Buffer, maxResults: number, signal: AbortSignal): Record<string, unknown> {
  const findings = collectSignatures(bytes, maxResults, signal);
  return {
    format: "proofblade-firmware-scan-v1",
    size: bytes.length,
    findings: findings.items,
    truncated: findings.truncated,
  };
}

function inspectPartitions(bytes: Buffer, signal: AbortSignal): Record<string, unknown> {
  throwIfAborted(signal);
  const partitions: FirmwarePartition[] = [];
  const tables: Array<Record<string, unknown>> = [];
  const mbr = parseMbr(bytes);
  if (mbr) {
    tables.push({ format: "mbr", offset: 0, diskSignature: mbr.diskSignature, partitionCount: mbr.partitions.length });
    partitions.push(...mbr.partitions);
  }
  const gpt = parseGpt(bytes, MAX_PARTITION_RESULTS, signal);
  if (gpt) {
    tables.push({ format: "gpt", offset: gpt.offset, firstUsableLba: gpt.firstUsableLba, lastUsableLba: gpt.lastUsableLba, partitionCount: gpt.partitions.length, entrySize: gpt.entrySize });
    partitions.push(...gpt.partitions);
  }
  const trx = findTrxContainers(bytes, signal);
  for (const finding of trx.items) {
    if (finding.format !== "trx") continue;
    const offsets = finding.metadata?.partitionOffsets;
    if (!Array.isArray(offsets)) continue;
    for (let index = 0; index < offsets.length; index += 1) {
      const current = offsets[index];
      const next = offsets[index + 1] ?? finding.size;
      if (typeof current !== "number" || typeof next !== "number" || next <= current) continue;
      partitions.push({ index, type: "trx-segment", offset: finding.offset + current, size: next - current, source: "trx" });
    }
  }
  partitions.sort((left, right) => left.offset - right.offset || left.source.localeCompare(right.source) || left.index - right.index);
  const truncated = Boolean(gpt?.truncated) || trx.truncated || partitions.length > MAX_PARTITION_RESULTS;
  return { format: "proofblade-firmware-partitions-v1", size: bytes.length, tables, partitions: partitions.slice(0, MAX_PARTITION_RESULTS), truncated };
}

function findTrxContainers(bytes: Buffer, signal: AbortSignal): { items: FirmwareFinding[]; truncated: boolean } {
  const magic = Buffer.from("HDR0");
  const findings: FirmwareFinding[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    throwIfAborted(signal);
    const offset = bytes.indexOf(magic, cursor);
    if (offset < 0) break;
    cursor = offset + 1;
    const finding = trxFinding(bytes, offset);
    if (!finding) continue;
    if (findings.length >= MAX_TRX_CONTAINERS) return { items: findings, truncated: true };
    findings.push(finding);
  }
  return { items: findings, truncated: false };
}

function inspectFilesystems(bytes: Buffer, maxResults: number, signal: AbortSignal): Record<string, unknown> {
  const findings = collectFilesystemSignatures(bytes, maxResults, signal);
  return { format: "proofblade-firmware-filesystems-v1", size: bytes.length, filesystems: findings.items, truncated: findings.truncated };
}

function inspectEntropy(bytes: Buffer, blockSize: number, maxResults: number, signal: AbortSignal): Record<string, unknown> {
  const blockCount = Math.ceil(bytes.length / blockSize);
  const sampleStride = Math.max(1, Math.ceil(blockCount / maxResults));
  const globalCounts = new Uint32Array(256);
  const blockCounts = new Uint32Array(256);
  const samples: Array<Record<string, unknown>> = [];
  let minEntropy = Number.POSITIVE_INFINITY;
  let maxEntropy = Number.NEGATIVE_INFINITY;
  let lowEntropyBytes = 0;
  let highEntropyBytes = 0;
  for (let offset = 0, block = 0; offset < bytes.length; offset += blockSize, block += 1) {
    throwIfAborted(signal);
    const end = Math.min(bytes.length, offset + blockSize);
    blockCounts.fill(0);
    for (let cursor = offset; cursor < end; cursor += 1) {
      const value = bytes[cursor]!;
      globalCounts[value] += 1;
      blockCounts[value] += 1;
    }
    const entropy = shannonEntropy(blockCounts, end - offset);
    minEntropy = Math.min(minEntropy, entropy);
    maxEntropy = Math.max(maxEntropy, entropy);
    if (entropy <= 1) lowEntropyBytes += end - offset;
    if (entropy >= 7.5) highEntropyBytes += end - offset;
    if (block % sampleStride === 0 && samples.length < maxResults) samples.push({ offset, size: end - offset, entropy: rounded(entropy) });
  }
  return {
    format: "proofblade-firmware-entropy-v1",
    size: bytes.length,
    blockSize,
    blockCount,
    globalEntropy: rounded(shannonEntropy(globalCounts, bytes.length)),
    minEntropy: rounded(Number.isFinite(minEntropy) ? minEntropy : 0),
    maxEntropy: rounded(Number.isFinite(maxEntropy) ? maxEntropy : 0),
    lowEntropyBytes,
    highEntropyBytes,
    samples,
    sampled: samples.length < blockCount,
  };
}

function inspectFileTree(bytes: Buffer, maxResults: number, signal: AbortSignal): Record<string, unknown> {
  const archives = discoverArchives(bytes, maxResults, signal);
  return {
    format: "proofblade-firmware-file-tree-v1",
    size: bytes.length,
    archives: archives.items.map((archive) => ({
      format: archive.format,
      offset: archive.offset,
      size: archive.size,
      entryCount: archive.entries.length,
      truncated: archive.truncated,
      entries: archive.entries.map(({ dataOffset: _dataOffset, ...entry }) => entry),
    })),
    truncated: archives.truncated,
  };
}

function extractArchiveEntry(bytes: Buffer, archiveOffset: number, entryPath: string, maxBytes: number, signal: AbortSignal): Record<string, unknown> {
  throwIfAborted(signal);
  const archive = parseArchiveAt(bytes, archiveOffset, MAX_EXTRACT_ENTRIES, signal);
  if (!archive) throw new Error(`No supported TAR or CPIO archive starts at offset ${archiveOffset}`);
  const entry = archive.entries.find((candidate) => candidate.path === entryPath);
  if (!entry) throw new Error(archive.truncated ? `Archive entry was not found in the first ${MAX_EXTRACT_ENTRIES} entries: ${entryPath}` : `Archive entry not found: ${entryPath}`);
  if (entry.type !== "file") throw new Error(`Archive entry is not a regular file: ${entryPath}`);
  const content = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.size);
  const visible = content.subarray(0, Math.min(content.length, maxBytes));
  const encoding = isReadableUtf8(visible) ? "utf8" : "base64";
  return {
    format: "proofblade-firmware-extract-v1",
    archive: { format: archive.format, offset: archive.offset },
    entry: { path: entry.path, size: entry.size, sha256: createHash("sha256").update(content).digest("hex") },
    contentEncoding: encoding,
    content: encoding === "utf8" ? visible.toString("utf8") : visible.toString("base64"),
    truncated: visible.length !== content.length,
  };
}

function collectSignatures(bytes: Buffer, maxResults: number, signal: AbortSignal): { items: FirmwareFinding[]; truncated: boolean } {
  return collectMatching(bytes, signatureDefinitions, maxResults, signal);
}

function collectFilesystemSignatures(bytes: Buffer, maxResults: number, signal: AbortSignal): { items: FirmwareFinding[]; truncated: boolean } {
  return collectMatching(bytes, filesystemDefinitions, maxResults, signal);
}

function collectMatching(bytes: Buffer, definitions: readonly SignatureDefinition[], maxResults: number, signal: AbortSignal): { items: FirmwareFinding[]; truncated: boolean } {
  const byFirstByte = new Map<number, SignatureDefinition[]>();
  for (const definition of definitions) {
    const first = definition.bytes[0]!;
    const current = byFirstByte.get(first) ?? [];
    current.push(definition);
    byFirstByte.set(first, current);
  }
  const items: FirmwareFinding[] = [];
  for (let offset = 0; offset < bytes.length; offset += 1) {
    if ((offset & 0x3fff) === 0) throwIfAborted(signal);
    const candidates = byFirstByte.get(bytes[offset]!);
    if (!candidates) continue;
    for (const definition of candidates) {
      if (!matchesAt(bytes, definition.bytes, offset)) continue;
      const finding = definition.find(bytes, offset);
      if (!finding) continue;
      if (items.length >= maxResults) return { items: items.sort(compareFinding), truncated: true };
      items.push(finding);
    }
  }
  return { items: items.sort(compareFinding), truncated: false };
}

const signatureDefinitions: readonly SignatureDefinition[] = [
  { bytes: Buffer.from("\x7fELF"), find: (_bytes, offset) => ({ kind: "executable", format: "elf", offset, description: "Embedded ELF executable" }) },
  { bytes: Buffer.from("MZ"), find: (_bytes, offset) => ({ kind: "executable", format: "pe", offset, description: "Embedded DOS/PE executable candidate" }) },
  { bytes: Buffer.from("HDR0"), find: (bytes, offset) => trxFinding(bytes, offset) },
  { bytes: Buffer.from([0x27, 0x05, 0x19, 0x56]), find: (bytes, offset) => uImageFinding(bytes, offset) },
  { bytes: Buffer.from([0xd0, 0x0d, 0xfe, 0xed]), find: (bytes, offset) => fdtFinding(bytes, offset) },
  { bytes: Buffer.from("ANDROID!"), find: (_bytes, offset) => ({ kind: "container", format: "android-boot", offset, description: "Android boot image" }) },
  { bytes: Buffer.from("hsqs"), find: (bytes, offset) => squashfsFinding(bytes, offset, "little") },
  { bytes: Buffer.from("qshs"), find: (bytes, offset) => squashfsFinding(bytes, offset, "big") },
  { bytes: Buffer.from([0x45, 0x3d, 0xcd, 0x28]), find: (bytes, offset) => cramfsFinding(bytes, offset, "little") },
  { bytes: Buffer.from([0x28, 0xcd, 0x3d, 0x45]), find: (bytes, offset) => cramfsFinding(bytes, offset, "big") },
  { bytes: Buffer.from("UBI#"), find: (_bytes, offset) => ({ kind: "filesystem", format: "ubi", offset, description: "UBI erase block header" }) },
  { bytes: Buffer.from([0x31, 0x18, 0x10, 0x06]), find: (_bytes, offset) => ({ kind: "filesystem", format: "ubifs", offset, description: "UBIFS node header" }) },
  { bytes: Buffer.from([0x1f, 0x8b, 0x08]), find: (_bytes, offset) => ({ kind: "compression", format: "gzip", offset, description: "Gzip-compressed payload" }) },
  { bytes: Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), find: (_bytes, offset) => ({ kind: "compression", format: "xz", offset, description: "XZ-compressed payload" }) },
  { bytes: Buffer.from("BZh"), find: (_bytes, offset) => ({ kind: "compression", format: "bzip2", offset, description: "Bzip2-compressed payload" }) },
  { bytes: Buffer.from([0x04, 0x22, 0x4d, 0x18]), find: (_bytes, offset) => ({ kind: "compression", format: "lz4", offset, description: "LZ4 frame" }) },
  { bytes: Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), find: (_bytes, offset) => ({ kind: "compression", format: "zstd", offset, description: "Zstandard frame" }) },
  { bytes: Buffer.from("PK\x03\x04"), find: (_bytes, offset) => ({ kind: "archive", format: "zip", offset, description: "ZIP archive" }) },
  { bytes: Buffer.from("070701"), find: (bytes, offset) => cpioFinding(bytes, offset) },
  { bytes: Buffer.from("070702"), find: (bytes, offset) => cpioFinding(bytes, offset) },
  { bytes: Buffer.from("ustar"), find: (bytes, offset) => tarFinding(bytes, offset) },
];

const filesystemDefinitions: readonly SignatureDefinition[] = [
  { bytes: Buffer.from("hsqs"), find: (bytes, offset) => squashfsFinding(bytes, offset, "little") },
  { bytes: Buffer.from("qshs"), find: (bytes, offset) => squashfsFinding(bytes, offset, "big") },
  { bytes: Buffer.from([0x45, 0x3d, 0xcd, 0x28]), find: (bytes, offset) => cramfsFinding(bytes, offset, "little") },
  { bytes: Buffer.from([0x28, 0xcd, 0x3d, 0x45]), find: (bytes, offset) => cramfsFinding(bytes, offset, "big") },
  { bytes: Buffer.from("UBI#"), find: (_bytes, offset) => ({ kind: "filesystem", format: "ubi", offset, description: "UBI erase block header" }) },
  { bytes: Buffer.from([0x31, 0x18, 0x10, 0x06]), find: (_bytes, offset) => ({ kind: "filesystem", format: "ubifs", offset, description: "UBIFS node header" }) },
  { bytes: Buffer.from([0x53, 0xef]), find: (bytes, magicOffset) => extFinding(bytes, magicOffset) },
];

function trxFinding(bytes: Buffer, offset: number): FirmwareFinding | undefined {
  if (offset + 28 > bytes.length) return undefined;
  const size = readUInt32(bytes, offset + 4, "le");
  if (size < 28 || offset + size > bytes.length) return undefined;
  const partitionOffsets = [readUInt32(bytes, offset + 16, "le"), readUInt32(bytes, offset + 20, "le"), readUInt32(bytes, offset + 24, "le")].filter((value) => value > 0 && value < size).sort((left, right) => left - right);
  return { kind: "container", format: "trx", offset, size, description: "Broadcom TRX firmware container", metadata: { partitionOffsets } };
}

function uImageFinding(bytes: Buffer, offset: number): FirmwareFinding | undefined {
  if (offset + 64 > bytes.length) return undefined;
  const payloadSize = readUInt32(bytes, offset + 12, "be");
  const name = readAscii(bytes, offset + 32, offset + 64);
  return {
    kind: "container",
    format: "uimage",
    offset,
    size: payloadSize + 64 <= bytes.length - offset ? payloadSize + 64 : undefined,
    description: "U-Boot legacy image",
    metadata: { payloadSize, architecture: uImageArchitecture(bytes[offset + 29] ?? 0), imageType: bytes[offset + 30] ?? 0, compression: uImageCompression(bytes[offset + 31] ?? 0), name },
  };
}

function fdtFinding(bytes: Buffer, offset: number): FirmwareFinding | undefined {
  if (offset + 8 > bytes.length) return undefined;
  const size = readUInt32(bytes, offset + 4, "be");
  if (size < 40 || offset + size > bytes.length) return undefined;
  return { kind: "container", format: "flattened-device-tree", offset, size, description: "Flattened Device Tree blob", metadata: { totalSize: size } };
}

function squashfsFinding(bytes: Buffer, offset: number, endian: "little" | "big"): FirmwareFinding | undefined {
  if (offset + 48 > bytes.length) return undefined;
  const byteOrder = endian === "little" ? "le" : "be";
  const bytesUsed = Number(readUInt64(bytes, offset + 40, byteOrder));
  const blockSize = readUInt32(bytes, offset + 12, byteOrder);
  const major = readUInt16(bytes, offset + 28, byteOrder);
  const minor = readUInt16(bytes, offset + 30, byteOrder);
  if (blockSize < 512 || blockSize > MAX_ENTROPY_BLOCK_SIZE || major < 1 || major > 10) return undefined;
  return { kind: "filesystem", format: "squashfs", offset, size: bytesUsed > 0 && offset + bytesUsed <= bytes.length ? bytesUsed : undefined, description: "SquashFS filesystem", metadata: { endian, blockSize, version: `${major}.${minor}`, bytesUsed } };
}

function cramfsFinding(bytes: Buffer, offset: number, endian: "little" | "big"): FirmwareFinding | undefined {
  if (offset + 16 > bytes.length) return undefined;
  const size = readUInt32(bytes, offset + 4, endian === "little" ? "le" : "be");
  if (size < 16) return undefined;
  return { kind: "filesystem", format: "cramfs", offset, size: offset + size <= bytes.length ? size : undefined, description: "CramFS filesystem", metadata: { endian, declaredSize: size } };
}

function cpioFinding(bytes: Buffer, offset: number): FirmwareFinding | undefined {
  const archive = parseCpioArchive(bytes, offset, 1, new AbortController().signal);
  if (!archive || archive.entries.length === 0) return undefined;
  return { kind: "archive", format: "cpio-newc", offset, size: archive.size, description: "ASCII newc CPIO archive" };
}

function tarFinding(bytes: Buffer, magicOffset: number): FirmwareFinding | undefined {
  const offset = magicOffset - 257;
  if (offset < 0) return undefined;
  const archive = parseTarArchive(bytes, offset, 1, new AbortController().signal);
  if (!archive) return undefined;
  return { kind: "archive", format: "tar", offset, size: archive.size, description: "USTAR archive" };
}

function parseMbr(bytes: Buffer): { diskSignature: string; partitions: FirmwarePartition[] } | undefined {
  if (bytes.length < 512 || bytes[510] !== 0x55 || bytes[511] !== 0xaa) return undefined;
  const partitions: FirmwarePartition[] = [];
  for (let index = 0; index < 4; index += 1) {
    const base = 446 + index * 16;
    const typeCode = bytes[base + 4] ?? 0;
    const startLba = readUInt32(bytes, base + 8, "le");
    const sectors = readUInt32(bytes, base + 12, "le");
    if (typeCode === 0 || sectors === 0) continue;
    partitions.push({ index, type: mbrPartitionType(typeCode), offset: startLba * 512, size: sectors * 512, source: "mbr" });
  }
  return { diskSignature: `0x${readUInt32(bytes, 440, "le").toString(16).padStart(8, "0")}`, partitions };
}

function parseGpt(bytes: Buffer, maxPartitions: number, signal: AbortSignal): { offset: number; firstUsableLba: number; lastUsableLba: number; entrySize: number; partitions: FirmwarePartition[]; truncated: boolean } | undefined {
  const offset = bytes.indexOf(Buffer.from("EFI PART"));
  if (offset < 0 || offset + 92 > bytes.length) return undefined;
  const headerSize = readUInt32(bytes, offset + 12, "le");
  const entryLba = safeLba(readUInt64(bytes, offset + 72, "le"));
  const firstUsableLba = safeLba(readUInt64(bytes, offset + 40, "le"));
  const lastUsableLba = safeLba(readUInt64(bytes, offset + 48, "le"));
  const entryCount = readUInt32(bytes, offset + 80, "le");
  const entrySize = readUInt32(bytes, offset + 84, "le");
  if (headerSize < 92 || headerSize > 4096 || entrySize < 128 || entrySize > 1024 || entryCount > 16_384 || entryLba === undefined || firstUsableLba === undefined || lastUsableLba === undefined) return undefined;
  const entriesOffset = entryLba * 512;
  if (entriesOffset < 0 || entriesOffset >= bytes.length) return undefined;
  const partitions: FirmwarePartition[] = [];
  for (let index = 0; index < entryCount && entriesOffset + (index + 1) * entrySize <= bytes.length; index += 1) {
    if ((index & 0x3ff) === 0) throwIfAborted(signal);
    const base = entriesOffset + index * entrySize;
    if (isZero(bytes, base, base + 16)) continue;
    const firstLba = safeLba(readUInt64(bytes, base + 32, "le"));
    const lastLba = safeLba(readUInt64(bytes, base + 40, "le"));
    if (firstLba === undefined || lastLba === undefined || lastLba < firstLba) continue;
    if (partitions.length >= maxPartitions) return { offset, firstUsableLba, lastUsableLba, entrySize, partitions, truncated: true };
    const name = readUtf16Le(bytes, base + 56, base + entrySize);
    partitions.push({ index, type: "gpt", offset: firstLba * 512, size: (lastLba - firstLba + 1) * 512, source: "gpt", ...(name ? { name } : {}) });
  }
  return { offset, firstUsableLba, lastUsableLba, entrySize, partitions, truncated: false };
}

function extFinding(bytes: Buffer, magicOffset: number): FirmwareFinding | undefined {
  const offset = magicOffset - 0x438;
  if (offset < 0 || offset + 0x440 > bytes.length) return undefined;
  const inodes = readUInt32(bytes, offset + 0, "le");
  const blocks = readUInt32(bytes, offset + 4, "le");
  const logBlockSize = readUInt32(bytes, offset + 24, "le");
  if (inodes === 0 || blocks === 0 || logBlockSize > 6) return undefined;
  return { kind: "filesystem", format: "ext", offset, description: "ext-family filesystem", metadata: { inodes, blocks, blockSize: 1024 << logBlockSize } };
}

function discoverArchives(bytes: Buffer, maxEntries: number, signal: AbortSignal): { items: ParsedArchive[]; truncated: boolean } {
  const starts: Array<{ format: "tar" | "cpio-newc"; offset: number }> = [];
  // A magic match is cheap but not necessarily a valid archive. Keep a
  // bounded false-positive budget so early decoys do not hide a later image.
  const maxCandidates = Math.min(MAX_ARCHIVE_CANDIDATES, maxEntries * 8);
  const tarMagic = Buffer.from("ustar");
  const cpioNewc = Buffer.from("070701");
  const cpioCrc = Buffer.from("070702");
  for (let cursor = 0; cursor < bytes.length; cursor += 1) {
    if ((cursor & 0x3fff) === 0) throwIfAborted(signal);
    if (cursor >= 257 && matchesAt(bytes, tarMagic, cursor)) {
      if (starts.length >= maxCandidates) return parseArchiveCandidates(bytes, starts, maxEntries, signal, true);
      starts.push({ format: "tar", offset: cursor - 257 });
    }
    if (matchesAt(bytes, cpioNewc, cursor) || matchesAt(bytes, cpioCrc, cursor)) {
      if (starts.length >= maxCandidates) return parseArchiveCandidates(bytes, starts, maxEntries, signal, true);
      starts.push({ format: "cpio-newc", offset: cursor });
    }
  }
  return parseArchiveCandidates(bytes, starts, maxEntries, signal, false);
}

function parseArchiveCandidates(bytes: Buffer, starts: Array<{ format: "tar" | "cpio-newc"; offset: number }>, maxEntries: number, signal: AbortSignal, candidateTruncated: boolean): { items: ParsedArchive[]; truncated: boolean } {
  const archives: ParsedArchive[] = [];
  let remaining = maxEntries;
  const candidates = starts.sort((left, right) => left.offset - right.offset || left.format.localeCompare(right.format));
  for (let index = 0; index < candidates.length; index += 1) {
    if (remaining <= 0) return { items: archives, truncated: true };
    const candidate = candidates[index]!;
    const archive = candidate.format === "tar" ? parseTarArchive(bytes, candidate.offset, remaining, signal) : parseCpioArchive(bytes, candidate.offset, remaining, signal);
    if (!archive || archive.entries.length === 0) continue;
    archives.push(archive);
    remaining -= archive.entries.length;
    if (archive.truncated) return { items: archives, truncated: true };
  }
  return { items: archives, truncated: candidateTruncated };
}

function parseArchiveAt(bytes: Buffer, offset: number, maxEntries: number, signal: AbortSignal): ParsedArchive | undefined {
  if (offset < 0 || offset >= bytes.length) return undefined;
  return bytes.toString("ascii", offset + 257, Math.min(bytes.length, offset + 262)) === "ustar"
    ? parseTarArchive(bytes, offset, maxEntries, signal)
    : (bytes.toString("ascii", offset, Math.min(bytes.length, offset + 6)) === "070701" || bytes.toString("ascii", offset, Math.min(bytes.length, offset + 6)) === "070702")
      ? parseCpioArchive(bytes, offset, maxEntries, signal)
      : undefined;
}

function parseTarArchive(bytes: Buffer, offset: number, maxEntries: number, signal: AbortSignal): ParsedArchive | undefined {
  if (offset < 0 || offset + TAR_BLOCK_SIZE > bytes.length || bytes.toString("ascii", offset + 257, offset + 262) !== "ustar") return undefined;
  const entries: ArchiveEntry[] = [];
  let cursor = offset;
  let terminated = false;
  while (cursor + TAR_BLOCK_SIZE <= bytes.length) {
    throwIfAborted(signal);
    if (isZero(bytes, cursor, cursor + TAR_BLOCK_SIZE)) {
      terminated = true;
      cursor += TAR_BLOCK_SIZE;
      break;
    }
    const name = readAscii(bytes, cursor, cursor + 100);
    const prefix = readAscii(bytes, cursor + 345, cursor + 500);
    const size = readTarNumber(bytes, cursor + 124, cursor + 136);
    if (!name || size === undefined || size < 0 || cursor + TAR_BLOCK_SIZE + size > bytes.length) return undefined;
    const fullPath = prefix ? `${prefix}/${name}` : name;
    entries.push({ path: fullPath, type: tarEntryType(bytes[cursor + 156] ?? 0), size, dataOffset: cursor + TAR_BLOCK_SIZE });
    cursor = align(cursor + TAR_BLOCK_SIZE + size, TAR_BLOCK_SIZE);
    if (entries.length >= maxEntries) return { format: "tar", offset, size: cursor - offset, entries, truncated: true };
  }
  if (!terminated && entries.length === 0) return undefined;
  return { format: "tar", offset, size: Math.min(bytes.length - offset, cursor - offset), entries, truncated: !terminated };
}

function parseCpioArchive(bytes: Buffer, offset: number, maxEntries: number, signal: AbortSignal): ParsedArchive | undefined {
  if (offset < 0 || offset + 110 > bytes.length) return undefined;
  const magic = bytes.toString("ascii", offset, offset + 6);
  if (magic !== "070701" && magic !== "070702") return undefined;
  const entries: ArchiveEntry[] = [];
  let cursor = offset;
  let terminated = false;
  while (cursor + 110 <= bytes.length) {
    throwIfAborted(signal);
    const currentMagic = bytes.toString("ascii", cursor, cursor + 6);
    if (currentMagic !== "070701" && currentMagic !== "070702") return undefined;
    const mode = readAsciiHex(bytes, cursor + 14, cursor + 22);
    const size = readAsciiHex(bytes, cursor + 54, cursor + 62);
    const nameSize = readAsciiHex(bytes, cursor + 94, cursor + 102);
    if (mode === undefined || size === undefined || nameSize === undefined || nameSize < 2) return undefined;
    const nameStart = cursor + 110;
    const nameEnd = nameStart + nameSize;
    if (nameEnd > bytes.length || bytes[nameEnd - 1] !== 0) return undefined;
    const path = bytes.toString("utf8", nameStart, nameEnd - 1);
    const dataOffset = align(nameEnd, 4);
    const next = align(dataOffset + size, 4);
    if (dataOffset > bytes.length || next > bytes.length) return undefined;
    if (path === "TRAILER!!!") {
      terminated = true;
      cursor = next;
      break;
    }
    entries.push({ path, type: cpioEntryType(mode), size, dataOffset });
    cursor = next;
    if (entries.length >= maxEntries) return { format: "cpio-newc", offset, size: cursor - offset, entries, truncated: true };
  }
  if (!terminated && entries.length === 0) return undefined;
  return { format: "cpio-newc", offset, size: Math.min(bytes.length - offset, cursor - offset), entries, truncated: !terminated };
}

function matchesAt(bytes: Buffer, pattern: Buffer, offset: number): boolean {
  if (offset + pattern.length > bytes.length) return false;
  for (let index = 0; index < pattern.length; index += 1) if (bytes[offset + index] !== pattern[index]) return false;
  return true;
}

function readUInt16(bytes: Buffer, offset: number, endian: "le" | "be"): number {
  if (offset < 0 || offset + 2 > bytes.length) return 0;
  return endian === "le" ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
}

function readUInt32(bytes: Buffer, offset: number, endian: "le" | "be"): number {
  if (offset < 0 || offset + 4 > bytes.length) return 0;
  return endian === "le" ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
}

function readUInt64(bytes: Buffer, offset: number, endian: "le" | "be"): bigint {
  if (offset < 0 || offset + 8 > bytes.length) return 0n;
  return endian === "le" ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset);
}

function safeLba(value: bigint): number | undefined {
  const maxLba = BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 512));
  return value <= maxLba ? Number(value) : undefined;
}

function readAscii(bytes: Buffer, start: number, end: number): string {
  const boundedEnd = Math.min(bytes.length, end);
  const zero = bytes.indexOf(0, start);
  return bytes.toString("ascii", start, zero >= start && zero < boundedEnd ? zero : boundedEnd).trim();
}

function readUtf16Le(bytes: Buffer, start: number, end: number): string {
  let cursor = start;
  while (cursor + 1 < end && cursor + 1 < bytes.length && (bytes[cursor] !== 0 || bytes[cursor + 1] !== 0)) cursor += 2;
  return bytes.toString("utf16le", start, cursor).trim();
}

function readTarNumber(bytes: Buffer, start: number, end: number): number | undefined {
  const raw = readAscii(bytes, start, end).replace(/\0/g, "");
  if (!raw || !/^[0-7]+$/.test(raw)) return 0;
  const value = Number.parseInt(raw, 8);
  return Number.isSafeInteger(value) ? value : undefined;
}

function readAsciiHex(bytes: Buffer, start: number, end: number): number | undefined {
  const raw = bytes.toString("ascii", start, end);
  if (!/^[0-9a-fA-F]{8}$/.test(raw)) return undefined;
  const value = Number.parseInt(raw, 16);
  return Number.isSafeInteger(value) ? value : undefined;
}

function shannonEntropy(counts: Uint32Array, total: number): number {
  if (total === 0) return 0;
  let entropy = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const probability = count / total;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

function isReadableUtf8(bytes: Buffer): boolean {
  if (bytes.length === 0) return true;
  const text = bytes.toString("utf8");
  if (text.includes("\ufffd")) return false;
  let printable = 0;
  for (const character of text) if (character === "\n" || character === "\r" || character === "\t" || character >= " ") printable += 1;
  return printable / Math.max(1, [...text].length) >= 0.85;
}

function isSafeArchiveEntryPath(path: string): boolean {
  return path.length > 0 && path.length <= 1_024 && !path.includes("\\") && !path.startsWith("/") && path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function assertInteger(value: unknown, name: string, min: number, max: number, required = false): void {
  if (value === undefined && !required) return;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Firmware ${name} must be an integer between ${min} and ${max}`);
}

function align(value: number, boundary: number): number {
  return Math.ceil(value / boundary) * boundary;
}

function isZero(bytes: Buffer, start: number, end: number): boolean {
  for (let cursor = start; cursor < end; cursor += 1) if (bytes[cursor] !== 0) return false;
  return true;
}

function compareFinding(left: FirmwareFinding, right: FirmwareFinding): number {
  return left.offset - right.offset || left.format.localeCompare(right.format) || left.description.localeCompare(right.description);
}

function tarEntryType(value: number): ArchiveEntry["type"] {
  return value === 0 || value === 0x30 ? "file" : value === 0x35 ? "directory" : value === 0x32 ? "symlink" : value === 0x31 ? "hardlink" : value === 0x33 ? "char" : value === 0x34 ? "block" : value === 0x36 ? "fifo" : "other";
}

function cpioEntryType(mode: number): ArchiveEntry["type"] {
  const kind = mode & 0o170000;
  return kind === 0o100000 ? "file" : kind === 0o040000 ? "directory" : kind === 0o120000 ? "symlink" : kind === 0o020000 ? "char" : kind === 0o060000 ? "block" : kind === 0o010000 ? "fifo" : "other";
}

function mbrPartitionType(value: number): string {
  return ({ 0x01: "fat12", 0x04: "fat16", 0x05: "extended", 0x07: "ntfs", 0x0b: "fat32", 0x0c: "fat32-lba", 0x0e: "fat16-lba", 0x0f: "extended-lba", 0x17: "hidden-ntfs", 0x83: "linux", 0x85: "linux-extended", 0xa5: "freebsd", 0xee: "gpt-protective" } as Record<number, string>)[value] ?? `mbr-0x${value.toString(16).padStart(2, "0")}`;
}

function uImageArchitecture(value: number): string {
  return ({ 2: "arm", 3: "x86", 20: "ppc", 22: "mips", 24: "aarch64", 26: "riscv" } as Record<number, string>)[value] ?? `arch-${value}`;
}

function uImageCompression(value: number): string {
  return ({ 0: "none", 1: "gzip", 2: "bzip2", 3: "lzma", 4: "lzo", 5: "lz4", 6: "zstd" } as Record<number, string>)[value] ?? `compression-${value}`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Firmware analysis aborted");
}
