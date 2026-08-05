import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ModelProfileConfig } from "../config.js";
import { createProviderTransport } from "./provider-transport.js";

export interface ResolvedModelProfile extends ModelProfileConfig {
  modelId: string;
}

export async function resolveModelProfile(profile: ModelProfileConfig): Promise<ResolvedModelProfile> {
  const baseUrl = profile.baseUrl.replace(/\/$/, "");
  if (profile.model !== "auto") {
    return { ...profile, baseUrl, modelId: profile.model };
  }
  const transport = createProviderTransport(profile.proxyUrl);
  let modelId: string;
  try {
    modelId = await discoverModel(baseUrl, profile.modelDiscoveryPath, transport?.fetch);
  } finally {
    await transport?.close();
  }
  return { ...profile, baseUrl, modelId };
}

export function createConfiguredModels(config: ResolvedModelProfile): { models: MutableModels; model: Model<"openai-completions">; closeTransport(): Promise<void> } {
  const model: Model<"openai-completions"> = {
    id: config.modelId,
    name: config.modelId,
    api: "openai-completions",
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning ?? false,
    input: config.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: config.supportsReasoningEffort ?? false,
      supportsUsageInStreaming: true,
      maxTokensField: config.maxTokensField ?? "max_tokens",
    },
  };
  const transport = createProviderTransport(config.proxyUrl);
  const baseApi = openAICompletionsApi();
  const api = transport ? {
    stream: (streamModel: typeof model, context: Parameters<typeof baseApi.stream>[1], options?: Parameters<typeof baseApi.stream>[2]) =>
      baseApi.stream(streamModel, context, { ...options, fetch: transport.fetch }),
    streamSimple: (streamModel: typeof model, context: Parameters<typeof baseApi.streamSimple>[1], options?: Parameters<typeof baseApi.streamSimple>[2]) =>
      baseApi.streamSimple(streamModel, context, { ...options, fetch: transport.fetch }),
  } : baseApi;
  const provider = createProvider<"openai-completions">({
    id: config.provider,
    name: config.provider,
    baseUrl: config.baseUrl,
    auth: { apiKey: envApiKeyAuth(`${config.provider} API key`, [config.apiKeyEnv]) },
    models: [model],
    api,
  });
  process.env[config.apiKeyEnv] ??= "local-provider";
  const models = createModels();
  models.setProvider(provider);
  return { models, model, closeTransport: async () => { await transport?.close(); } };
}

async function discoverModel(baseUrl: string, discoveryPath: string, providerFetch: typeof globalThis.fetch = fetch): Promise<string> {
  const response = await providerFetch(`${baseUrl}${discoveryPath}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`LM Studio model discovery failed: HTTP ${response.status}`);
  const body = await response.json() as { data?: Array<{ id?: string }> };
  const model = body.data?.find((item) => item.id && !item.id.toLowerCase().includes("embed"));
  if (!model?.id) throw new Error("LM Studio returned no chat model");
  return model.id;
}
