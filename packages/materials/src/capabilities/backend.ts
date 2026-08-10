import { join } from "node:path";
import type { ArtifactRef, RawEffectResult, ReplayPolicy } from "../domain/types.js";
import type { FixtureRef } from "../sandbox/fixture.js";
import type { CapabilityOperationAtom } from "@proofblade/molecules";
import type { McpProjectRegistry } from "../mcp/registry.js";
import { executeBinaryCapability, validateBinaryInput, type BinaryCapabilityInput } from "./binary.js";

export type CapabilityBackendKind = "bundled" | "local-process" | "mcp" | "provider-native";

export interface CapabilityBackendStatus {
  id: string;
  kind: CapabilityBackendKind;
  version: string;
  priority: number;
  available: boolean;
  reason?: string;
}

export interface CapabilityBackendAvailability {
  available: boolean;
  reason?: string;
}

export interface CapabilityBackendRequest {
  capabilityId: string;
  operation: string;
  input: Record<string, unknown>;
  backendId?: string;
  backendVersion?: string;
}

export interface CapabilityBackendPersistence {
  operation: CapabilityOperationAtom;
  input: Record<string, unknown>;
  argsRedacted: boolean;
}

export interface CapabilityBackendContext {
  runId: string;
  fixture: FixtureRef;
  runsRoot: string;
  artifacts: Record<string, { path: string; sha256: string }>;
}

export interface CapabilityBackendExecution {
  operation: string;
  args: Record<string, unknown>;
  cwd: string;
  replayPolicy: ReplayPolicy;
  artifactSensitivity?: ArtifactRef["sensitivity"];
  execute?: (signal: AbortSignal) => Promise<RawEffectResult>;
}

export interface CapabilityBackend {
  readonly id: string;
  readonly kind: CapabilityBackendKind;
  readonly priority: number;
  status(): CapabilityBackendStatus;
  availability(request: CapabilityBackendRequest): CapabilityBackendAvailability;
  handles(capabilityId: string, operation: string): boolean;
  versionFor(request: CapabilityBackendRequest): string;
  preparePersistence(request: CapabilityBackendRequest, operation: CapabilityOperationAtom): CapabilityBackendPersistence;
  prepareExecution(request: CapabilityBackendRequest, operation: CapabilityOperationAtom, context: CapabilityBackendContext): CapabilityBackendExecution;
}

export interface ResolvedCapabilityBackend {
  backend: CapabilityBackend;
  version: string;
}

export class CapabilityBackendResolver {
  private readonly backends: CapabilityBackend[];

  public constructor(backends: readonly CapabilityBackend[]) {
    const ids = new Set<string>();
    for (const backend of backends) {
      if (!backend.id || ids.has(backend.id)) throw new Error(`Duplicate capability backend id: ${backend.id}`);
      ids.add(backend.id);
    }
    this.backends = [...backends].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  public statuses(): CapabilityBackendStatus[] {
    return this.backends.map((backend) => ({ ...backend.status() }));
  }

  public resolve(request: CapabilityBackendRequest): ResolvedCapabilityBackend {
    const matching = this.backends.filter((backend) => backend.handles(request.capabilityId, request.operation));
    const candidates = request.backendId ? matching.filter((backend) => backend.id === request.backendId) : matching;
    if (request.backendId && candidates.length === 0) {
      throw new Error(`Capability backend ${request.backendId} does not handle ${request.capabilityId}.${request.operation}`);
    }
    const backend = candidates.find((candidate) => candidate.availability(request).available);
    if (!backend) {
      const reasons = candidates.map((candidate) => `${candidate.id}: ${candidate.availability(request).reason ?? "unavailable"}`).join("; ");
      throw new Error(`No available backend for ${request.capabilityId}.${request.operation}${reasons ? ` (${reasons})` : ""}`);
    }
    const version = backend.versionFor(request);
    if (request.backendVersion !== undefined && request.backendVersion !== version) {
      throw new Error(`Capability backend version changed for ${backend.id}: expected ${request.backendVersion}, got ${version}`);
    }
    return { backend, version };
  }
}

export class BundledCapabilityBackend implements CapabilityBackend {
  public readonly id = "proofblade-bundled";
  public readonly kind = "bundled" as const;
  public readonly priority = 100;
  private readonly version = "1.0.0";

  public status(): CapabilityBackendStatus {
    return { id: this.id, kind: this.kind, version: this.version, priority: this.priority, available: true };
  }

  public handles(capabilityId: string, operation: string): boolean {
    return (capabilityId === "proofblade.target" && ["list", "inspect", "read", "delay"].includes(operation))
      || (capabilityId === "proofblade.artifact" && operation === "read");
  }

  public availability(_request: CapabilityBackendRequest): CapabilityBackendAvailability {
    return { available: true };
  }

  public versionFor(_request: CapabilityBackendRequest): string {
    return this.version;
  }

  public preparePersistence(_request: CapabilityBackendRequest, operation: CapabilityOperationAtom): CapabilityBackendPersistence {
    return { operation, input: structuredClone(_request.input), argsRedacted: false };
  }

  public prepareExecution(request: CapabilityBackendRequest, operation: CapabilityOperationAtom, context: CapabilityBackendContext): CapabilityBackendExecution {
    const mapped = mapBundledOperation(request, context);
    return { ...mapped, replayPolicy: operation.replay };
  }
}

export class BinaryCapabilityBackend implements CapabilityBackend {
  public readonly id = "proofblade-binary";
  public readonly kind = "bundled" as const;
  public readonly priority = 90;
  private readonly version = "1.0.0";

  public status(): CapabilityBackendStatus {
    return { id: this.id, kind: this.kind, version: this.version, priority: this.priority, available: true };
  }

  public handles(capabilityId: string, operation: string): boolean {
    return capabilityId === "proofblade.binary" && ["identify", "read_range", "sections", "symbols", "strings"].includes(operation);
  }

  public availability(_request: CapabilityBackendRequest): CapabilityBackendAvailability {
    return { available: true };
  }

  public versionFor(_request: CapabilityBackendRequest): string {
    return this.version;
  }

  public preparePersistence(request: CapabilityBackendRequest, operation: CapabilityOperationAtom): CapabilityBackendPersistence {
    validateBinaryInput(request.operation, request.input);
    return { operation, input: structuredClone(request.input), argsRedacted: false };
  }

  public prepareExecution(request: CapabilityBackendRequest, operation: CapabilityOperationAtom, context: CapabilityBackendContext): CapabilityBackendExecution {
    validateBinaryInput(request.operation, request.input);
    return {
      operation: `binary:${request.operation}`,
      args: structuredClone(request.input),
      replayPolicy: operation.replay,
      cwd: context.fixture.path,
      execute: async (signal) => await executeBinaryCapability(request.operation, request.input as unknown as BinaryCapabilityInput, context.fixture.path, signal),
    };
  }
}

export class McpCapabilityBackend implements CapabilityBackend {
  public readonly id = "proofblade-mcp";
  public readonly kind = "mcp" as const;
  public readonly priority = 100;
  private readonly version = "1.0.0";

  public constructor(private readonly mcp: McpProjectRegistry) {}

  public status(): CapabilityBackendStatus {
    const configured = this.mcp.summaries().filter((server) => !server.disabled);
    const available = configured.filter((server) => server.status !== "failed" || this.mcp.retryAfterMs(server.capabilityId) === 0);
    return {
      id: this.id,
      kind: this.kind,
      version: this.mcp.catalogHash(),
      priority: this.priority,
      available: available.length > 0,
      reason: configured.length === 0 ? "no enabled MCP servers" : available.length === 0 ? "all enabled MCP servers failed" : undefined,
    };
  }

  public availability(request: CapabilityBackendRequest): CapabilityBackendAvailability {
    const server = this.mcp.summaries().find((item) => item.capabilityId === request.capabilityId);
    if (!server || server.disabled) return { available: false, reason: "MCP capability is disabled or not configured" };
    const retryAfterMs = this.mcp.retryAfterMs(server.capabilityId);
    if (server.status === "failed" && retryAfterMs > 0) {
      return { available: false, reason: `MCP server ${server.name} connection failed; retry available in ${retryAfterMs}ms` };
    }
    return { available: true };
  }

  public handles(capabilityId: string, operation: string): boolean {
    return this.mcp.handles(capabilityId) && (operation === "describe" || operation === "call");
  }

  public versionFor(request: CapabilityBackendRequest): string {
    return this.mcp.catalogHash();
  }

  public preparePersistence(request: CapabilityBackendRequest, operation: CapabilityOperationAtom): CapabilityBackendPersistence {
    const resolved = this.mcp.resolveInvocation(request.capabilityId, request.operation, request.input);
    const persisted = this.mcp.persistedInput(request.input, resolved);
    return {
      operation: { ...operation, readOnly: resolved.readOnly, sideEffect: resolved.sideEffect, replay: resolved.replay },
      input: persisted.input,
      argsRedacted: persisted.argsRedacted,
    };
  }

  public prepareExecution(request: CapabilityBackendRequest, operation: CapabilityOperationAtom, context: CapabilityBackendContext): CapabilityBackendExecution {
    const policy = this.mcp.resolveInvocation(request.capabilityId, request.operation, request.input);
    return {
      operation: `mcp:${request.capabilityId}:${request.operation}`,
      args: this.mcp.effectArgs(request.capabilityId, request.operation, request.input, policy),
      replayPolicy: operation.replay,
      artifactSensitivity: policy.sensitivity === "secret" ? "secret" : undefined,
      cwd: context.runsRoot,
      execute: async (signal) => await this.mcp.execute(request.capabilityId, request.operation, request.input, signal),
    };
  }
}

function mapBundledOperation(request: CapabilityBackendRequest, context: CapabilityBackendContext): Omit<CapabilityBackendExecution, "replayPolicy"> {
  if (request.capabilityId === "proofblade.target" && request.operation === "list") return { operation: "fixture_list", args: {}, cwd: context.fixture.path };
  if (request.capabilityId === "proofblade.target" && request.operation === "inspect") return { operation: "fixture_inspect", args: { path: request.input.path ?? "" }, cwd: context.fixture.path };
  if (request.capabilityId === "proofblade.target" && request.operation === "read") {
    return { operation: "fixture_read", args: { path: request.input.path }, cwd: context.fixture.path };
  }
  if (request.capabilityId === "proofblade.target" && request.operation === "delay") {
    return { operation: "fixture_delay", args: { milliseconds: request.input.milliseconds }, cwd: context.fixture.path };
  }
  if (request.capabilityId === "proofblade.artifact" && request.operation === "read") {
    const artifact = context.artifacts[String(request.input.artifactId)];
    if (!artifact) throw new Error(`Unknown artifact: ${String(request.input.artifactId)}`);
    return {
      operation: "artifact_read",
      args: { artifactId: request.input.artifactId, path: artifact.path, sha256: artifact.sha256, maxChars: request.input.maxChars ?? 4_000 },
      cwd: join(context.runsRoot, context.runId),
    };
  }
  throw new Error(`Unsupported bundled capability operation: ${request.capabilityId}.${request.operation}`);
}
