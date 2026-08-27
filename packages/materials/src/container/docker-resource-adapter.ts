import type { ExternalResourceAdapter, ExternalResourceInspection, ExternalResourceRecord } from "../recovery/external-resource-registry.js";
import type { DockerCommandRunner, DockerProcessResult } from "./docker.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const SAFE_DOCKER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

interface DockerInspectPayload {
  Id?: unknown;
  State?: { Running?: unknown };
  Config?: { Labels?: unknown };
}

/**
 * Read-only ownership adapter for Docker containers recorded in the external
 * resource ledger. It never searches by a mutable name: the ledger's
 * externalId is inspected directly and all immutable ProofBlade labels must
 * match before adoption or removal is allowed.
 */
export class DockerContainerResourceAdapter implements ExternalResourceAdapter {
  public readonly kind = "container" as const;

  public constructor(
    private readonly runner: DockerCommandRunner,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly maxOutputBytes = DEFAULT_OUTPUT_BYTES,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Docker resource adapter timeout must be positive");
    if (!Number.isFinite(maxOutputBytes) || maxOutputBytes < 1) throw new Error("Docker resource adapter output limit must be positive");
  }

  public async inspect(record: ExternalResourceRecord, signal?: AbortSignal): Promise<ExternalResourceInspection> {
    const externalId = record.externalId;
    if (!externalId || !SAFE_DOCKER_ID.test(externalId)) return { status: "UNKNOWN", binding: "UNKNOWN", summary: "Docker resource has no safe container id" };
    const result = await this.runner.run(["inspect", "--format", "{{json .}}", externalId], { timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes, signal });
    if (result.spawnError) throw result.spawnError;
    if (result.exitCode !== 0) {
      if (isMissingResource(result)) return { status: "ABSENT", binding: "UNKNOWN", externalId, summary: "Docker container is absent" };
      throw new Error(`Docker inspect failed: ${boundedError(result)}`);
    }
    const payload = parseInspect(result);
    const labels = readLabels(payload.Config?.Labels);
    const expected = {
      "proofblade.managed": "true",
      "proofblade.run_id": record.runId,
      "proofblade.generation": String(record.generation),
      ...(record.bindingTxnId ? { "proofblade.binding_txn": record.bindingTxnId } : {}),
    };
    const matches = Object.entries(expected).every(([key, value]) => labels[key] === value)
      && (payload.Id === undefined || payload.Id === externalId);
    return {
      status: "PRESENT",
      binding: matches ? "MATCH" : "MISMATCH",
      externalId,
      summary: matches
        ? `Docker container is owned by run ${record.runId}, generation ${record.generation}; running=${String(payload.State?.Running === true)}.`
        : "Docker container exists but its immutable ProofBlade labels do not match the ledger record",
    };
  }

  public async adopt(_record: ExternalResourceRecord, inspection: ExternalResourceInspection, _signal?: AbortSignal): Promise<{ state: "CONFIRMED" | "UNKNOWN"; summary?: string }> {
    return inspection.status === "PRESENT" && inspection.binding === "MATCH"
      ? { state: "CONFIRMED", summary: inspection.summary }
      : { state: "UNKNOWN", summary: inspection.summary ?? "Docker container ownership is ambiguous" };
  }

  public async release(record: ExternalResourceRecord, reason: string, signal?: AbortSignal): Promise<{ released: boolean; summary?: string }> {
    const inspection = await this.inspect(record, signal);
    if (inspection.status === "ABSENT") return { released: true, summary: "Docker container was already absent" };
    if (inspection.status !== "PRESENT" || inspection.binding !== "MATCH" || !record.externalId) {
      return { released: false, summary: inspection.summary ?? "Docker container ownership is ambiguous; refusing removal" };
    }
    const result = await this.runner.run(["rm", "-f", record.externalId], { timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes, signal });
    if (result.spawnError) throw result.spawnError;
    if (result.exitCode !== 0 && !isMissingResource(result)) throw new Error(`Docker release failed (${reason}): ${boundedError(result)}`);
    return { released: true, summary: `Docker container released: ${reason}` };
  }
}

function parseInspect(result: DockerProcessResult): DockerInspectPayload {
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Docker inspect did not return an object");
    return parsed as DockerInspectPayload;
  } catch (error) {
    throw new Error(`Docker inspect returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readLabels(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"));
}

function isMissingResource(result: DockerProcessResult): boolean {
  return /(?:no such|not found|does not exist)/i.test(`${result.stderr}\n${result.stdout}`);
}

function boundedError(result: DockerProcessResult): string {
  return `${result.stderr || result.stdout}`.replace(/\s+/g, " ").trim().slice(0, 512) || `exit ${String(result.exitCode)}`;
}
