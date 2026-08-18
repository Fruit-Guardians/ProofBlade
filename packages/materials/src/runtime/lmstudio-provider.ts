import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Model,
  type MutableModels,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ModelProfileConfig, ProviderApi } from "../config.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import { createProviderTransport, wrapExactEndpointFetch } from "./provider-transport.js";
import type { ProviderRequestBudget } from "./provider-budget.js";
import { configuredMaxConcurrentRequests, providerRequestScheduler, type ProviderRequestScheduler, type ProviderRequestSchedulingObserver } from "./provider-scheduler.js";

export interface ResolvedModelProfile extends ModelProfileConfig {
  modelId: string;
}

export async function resolveModelProfile(profile: ModelProfileConfig): Promise<ResolvedModelProfile> {
  const baseUrl = normalizeProviderBaseUrl(profile.baseUrl, profile.api);
  if (profile.model !== "auto") {
    return { ...profile, baseUrl, modelId: profile.model };
  }
  const transport = createProviderTransport(profile.proxyUrl);
  let modelId: string;
  try {
    modelId = await discoverModel(baseUrl, discoveryPathForApi(profile.modelDiscoveryPath, profile.api), transport?.fetch, profile.api, process.env[profile.apiKeyEnv]);
  } finally {
    await transport?.close();
  }
  return { ...profile, baseUrl, modelId };
}

export function createConfiguredModels(config: ResolvedModelProfile, budget?: ProviderRequestBudget, scheduling?: {
  scheduler?: ProviderRequestScheduler;
  observer?: ProviderRequestSchedulingObserver;
}): { models: MutableModels; model: Model<ProviderApi>; closeTransport(): Promise<void> } {
  const model: Model<ProviderApi> = {
    id: config.modelId,
    name: config.modelId,
    api: config.api,
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning ?? false,
    input: config.input,
    cost: configuredModelCost(config),
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    ...(config.api === "openai-completions" ? { compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: config.supportsReasoningEffort ?? false,
      supportsUsageInStreaming: true,
      maxTokensField: config.maxTokensField ?? "max_tokens",
    } } : {}),
  };
  const transport = createProviderTransport(config.proxyUrl);
  const baseApi = providerApi(config.api);
  // In "exact" mode the baseUrl is already the full gateway endpoint, so strip
  // the operation path the SDK appends. Compose over the proxy transport (or the
  // global fetch) so both features can be on at once.
  const effectiveFetch = config.endpointMode === "exact"
    ? wrapExactEndpointFetch(config.baseUrl, transport?.fetch)
    : transport?.fetch;
  const rawApi: ProviderStreams = effectiveFetch ? {
    stream: (streamModel: Model<ProviderApi>, context: Parameters<ProviderStreams["stream"]>[1], options?: Parameters<ProviderStreams["stream"]>[2]) =>
      baseApi.stream(streamModel, context, { ...options, fetch: effectiveFetch }),
    streamSimple: (streamModel: Model<ProviderApi>, context: Parameters<ProviderStreams["streamSimple"]>[1], options?: Parameters<ProviderStreams["streamSimple"]>[2]) =>
      baseApi.streamSimple(streamModel, context, { ...options, fetch: effectiveFetch }),
  } : baseApi;
  // Scheduling is deliberately outermost: a waiting request has not yet made
  // a billable reservation, and cannot call the Provider until it owns a slot.
  const api = (scheduling?.scheduler ?? providerRequestScheduler()).wrap(
    budget ? budget.wrap(rawApi) : rawApi,
    {
      provider: config.provider,
      model: config.modelId,
      endpoint: providerEndpointIdentity(config),
      maxConcurrentRequests: configuredMaxConcurrentRequests(config.maxConcurrentRequests),
    },
    scheduling?.observer,
  );
  const provider = createProvider<ProviderApi>({
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

/** Non-secret pool identity: credentials are intentionally excluded. */
export function providerEndpointIdentity(config: Pick<ModelProfileConfig, "api" | "baseUrl" | "proxyUrl" | "apiKeyEnv">): string {
  return sha256(canonicalJson({ api: config.api, baseUrl: config.baseUrl, proxyUrl: config.proxyUrl ?? "", apiKeyEnv: config.apiKeyEnv }));
}

function providerApi(api: ProviderApi): ProviderStreams {
  if (api === "openai-responses") return openAIResponsesApi();
  if (api === "anthropic-messages") return anthropicMessagesApi();
  return openAICompletionsApi();
}

export function normalizeProviderBaseUrl(value: string, api: ProviderApi): string {
  const baseUrl = value.replace(/\/+$/, "");
  if (api !== "anthropic-messages") return baseUrl;
  const parsed = new URL(baseUrl);
  if (parsed.pathname === "/v1") return parsed.origin;
  return baseUrl;
}

export function discoveryPathForApi(path: string, api: ProviderApi): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (api !== "anthropic-messages" || normalized.startsWith("/v1/")) return normalized;
  return `/v1${normalized}`;
}

async function discoverModel(baseUrl: string, discoveryPath: string, providerFetch: typeof globalThis.fetch = fetch, api: ProviderApi = "openai-completions", apiKey?: string): Promise<string> {
  const headers: Record<string, string> | undefined = api === "anthropic-messages"
    ? (apiKey ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : undefined)
    : (apiKey ? { authorization: `Bearer ${apiKey}` } : undefined);
  const response = await providerFetch(`${baseUrl}${discoveryPath}`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`LM Studio model discovery failed: HTTP ${response.status}`);
  const body = await response.json() as { data?: Array<{ id?: string }> };
  const model = body.data?.find((item) => item.id && !item.id.toLowerCase().includes("embed"));
  if (!model?.id) throw new Error("LM Studio returned no chat model");
  return model.id;
}

export function configuredModelCost(config: ModelProfileConfig): Model<ProviderApi>["cost"] {
  const pricing = config.pricing;
  if (!pricing) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    input: pricing.inputUsdPerMillion,
    output: pricing.outputUsdPerMillion,
    cacheRead: pricing.cacheReadUsdPerMillion,
    cacheWrite: pricing.cacheWriteUsdPerMillion,
  };
}
