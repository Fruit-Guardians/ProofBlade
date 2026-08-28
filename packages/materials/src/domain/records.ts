import type { DomainRecord, DomainRecordKind } from "./types.js";

const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const HEX = /^(?:0x)?[0-9a-f]+$/i;
const WEB_KINDS = new Set<DomainRecordKind>(["web_baseline", "web_endpoint", "web_request", "web_exploit_chain"]);
const PWN_KINDS = new Set<DomainRecordKind>(["pwn_binary_profile", "pwn_protocol_transcript", "pwn_primitive", "pwn_leak", "pwn_exploit_stage"]);

/** Validate the bounded, non-secret shape of one Web/Pwn domain record. */
export function validateDomainRecordShape(record: DomainRecord): void {
  if (!record || !RECORD_ID.test(record.id)) throw new Error("Domain record id is invalid");
  if (!Number.isInteger(record.generation) || record.generation < 0) throw new Error(`Domain record ${record.id} generation is invalid`);
  if (!record.runId.trim() || record.runId.length > 96) throw new Error(`Domain record ${record.id} runId is invalid`);
  boundedText(record.summary, `Domain record ${record.id} summary`, 2_000);
  boundedList(record.artifactIds, `Domain record ${record.id} artifacts`, 32, 96);
  boundedList(record.evidenceIds, `Domain record ${record.id} evidence`, 32, 96);
  unique(record.artifactIds, `Domain record ${record.id} artifacts`);
  unique(record.evidenceIds, `Domain record ${record.id} evidence`);
  if (record.effectId !== undefined) boundedText(record.effectId, `Domain record ${record.id} effect`, 96);
  if (!WEB_KINDS.has(record.kind) && !PWN_KINDS.has(record.kind)) throw new Error(`Unknown domain record kind: ${String(record.kind)}`);
  switch (record.kind) {
    case "web_baseline":
      boundedUrl(record.baseUrl, `Domain record ${record.id} baseUrl`);
      statusCode(record.status, record.id);
      hash(record.stateHash, `Domain record ${record.id} stateHash`);
      break;
    case "web_endpoint":
      method(record.method, record.id);
      boundedText(record.path, `Domain record ${record.id} path`, 2_048);
      boundedList(record.sourceRecordIds, `Domain record ${record.id} source records`, 16, 96);
      unique(record.sourceRecordIds, `Domain record ${record.id} source records`);
      break;
    case "web_request":
      method(record.method, record.id);
      boundedText(record.path, `Domain record ${record.id} path`, 2_048);
      statusCode(record.status, record.id);
      boundedText(record.sessionId, `Domain record ${record.id} session`, 96);
      hash(record.stateHash, `Domain record ${record.id} stateHash`);
      break;
    case "web_exploit_chain":
      boundedList(record.stepRecordIds, `Domain record ${record.id} steps`, 32, 96);
      unique(record.stepRecordIds, `Domain record ${record.id} steps`);
      if (!["proposed", "observed", "reproduced"].includes(record.status)) throw new Error(`Domain record ${record.id} chain status is invalid`);
      break;
    case "pwn_binary_profile":
      boundedText(record.format, `Domain record ${record.id} format`, 64);
      boundedText(record.architecture, `Domain record ${record.id} architecture`, 64);
      if (!Number.isInteger(record.bits) || record.bits < 8 || record.bits > 256) throw new Error(`Domain record ${record.id} bits is invalid`);
      boundedList(record.protections, `Domain record ${record.id} protections`, 32, 96);
      break;
    case "pwn_protocol_transcript":
      boundedText(record.sessionId, `Domain record ${record.id} session`, 96);
      if (!Number.isInteger(record.interactionCount) || record.interactionCount < 0 || record.interactionCount > 10_000) throw new Error(`Domain record ${record.id} interaction count is invalid`);
      boundedList(record.anchors, `Domain record ${record.id} anchors`, 32, 256);
      break;
    case "pwn_primitive":
      boundedText(record.primitive, `Domain record ${record.id} primitive`, 256);
      if (!Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence >= 1) throw new Error(`Domain record ${record.id} confidence must be in [0,1)`);
      boundedList(record.preconditionRecordIds, `Domain record ${record.id} preconditions`, 32, 96);
      unique(record.preconditionRecordIds, `Domain record ${record.id} preconditions`);
      break;
    case "pwn_leak":
      boundedText(record.sourceHex, `Domain record ${record.id} sourceHex`, 512);
      if (!HEX.test(record.sourceHex) || record.sourceHex.replace(/^0x/i, "").length % 2 !== 0) throw new Error(`Domain record ${record.id} sourceHex is invalid`);
      if (!["le64", "le32", "be64", "be32"].includes(record.format)) throw new Error(`Domain record ${record.id} leak format is invalid`);
      if (!HEX.test(record.value) || record.value.length > 66) throw new Error(`Domain record ${record.id} leak value is invalid`);
      boundedText(record.addressKind, `Domain record ${record.id} address kind`, 32);
      if (record.symbol !== undefined) boundedText(record.symbol, `Domain record ${record.id} symbol`, 128);
      if (record.derivation !== undefined) {
        boundedText(record.derivation.expression, `Domain record ${record.id} derivation`, 512);
        boundedList(record.derivation.sourceRecordIds, `Domain record ${record.id} derivation sources`, 16, 96);
        unique(record.derivation.sourceRecordIds, `Domain record ${record.id} derivation sources`);
      }
      break;
    case "pwn_exploit_stage":
      if (!Number.isInteger(record.stageIndex) || record.stageIndex < 0 || record.stageIndex > 128) throw new Error(`Domain record ${record.id} stage index is invalid`);
      boundedText(record.stageName, `Domain record ${record.id} stage name`, 160);
      if (!["proposed", "observed", "passed", "failed"].includes(record.status)) throw new Error(`Domain record ${record.id} stage status is invalid`);
      if (record.inputArtifactId !== undefined) boundedText(record.inputArtifactId, `Domain record ${record.id} input artifact`, 96);
      if (record.expectedAnchor !== undefined) boundedText(record.expectedAnchor, `Domain record ${record.id} expected anchor`, 256);
      break;
  }
}

export function isWebDomainRecord(record: DomainRecord): boolean { return WEB_KINDS.has(record.kind); }

export function isPwnDomainRecord(record: DomainRecord): boolean { return PWN_KINDS.has(record.kind); }

function boundedText(value: string, label: string, max: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000\r\n]/.test(value)) throw new Error(`${label} is invalid`);
}

function boundedList(value: string[], label: string, maxItems: number, maxItem: number): void {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > maxItem)) throw new Error(`${label} is invalid`);
}

function unique(value: string[], label: string): void {
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
}

function boundedUrl(value: string, label: string): void {
  boundedText(value, label, 2_048);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${label} is invalid`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${label} must use http(s)`);
}

function method(value: string, id: string): void {
  boundedText(value, `Domain record ${id} method`, 16);
  if (!/^[A-Z]+$/.test(value)) throw new Error(`Domain record ${id} method is invalid`);
}

function statusCode(value: number, id: string): void {
  if (!Number.isInteger(value) || value < 100 || value > 599) throw new Error(`Domain record ${id} status is invalid`);
}

function hash(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} is invalid`);
}
