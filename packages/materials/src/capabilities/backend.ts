import { join } from "node:path";
import type { ArtifactRef, RawEffectResult, ReplayPolicy } from "../domain/types.js";
import type { FixtureRef } from "../sandbox/fixture.js";
import type { CapabilityOperationAtom } from "@proofblade/molecules";
import type { McpProjectRegistry } from "../mcp/registry.js";
import { executeBinaryCapability, validateBinaryInput, type BinaryCapabilityInput } from "./binary.js";
import { executeFirmwareCapability, validateFirmwareInput, type FirmwareCapabilityInput } from "./firmware.js";
import { createRizinAvailability, executeRizinCapability, normalizeFunctions, normalizeInstructions, normalizeXrefs, reverseOperation, validateReverseInput, withStagedVisibleBinary, type ReverseCapabilityInput, type ReverseOperation, type RizinCapabilityOptions } from "./reverse.js";
import type { McpBinaryReverseOperation, McpReverseOutput } from "../mcp/registry.js";

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

export interface CapabilityBackendCandidate {
  id: string;
  kind: CapabilityBackendKind;
  version: string;
  priority: number;
  available: boolean;
  selected: boolean;
  reason?: string;
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

  public candidates(request: CapabilityBackendRequest): CapabilityBackendCandidate[] {
    const matching = this.backends.filter((backend) => backend.handles(request.capabilityId, request.operation));
    let selected = false;
    return matching.map((backend) => {
      const status = backend.status();
      const availability = backend.availability(request);
      const isSelected = !selected && availability.available;
      if (isSelected) selected = true;
      return {
        id: backend.id,
        kind: backend.kind,
        version: availability.available ? backend.versionFor(request) : status.version,
        priority: backend.priority,
        available: availability.available,
        selected: isSelected,
        ...(availability.reason ? { reason: publicAvailabilityReason(availability.reason) } : {}),
      };
    });
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

function publicAvailabilityReason(reason: string): string {
  return reason
    .replace(/[A-Za-z]:[\\/](?:[^\s:;,)]+[\\/])*[^\s:;,)]+/g, "[host-path]")
    .replace(/(^|[\s(])\/(?:[^\s:;,)]+\/)*[^\s:;,)]+/g, "$1[host-path]");
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

export class FirmwareCapabilityBackend implements CapabilityBackend {
  public readonly id = "proofblade-firmware";
  public readonly kind = "bundled" as const;
  public readonly priority = 89;
  private readonly version = "1.0.0";

  public status(): CapabilityBackendStatus {
    return { id: this.id, kind: this.kind, version: this.version, priority: this.priority, available: true };
  }

  public handles(capabilityId: string, operation: string): boolean {
    return capabilityId === "proofblade.firmware" && ["scan", "partitions", "filesystems", "entropy", "file_tree", "extract"].includes(operation);
  }

  public availability(_request: CapabilityBackendRequest): CapabilityBackendAvailability {
    return { available: true };
  }

  public versionFor(_request: CapabilityBackendRequest): string {
    return this.version;
  }

  public preparePersistence(request: CapabilityBackendRequest, operation: CapabilityOperationAtom): CapabilityBackendPersistence {
    validateFirmwareInput(request.operation, request.input);
    return { operation, input: structuredClone(request.input), argsRedacted: false };
  }

  public prepareExecution(request: CapabilityBackendRequest, operation: CapabilityOperationAtom, context: CapabilityBackendContext): CapabilityBackendExecution {
    validateFirmwareInput(request.operation, request.input);
    return {
      operation: `firmware:${request.operation}`,
      args: structuredClone(request.input),
      replayPolicy: operation.replay,
      cwd: context.fixture.path,
      execute: async (signal) => await executeFirmwareCapability(request.operation, request.input as unknown as FirmwareCapabilityInput, context.fixture.path, signal),
    };
  }
}

export class RizinCapabilityBackend implements CapabilityBackend {
  public readonly id = "proofblade-rizin";
  public readonly kind = "local-process" as const;
  public readonly priority = 80;
  private readonly availabilityState: ReturnType<typeof createRizinAvailability>;

  public constructor(options: RizinCapabilityOptions = {}) {
    this.availabilityState = createRizinAvailability(options);
  }

  public status(): CapabilityBackendStatus {
    const status: CapabilityBackendStatus = {
      id: this.id,
      kind: this.kind,
      version: this.availabilityState.version,
      priority: this.priority,
      available: this.availabilityState.available,
    };
    if (this.availabilityState.reason) status.reason = this.availabilityState.reason;
    return status;
  }

  public handles(capabilityId: string, operation: string): boolean {
    return capabilityId === "proofblade.binary" && ["functions", "disassemble", "xrefs"].includes(operation);
  }

  public availability(_request: CapabilityBackendRequest): CapabilityBackendAvailability {
    return { available: this.availabilityState.available, reason: this.availabilityState.reason };
  }

  public versionFor(_request: CapabilityBackendRequest): string {
    return this.availabilityState.version;
  }

  public preparePersistence(request: CapabilityBackendRequest, operation: CapabilityOperationAtom): CapabilityBackendPersistence {
    validateReverseInput(request.operation, request.input);
    return { operation, input: structuredClone(request.input), argsRedacted: false };
  }

  public prepareExecution(request: CapabilityBackendRequest, operation: CapabilityOperationAtom, context: CapabilityBackendContext): CapabilityBackendExecution {
    const reverse = reverseOperation(request.operation);
    validateReverseInput(reverse, request.input);
    if (!this.availabilityState.executable) throw new Error("Rizin executable is unavailable");
    return {
      operation: `rizin:${request.operation}`,
      args: structuredClone(request.input),
      replayPolicy: operation.replay,
      cwd: context.fixture.path,
      execute: async (signal) => await executeRizinCapability(reverse, request.input as ReverseCapabilityInput, context.fixture.path, this.availabilityState.executable!, this.availabilityState.runner, signal),
    };
  }
}

export class McpReverseCapabilityBackend implements CapabilityBackend {
  public readonly id = "proofblade-mcp-reverse";
  public readonly kind = "mcp" as const;
  public readonly priority = 85;
  private readonly adapterVersion = "1";

  public constructor(private readonly mcp: McpProjectRegistry) {}

  public status(): CapabilityBackendStatus {
    const configured = (['functions', 'disassemble', 'xrefs'] as const).map((operation) => this.mcp.binaryReverse(operation)).filter((binding): binding is McpBinaryReverseOperation => Boolean(binding));
    const available = configured.filter((binding) => this.bindingAvailability(binding).available);
    return {
      id: this.id,
      kind: this.kind,
      version: this.versionForCatalog(),
      priority: this.priority,
      available: available.length > 0,
      reason: configured.length === 0 ? "no binaryReverse MCP mappings" : available.length === 0 ? "all binaryReverse MCP servers are unavailable" : undefined,
    };
  }

  public handles(capabilityId: string, operation: string): boolean {
    return capabilityId === "proofblade.binary" && (operation === "functions" || operation === "disassemble" || operation === "xrefs") && this.mcp.binaryReverse(operation) !== undefined;
  }

  public availability(request: CapabilityBackendRequest): CapabilityBackendAvailability {
    const reverse = request.operation === "functions" || request.operation === "disassemble" || request.operation === "xrefs" ? request.operation : undefined;
    const binding = reverse ? this.mcp.binaryReverse(reverse) : undefined;
    if (!reverse || !binding) return { available: false, reason: `no binaryReverse MCP mapping for ${request.operation}` };
    try {
      validateReverseInput(reverse, request.input);
      const mapped = this.prepareMcpCall(reverse, request.input);
      const policy = this.mcp.resolveInvocation(mapped.capabilityId, "call", mapped.input);
      assertReadOnlyReversePolicy(reverse, policy.readOnly, policy.replay);
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return this.bindingAvailability(binding);
  }

  public versionFor(_request: CapabilityBackendRequest): string {
    return this.versionForCatalog();
  }

  public preparePersistence(request: CapabilityBackendRequest, operation: CapabilityOperationAtom): CapabilityBackendPersistence {
    const reverse = reverseOperation(request.operation);
    validateReverseInput(reverse, request.input);
    const mapped = this.prepareMcpCall(reverse, request.input);
    const policy = this.mcp.resolveInvocation(mapped.capabilityId, "call", mapped.input);
    assertReadOnlyReversePolicy(reverse, policy.readOnly, policy.replay);
    return { operation: { ...operation, readOnly: policy.readOnly, sideEffect: policy.sideEffect, replay: policy.replay }, input: structuredClone(request.input), argsRedacted: false };
  }

  public prepareExecution(request: CapabilityBackendRequest, operation: CapabilityOperationAtom, context: CapabilityBackendContext): CapabilityBackendExecution {
    const reverse = reverseOperation(request.operation);
    validateReverseInput(reverse, request.input);
    const mapped = this.prepareMcpCall(reverse, request.input);
    const policy = this.mcp.resolveInvocation(mapped.capabilityId, "call", mapped.input);
    assertReadOnlyReversePolicy(reverse, policy.readOnly, policy.replay);
    return {
      operation: `mcp-reverse:${reverse}`,
      args: this.mcp.effectArgs(mapped.capabilityId, "call", mapped.input, policy),
      replayPolicy: operation.replay,
      artifactSensitivity: policy.sensitivity === "secret" ? "secret" : undefined,
      cwd: context.runsRoot,
      execute: async (signal) => await withStagedVisibleBinary(context.fixture.path, String(request.input.path), signal, async (stagedPath) => {
        const staged = this.prepareMcpCall(reverse, { ...request.input, path: stagedPath });
        const result = await this.mcp.execute(staged.capabilityId, "call", staged.input, signal);
        if (result.exitCode !== 0) return result;
        return { ...result, stdout: JSON.stringify(normalizeMcpReverseOutput(reverse, result.stdout, request.input), null, 2) };
      }),
    };
  }

  private bindingAvailability(binding: McpBinaryReverseOperation): CapabilityBackendAvailability {
    const capabilityId = this.mcp.serverCapabilityId(binding.server);
    const server = capabilityId ? this.mcp.summaries().find((item) => item.capabilityId === capabilityId) : undefined;
    if (!capabilityId || !server || server.disabled) return { available: false, reason: `MCP server ${binding.server} is not configured or disabled` };
    if (server.status === "unavailable") return { available: false, reason: server.toolchain?.reason ?? `MCP server ${binding.server} toolchain is unavailable` };
    const retryAfterMs = this.mcp.retryAfterMs(capabilityId);
    if (server.status === "failed" && retryAfterMs > 0) return { available: false, reason: `MCP server ${binding.server} connection failed; retry available in ${retryAfterMs}ms` };
    return { available: true };
  }

  private prepareMcpCall(operation: ReverseOperation, input: Record<string, unknown>): { capabilityId: string; input: Record<string, unknown> } {
    const binding = this.mcp.binaryReverse(operation);
    if (!binding) throw new Error(`No binaryReverse MCP mapping for ${operation}`);
    const capabilityId = this.mcp.serverCapabilityId(binding.server);
    if (!capabilityId) throw new Error(`MCP server ${binding.server} is not configured`);
    const mappedArguments = mapReverseArguments(binding, input);
    const argumentsValue = binding.nestedTool
      ? { [binding.nestedTool.toolField]: binding.nestedTool.name, ...(binding.nestedTool.argumentsField ? { [binding.nestedTool.argumentsField]: mappedArguments } : mappedArguments) }
      : mappedArguments;
    return { capabilityId, input: { tool: binding.tool, arguments: argumentsValue } };
  }

  private versionForCatalog(): string {
    return `${this.mcp.catalogHash()}:reverse-adapter-${this.adapterVersion}`;
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
    const available = configured.filter((server) => server.status !== "unavailable" && (server.status !== "failed" || this.mcp.retryAfterMs(server.capabilityId) === 0));
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
    if (server.status === "unavailable") return { available: false, reason: server.toolchain?.reason ?? `MCP server ${server.name} toolchain is unavailable` };
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

function mapReverseArguments(binding: McpBinaryReverseOperation, input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [name, mapping] of Object.entries(binding.arguments)) {
    if (typeof mapping === "string" && mapping.startsWith("$")) {
      const value = input[mapping.slice(1)];
      if (value !== undefined) output[name] = value;
    } else {
      output[name] = mapping;
    }
  }
  if (binding.nestedTool && binding.nestedTool.argumentsField === undefined && Object.keys(output).length > 0) {
    throw new Error(`binaryReverse nested tool ${binding.nestedTool.name} requires argumentsField for mapped arguments`);
  }
  return output;
}

function assertReadOnlyReversePolicy(operation: ReverseOperation, readOnly: boolean, replay: ReplayPolicy): void {
  if (!readOnly || replay !== "pure") throw new Error(`MCP reverse mapping for ${operation} must declare readOnly=true and replay=pure`);
}

function normalizeMcpReverseOutput(operation: ReverseOperation, stdout: string, input: Record<string, unknown>): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`MCP reverse ${operation} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const payload = unwrapMcpResult(parsed);
  if (operation === "functions") return { format: "mcp", functions: normalizeFunctions(reverseRows(payload, "functions"), typeof input.maxResults === "number" ? input.maxResults : 2_000) };
  if (operation === "disassemble") return {
    format: "mcp",
    address: String(input.address),
    instructions: normalizeInstructions(reverseRows(payload, "instructions"), typeof input.maxInstructions === "number" ? input.maxInstructions : 128),
  };
  return {
    format: "mcp",
    address: String(input.address),
    direction: input.direction ?? "to",
    xrefs: normalizeXrefs(reverseRows(payload, "xrefs"), typeof input.maxResults === "number" ? input.maxResults : 1_000),
  };
}

function unwrapMcpResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const object = value as Record<string, unknown>;
  const result = object.result && typeof object.result === "object" ? object.result : value;
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const resultObject = result as Record<string, unknown>;
  if (resultObject.structuredContent !== undefined) return resultObject.structuredContent;
  if (!Array.isArray(resultObject.content)) return result;
  const texts = resultObject.content.filter((item): item is { type?: unknown; text: string } => Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string").map((item) => item.text);
  for (const text of texts) {
    try { return JSON.parse(text); } catch { /* fall through to the next text block */ }
  }
  return texts.length === 1 ? texts[0] : result;
}

function reverseRows(value: unknown, field: "functions" | "instructions" | "xrefs"): Array<Record<string, unknown>> {
  const candidate = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>)[field]) ? (value as Record<string, unknown>)[field] : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).data) ? (value as Record<string, unknown>).data : undefined;
  if (!Array.isArray(candidate) || candidate.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new Error(`MCP reverse output must contain an array of ${field}`);
  return candidate as Array<Record<string, unknown>>;
}
