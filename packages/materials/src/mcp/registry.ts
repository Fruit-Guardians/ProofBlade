import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Client, SdkErrorCode, StreamableHTTPClientTransport, type ListToolsResult } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import type { ToolSensitivityAtom, ToolSideEffectAtom } from "@proofblade/atoms";
import { withCapabilityHash, type CapabilityManifest } from "@proofblade/molecules";
import type { RawEffectResult, ReplayPolicy } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";

export interface McpServerDefinition {
  /** stdio launch command. Provide EITHER command OR url, not both. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Streamable-HTTP endpoint for a long-running MCP server (e.g. idalib-mcp on :8745). */
  url?: string;
  description?: string;
  requestTimeoutMs?: number;
  includeTools?: string[];
  excludeTools?: string[];
  disabled?: boolean;
  readOnly?: boolean;
  sideEffect?: ToolSideEffectAtom;
  replay?: ReplayPolicy;
  sensitivity?: ToolSensitivityAtom;
  resourceKeys?: string[];
  redactArguments?: string[];
  nestedToolPolicy?: McpNestedToolPolicy;
  protocolVersion?: "legacy" | "auto" | "2026-07-28";
  toolchain?: McpToolchainProfile;
}

/**
 * A portable declaration for an external program that an MCP server controls.
 * The path itself stays in the host environment, not in project configuration.
 */
export interface McpToolchainProfile {
  kind: McpToolchainKind;
  pathEnvironment: string;
  injectEnvironment?: string;
  pathKind?: "file" | "directory";
}

export type McpToolchainKind = "ida-pro" | "idalib" | "jadx" | "ghidra" | "rizin" | "custom";
export type McpToolchainState = "ready" | "missing" | "invalid";

export type McpReverseOutput = "functions" | "disassemble" | "xrefs";
export type McpReverseArgumentValue = string | number | boolean | null;

export interface McpBinaryReverseOperation {
  server: string;
  tool: string;
  arguments: Record<string, McpReverseArgumentValue>;
  output: McpReverseOutput;
  nestedTool?: {
    name: string;
    toolField: string;
    argumentsField?: string;
  };
}

export interface McpBinaryReverseConfig {
  functions?: McpBinaryReverseOperation;
  disassemble?: McpBinaryReverseOperation;
  xrefs?: McpBinaryReverseOperation;
}

export interface McpNestedToolPolicy {
  dispatcherTool: string;
  toolField: string;
  argumentsField?: string;
  includeTools?: string[];
  excludeTools?: string[];
  tools: Record<string, McpNestedToolDefinition>;
}

export interface McpNestedToolDefinition {
  readOnly: boolean;
  sideEffect: ToolSideEffectAtom;
  replay: ReplayPolicy;
  sensitivity?: ToolSensitivityAtom;
  resourceKeys?: string[];
  redactArguments?: string[];
}

export interface McpResolvedInvocationPolicy {
  readOnly: boolean;
  sideEffect: ToolSideEffectAtom;
  replay: ReplayPolicy;
  sensitivity: ToolSensitivityAtom;
  resourceKeys: string[];
  redactArguments: string[];
  outerTool?: string;
  innerTool?: string;
}

export interface McpPersistedInvocationInput {
  input: Record<string, unknown>;
  argsRedacted: boolean;
}

export interface McpProjectConfig {
  mcpServers: Record<string, McpServerDefinition>;
  binaryReverse?: McpBinaryReverseConfig;
}

export interface McpServerSummary {
  name: string;
  capabilityId: string;
  description: string;
  disabled: boolean;
  status: "configured" | "connected" | "failed" | "disabled" | "unavailable";
  configHash: string;
  toolchain?: McpToolchainSummary;
}

export interface McpToolchainSummary {
  kind: McpToolchainKind;
  state: McpToolchainState;
  pathEnvironment: string;
  injectEnvironment: string;
  reason?: string;
}

export interface McpToolSummary {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean;
}

export const MCP_SCHEMA_CACHE_FILE = ".proofblade/mcp-schema-cache.json";

interface PersistedMcpSchemaCache {
  schemaVersion: 1;
  servers: Record<string, { configHash: string; tools: McpToolSummary[] }>;
}

/** Failed MCP processes are retried after a short cooldown instead of being
 * treated as permanently unavailable for the lifetime of a Runtime. */
export const MCP_FAILURE_RETRY_DELAY_MS = 1_000;

interface McpConnection {
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools?: McpToolSummary[];
}

interface PendingMcpConnection {
  promise: Promise<McpConnection>;
  controller: AbortController;
}

interface McpServerEntry {
  name: string;
  capabilityId: string;
  definition: McpServerDefinition;
  configHash: string;
}

export class McpProjectRegistry {
  private readonly definitions: McpServerEntry[];
  private readonly connections = new Map<string, McpConnection>();
  private readonly connecting = new Map<string, PendingMcpConnection>();
  private readonly failures = new Map<string, number>();
  private readonly schemaCache = new Map<string, McpToolSummary[]>();
  private schemaCacheWrite: Promise<void> = Promise.resolve();
  private closed = false;

  private readonly binaryReverseConfig: McpBinaryReverseConfig;

  private constructor(private readonly projectRoot: string, definitions: Record<string, McpServerDefinition>, binaryReverse: McpBinaryReverseConfig = {}) {
    const capabilityIds = new Set<string>();
    this.definitions = Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b)).map(([name, definition]) => {
      validateServer(name, definition, projectRoot);
      const capabilityId = `mcp.${name.replace(/_/g, "-")}`;
      if (capabilityIds.has(capabilityId)) throw new Error(`MCP server names collide after normalization: ${name}`);
      capabilityIds.add(capabilityId);
      return { name, capabilityId, definition: structuredClone(definition), configHash: serverConfigHash(name, definition) };
    });
    validateBinaryReverseConfig(binaryReverse, definitions);
    this.binaryReverseConfig = structuredClone(binaryReverse);
    this.loadSchemaCache();
  }

  public static load(projectRoot: string, configPath = ".mcp.json"): McpProjectRegistry {
    const root = resolve(projectRoot);
    const path = isAbsolute(configPath) ? resolve(configPath) : resolve(root, configPath);
    if (!isWithin(root, path)) throw new Error("MCP config must be inside the project root");
    if (!existsSync(path)) return new McpProjectRegistry(root, {});
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<McpProjectConfig>;
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)) throw new Error(`Invalid MCP config: ${path}`);
    return new McpProjectRegistry(root, parsed.mcpServers, parsed.binaryReverse ?? {});
  }

  public binaryReverse(operation: McpReverseOutput): McpBinaryReverseOperation | undefined {
    const binding = this.binaryReverseConfig[operation];
    return binding ? structuredClone(binding) : undefined;
  }

  public serverCapabilityId(name: string): string | undefined {
    return this.definitions.find((entry) => entry.name === name)?.capabilityId;
  }

  public summaries(): McpServerSummary[] {
    return this.definitions.map((entry) => {
      const toolchain = diagnoseToolchain(entry.definition.toolchain);
      const disabled = entry.definition.disabled === true;
      return {
        name: entry.name,
        capabilityId: entry.capabilityId,
        description: entry.definition.description ?? `Project MCP server ${entry.name}`,
        disabled,
        status: disabled ? "disabled" : toolchain && toolchain.state !== "ready" ? "unavailable" : this.connections.has(entry.name) ? "connected" : this.failures.has(entry.name) ? "failed" : "configured",
        configHash: entry.configHash,
        ...(toolchain ? { toolchain } : {}),
      };
    });
  }

  public catalogHash(): string {
    // Host paths and their current availability are intentionally excluded. They
    // must not change a portable catalog or be persisted into a Run snapshot.
    const summaries = this.definitions.map((entry) => ({
      name: entry.name,
      capabilityId: entry.capabilityId,
      description: entry.definition.description ?? `Project MCP server ${entry.name}`,
      disabled: entry.definition.disabled === true,
      configHash: entry.configHash,
    }));
    return sha256(canonicalJson(Object.keys(this.binaryReverseConfig).length === 0 ? summaries : { summaries, binaryReverse: this.binaryReverseConfig }));
  }

  /** Return the remaining cooldown before a failed server may be retried. */
  public retryAfterMs(capabilityId: string, now = Date.now()): number {
    const entry = this.definitions.find((item) => item.capabilityId === capabilityId);
    if (!entry) return 0;
    const failedAt = this.failures.get(entry.name);
    if (failedAt === undefined) return 0;
    return Math.max(0, failedAt + MCP_FAILURE_RETRY_DELAY_MS - now);
  }

  /** Clear failed connection state so the next operation retries immediately. */
  public resetFailures(capabilityId?: string): void {
    if (capabilityId === undefined) {
      this.failures.clear();
      return;
    }
    const entry = this.definitions.find((item) => item.capabilityId === capabilityId);
    if (entry) this.failures.delete(entry.name);
  }

  public capabilityManifests(): CapabilityManifest[] {
    return this.definitions.filter((entry) => !entry.definition.disabled).map((entry) => withCapabilityHash({
      id: entry.capabilityId,
      version: "1.0.0",
      description: entry.definition.description ?? `Project MCP server ${entry.name}`,
      trust: "local",
      operations: [
        {
          name: "describe",
          description: "Connect lazily and return the allowed MCP tool schemas for this server.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          readOnly: true,
          sideEffect: "process",
          replay: "manual",
          outputPolicy: "summary",
          executionMode: "sequential",
        },
        {
          name: "call",
          description: "Call one allowed MCP tool through the ProofBlade effect and artifact boundary.",
          parameters: {
            type: "object",
            properties: { tool: { type: "string" }, arguments: { type: "object" } },
            required: ["tool", "arguments"],
            additionalProperties: false,
          },
          readOnly: entry.definition.readOnly === true,
          sideEffect: entry.definition.sideEffect ?? "process",
          replay: entry.definition.replay ?? "manual",
          outputPolicy: "summary",
          executionMode: "sequential",
        },
      ],
    }));
  }

  public handles(capabilityId: string): boolean {
    return this.definitions.some((entry) => entry.capabilityId === capabilityId && !entry.definition.disabled);
  }

  public resolveInvocation(capabilityId: string, operation: string, input: Record<string, unknown>): McpResolvedInvocationPolicy {
    const entry = this.definitions.find((item) => item.capabilityId === capabilityId && !item.definition.disabled);
    if (!entry) throw new Error(`Unknown MCP capability: ${capabilityId}`);
    const base = serverInvocationPolicy(entry);
    if (operation === "describe") {
      return {
        readOnly: true,
        sideEffect: "process",
        replay: "manual",
        sensitivity: "public",
        resourceKeys: base.resourceKeys,
        redactArguments: [],
      };
    }
    if (operation !== "call") throw new Error(`Unsupported MCP operation: ${operation}`);
    const outerTool = typeof input.tool === "string" ? input.tool : "";
    const args = input.arguments;
    if (!outerTool || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("MCP call requires tool and object arguments");
    const nested = entry.definition.nestedToolPolicy;
    if (!nested || outerTool !== nested.dispatcherTool) return { ...base, outerTool };
    const dispatchArgs = args as Record<string, unknown>;
    const innerTool = typeof dispatchArgs[nested.toolField] === "string" ? String(dispatchArgs[nested.toolField]) : "";
    if (!innerTool) throw new Error(`MCP nested dispatcher ${entry.name}.${outerTool} requires string field ${nested.toolField}`);
    const innerArgs = nested.argumentsField === undefined ? {} : dispatchArgs[nested.argumentsField];
    if (innerArgs !== undefined && (!innerArgs || typeof innerArgs !== "object" || Array.isArray(innerArgs))) {
      throw new Error(`MCP nested dispatcher ${entry.name}.${outerTool} requires object field ${nested.argumentsField}`);
    }
    const includes = nested.includeTools ? new Set(nested.includeTools) : undefined;
    const excludes = new Set(nested.excludeTools ?? []);
    const definition = Object.hasOwn(nested.tools, innerTool) ? nested.tools[innerTool] : undefined;
    if (!definition || (includes && !includes.has(innerTool)) || excludes.has(innerTool)) {
      throw new Error(`MCP nested tool is not allowed: ${entry.name}.${outerTool} -> ${innerTool}`);
    }
    return {
      readOnly: definition.readOnly,
      sideEffect: definition.sideEffect,
      replay: definition.replay,
      sensitivity: definition.sensitivity ?? "target",
      resourceKeys: [...(definition.resourceKeys ?? [`mcp:${entry.name}`, `mcp-tool:${entry.name}:${innerTool}`])],
      redactArguments: [...(definition.redactArguments ?? [])],
      outerTool,
      innerTool,
    };
  }

  public effectArgs(capabilityId: string, operation: string, input: Record<string, unknown>, policy: McpResolvedInvocationPolicy): Record<string, unknown> {
    return {
      capabilityId,
      operation,
      mcp: {
        ...(policy.outerTool ? { outerTool: policy.outerTool } : {}),
        ...(policy.innerTool ? { innerTool: policy.innerTool } : {}),
        policy: {
          readOnly: policy.readOnly,
          sideEffect: policy.sideEffect,
          replay: policy.replay,
          sensitivity: policy.sensitivity,
          resourceKeys: policy.resourceKeys,
        },
      },
      input: this.persistedInput(input, policy).input,
    };
  }

  public persistedInput(input: Record<string, unknown>, policy: McpResolvedInvocationPolicy): McpPersistedInvocationInput {
    const persisted = redactSensitiveValues(input, "", new Set(policy.redactArguments)) as Record<string, unknown>;
    return {
      input: persisted,
      argsRedacted: canonicalJson(persisted) !== canonicalJson(input),
    };
  }

  public async execute(capabilityId: string, operation: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<RawEffectResult> {
    const entry = this.definitions.find((item) => item.capabilityId === capabilityId && !item.definition.disabled);
    if (!entry) throw new Error(`Unknown MCP capability: ${capabilityId}`);
    const started = Date.now();
    let connection: McpConnection | undefined;
    try {
      if (operation === "describe") {
        if (Object.keys(input).length > 0) throw new Error("MCP describe takes no input");
        const description = await this.describeServer(entry.name, signal);
        return { stdout: JSON.stringify(description, null, 2), stderr: "", exitCode: 0, durationMs: Date.now() - started, externalId: externalId(this.connections.get(entry.name)) };
      }
      if (operation !== "call") throw new Error(`Unsupported MCP operation: ${operation}`);
      const policy = this.resolveInvocation(capabilityId, operation, input);
      const tool = typeof input.tool === "string" ? input.tool : "";
      const args = input.arguments;
      if (!tool || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("MCP call requires tool and object arguments");
      connection = await this.ensureConnection(entry.name, signal);
      const tools = await this.describe(entry.name, signal);
      if (!tools.some((item) => item.name === tool)) throw new Error(`MCP tool is not allowed: ${entry.name}.${tool}`);
      const result = await connection.client.callTool({ name: tool, arguments: args as Record<string, unknown> }, requestOptions(entry.definition, signal));
      const secrets = [...resolvedEnvSecrets(entry.definition.env), ...resolvedToolchainValues(entry.definition.toolchain), ...sensitiveArgumentValues(args as Record<string, unknown>, new Set(policy.redactArguments))];
      const stdout = redactText(JSON.stringify({ server: entry.name, tool, result }, null, 2), secrets);
      const stderr = result.isError ? redactText(mcpToolErrorMessage(entry.name, tool, result), secrets) : "";
      return { stdout, stderr, exitCode: result.isError ? 1 : 0, durationMs: Date.now() - started, externalId: externalId(connection) };
    } catch (error) {
      if (connection && isTransportFailure(error)) await this.invalidateConnection(entry.name, connection);
      return { stdout: "", stderr: redactText(error instanceof Error ? error.message : String(error), [...resolvedEnvSecrets(entry.definition.env), ...resolvedToolchainValues(entry.definition.toolchain)]), exitCode: signal?.aborted ? null : 1, durationMs: Date.now() - started, externalId: externalId(this.connections.get(entry.name)) };
    }
  }

  public async describe(name: string, signal?: AbortSignal): Promise<McpToolSummary[]> {
    const entry = this.entry(name);
    const cached = this.schemaCache.get(name);
    const existing = this.connections.get(name);
    if (!existing && cached) return cloneToolSummaries(cached);
    const connection = existing ?? await this.ensureConnection(name, signal);
    if (!connection.tools) {
      if (cached) {
        connection.tools = cloneToolSummaries(cached);
      } else {
        try {
          const result = await connection.client.listTools(undefined, requestOptions(entry.definition, signal));
          connection.tools = allowedTools(result, entry.definition).sort((a, b) => a.name.localeCompare(b.name));
          this.schemaCache.set(name, cloneToolSummaries(connection.tools));
          await this.persistSchemaCache();
        } catch (error) {
          if (isTransportFailure(error)) await this.invalidateConnection(name, connection);
          throw error;
        }
      }
    }
    return cloneToolSummaries(connection.tools);
  }

  public async describeServer(name: string, signal?: AbortSignal): Promise<{ server: string; configHash: string; tools: McpToolSummary[]; nestedTools?: Array<McpNestedToolDefinition & { name: string }> }> {
    const entry = this.entry(name);
    const tools = await this.describe(name, signal);
    const nestedTools = allowedNestedTools(entry.definition);
    return { server: entry.name, configHash: entry.configHash, tools, ...(nestedTools.length > 0 ? { nestedTools } : {}) };
  }

  public async close(): Promise<void> {
    if (this.closed && this.connecting.size === 0 && this.connections.size === 0) return;
    this.closed = true;
    for (const pending of this.connecting.values()) pending.controller.abort(new Error("MCP registry is closing"));
    const pending = await Promise.allSettled([...this.connecting.values()].map((item) => item.promise));
    const connected = [...this.connections.values(), ...pending.flatMap((item) => item.status === "fulfilled" ? [item.value] : [])];
    this.connecting.clear();
    this.connections.clear();
    const results = await Promise.allSettled([...new Set(connected)].map((entry) => closeMcpConnection(entry)));
    const failures = results.flatMap((item) => item.status === "rejected" ? [item.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "MCP connection cleanup failed");
  }

  private entry(name: string): McpServerEntry {
    const entry = this.definitions.find((item) => item.name === name && !item.definition.disabled);
    if (!entry) throw new Error(`Unknown MCP server: ${name}`);
    return entry;
  }

  private loadSchemaCache(): void {
    try {
      const parsed = JSON.parse(readFileSync(resolve(this.projectRoot, MCP_SCHEMA_CACHE_FILE), "utf8")) as PersistedMcpSchemaCache;
      if (parsed.schemaVersion !== 1 || !parsed.servers || typeof parsed.servers !== "object") return;
      for (const entry of this.definitions) {
        const cached = parsed.servers[entry.name];
        if (!cached || cached.configHash !== entry.configHash || !Array.isArray(cached.tools)) continue;
        if (cached.tools.every(isMcpToolSummary)) this.schemaCache.set(entry.name, cloneToolSummaries(cached.tools));
      }
    } catch {
      // Schema cache is an optimization. A missing/corrupt cache falls back to
      // the normal lazy MCP handshake and listTools call.
    }
  }

  private async persistSchemaCache(): Promise<void> {
    this.schemaCacheWrite = this.schemaCacheWrite.then(async () => {
      const path = resolve(this.projectRoot, MCP_SCHEMA_CACHE_FILE);
      const directory = resolve(this.projectRoot, ".proofblade");
      await mkdir(directory, { recursive: true });
      const servers: PersistedMcpSchemaCache["servers"] = {};
      for (const entry of this.definitions) {
        const tools = this.schemaCache.get(entry.name);
        if (tools) servers[entry.name] = { configHash: entry.configHash, tools: cloneToolSummaries(tools) };
      }
      const temporary = `${path}.tmp-${process.pid}`;
      await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, servers } satisfies PersistedMcpSchemaCache, null, 2)}\n`, "utf8");
      await rename(temporary, path);
    }).catch(() => undefined);
    await this.schemaCacheWrite;
  }

  private async ensureConnection(name: string, signal?: AbortSignal): Promise<McpConnection> {
    if (this.closed) throw new Error("MCP registry is closed");
    const existing = this.connections.get(name);
    if (existing) return existing;
    const pending = this.connecting.get(name);
    if (pending) return await pending.promise;
    const entry = this.entry(name);
    const toolchain = diagnoseToolchain(entry.definition.toolchain);
    if (toolchain && toolchain.state !== "ready") throw new Error(toolchain.reason ?? `MCP server ${name} toolchain is unavailable`);
    const controller = new AbortController();
    const connectSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const connecting = this.connect(entry, connectSignal).finally(() => {
      const current = this.connecting.get(name);
      if (current?.controller === controller) this.connecting.delete(name);
    });
    this.connecting.set(name, { promise: connecting, controller });
    return await connecting;
  }

  private async invalidateConnection(name: string, connection: McpConnection): Promise<void> {
    if (this.connections.get(name) !== connection) return;
    this.connections.delete(name);
    this.failures.set(name, Date.now());
    await closeMcpConnection(connection).catch(() => undefined);
  }

  private async connect(entry: McpServerEntry, signal?: AbortSignal): Promise<McpConnection> {
    const transport: StdioClientTransport | StreamableHTTPClientTransport = entry.definition.url
      ? new StreamableHTTPClientTransport(new URL(entry.definition.url))
      : (() => {
        const cwd = resolve(this.projectRoot, entry.definition.cwd ?? ".");
        const env = { ...getDefaultEnvironment(), ...resolveEnvironment(entry.definition.env), ...toolchainEnvironment(entry.definition.toolchain) };
        return new StdioClientTransport({ command: entry.definition.command!, args: entry.definition.args, cwd, env, stderr: "pipe" });
      })();
    const client = new Client(
      { name: `proofblade-${entry.name}`, version: "0.1.0" },
      { versionNegotiation: entry.definition.protocolVersion === "auto" ? { mode: "auto" } : entry.definition.protocolVersion === "2026-07-28" ? { mode: { pin: "2026-07-28" } } : undefined },
    );
    const onAbort = (): void => {
      const pid = transportPid(transport);
      if (pid !== undefined) void terminateMcpProcess(pid);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await client.connect(transport, requestOptions(entry.definition, signal));
      const connection = { client, transport };
      this.connections.set(entry.name, connection);
      this.failures.delete(entry.name);
      return connection;
    } catch (error) {
      this.failures.set(entry.name, Date.now());
      const pid = transportPid(transport);
      if (pid !== undefined) await terminateMcpProcess(pid);
      // A failed handshake can leave the SDK client in a state where
      // client.close() resolves without closing the stdio transport. Close
      // the transport first while it still owns the child-process handle, then
      // close the protocol layer so the child process and cwd handles are
      // released before the failed connection is observed by callers.
      await transport.close().catch(() => undefined);
      await client.close().catch(() => undefined);
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function isTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  if ([SdkErrorCode.ConnectionClosed, SdkErrorCode.NotConnected, SdkErrorCode.SendFailed].includes(code as SdkErrorCode)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /connection\s+(?:closed|lost)|transport\s+(?:closed|error)|broken\s+pipe|not\s+connected/i.test(message);
}

function validateServer(name: string, definition: McpServerDefinition, projectRoot: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error(`Invalid MCP server name: ${name}`);
  if (!definition || typeof definition !== "object") throw new Error(`MCP server ${name} requires command or url`);
  const hasCommand = typeof definition.command === "string" && definition.command.trim() !== "";
  const hasUrl = typeof definition.url === "string" && definition.url.trim() !== "";
  if (hasCommand && hasUrl) throw new Error(`MCP server ${name} must set command or url, not both`);
  if (!hasCommand && !hasUrl) throw new Error(`MCP server ${name} requires command or url`);
  if (hasUrl) {
    let parsed: URL;
    try { parsed = new URL(definition.url!); } catch { throw new Error(`MCP server ${name} has an invalid url`); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`MCP server ${name} url must be http or https`);
  }
  if (definition.args && (!Array.isArray(definition.args) || definition.args.some((item) => typeof item !== "string"))) throw new Error(`MCP server ${name} has invalid args`);
  if (definition.env && (typeof definition.env !== "object" || Array.isArray(definition.env) || Object.values(definition.env).some((item) => typeof item !== "string"))) throw new Error(`MCP server ${name} has invalid env`);
  validateToolchain(name, definition.toolchain, definition.env);
  if (definition.readOnly !== undefined && typeof definition.readOnly !== "boolean") throw new Error(`MCP server ${name} has invalid readOnly`);
  if (definition.requestTimeoutMs !== undefined && (!Number.isInteger(definition.requestTimeoutMs) || definition.requestTimeoutMs < 50 || definition.requestTimeoutMs > 120_000)) throw new Error(`MCP server ${name} requestTimeoutMs must be between 50 and 120000`);
  for (const list of [definition.includeTools, definition.excludeTools]) if (list && (!Array.isArray(list) || list.some((item) => typeof item !== "string" || item.length === 0))) throw new Error(`MCP server ${name} has an invalid tool filter`);
  validateEffectPolicy(name, definition);
  validateNestedToolPolicy(name, definition.nestedToolPolicy);
  if (!isWithin(projectRoot, resolve(projectRoot, definition.cwd ?? "."))) throw new Error(`MCP server ${name} cwd escapes the project root`);
}

function validateToolchain(name: string, toolchain: McpToolchainProfile | undefined, environment: Record<string, string> | undefined): void {
  if (!toolchain) return;
  if (!TOOLCHAIN_KINDS.has(toolchain.kind)) throw new Error(`MCP server ${name} has an unsupported toolchain kind`);
  if (!environmentName(toolchain.pathEnvironment)) throw new Error(`MCP server ${name} toolchain requires a valid pathEnvironment`);
  if (toolchain.injectEnvironment !== undefined && !environmentName(toolchain.injectEnvironment)) throw new Error(`MCP server ${name} toolchain has an invalid injectEnvironment`);
  if (toolchain.pathKind !== undefined && toolchain.pathKind !== "file" && toolchain.pathKind !== "directory") throw new Error(`MCP server ${name} toolchain has an invalid pathKind`);
  const inject = toolchainInjectEnvironment(toolchain);
  if (environment && Object.hasOwn(environment, inject)) throw new Error(`MCP server ${name} toolchain injectEnvironment must not also be declared in env`);
}

function validateBinaryReverseConfig(config: unknown, definitions: Record<string, McpServerDefinition>): asserts config is McpBinaryReverseConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid binaryReverse MCP configuration");
  for (const [operation, binding] of Object.entries(config as Record<string, unknown>)) {
    if (operation !== "functions" && operation !== "disassemble" && operation !== "xrefs") throw new Error(`Unsupported binaryReverse operation: ${operation}`);
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error(`Invalid binaryReverse mapping for ${operation}`);
    const item = binding as Record<string, unknown>;
    if (typeof item.server !== "string" || !Object.hasOwn(definitions, item.server)) throw new Error(`binaryReverse.${operation} references an unknown MCP server`);
    if (definitions[item.server]?.disabled === true) throw new Error(`binaryReverse.${operation} references a disabled MCP server`);
    if (typeof item.tool !== "string" || item.tool.length === 0) throw new Error(`binaryReverse.${operation} requires tool`);
    if (item.output !== operation) throw new Error(`binaryReverse.${operation}.output must be ${operation}`);
    if (!item.arguments || typeof item.arguments !== "object" || Array.isArray(item.arguments)) throw new Error(`binaryReverse.${operation} requires an arguments mapping`);
    for (const [argument, value] of Object.entries(item.arguments as Record<string, unknown>)) {
      if (!argument || !isMcpReverseArgumentValue(value)) throw new Error(`binaryReverse.${operation} has an invalid argument mapping for ${argument}`);
      if (typeof value === "string" && value.startsWith("$") && !REVERSE_INPUT_FIELDS.has(value.slice(1))) {
        throw new Error(`binaryReverse.${operation} references an unknown input field: ${value}`);
      }
    }
    if (item.nestedTool !== undefined) {
      if (!item.nestedTool || typeof item.nestedTool !== "object" || Array.isArray(item.nestedTool)) throw new Error(`binaryReverse.${operation}.nestedTool must be an object`);
      const nested = item.nestedTool as Record<string, unknown>;
      if (typeof nested.name !== "string" || nested.name.length === 0 || typeof nested.toolField !== "string" || nested.toolField.length === 0) throw new Error(`binaryReverse.${operation}.nestedTool requires name and toolField`);
      if (nested.argumentsField !== undefined && (typeof nested.argumentsField !== "string" || nested.argumentsField.length === 0)) throw new Error(`binaryReverse.${operation}.nestedTool has invalid argumentsField`);
      const serverPolicy = definitions[String(item.server)]?.nestedToolPolicy;
      if (!serverPolicy || serverPolicy.dispatcherTool !== item.tool || serverPolicy.toolField !== nested.toolField || serverPolicy.argumentsField !== nested.argumentsField) throw new Error(`binaryReverse.${operation}.nestedTool must match the MCP server nestedToolPolicy`);
    }
  }
}

function isMcpReverseArgumentValue(value: unknown): value is McpReverseArgumentValue {
  return value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean";
}

function validateEffectPolicy(name: string, definition: Pick<McpServerDefinition, "sideEffect" | "replay" | "sensitivity" | "resourceKeys" | "redactArguments">): void {
  if (definition.sideEffect !== undefined && !SIDE_EFFECTS.has(definition.sideEffect)) throw new Error(`MCP server ${name} has invalid sideEffect`);
  if (definition.replay !== undefined && !REPLAY_POLICIES.has(definition.replay)) throw new Error(`MCP server ${name} has invalid replay policy`);
  if (definition.sensitivity !== undefined && !SENSITIVITIES.has(definition.sensitivity)) throw new Error(`MCP server ${name} has invalid sensitivity`);
  for (const [label, list] of [["resourceKeys", definition.resourceKeys], ["redactArguments", definition.redactArguments]] as const) {
    if (list && (!Array.isArray(list) || list.some((item) => typeof item !== "string" || item.length === 0))) throw new Error(`MCP server ${name} has invalid ${label}`);
  }
}

function validateNestedToolPolicy(name: string, policy: McpNestedToolPolicy | undefined): void {
  if (!policy) return;
  for (const [label, value] of [["dispatcherTool", policy.dispatcherTool], ["toolField", policy.toolField]] as const) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`MCP server ${name} nestedToolPolicy requires ${label}`);
  }
  if (policy.argumentsField !== undefined && (typeof policy.argumentsField !== "string" || policy.argumentsField.length === 0)) throw new Error(`MCP server ${name} nestedToolPolicy has invalid argumentsField`);
  for (const list of [policy.includeTools, policy.excludeTools]) if (list && (!Array.isArray(list) || list.some((item) => typeof item !== "string" || item.length === 0))) throw new Error(`MCP server ${name} nestedToolPolicy has an invalid tool filter`);
  if (!policy.tools || typeof policy.tools !== "object" || Array.isArray(policy.tools)) throw new Error(`MCP server ${name} nestedToolPolicy requires tools`);
  for (const [tool, definition] of Object.entries(policy.tools)) {
    if (!tool || !definition || typeof definition !== "object") throw new Error(`MCP server ${name} has an invalid nested tool definition`);
    if (typeof definition.readOnly !== "boolean" || !SIDE_EFFECTS.has(definition.sideEffect) || !REPLAY_POLICIES.has(definition.replay)) throw new Error(`MCP server ${name} has invalid nested tool policy for ${tool}`);
    validateEffectPolicy(`${name}.${tool}`, definition);
  }
}

function serverConfigHash(name: string, definition: McpServerDefinition): string {
  return sha256(canonicalJson({ ...definition, name, env: Object.keys(definition.env ?? {}).sort() }));
}

function allowedTools(result: ListToolsResult, definition: McpServerDefinition): McpToolSummary[] {
  const includes = definition.includeTools ? new Set(definition.includeTools) : undefined;
  const excludes = new Set(definition.excludeTools ?? []);
  return result.tools.filter((tool) => (!includes || includes.has(tool.name)) && !excludes.has(tool.name)).map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema as Record<string, unknown>,
    readOnlyHint: tool.annotations?.readOnlyHint === true,
  }));
}

function requestOptions(definition: McpServerDefinition, signal?: AbortSignal): { signal?: AbortSignal; timeout: number } {
  return { ...(signal ? { signal } : {}), timeout: definition.requestTimeoutMs ?? 30_000 };
}

const MCP_CLOSE_TIMEOUT_MS = 2_000;

async function closeMcpConnection(connection: McpConnection): Promise<void> {
  const pid = transportPid(connection.transport);
  let clientError: unknown;
  try {
    await withTimeout(connection.client.close(), MCP_CLOSE_TIMEOUT_MS);
  } catch (error) {
    clientError = error;
  }
  if (pid !== undefined) await terminateMcpProcess(pid);
  let transportError: unknown;
  try {
    await withTimeout(connection.transport.close(), MCP_CLOSE_TIMEOUT_MS);
  } catch (error) {
    transportError = error;
  }
  if (clientError && transportError) throw new AggregateError([clientError, transportError], "MCP client and transport cleanup failed");
  if (clientError) throw clientError;
  if (transportError) throw transportError;
}

function transportPid(transport: McpConnection["transport"]): number | undefined {
  if (!("pid" in transport)) return undefined;
  const pid = transport.pid;
  return pid === null ? undefined : pid;
}

async function terminateMcpProcess(pid: number): Promise<void> {
  try {
    process.kill(pid);
  } catch {
    return;
  }
  await waitForProcessExit(pid, 250);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  await waitForProcessExit(pid, MCP_CLOSE_TIMEOUT_MS);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`MCP cleanup timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveEnvironment(values: Record<string, string> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    output[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable: string) => {
      const resolved = process.env[variable];
      if (resolved === undefined) throw new Error(`Missing MCP environment variable: ${variable}`);
      return resolved;
    });
  }
  return output;
}

function diagnoseToolchain(profile: McpToolchainProfile | undefined): McpToolchainSummary | undefined {
  if (!profile) return undefined;
  const injectEnvironment = toolchainInjectEnvironment(profile);
  const base = {
    kind: profile.kind,
    pathEnvironment: profile.pathEnvironment,
    injectEnvironment,
  };
  const path = process.env[profile.pathEnvironment]?.trim();
  if (!path) return { ...base, state: "missing", reason: `Set ${profile.pathEnvironment} to the installed ${profile.kind} path` };
  if (!isAbsolute(path)) return { ...base, state: "invalid", reason: `${profile.pathEnvironment} must be an absolute path` };
  try {
    const stats = statSync(path);
    const expected = profile.pathKind ?? DEFAULT_TOOLCHAIN_PATH_KINDS[profile.kind];
    if (expected === "file" && !stats.isFile()) return { ...base, state: "invalid", reason: `${profile.pathEnvironment} must reference a file` };
    if (expected === "directory" && !stats.isDirectory()) return { ...base, state: "invalid", reason: `${profile.pathEnvironment} must reference a directory` };
  } catch {
    return { ...base, state: "missing", reason: `${profile.pathEnvironment} does not reference an installed ${profile.kind} path` };
  }
  return { ...base, state: "ready" };
}

function toolchainEnvironment(profile: McpToolchainProfile | undefined): Record<string, string> {
  if (!profile) return {};
  const path = process.env[profile.pathEnvironment]?.trim();
  if (!path) throw new Error(`Missing MCP toolchain environment variable: ${profile.pathEnvironment}`);
  return { [toolchainInjectEnvironment(profile)]: path };
}

function resolvedToolchainValues(profile: McpToolchainProfile | undefined): string[] {
  const path = profile ? process.env[profile.pathEnvironment]?.trim() : undefined;
  return path ? [path] : [];
}

function toolchainInjectEnvironment(profile: McpToolchainProfile): string {
  return profile.injectEnvironment ?? DEFAULT_TOOLCHAIN_ENVIRONMENTS[profile.kind];
}

function environmentName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function resolvedEnvSecrets(values: Record<string, string> | undefined): string[] {
  try {
    return Object.values(resolveEnvironment(values)).filter((value) => value.length >= 4);
  } catch {
    return [];
  }
}

function redactSensitiveValues(value: unknown, key = "", configured = new Set<string>()): unknown {
  if (configured.has(key) || (typeof value === "string" && /(?:authorization|cookie|password|secret|token|api[-_]?key)/i.test(key))) {
    return { redacted: true, sha256: sha256(typeof value === "string" ? value : canonicalJson(value)) };
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValues(item, key, configured));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redactSensitiveValues(child, childKey, configured)]));
  return value;
}

function allowedNestedTools(definition: McpServerDefinition): Array<McpNestedToolDefinition & { name: string }> {
  const policy = definition.nestedToolPolicy;
  if (!policy) return [];
  const includes = policy.includeTools ? new Set(policy.includeTools) : undefined;
  const excludes = new Set(policy.excludeTools ?? []);
  return Object.entries(policy.tools)
    .filter(([name]) => (!includes || includes.has(name)) && !excludes.has(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, nested]) => ({ name, ...structuredClone(nested) }));
}

function sensitiveArgumentValues(value: Record<string, unknown>, configured = new Set<string>()): string[] {
  const output: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (configured.has(key)) output.push(...stringValues(child).filter((item) => item.length > 0));
    else if (/(?:authorization|cookie|password|secret|token|api[-_]?key)/i.test(key)) output.push(...stringValues(child).filter((item) => item.length >= 4));
    else if (child && typeof child === "object") output.push(...sensitiveArgumentValues(Array.isArray(child) ? Object.fromEntries(child.map((item, index) => [String(index), item])) : child as Record<string, unknown>, configured));
  }
  return output;
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(stringValues);
  return [];
}

function serverInvocationPolicy(entry: McpServerEntry): McpResolvedInvocationPolicy {
  return {
    readOnly: entry.definition.readOnly === true,
    sideEffect: entry.definition.sideEffect ?? "process",
    replay: entry.definition.replay ?? "manual",
    sensitivity: entry.definition.sensitivity ?? "target",
    resourceKeys: [...(entry.definition.resourceKeys ?? [`mcp:${entry.name}`])],
    redactArguments: [...(entry.definition.redactArguments ?? [])],
  };
}

const SIDE_EFFECTS = new Set<ToolSideEffectAtom>(["none", "workspace", "process", "network", "platform"]);
const REPLAY_POLICIES = new Set<ReplayPolicy>(["pure", "idempotent", "resumable", "reconcile", "manual", "forbidden-replay"]);
const SENSITIVITIES = new Set<ToolSensitivityAtom>(["public", "target", "secret"]);
const REVERSE_INPUT_FIELDS = new Set(["path", "address", "maxResults", "maxInstructions", "direction"]);
const TOOLCHAIN_KINDS = new Set<McpToolchainKind>(["ida-pro", "idalib", "jadx", "ghidra", "rizin", "custom"]);
const DEFAULT_TOOLCHAIN_ENVIRONMENTS: Record<McpToolchainKind, string> = {
  "ida-pro": "IDA_PATH",
  idalib: "IDA_PATH",
  jadx: "JADX_HOME",
  ghidra: "GHIDRA_HOME",
  rizin: "RIZIN_HOME",
  custom: "PROOFBLADE_TOOLCHAIN_PATH",
};

const DEFAULT_TOOLCHAIN_PATH_KINDS: Record<McpToolchainKind, "file" | "directory"> = {
  "ida-pro": "file",
  idalib: "file",
  jadx: "directory",
  ghidra: "directory",
  rizin: "directory",
  custom: "file",
};

function redactText(value: string, secrets: string[]): string {
  const variants = [...new Set(secrets.flatMap((secret) => escapedVariants(secret)))];
  return variants.sort((a, b) => b.length - a.length).reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
}

function mcpToolErrorMessage(server: string, tool: string, result: { content?: unknown }): string {
  const detail = mcpTextContent(result.content);
  const prefix = `MCP tool reported an error: ${server}.${tool}`;
  if (/idalib/i.test(server) && /disassemble/i.test(tool) && /can't import pyside6|qt without gui/i.test(detail)) {
    return `${prefix}. ${detail}\nThe requested static-analysis action was not executed, and no code fact was obtained. Next: call capability search with query "binary disassemble", then invoke the available read-only proofblade.binary.disassemble backend for the same fixture path and address; or install a headless-capable IDALIB environment. Do not repeat this IDALIB code-analysis call until that dependency is available.`;
  }
  if (/idalib/i.test(server) && /decompile/i.test(tool) && /can't import pyside6|qt without gui/i.test(detail)) {
    return `${prefix}. ${detail}\nThe requested decompilation action was not executed, and no code fact was obtained. Next: make at most one disassemble_function probe on the same address to check whether this endpoint's static-analysis path is usable; if it reports the same dependency error, call capability search with query "binary disassemble" and invoke the available read-only proofblade.binary.disassemble backend, or install a headless-capable IDALIB environment. Do not repeat decompile_function until that dependency is available.`;
  }
  return detail ? `${prefix}. ${detail}` : prefix;
}

function mcpTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part) && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .slice(0, 4_000);
}

function escapedVariants(secret: string): string[] {
  const variants = [secret];
  let escaped = secret;
  // MCP content is often JSON embedded in a JSON-RPC result. Cover the
  // resulting escape layers without attempting to parse arbitrary tool output.
  for (let depth = 0; depth < 4; depth += 1) {
    escaped = JSON.stringify(escaped).slice(1, -1);
    if (escaped === variants.at(-1)) break;
    variants.push(escaped);
  }
  return variants;
}

function externalId(connection: McpConnection | undefined): string | undefined {
  const transport = connection?.transport;
  const pid = transport && "pid" in transport ? transport.pid : undefined;
  return pid === null || pid === undefined ? undefined : String(pid);
}

function cloneToolSummaries(tools: readonly McpToolSummary[]): McpToolSummary[] {
  return tools.map((tool) => ({ ...tool, inputSchema: structuredClone(tool.inputSchema) }));
}

function isMcpToolSummary(value: unknown): value is McpToolSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<McpToolSummary>;
  return typeof item.name === "string"
    && typeof item.description === "string"
    && typeof item.inputSchema === "object"
    && item.inputSchema !== null
    && !Array.isArray(item.inputSchema)
    && typeof item.readOnlyHint === "boolean";
}

function isWithin(root: string, child: string): boolean {
  const path = relative(resolve(root), resolve(child));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
