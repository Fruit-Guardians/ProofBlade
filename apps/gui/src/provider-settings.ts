import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createProviderTransport, type ModelProfileConfig, type ProofBladeConfig } from "@proofblade/materials";
import type { ModelDiscoveryResult, ProviderProfile, ProviderSettings, ProviderSettingsInput, ProviderThinkingLevel } from "./shared.js";

interface LocalProviderProfile {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  proxyUrl?: string;
  model: string;
  models: string[];
  thinkingLevel: ProviderThinkingLevel;
  apiKey?: string;
}

interface LocalProviderFile {
  schemaVersion: 2;
  activeProfileId: string;
  profiles: LocalProviderProfile[];
}

interface LegacyProviderFile {
  schemaVersion: 1;
  provider: string;
  baseUrl: string;
  proxyUrl?: string;
  model: string;
  thinkingLevel: ProviderThinkingLevel;
  apiKey?: string;
}

const thinkingLevels = new Set<ProviderThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export class ProviderSettingsStore {
  private readonly path: string;
  private profiles: LocalProviderProfile[] = [];
  private activeProfileId = "default";

  private constructor(private readonly baseProfile: ModelProfileConfig, settingsPath: string) {
    this.path = settingsPath;
  }

  public static async create(config: ProofBladeConfig, settingsPath = join(homedir(), ".proofblade", "gui-provider.json")): Promise<ProviderSettingsStore> {
    const store = new ProviderSettingsStore(config.modelProfiles.executor, settingsPath);
    await store.load();
    return store;
  }

  public modelProfile(profileId = this.activeProfileId, model?: string, thinkingLevel?: ProviderThinkingLevel): ModelProfileConfig {
    const profile = this.requireProfile(profileId);
    const level = thinkingLevel ?? profile.thinkingLevel;
    const reasoningEnabled = level !== "off";
    const apiKeyEnv = `PROOFBLADE_GUI_${profile.id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_API_KEY`;
    if (profile.apiKey) {
      process.env[apiKeyEnv] = profile.apiKey;
      process.env[this.baseProfile.apiKeyEnv] = profile.apiKey;
    } else {
      delete process.env[apiKeyEnv];
      delete process.env[this.baseProfile.apiKeyEnv];
    }
    return {
      ...this.baseProfile,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      proxyUrl: profile.proxyUrl,
      model: model?.trim() || profile.model,
      thinkingLevel: level,
      apiKeyEnv,
      reasoning: reasoningEnabled || (this.baseProfile.reasoning ?? false),
      supportsReasoningEffort: reasoningEnabled ? true : this.baseProfile.supportsReasoningEffort,
      maxTokensField: reasoningEnabled ? "max_completion_tokens" : this.baseProfile.maxTokensField,
      input: [...this.baseProfile.input],
    };
  }

  public publicSettings(): ProviderSettings {
    const active = this.requireProfile(this.activeProfileId);
    return {
      activeProfileId: this.activeProfileId,
      profiles: this.profiles.map((profile) => publicProfile(profile)),
      localPath: this.path,
      provider: active.provider,
      baseUrl: active.baseUrl,
      proxyUrl: active.proxyUrl ?? "",
      model: active.model,
      thinkingLevel: active.thinkingLevel,
      hasApiKey: Boolean(active.apiKey),
    };
  }

  public async save(input: ProviderSettingsInput): Promise<ProviderSettings> {
    const validated = validateInput(input);
    const existing = input.id ? this.profiles.find((profile) => profile.id === input.id) : undefined;
    const id = existing?.id ?? uniqueId(validated.name, new Set(this.profiles.map((profile) => profile.id)));
    const apiKey = input.clearApiKey ? undefined : input.apiKey?.trim() || existing?.apiKey;
    const next: LocalProviderProfile = { id, ...validated, ...(apiKey ? { apiKey } : {}) };
    this.profiles = [...this.profiles.filter((profile) => profile.id !== id), next];
    if (input.setActive || !existing || !this.profiles.some((profile) => profile.id === this.activeProfileId)) this.activeProfileId = id;
    await this.persist();
    return this.publicSettings();
  }

  public async activate(profileId: string): Promise<ProviderSettings> {
    this.requireProfile(profileId);
    this.activeProfileId = profileId;
    await this.persist();
    return this.publicSettings();
  }

  public async remove(profileId: string): Promise<ProviderSettings> {
    this.requireProfile(profileId);
    if (this.profiles.length === 1) throw new Error("至少保留一个 Provider 配置");
    this.profiles = this.profiles.filter((profile) => profile.id !== profileId);
    if (this.activeProfileId === profileId) this.activeProfileId = this.profiles[0]!.id;
    await this.persist();
    return this.publicSettings();
  }

  public async discover(input: { profileId?: string; baseUrl?: string; proxyUrl?: string; apiKey?: string }): Promise<ModelDiscoveryResult> {
    const profile = input.profileId ? this.requireProfile(input.profileId) : this.requireProfile(this.activeProfileId);
    const baseUrl = normalizeBaseUrl(input.baseUrl ?? profile.baseUrl);
    const proxyUrl = normalizeOptionalUrl(input.proxyUrl ?? profile.proxyUrl, "代理 URL");
    const apiKey = input.apiKey?.trim() || profile.apiKey;
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : undefined;
    const transport = createProviderTransport(proxyUrl);
    try {
      let response: Response;
      try {
        response = await (transport?.fetch ?? fetch)(`${baseUrl}${normalizeDiscoveryPath(this.baseProfile.modelDiscoveryPath)}`, {
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
    } finally {
      await transport?.close();
    }
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<LocalProviderFile> & Partial<LegacyProviderFile>;
      if (parsed.schemaVersion === 2) {
        const profiles = Array.isArray(parsed.profiles) ? parsed.profiles.map(validateStoredProfile) : [];
        if (!profiles.length) throw new Error("Provider 配置列表为空");
        this.profiles = profiles;
        this.activeProfileId = profiles.some((profile) => profile.id === parsed.activeProfileId) ? parsed.activeProfileId! : profiles[0]!.id;
        return;
      }
      if (parsed.schemaVersion === 1) {
        const legacy = parsed as unknown as LegacyProviderFile;
        const validated = validateInput({
          name: legacy.provider || "默认中转站",
          provider: legacy.provider,
          baseUrl: legacy.baseUrl,
          proxyUrl: legacy.proxyUrl,
          model: legacy.model,
          models: legacy.model && legacy.model !== "auto" ? [legacy.model] : [],
          thinkingLevel: legacy.thinkingLevel,
        });
        this.profiles = [{ id: "default", ...validated, ...(legacy.apiKey?.trim() ? { apiKey: legacy.apiKey.trim() } : {}) }];
        this.activeProfileId = "default";
        await this.persist();
        return;
      }
      throw new Error("unsupported schemaVersion");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`本地 Provider 配置读取失败：${error instanceof Error ? error.message : String(error)}`);
      }
      const apiKey = process.env[this.baseProfile.apiKeyEnv]?.trim();
      this.profiles = [{
        id: "default",
        name: this.baseProfile.provider,
        provider: this.baseProfile.provider,
        baseUrl: normalizeBaseUrl(this.baseProfile.baseUrl),
        ...(this.baseProfile.proxyUrl ? { proxyUrl: this.baseProfile.proxyUrl } : {}),
        model: this.baseProfile.model,
        models: this.baseProfile.model === "auto" ? [] : [this.baseProfile.model],
        thinkingLevel: this.baseProfile.thinkingLevel ?? "off",
        ...(apiKey ? { apiKey } : {}),
      }];
      this.activeProfileId = "default";
    }
  }

  private requireProfile(profileId: string): LocalProviderProfile {
    const profile = this.profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error(`Provider 配置不存在：${profileId}`);
    return profile;
  }

  private async persist(): Promise<void> {
    const local: LocalProviderFile = { schemaVersion: 2, activeProfileId: this.activeProfileId, profiles: this.profiles };
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(local, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

function publicProfile(profile: LocalProviderProfile): ProviderProfile {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    proxyUrl: profile.proxyUrl ?? "",
    model: profile.model,
    models: [...profile.models],
    thinkingLevel: profile.thinkingLevel,
    hasApiKey: Boolean(profile.apiKey),
  };
}

function validateStoredProfile(value: unknown): LocalProviderProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider 配置项格式错误");
  const input = value as Partial<LocalProviderProfile>;
  const id = required(input.id, "Provider ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error(`Provider ID 格式错误：${id}`);
  const validated = validateInput({
    name: input.name ?? "",
    provider: input.provider ?? "",
    baseUrl: input.baseUrl ?? "",
    proxyUrl: input.proxyUrl,
    model: input.model ?? "",
    models: input.models,
    thinkingLevel: input.thinkingLevel ?? "off",
  });
  const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : undefined;
  return { id, ...validated, ...(apiKey ? { apiKey } : {}) };
}

function validateInput(input: ProviderSettingsInput): Omit<LocalProviderProfile, "id" | "apiKey"> {
  const provider = required(input.provider, "Provider");
  const name = required(input.name ?? provider, "配置名称");
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const proxyUrl = normalizeOptionalUrl(input.proxyUrl, "代理 URL");
  const model = required(input.model, "模型");
  if (!thinkingLevels.has(input.thinkingLevel)) throw new Error(`不支持的思考等级：${String(input.thinkingLevel)}`);
  const models = [...new Set((input.models ?? []).filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
  if (model !== "auto" && !models.includes(model)) models.unshift(model);
  return { name, provider, baseUrl, ...(proxyUrl ? { proxyUrl } : {}), model, models, thinkingLevel: input.thinkingLevel };
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

function normalizeOptionalUrl(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = required(value, label).replace(/\/+$/, "");
  let parsed: URL;
  try { parsed = new URL(normalized); } catch { throw new Error(`${label}格式错误`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${label}必须使用 http 或 https`);
  if (parsed.username || parsed.password) throw new Error(`${label}请勿包含凭据`);
  return normalized;
}

function normalizeDiscoveryPath(value: string): string {
  const path = value.trim() || "/models";
  return path.startsWith("/") ? path : `/${path}`;
}

function uniqueId(name: string, used: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "provider";
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
