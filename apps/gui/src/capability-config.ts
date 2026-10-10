import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { McpProjectRegistry, ProofBladeSkillRegistry, type McpProjectConfig, type McpServerDefinition } from "@proofblade/materials";

export interface NewSkillInput {
  name: string;
  description: string;
  instructions: string;
}

export interface NewMcpServerInput {
  name: string;
  description: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  readOnly: boolean;
}

export interface CapabilityConfigResult {
  name: string;
  path: string;
}

/** Writes project-owned Skill and MCP declarations through one serialized path. */
export class CapabilityConfigStore {
  private mutation: Promise<void> = Promise.resolve();

  public constructor(private readonly projectRoot: string) {}

  public async createSkill(input: NewSkillInput): Promise<CapabilityConfigResult> {
    return await this.mutate(async () => {
      const name = capabilityName(input.name, "Skill");
      const description = boundedText(input.description, "Skill description", 500);
      const instructions = boundedText(input.instructions, "Skill instructions", 20_000);
      const skillsRoot = join(this.projectRoot, "skills");
      const skillDirectory = join(skillsRoot, name);
      const skillPath = join(skillDirectory, "SKILL.md");
      await mkdir(skillsRoot, { recursive: true });
      try {
        await mkdir(skillDirectory);
      } catch (error) {
        if (nodeErrorCode(error) === "EEXIST") throw new Error(`Skill ${name} already exists`);
        throw error;
      }
      try {
        const content = [
          "---",
          `name: ${name}`,
          `description: ${JSON.stringify(description)}`,
          "---",
          "",
          instructions,
          "",
        ].join("\n");
        await writeFile(skillPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        const registry = await ProofBladeSkillRegistry.load(this.projectRoot, "skills");
        if (!registry.list({ includeDisabled: true }).some((skill) => skill.name === name)) {
          throw new Error(`Skill ${name} did not pass registry validation`);
        }
        return { name, path: portableRelative(this.projectRoot, skillPath) };
      } catch (error) {
        await rm(skillDirectory, { recursive: true, force: true });
        throw error;
      }
    });
  }

  public async addMcpServer(input: NewMcpServerInput): Promise<CapabilityConfigResult> {
    return await this.mutate(async () => {
      const name = capabilityName(input.name, "MCP server", true);
      const description = boundedText(input.description, "MCP description", 1_000);
      const definition = mcpDefinition(input, description);
      const configPath = join(this.projectRoot, ".mcp.json");
      const config = await readMcpConfig(configPath);
      if (Object.hasOwn(config.mcpServers, name)) throw new Error(`MCP server ${name} already exists`);
      const next: McpProjectConfig = { ...config, mcpServers: { ...config.mcpServers, [name]: definition } };
      const content = `${JSON.stringify(next, null, 2)}\n`;
      const validationPath = join(this.projectRoot, `.mcp.gui-${randomUUID()}.json`);
      await writeFile(validationPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      try {
        const registry = McpProjectRegistry.load(this.projectRoot, basename(validationPath));
        try {
          if (!registry.summaries().some((server) => server.name === name)) throw new Error(`MCP server ${name} did not pass registry validation`);
        } finally {
          await registry.close();
        }
        await writeFile(configPath, content, { encoding: "utf8", mode: 0o600 });
      } finally {
        await rm(validationPath, { force: true });
      }
      return { name, path: portableRelative(this.projectRoot, configPath) };
    });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.mutation.then(operation, operation);
    this.mutation = task.then(() => undefined, () => undefined);
    return await task;
  }
}

function mcpDefinition(input: NewMcpServerInput, description: string): McpServerDefinition {
  const shared: McpServerDefinition = {
    description,
    readOnly: input.readOnly,
    sideEffect: "process",
    replay: "manual",
    sensitivity: "target",
    requestTimeoutMs: 30_000,
  };
  if (input.transport === "http") {
    const url = boundedText(input.url ?? "", "MCP URL", 2_000);
    return { ...shared, url };
  }
  if (input.transport !== "stdio") throw new Error("MCP transport must be http or stdio");
  const command = boundedText(input.command ?? "", "MCP command", 2_000);
  const args = (input.args ?? []).map((argument) => boundedText(argument, "MCP argument", 2_000));
  if (args.length > 128) throw new Error("MCP arguments cannot exceed 128 entries");
  return { ...shared, command, ...(args.length > 0 ? { args } : {}) };
}

async function readMcpConfig(path: string): Promise<McpProjectConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<McpProjectConfig>;
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)) throw new Error(".mcp.json requires an mcpServers object");
    return { ...parsed, mcpServers: parsed.mcpServers } as McpProjectConfig;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return { mcpServers: {} };
    throw error;
  }
}

function capabilityName(value: string, label: string, allowUnderscore = false): string {
  const normalized = value.trim().toLowerCase();
  const pattern = allowUnderscore ? /^[a-z0-9][a-z0-9_-]{0,63}$/ : /^[a-z0-9][a-z0-9-]{0,63}$/;
  if (!pattern.test(normalized)) throw new Error(`${label} name must use lowercase letters, numbers${allowUnderscore ? ", _" : ""} and -`);
  return normalized;
}

function boundedText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maxLength) throw new Error(`${label} cannot exceed ${maxLength} characters`);
  return normalized;
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}
