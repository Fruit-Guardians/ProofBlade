import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ConversationFolder, ConversationPreferences, ProviderThinkingLevel, WorkspaceSettings } from "./shared.js";

interface StoredConversationPreferences {
  folderId?: string;
  workspacePath?: string;
  profileId?: string;
  model?: string;
  thinkingLevel?: ProviderThinkingLevel;
  enabledTools?: string[];
  enabledSkills?: string[];
  enabledMcpServers?: string[];
}

interface LocalWorkspaceFile {
  schemaVersion: 1;
  folders: ConversationFolder[];
  conversations: Record<string, StoredConversationPreferences>;
}

export class WorkspaceSettingsStore {
  private folders: ConversationFolder[] = [];
  private conversations: Record<string, StoredConversationPreferences> = {};

  private constructor(private readonly path: string) {}

  public static async create(path = join(homedir(), ".proofblade", "gui-workspace.json")): Promise<WorkspaceSettingsStore> {
    const store = new WorkspaceSettingsStore(path);
    await store.load();
    return store;
  }

  public publicSettings(capabilities: WorkspaceSettings["capabilities"], defaults: ConversationPreferences): WorkspaceSettings {
    return {
      folders: this.folders.map((folder) => ({ ...folder })),
      conversations: Object.fromEntries(Object.entries(this.conversations).map(([runId, stored]) => [runId, this.resolve(stored, defaults)])),
      capabilities,
      localPath: this.path,
    };
  }

  public preferences(runId: string, defaults: ConversationPreferences): ConversationPreferences {
    return this.resolve(this.conversations[runId] ?? {}, defaults);
  }

  public async saveConversation(runId: string, input: Partial<ConversationPreferences>, defaults: ConversationPreferences): Promise<ConversationPreferences> {
    const current = this.preferences(runId, defaults);
    const next: ConversationPreferences = {
      ...current,
      ...input,
      workspacePath: input.workspacePath?.trim() || current.workspacePath,
      enabledTools: normalizeList(input.enabledTools ?? current.enabledTools),
      enabledSkills: normalizeList(input.enabledSkills ?? current.enabledSkills),
      enabledMcpServers: normalizeList(input.enabledMcpServers ?? current.enabledMcpServers),
    };
    if (next.folderId && !this.folders.some((folder) => folder.id === next.folderId)) throw new Error(`对话文件夹不存在：${next.folderId}`);
    this.conversations[runId] = next;
    await this.persist();
    return next;
  }

  public async createFolder(name: string): Promise<ConversationFolder> {
    const normalized = required(name, "文件夹名称");
    const used = new Set(this.folders.map((folder) => folder.id));
    const folder = { id: uniqueId(normalized, used), name: normalized };
    this.folders.push(folder);
    await this.persist();
    return folder;
  }

  public async renameFolder(folderId: string, name: string): Promise<ConversationFolder> {
    const folder = this.requireFolder(folderId);
    folder.name = required(name, "文件夹名称");
    await this.persist();
    return { ...folder };
  }

  public async removeFolder(folderId: string): Promise<void> {
    this.requireFolder(folderId);
    this.folders = this.folders.filter((folder) => folder.id !== folderId);
    for (const settings of Object.values(this.conversations)) if (settings.folderId === folderId) delete settings.folderId;
    await this.persist();
  }

  private resolve(stored: StoredConversationPreferences, defaults: ConversationPreferences): ConversationPreferences {
    return {
      ...defaults,
      ...stored,
      enabledTools: normalizeList(stored.enabledTools ?? defaults.enabledTools),
      enabledSkills: normalizeList(stored.enabledSkills ?? defaults.enabledSkills),
      enabledMcpServers: normalizeList(stored.enabledMcpServers ?? defaults.enabledMcpServers),
    };
  }

  private requireFolder(folderId: string): ConversationFolder {
    const folder = this.folders.find((item) => item.id === folderId);
    if (!folder) throw new Error(`对话文件夹不存在：${folderId}`);
    return folder;
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<LocalWorkspaceFile>;
      if (parsed.schemaVersion !== 1) throw new Error("unsupported schemaVersion");
      this.folders = Array.isArray(parsed.folders) ? parsed.folders.map(validateFolder) : [];
      this.conversations = parsed.conversations && typeof parsed.conversations === "object" && !Array.isArray(parsed.conversations)
        ? Object.fromEntries(Object.entries(parsed.conversations).map(([runId, value]) => [runId, validatePreferences(value)]))
        : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`本地工作区配置读取失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async persist(): Promise<void> {
    const local: LocalWorkspaceFile = { schemaVersion: 1, folders: this.folders, conversations: this.conversations };
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(local, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

function validateFolder(value: unknown): ConversationFolder {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("文件夹配置格式错误");
  const folder = value as Partial<ConversationFolder>;
  return { id: required(folder.id, "文件夹 ID"), name: required(folder.name, "文件夹名称") };
}

function validatePreferences(value: unknown): StoredConversationPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as StoredConversationPreferences;
  return {
    ...(typeof input.folderId === "string" && input.folderId ? { folderId: input.folderId } : {}),
    ...(typeof input.workspacePath === "string" && input.workspacePath.trim() ? { workspacePath: input.workspacePath.trim() } : {}),
    ...(typeof input.profileId === "string" && input.profileId ? { profileId: input.profileId } : {}),
    ...(typeof input.model === "string" && input.model ? { model: input.model } : {}),
    ...(typeof input.thinkingLevel === "string" ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(Array.isArray(input.enabledTools) ? { enabledTools: normalizeList(input.enabledTools) } : {}),
    ...(Array.isArray(input.enabledSkills) ? { enabledSkills: normalizeList(input.enabledSkills) } : {}),
    ...(Array.isArray(input.enabledMcpServers) ? { enabledMcpServers: normalizeList(input.enabledMcpServers) } : {}),
  };
}

function normalizeList(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  return value.trim();
}

function uniqueId(name: string, used: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "folder";
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
