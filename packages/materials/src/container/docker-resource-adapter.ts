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

interface DockerNetworkInspectPayload {
  Id?: unknown;
  Labels?: unknown;
  Containers?: unknown;
}

interface DockerResourceObservation {
  kind: "container" | "network";
  locator: string;
  status: "PRESENT" | "ABSENT" | "UNKNOWN";
  binding: "MATCH" | "MISMATCH" | "UNKNOWN";
  externalId?: string;
  summary?: string;
}

/**
 * Read-only ownership adapter for Docker resources recorded in the external
 * resource ledger. It never scans by a broad or mutable name: only the
 * ledger's bounded opaque handle or persisted create locators are inspected,
 * and all immutable ProofBlade labels must match before adoption or removal.
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
    const observations = await this.inspectResources(record, signal);
    const mismatch = observations.find((observation) => observation.status === "PRESENT" && observation.binding === "MISMATCH");
    if (mismatch) return { status: "PRESENT", binding: "MISMATCH", ...(mismatch.externalId ? { externalId: mismatch.externalId } : {}), summary: mismatch.summary };
    const unknown = observations.find((observation) => observation.status === "UNKNOWN");
    if (unknown) return { status: "UNKNOWN", binding: "UNKNOWN", summary: unknown.summary };
    const present = observations.filter((observation) => observation.status === "PRESENT" && observation.binding === "MATCH");
    if (present.length === 0) return { status: "ABSENT", binding: "UNKNOWN", summary: "Docker resource set is absent" };
    const solver = present.find((observation) => observation.kind === "container" && observation.locator === solverLocator(record));
    return {
      status: "PRESENT",
      binding: "MATCH",
      ...(solver?.externalId ? { externalId: solver.externalId } : {}),
      summary: solver
        ? `Docker solver container is owned by run ${record.runId}, generation ${record.generation}.`
        : "Docker create left a partial owned resource set before the solver container was durable",
    };
  }

  public async adopt(_record: ExternalResourceRecord, inspection: ExternalResourceInspection, _signal?: AbortSignal): Promise<{ state: "CONFIRMED" | "UNKNOWN"; summary?: string }> {
    return inspection.status === "PRESENT" && inspection.binding === "MATCH"
      ? { state: "CONFIRMED", summary: inspection.summary }
      : { state: "UNKNOWN", summary: inspection.summary ?? "Docker container ownership is ambiguous" };
  }

  public async release(record: ExternalResourceRecord, reason: string, signal?: AbortSignal): Promise<{ released: boolean; summary?: string }> {
    const observations = await this.inspectResources(record, signal);
    const unsafe = observations.find((observation) => observation.status === "UNKNOWN" || (observation.status === "PRESENT" && observation.binding !== "MATCH"));
    if (unsafe) return { released: false, summary: unsafe.summary ?? "Docker resource ownership is ambiguous; refusing removal" };
    const present = observations.filter((observation) => observation.status === "PRESENT");
    if (present.length === 0) return { released: true, summary: "Docker resource set was already absent" };
    const removed = new Set<string>();
    for (const observation of present.filter((item) => item.kind === "container")) {
      const target = observation.externalId ?? observation.locator;
      if (removed.has(`container:${target}`)) continue;
      removed.add(`container:${target}`);
      const result = await this.runner.run(["rm", "-f", target], { timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes, signal });
      if (result.spawnError) throw result.spawnError;
      if (result.exitCode !== 0 && !isMissingResource(result)) throw new Error(`Docker release failed (${reason}): ${boundedError(result)}`);
    }
    for (const observation of present.filter((item) => item.kind === "network")) {
      const target = observation.externalId ?? observation.locator;
      if (removed.has(`network:${target}`)) continue;
      removed.add(`network:${target}`);
      const result = await this.runner.run(["network", "rm", target], { timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes, signal });
      if (result.spawnError) throw result.spawnError;
      if (result.exitCode !== 0 && !isMissingResource(result)) throw new Error(`Docker network release failed (${reason}): ${boundedError(result)}`);
    }
    return { released: true, summary: `Docker resources released: ${reason}` };
  }

  private async inspectResources(record: ExternalResourceRecord, signal?: AbortSignal): Promise<DockerResourceObservation[]> {
    const refs = { ...derivedDockerRefs(record), ...(record.externalRefs ?? {}) };
    const observations: DockerResourceObservation[] = [];
    for (const locator of uniqueLocators([record.externalId, refs.solver])) {
      observations.push(await this.inspectContainer(record, locator, signal));
    }
    if (observations.length === 0 && record.state === "PROPOSED") {
      return [{ kind: "container", locator: "", status: "UNKNOWN", binding: "UNKNOWN", summary: "Docker proposal has no solver locator" }];
    }
    for (const locator of uniqueLocators([refs.gateway])) observations.push(await this.inspectContainer(record, locator, signal));
    for (const locator of uniqueLocators([refs.network])) observations.push(await this.inspectNetwork(record, locator, signal));
    return observations;
  }

  private async inspectContainer(record: ExternalResourceRecord, locator: string, signal?: AbortSignal): Promise<DockerResourceObservation> {
    if (!SAFE_DOCKER_ID.test(locator)) return { kind: "container", locator, status: "UNKNOWN", binding: "UNKNOWN", summary: "Docker resource has no safe container locator" };
    const result = await this.runner.run(["inspect", "--format", "{{json .}}", locator], { timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes, signal });
    if (result.spawnError) throw result.spawnError;
    if (result.exitCode !== 0) {
      if (isMissingResource(result)) return { kind: "container", locator, status: "ABSENT", binding: "UNKNOWN", externalId: locator, summary: "Docker container is absent" };
      throw new Error(`Docker inspect failed: ${boundedError(result)}`);
    }
    const payload = parseInspect(result);
    const labels = readLabels(payload.Config?.Labels);
    const matches = hasExpectedLabels(record, labels) && (payload.Id === undefined || record.externalId !== locator || payload.Id === locator);
    return {
      kind: "container",
      locator,
      status: "PRESENT",
      binding: matches ? "MATCH" : "MISMATCH",
      externalId: typeof payload.Id === "string" ? payload.Id : locator,
      summary: matches
        ? `Docker container is owned by run ${record.runId}, generation ${record.generation}; running=${String(payload.State?.Running === true)}.`
        : "Docker container exists but its immutable ProofBlade labels do not match the ledger record",
    };
  }

  private async inspectNetwork(record: ExternalResourceRecord, locator: string, signal?: AbortSignal): Promise<DockerResourceObservation> {
    if (!SAFE_DOCKER_ID.test(locator)) return { kind: "network", locator, status: "UNKNOWN", binding: "UNKNOWN", summary: "Docker resource has no safe network locator" };
    const result = await this.runner.run(["network", "inspect", "--format", "{{json .}}", locator], { timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes, signal });
    if (result.spawnError) throw result.spawnError;
    if (result.exitCode !== 0) {
      if (isMissingResource(result)) return { kind: "network", locator, status: "ABSENT", binding: "UNKNOWN", externalId: locator, summary: "Docker network is absent" };
      throw new Error(`Docker network inspect failed: ${boundedError(result)}`);
    }
    const payload = parseNetworkInspect(result);
    const labels = readLabels(payload.Labels);
    const matches = hasExpectedLabels(record, labels);
    const attached = payload.Containers && typeof payload.Containers === "object" && !Array.isArray(payload.Containers)
      ? Object.keys(payload.Containers).length
      : 0;
    return {
      kind: "network",
      locator,
      status: "PRESENT",
      binding: matches ? "MATCH" : "MISMATCH",
      externalId: typeof payload.Id === "string" ? payload.Id : locator,
      summary: matches
        ? `Docker network is owned by run ${record.runId}, generation ${record.generation}; attached=${String(attached)}.`
        : "Docker network exists but its immutable ProofBlade labels do not match the ledger record",
    };
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

function parseNetworkInspect(result: DockerProcessResult): DockerNetworkInspectPayload {
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Docker network inspect did not return an object");
    return parsed as DockerNetworkInspectPayload;
  } catch (error) {
    throw new Error(`Docker network inspect returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function hasExpectedLabels(record: ExternalResourceRecord, labels: Record<string, string>): boolean {
  const expected = {
    "proofblade.managed": "true",
    "proofblade.run_id": record.runId,
    "proofblade.generation": String(record.generation),
    ...(record.bindingTxnId ? { "proofblade.binding_txn": record.bindingTxnId } : {}),
  };
  return Object.entries(expected).every(([key, value]) => labels[key] === value);
}

function solverLocator(record: ExternalResourceRecord): string {
  return record.externalId ?? record.externalRefs?.solver ?? derivedDockerRefs(record).solver ?? "";
}

function uniqueLocators(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined && value.length > 0))];
}

function derivedDockerRefs(record: ExternalResourceRecord): { solver?: string; gateway?: string; network?: string } {
  const match = /^container:(.*):(\d+):(web|pwn|pwn-kernel)$/.exec(record.id);
  if (!match) return {};
  const [, runId, generation, profile] = match;
  const name = `proofblade-${safeName(runId)}-g${generation}-${profile}`;
  return { solver: name, gateway: `${name}-gateway`, network: `proofblade-${safeName(runId)}-g${generation}-net` };
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "run";
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
