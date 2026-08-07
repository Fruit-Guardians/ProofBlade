import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Client, type ListToolsResult } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import type { ToolSensitivityAtom, ToolSideEffectAtom } from "@proofblade/atoms";
import { withCapabilityHash, type CapabilityManifest } from "@proofblade/molecules";
import type { RawEffectResult, ReplayPolicy } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";

export interface McpServerDefinition {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
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
}

export interface McpServerSummary {
  name: string;
  capabilityId: string;
  description: string;
  disabled: boolean;
  status: "configured" | "connected" | "failed" | "disabled";
  configHash: string;
}

export interface McpToolSummary {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean;
}

interface McpConnection {
  client: Client;
  transport: StdioClientTransport;
  tools?: McpToolSummary[];
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
  private readonly connecting = new Map<string, Promise<McpConnection>>();
  private readonly failures = new Set<string>();

  private constructor(private readonly projectRoot: string, definitions: Record<string, McpServerDefinition>) {
    const capabilityIds = new Set<string>();
    this.definitions = Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b)).map(([name, definition]) => {
      validateServer(name, definition, projectRoot);
      const capabilityId = `mcp.${name.replace(/_/g, "-")}`;
      if (capabilityIds.has(capabilityId)) throw new Error(`MCP server names collide after normalization: ${name}`);
      capabilityIds.add(capabilityId);
      return { name, capabilityId, definition: structuredClone(definition), configHash: serverConfigHash(name, definition) };
    });
  }

  public static load(projectRoot: string, configPath = ".mcp.json"): McpProjectRegistry {
    const root = resolve(projectRoot);
    const path = isAbsolute(configPath) ? resolve(configPath) : resolve(root, configPath);
    if (!isWithin(root, path)) throw new Error("MCP config must be inside the project root");
    if (!existsSync(path)) return new McpProjectRegistry(root, {});
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<McpProjectConfig>;
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)) throw new Error(`Invalid MCP config: ${path}`);
    return new McpProjectRegistry(root, parsed.mcpServers);
  }

  public summaries(): McpServerSummary[] {
    return this.definitions.map((entry) => ({
      name: entry.name,
      capabilityId: entry.capabilityId,
      description: entry.definition.description ?? `Project MCP server ${entry.name}`,
      disabled: entry.definition.disabled === true,
      status: entry.definition.disabled === true ? "disabled" : this.connections.has(entry.name) ? "connected" : this.failures.has(entry.name) ? "failed" : "configured",
      configHash: entry.configHash,
    }));
  }

  public catalogHash(): string {
    return sha256(canonicalJson(this.summaries().map(({ status: _status, ...summary }) => summary)));
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
      const connection = await this.ensureConnection(entry.name, signal);
      const tools = await this.describe(entry.name, signal);
      if (!tools.some((item) => item.name === tool)) throw new Error(`MCP tool is not allowed: ${entry.name}.${tool}`);
      const result = await connection.client.callTool({ name: tool, arguments: args as Record<string, unknown> }, requestOptions(entry.definition, signal));
      const secrets = [...resolvedEnvSecrets(entry.definition.env), ...sensitiveArgumentValues(args as Record<string, unknown>, new Set(policy.redactArguments))];
      const stdout = redactText(JSON.stringify({ server: entry.name, tool, result }, null, 2), secrets);
      return { stdout, stderr: result.isError ? `MCP tool reported an error: ${entry.name}.${tool}` : "", exitCode: result.isError ? 1 : 0, durationMs: Date.now() - started, externalId: externalId(connection) };
    } catch (error) {
      return { stdout: "", stderr: redactText(error instanceof Error ? error.message : String(error), resolvedEnvSecrets(entry.definition.env)), exitCode: signal?.aborted ? null : 1, durationMs: Date.now() - started, externalId: externalId(this.connections.get(entry.name)) };
    }
  }

  public async describe(name: string, signal?: AbortSignal): Promise<McpToolSummary[]> {
    const entry = this.entry(name);
    const connection = await this.ensureConnection(name, signal);
    if (!connection.tools) {
      const result = await connection.client.listTools(undefined, requestOptions(entry.definition, signal));
      connection.tools = allowedTools(result, entry.definition).sort((a, b) => a.name.localeCompare(b.name));
    }
    return connection.tools.map((tool) => ({ ...tool, inputSchema: structuredClone(tool.inputSchema) }));
  }

  public async describeServer(name: string, signal?: AbortSignal): Promise<{ server: string; configHash: string; tools: McpToolSummary[]; nestedTools?: Array<McpNestedToolDefinition & { name: string }> }> {
    const entry = this.entry(name);
    const tools = await this.describe(name, signal);
    const nestedTools = allowedNestedTools(entry.definition);
    return { server: entry.name, configHash: entry.configHash, tools, ...(nestedTools.length > 0 ? { nestedTools } : {}) };
  }

  public async close(): Promise<void> {
    const pending = await Promise.allSettled(this.connecting.values());
    const connected = [...this.connections.values(), ...pending.flatMap((item) => item.status === "fulfilled" ? [item.value] : [])];
    this.connecting.clear();
    this.connections.clear();
    const results = await Promise.allSettled([...new Set(connected)].map((entry) => entry.client.close()));
    const failures = results.flatMap((item) => item.status === "rejected" ? [item.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "MCP connection cleanup failed");
  }

  private entry(name: string): McpServerEntry {
    const entry = this.definitions.find((item) => item.name === name && !item.definition.disabled);
    if (!entry) throw new Error(`Unknown MCP server: ${name}`);
    return entry;
  }

  private async ensureConnection(name: string, signal?: AbortSignal): Promise<McpConnection> {
    const existing = this.connections.get(name);
    if (existing) return existing;
    const pending = this.connecting.get(name);
    if (pending) return await pending;
    const entry = this.entry(name);
    const connecting = this.connect(entry, signal).finally(() => this.connecting.delete(name));
    this.connecting.set(name, connecting);
    return await connecting;
  }

  private async connect(entry: McpServerEntry, signal?: AbortSignal): Promise<McpConnection> {
    const cwd = resolve(this.projectRoot, entry.definition.cwd ?? ".");
    const env = { ...getDefaultEnvironment(), ...resolveEnvironment(entry.definition.env) };
    const transport = new StdioClientTransport({ command: entry.definition.command, args: entry.definition.args, cwd, env, stderr: "pipe" });
    const client = new Client(
      { name: `proofblade-${entry.name}`, version: "0.1.0" },
      { versionNegotiation: entry.definition.protocolVersion === "auto" ? { mode: "auto" } : entry.definition.protocolVersion === "2026-07-28" ? { mode: { pin: "2026-07-28" } } : undefined },
    );
    try {
      await client.connect(transport, requestOptions(entry.definition, signal));
      const connection = { client, transport };
      this.connections.set(entry.name, connection);
      this.failures.delete(entry.name);
      return connection;
    } catch (error) {
      this.failures.add(entry.name);
      await client.close().catch(() => transport.close().catch(() => undefined));
      throw error;
    }
  }
}

function validateServer(name: string, definition: McpServerDefinition, projectRoot: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error(`Invalid MCP server name: ${name}`);
  if (!definition || typeof definition !== "object" || typeof definition.command !== "string" || definition.command.trim() === "") throw new Error(`MCP server ${name} requires command`);
  if (definition.args && (!Array.isArray(definition.args) || definition.args.some((item) => typeof item !== "string"))) throw new Error(`MCP server ${name} has invalid args`);
  if (definition.env && (typeof definition.env !== "object" || Array.isArray(definition.env) || Object.values(definition.env).some((item) => typeof item !== "string"))) throw new Error(`MCP server ${name} has invalid env`);
  if (definition.readOnly !== undefined && typeof definition.readOnly !== "boolean") throw new Error(`MCP server ${name} has invalid readOnly`);
  if (definition.requestTimeoutMs !== undefined && (!Number.isInteger(definition.requestTimeoutMs) || definition.requestTimeoutMs < 50 || definition.requestTimeoutMs > 120_000)) throw new Error(`MCP server ${name} requestTimeoutMs must be between 50 and 120000`);
  for (const list of [definition.includeTools, definition.excludeTools]) if (list && (!Array.isArray(list) || list.some((item) => typeof item !== "string" || item.length === 0))) throw new Error(`MCP server ${name} has an invalid tool filter`);
  validateEffectPolicy(name, definition);
  validateNestedToolPolicy(name, definition.nestedToolPolicy);
  if (!isWithin(projectRoot, resolve(projectRoot, definition.cwd ?? "."))) throw new Error(`MCP server ${name} cwd escapes the project root`);
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

function redactText(value: string, secrets: string[]): string {
  return [...new Set(secrets)].sort((a, b) => b.length - a.length).reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
}

function externalId(connection: McpConnection | undefined): string | undefined {
  const pid = connection?.transport.pid;
  return pid === null || pid === undefined ? undefined : String(pid);
}

function isWithin(root: string, child: string): boolean {
  const path = relative(resolve(root), resolve(child));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
