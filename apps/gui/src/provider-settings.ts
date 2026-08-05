import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelProfileConfig, ProofBladeConfig } from "@proofblade/materials";
import type { ModelDiscoveryResult, ProviderSettings, ProviderSettingsInput, ProviderThinkingLevel } from "./shared.js";

interface LocalProviderFile {
  schemaVersion: 1;
  provider: string;
  baseUrl: string;
  model: string;
  thinkingLevel: ProviderThinkingLevel;
  apiKey?: string;
}

const thinkingLevels = new Set<ProviderThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export class ProviderSettingsStore {
  private readonly path: string;
  private profile: ModelProfileConfig;
  private apiKey?: string;

  private constructor(private readonly baseProfile: ModelProfileConfig, settingsPath: string) {
    this.path = settingsPath;
    this.profile = { ...baseProfile, input: [...baseProfile.input] };
  }

  public static async create(config: ProofBladeConfig, settingsPath = join(homedir(), ".proofblade", "gui-provider.json")): Promise<ProviderSettingsStore> {
    const store = new ProviderSettingsStore(config.modelProfiles.executor, settingsPath);
    await store.load();
    return store;
  }

  public modelProfile(): ModelProfileConfig {
    return { ...this.profile, input: [...this.profile.input] };
  }

  public publicSettings(): ProviderSettings {
    return {
      provider: this.profile.provider,
      baseUrl: this.profile.baseUrl,
      model: this.profile.model,
      thinkingLevel: this.profile.thinkingLevel ?? "off",
      hasApiKey: Boolean(this.apiKey),
      localPath: this.path,
    };
  }

  public async save(input: ProviderSettingsInput): Promise<ProviderSettings> {
    const next = validateInput(input);
    const apiKey = input.clearApiKey ? undefined : input.apiKey?.trim() || this.apiKey;
    const local: LocalProviderFile = { schemaVersion: 1, ...next, ...(apiKey ? { apiKey } : {}) };
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(local, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    this.apiKey = apiKey;
    this.apply(local);
    return this.publicSettings();
  }

  public async discover(input: { baseUrl?: string; apiKey?: string }): Promise<ModelDiscoveryResult> {
    const baseUrl = normalizeBaseUrl(input.baseUrl ?? this.profile.baseUrl);
    const apiKey = input.apiKey?.trim() || this.apiKey;
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : undefined;
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${normalizeDiscoveryPath(this.profile.modelDiscoveryPath)}`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new Error(`模型服务连接失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`模型列表请求失败：HTTP ${response.status}`);
    const body = await response.json() as { data?: Array<{ id?: unknown }> };
    const models = [...new Set((body.data ?? [])
      .map((item) => typeof item.id === "string" ? item.id.trim() : "")
      .filter((id) => id && !id.toLowerCase().includes("embed")))].sort((a, b) => a.localeCompare(b));
    if (!models.length) throw new Error("模型服务返回的列表中没有可用模型");
    return { models, baseUrl };
  }

  private async load(): Promise<void> {
    this.apiKey = process.env[this.baseProfile.apiKeyEnv]?.trim() || undefined;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<LocalProviderFile>;
      if (parsed.schemaVersion !== 1) throw new Error("unsupported schemaVersion");
      const validated = validateInput(parsed as ProviderSettingsInput);
      this.apiKey = typeof parsed.apiKey === "string" && parsed.apiKey.trim() ? parsed.apiKey.trim() : this.apiKey;
      this.apply({ schemaVersion: 1, ...validated, ...(this.apiKey ? { apiKey: this.apiKey } : {}) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`本地 Provider 配置读取失败：${error instanceof Error ? error.message : String(error)}`);
      }
      this.apply({
        schemaVersion: 1,
        provider: this.baseProfile.provider,
        baseUrl: this.baseProfile.baseUrl,
        model: this.baseProfile.model,
        thinkingLevel: this.baseProfile.thinkingLevel ?? "off",
      });
    }
  }

  private apply(local: LocalProviderFile): void {
    const reasoningEnabled = local.thinkingLevel !== "off";
    this.profile = {
      ...this.baseProfile,
      provider: local.provider,
      baseUrl: local.baseUrl,
      model: local.model,
      thinkingLevel: local.thinkingLevel,
      reasoning: reasoningEnabled || (this.baseProfile.reasoning ?? false),
      supportsReasoningEffort: reasoningEnabled ? true : this.baseProfile.supportsReasoningEffort,
      maxTokensField: reasoningEnabled ? "max_completion_tokens" : this.baseProfile.maxTokensField,
      input: [...this.baseProfile.input],
    };
    if (this.apiKey) process.env[this.profile.apiKeyEnv] = this.apiKey;
    else delete process.env[this.profile.apiKeyEnv];
  }
}

function validateInput(input: ProviderSettingsInput): Omit<LocalProviderFile, "schemaVersion" | "apiKey"> {
  const provider = required(input.provider, "Provider");
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const model = required(input.model, "模型");
  if (!thinkingLevels.has(input.thinkingLevel)) throw new Error(`不支持的思考等级：${String(input.thinkingLevel)}`);
  return { provider, baseUrl, model, thinkingLevel: input.thinkingLevel };
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  return value.trim();
}

function normalizeBaseUrl(value: unknown): string {
  const baseUrl = required(value, "Base URL").replace(/\/+$/, "");
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new Error("Base URL 格式错误"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Base URL 必须使用 http 或 https");
  return baseUrl;
}

function normalizeDiscoveryPath(value: string): string {
  const path = value.trim() || "/models";
  return path.startsWith("/") ? path : `/${path}`;
}
