import { join } from "node:path";
import { capabilityCatalogHash, snipText, type CapabilityManifest, type CapabilityOperationAtom } from "@proofblade/molecules";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { EffectJournal } from "../effects/effect-journal.js";
import type { FixtureRef } from "../sandbox/fixture.js";
import type { ControlStore } from "../control/control-store.js";
import { listBundledCapabilities } from "./catalog.js";

export interface CapabilityInvocation {
  capabilityId: string;
  operation: string;
  input: Record<string, unknown>;
}

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
  observationId?: string;
  evidenceId?: string;
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
  ) {}

  public listCapabilities(): { catalogHash: string; capabilities: CapabilityManifest[] } {
    return { catalogHash: this.registry.catalogHash(), capabilities: this.registry.list() };
  }

  public describe(capabilityId: string, operationName: string): CapabilityOperationAtom {
    return this.registry.find(capabilityId, operationName).operation;
  }

  public async invoke(request: CapabilityInvocation, signal?: AbortSignal): Promise<CapabilityInvocationResult> {
    const { manifest, operation } = this.registry.find(request.capabilityId, request.operation);
    validateInput(operation, request.input);
    const snapshot = await this.controlStore.snapshot(this.runId);
    const mapped = mapOperation(request.capabilityId, request.operation, request.input, this.fixture, this.runsRoot, this.runId, snapshot.artifacts);
    const executed = await this.journal.execute(this.runId, { operation: mapped.operation, args: { ...mapped.args, generation: snapshot.generation }, replayPolicy: operation.replay, cwd: mapped.cwd }, signal);
    if (executed.result.exitCode !== 0) throw new Error(executed.result.stderr || `Capability failed: ${request.capabilityId}.${request.operation}`);
    const output = formatOutput(executed.result.stdout, operation.outputPolicy, typeof request.input.maxChars === "number" ? request.input.maxChars : undefined);
    return {
      capabilityId: request.capabilityId,
      operation: request.operation,
      manifestHash: manifest.hash,
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

function mapOperation(capabilityId: string, operation: string, input: Record<string, unknown>, fixture: FixtureRef, runsRoot: string, runId: string, artifacts: Record<string, { path: string; sha256: string }>): { operation: string; args: Record<string, unknown>; cwd: string } {
  if (capabilityId === "proofblade.target" && operation === "list") return { operation: "fixture_list", args: {}, cwd: fixture.path };
  if (capabilityId === "proofblade.target" && operation === "inspect") return { operation: "fixture_inspect", args: { path: input.path ?? "" }, cwd: fixture.path };
  if (capabilityId === "proofblade.target" && operation === "read") {
    return { operation: "fixture_read", args: { path: input.path }, cwd: fixture.path };
  }
  if (capabilityId === "proofblade.target" && operation === "delay") {
    return { operation: "fixture_delay", args: { milliseconds: input.milliseconds }, cwd: fixture.path };
  }
  if (capabilityId === "proofblade.artifact" && operation === "read") {
    const artifact = artifacts[String(input.artifactId)];
    if (!artifact) throw new Error(`Unknown artifact: ${String(input.artifactId)}`);
    return { operation: "artifact_read", args: { artifactId: input.artifactId, path: artifact.path, sha256: artifact.sha256, maxChars: input.maxChars ?? 4_000 }, cwd: join(runsRoot, runId) };
  }
  throw new Error(`Unsupported capability operation: ${operation}`);
}

function formatOutput(value: string, policy: CapabilityOperationAtom["outputPolicy"], requestedMaxChars?: number): { text: string; tier: "small" | "medium" | "large"; truncated: boolean; originalChars: number } {
  const originalChars = value.length;
  const tier = originalChars <= 768 ? "small" : originalChars <= 12_000 ? "medium" : "large";
  const maxChars = requestedMaxChars ?? (policy === "inline" ? 2_000 : tier === "large" ? 1_024 : 2_000);
  const snipped = snipText(value, Math.max(64, maxChars));
  return { text: snipped.text, tier, truncated: snipped.truncated, originalChars };
}
