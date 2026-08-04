import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ModelProfileConfig } from "../config.js";

export interface ResolvedModelProfile extends ModelProfileConfig {
  modelId: string;
}

export async function resolveModelProfile(profile: ModelProfileConfig): Promise<ResolvedModelProfile> {
  const baseUrl = profile.baseUrl.replace(/\/$/, "");
  const modelId = profile.model === "auto"
    ? await discoverModel(baseUrl, profile.modelDiscoveryPath)
    : profile.model;
  return { ...profile, baseUrl, modelId };
}

export function createConfiguredModels(config: ResolvedModelProfile): { models: MutableModels; model: Model<"openai-completions"> } {
  const model: Model<"openai-completions"> = {
    id: config.modelId,
    name: config.modelId,
    api: "openai-completions",
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: config.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
    },
  };
  const provider = createProvider<"openai-completions">({
    id: config.provider,
    name: config.provider,
    baseUrl: config.baseUrl,
    auth: { apiKey: envApiKeyAuth(`${config.provider} API key`, [config.apiKeyEnv]) },
    models: [model],
    api: openAICompletionsApi(),
  });
  process.env[config.apiKeyEnv] ??= "local-provider";
  const models = createModels();
  models.setProvider(provider);
  return { models, model };
}

async function discoverModel(baseUrl: string, discoveryPath: string): Promise<string> {
  const response = await fetch(`${baseUrl}${discoveryPath}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`LM Studio model discovery failed: HTTP ${response.status}`);
  const body = await response.json() as { data?: Array<{ id?: string }> };
  const model = body.data?.find((item) => item.id && !item.id.toLowerCase().includes("embed"));
  if (!model?.id) throw new Error("LM Studio returned no chat model");
  return model.id;
}
