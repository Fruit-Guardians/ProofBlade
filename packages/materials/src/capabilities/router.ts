import { capabilityCatalogHash, snipText, type CapabilityManifest, type CapabilityOperationAtom } from "@proofblade/molecules";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { EffectJournal } from "../effects/effect-journal.js";
import type { FixtureRef } from "../sandbox/fixture.js";
import type { ControlStore } from "../control/control-store.js";
import { listBundledCapabilities } from "./catalog.js";
import {
  BundledCapabilityBackend,
  CapabilityBackendResolver,
  type CapabilityBackendCandidate,
  type CapabilityBackendRequest,
  type CapabilityBackendStatus,
} from "./backend.js";

export interface CapabilityInvocation extends CapabilityBackendRequest {}

export interface CapabilityInvocationResult {
  capabilityId: string;
  operation: string;
  manifestHash: string;
  effectId: string;
  artifactId: string;
  output: string;
  stderr: string;
  outputTier: "small" | "medium" | "large";
  truncated: boolean;
  originalChars: number;
  backendId: string;
  backendKind: CapabilityBackendStatus["kind"];
  backendVersion: string;
  observationId?: string;
  evidenceId?: string;
  /** Domain records emitted from structured capability output, if any. */
  domainRecordIds?: string[];
  /** Stable content-based key used by no-progress guards and telemetry. */
  progressKey?: string;
}

export interface PersistedCapabilityInvocation {
  operation: CapabilityOperationAtom;
  input: Record<string, unknown>;
  argsRedacted: boolean;
  backendId: string;
  backendVersion: string;
}

export interface CapabilityDiscoveryInput {
  query?: string;
  capabilityId?: string;
  operation?: string;
  includeSchemas?: boolean;
  maxResults?: number;
}

export interface CapabilityOperationDiscovery {
  capabilityId: string;
  capabilityVersion: string;
  capabilityDescription: string;
  trust: CapabilityManifest["trust"];
  manifestHash: string;
  operation: string;
  description: string;
  readOnly: boolean;
  sideEffect: CapabilityOperationAtom["sideEffect"];
  replay: CapabilityOperationAtom["replay"];
  outputPolicy: CapabilityOperationAtom["outputPolicy"];
  executionMode: CapabilityOperationAtom["executionMode"];
  available: boolean;
  selectedBackend?: { id: string; kind: CapabilityBackendStatus["kind"]; version: string };
  backends: CapabilityBackendCandidate[];
  parameters?: Record<string, unknown>;
}

export interface CapabilityDiscoveryResult {
  catalogHash: string;
  query?: string;
  totalMatches: number;
  truncated: boolean;
  results: CapabilityOperationDiscovery[];
}

export class CapabilityRegistry {
  private readonly manifests: CapabilityManifest[];

  public constructor(manifests = listBundledCapabilities()) {
    this.manifests = manifests.map((manifest) => ({ ...manifest, operations: [...manifest.operations].sort((a, b) => a.name.localeCompare(b.name)) })).sort((a, b) => a.id.localeCompare(b.id));
  }

  public list(): CapabilityManifest[] {
    return this.manifests.map((manifest) => ({ ...manifest, operations: manifest.operations.map((operation) => ({ ...operation, parameters: structuredClone(operation.parameters) })) }));
  }

  public catalogHash(): string {
    return capabilityCatalogHash(this.manifests);
  }

  public find(capabilityId: string, operationName: string): { manifest: CapabilityManifest; operation: CapabilityOperationAtom } {
    const manifest = this.manifests.find((item) => item.id === capabilityId);
    if (!manifest) throw new Error(`Unknown capability: ${capabilityId}`);
    const operation = manifest.operations.find((item) => item.name === operationName);
    if (!operation) throw new Error(`Unknown capability operation: ${capabilityId}.${operationName}`);
    return { manifest, operation };
  }
}

export class ProofBladeCapabilityRouter {
  public constructor(
    private readonly runId: string,
    private readonly fixture: FixtureRef,
    private readonly runsRoot: string,
    private readonly controlStore: ControlStore,
    private readonly _artifactStore: ArtifactStore,
    private readonly journal: EffectJournal,
    private readonly registry = new CapabilityRegistry(),
    private readonly backends = new CapabilityBackendResolver([new BundledCapabilityBackend()]),
  ) {}

  public listCapabilities(): { catalogHash: string; capabilities: CapabilityManifest[]; backends: CapabilityBackendStatus[] } {
    return { catalogHash: this.registry.catalogHash(), capabilities: this.registry.list(), backends: this.backends.statuses() };
  }

  public describe(capabilityId: string, operationName: string): CapabilityOperationAtom {
    return this.registry.find(capabilityId, operationName).operation;
  }

  public discover(input: CapabilityDiscoveryInput = {}): CapabilityDiscoveryResult {
    const query = normalizeDiscoveryQuery(input.query);
    const maxResults = normalizeDiscoveryLimit(input.maxResults);
    if (input.operation && !input.capabilityId) throw new Error("Capability discovery operation requires capabilityId");
    const terms = query ? query.split(/\s+/).filter(Boolean) : [];
    const matches: CapabilityOperationDiscovery[] = [];
    for (const manifest of this.registry.list()) {
      if (input.capabilityId && manifest.id !== input.capabilityId) continue;
      for (const operation of manifest.operations) {
        if (input.operation && operation.name !== input.operation) continue;
        const haystack = [manifest.id, manifest.description, operation.name, operation.description].join(" ").toLowerCase();
        if (terms.some((term) => !haystack.includes(term))) continue;
        const request = { capabilityId: manifest.id, operation: operation.name, input: {} };
        const backends = this.backends.candidates(request);
        const selected = backends.find((backend) => backend.selected);
        matches.push({
          capabilityId: manifest.id,
          capabilityVersion: manifest.version,
          capabilityDescription: manifest.description,
          trust: manifest.trust,
          manifestHash: manifest.hash,
          operation: operation.name,
          description: operation.description,
          readOnly: operation.readOnly,
          sideEffect: operation.sideEffect,
          replay: operation.replay,
          outputPolicy: operation.outputPolicy,
          executionMode: operation.executionMode,
          available: selected !== undefined,
          ...(selected ? { selectedBackend: { id: selected.id, kind: selected.kind, version: selected.version } } : {}),
          backends,
          ...(input.includeSchemas ? { parameters: structuredClone(operation.parameters) } : {}),
        });
      }
    }
    matches.sort((left, right) => left.capabilityId.localeCompare(right.capabilityId) || left.operation.localeCompare(right.operation));
    return {
      catalogHash: this.registry.catalogHash(),
      ...(query ? { query } : {}),
      totalMatches: matches.length,
      truncated: matches.length > maxResults,
      results: matches.slice(0, maxResults),
    };
  }

  public resolveInvocationPolicy(request: CapabilityInvocation): CapabilityOperationAtom {
    return this.preparePersistence(request).operation;
  }

  public preparePersistence(request: CapabilityInvocation): PersistedCapabilityInvocation {
    const { operation } = this.registry.find(request.capabilityId, request.operation);
    validateInput(operation, request.input);
    const resolved = this.backends.resolve(request);
    const persisted = resolved.backend.preparePersistence(request, operation);
    return {
      ...persisted,
      backendId: resolved.backend.id,
      backendVersion: resolved.version,
    };
  }

  public async invoke(request: CapabilityInvocation, signal?: AbortSignal): Promise<CapabilityInvocationResult> {
    const { manifest, operation: manifestOperation } = this.registry.find(request.capabilityId, request.operation);
    validateInput(manifestOperation, request.input);
    const resolved = this.backends.resolve(request);
    const persistence = resolved.backend.preparePersistence(request, manifestOperation);
    const operation = persistence.operation;
    const snapshot = await this.controlStore.snapshot(this.runId);
    const plan = resolved.backend.prepareExecution(request, operation, {
      runId: this.runId,
      fixture: this.fixture,
      runsRoot: this.runsRoot,
      artifacts: snapshot.artifacts,
    });
    const provenance = {
      capabilityId: request.capabilityId,
      operation: request.operation,
      manifestHash: manifest.hash,
      backendId: resolved.backend.id,
      backendKind: resolved.backend.kind,
      backendVersion: resolved.version,
    };
    const journalInput = {
      operation: plan.operation,
      args: { ...plan.args, generation: snapshot.generation, capability: provenance },
      replayPolicy: plan.replayPolicy,
      artifactSensitivity: plan.artifactSensitivity,
      cwd: plan.cwd,
    };
    const executed = plan.execute
      ? await this.journal.executeWith(this.runId, journalInput, async (_effect, innerSignal) => await plan.execute!(innerSignal), signal)
      : await this.journal.execute(this.runId, journalInput, signal);
    if (executed.result.exitCode !== 0) throw new Error(executed.result.stderr || `Capability failed: ${request.capabilityId}.${request.operation}`);
    const output = formatOutput(executed.result.stdout, operation.outputPolicy, typeof request.input.maxChars === "number" ? request.input.maxChars : undefined);
    return {
      ...provenance,
      effectId: executed.effectId,
      artifactId: executed.artifactId,
      output: `<untrusted-observation capability="${request.capabilityId}" operation="${request.operation}" artifact="${executed.artifactId}">\n${output.text}\n</untrusted-observation>`,
      stderr: executed.result.stderr,
      outputTier: output.tier,
      truncated: output.truncated,
      originalChars: output.originalChars,
    };
  }
}

function normalizeDiscoveryQuery(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Capability discovery query must be a string");
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  if (normalized.length > 200) throw new Error("Capability discovery query must not exceed 200 characters");
  return normalized;
}

function normalizeDiscoveryLimit(value: number | undefined): number {
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("Capability discovery maxResults must be between 1 and 100");
  return value;
}

function validateInput(operation: CapabilityOperationAtom, input: Record<string, unknown>): void {
  const schema = operation.parameters;
  const properties = schema.properties && typeof schema.properties === "object" ? Object.keys(schema.properties as object) : [];
  for (const key of Object.keys(input)) if (!properties.includes(key)) throw new Error(`Unsupported capability input: ${operation.name}.${key}`);
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  for (const key of required) if (input[key] === undefined || input[key] === "") throw new Error(`Missing capability input: ${operation.name}.${key}`);
  if (input.path !== undefined && (typeof input.path !== "string" || input.path.length === 0)) throw new Error("Capability path must be a non-empty relative string");
  if (input.artifactId !== undefined && (typeof input.artifactId !== "string" || input.artifactId.length === 0)) throw new Error("Capability artifactId must be a non-empty string");
  if (input.maxChars !== undefined && (!Number.isInteger(input.maxChars) || Number(input.maxChars) < 256 || Number(input.maxChars) > 12_000)) throw new Error("Capability maxChars must be between 256 and 12000");
  if (input.milliseconds !== undefined && (!Number.isInteger(input.milliseconds) || Number(input.milliseconds) < 50 || Number(input.milliseconds) > 120_000)) throw new Error("Capability milliseconds must be between 50 and 120000");
}

function formatOutput(value: string, policy: CapabilityOperationAtom["outputPolicy"], requestedMaxChars?: number): { text: string; tier: "small" | "medium" | "large"; truncated: boolean; originalChars: number } {
  const originalChars = value.length;
  const tier = originalChars <= 768 ? "small" : originalChars <= 12_000 ? "medium" : "large";
  const maxChars = requestedMaxChars ?? (policy === "inline" ? 2_000 : tier === "large" ? 1_024 : 2_000);
  const snipped = snipText(value, Math.max(64, maxChars));
  return { text: snipped.text, tier, truncated: snipped.truncated, originalChars };
}
