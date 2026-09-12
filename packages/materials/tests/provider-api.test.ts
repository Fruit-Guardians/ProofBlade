import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { Context, Model } from "@earendil-works/pi-ai";
import { createConfiguredModels, discoveryPathForApi, effectiveCacheRetention, normalizeProviderBaseUrl, resolveModelProfile } from "../src/runtime/lmstudio-provider.js";

test("Anthropic profiles use a root base URL while discovery retains the API version", async () => {
  assert.equal(normalizeProviderBaseUrl("https://api.anthropic.com/v1/", "anthropic-messages"), "https://api.anthropic.com");
  assert.equal(discoveryPathForApi("/models", "anthropic-messages"), "/v1/models");
  assert.equal(discoveryPathForApi("/v1/models", "anthropic-messages"), "/v1/models");

  const resolved = await resolveModelProfile({
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1/",
    model: "claude-test",
    modelDiscoveryPath: "/models",
    apiKeyEnv: "PROOFBLADE_TEST_ANTHROPIC_KEY",
    contextWindow: 32_000,
    maxTokens: 1_024,
    requestTimeoutMs: 10_000,
    maxRetries: 0,
    input: ["text"],
  });
  assert.equal(resolved.baseUrl, "https://api.anthropic.com");
});

test("configured models retain the selected Provider API", async () => {
  for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
    const configured = createConfiguredModels({
      provider: `test-${api}`,
      api,
      baseUrl: "https://example.test",
      model: "test-model",
      modelId: "test-model",
      modelDiscoveryPath: "/models",
      apiKeyEnv: `PROOFBLADE_TEST_${api.toUpperCase().replaceAll("-", "_")}`,
      contextWindow: 32_000,
      maxTokens: 1_024,
      requestTimeoutMs: 10_000,
      maxRetries: 0,
      input: ["text"],
    });
    assert.equal(configured.model.api, api);
    await configured.closeTransport();
  }
});

test("the checked-in aihub evaluation profile uses the Responses wire protocol", () => {
  const path = fileURLToPath(new URL("../../../examples/real-evaluation-provider.aihub.example.json", import.meta.url));
  const config = JSON.parse(readFileSync(path, "utf8")) as {
    modelProfiles?: { executor?: { provider?: string; api?: string } };
  };
  assert.equal(config.modelProfiles?.executor?.provider, "aihub");
  assert.equal(config.modelProfiles?.executor?.api, "openai-responses");
});

test("long cache retention requires explicit Provider support", () => {
  assert.equal(effectiveCacheRetention({ cacheRetention: "long" }), "short");
  assert.equal(effectiveCacheRetention({ cacheRetention: "long", supportsLongCacheRetention: false }), "short");
  assert.equal(effectiveCacheRetention({ cacheRetention: "long", supportsLongCacheRetention: true }), "long");
  assert.equal(effectiveCacheRetention({ cacheRetention: "short", supportsLongCacheRetention: true }), "short");
  assert.equal(effectiveCacheRetention({ cacheRetention: "none", supportsLongCacheRetention: true }), "none");
});

test("unsupported long retention is absent from the OpenAI Responses payload", async () => {
  const api = openAIResponsesApi();
  const model: Model<"openai-responses"> = {
    id: "mock-model",
    name: "mock-model",
    api: "openai-responses",
    provider: "mock-relay",
    baseUrl: "http://127.0.0.1:1/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 256,
  };
  const context: Context = {
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
  };
  let payload: Record<string, unknown> | undefined;
  const stream = api.stream(model, context, {
    apiKey: "test-key",
    cacheRetention: effectiveCacheRetention({ cacheRetention: "long" }),
    sessionId: "stable-session",
    onPayload: (value) => {
      payload = value as Record<string, unknown>;
      throw new Error("stop after payload capture");
    },
  });
  for await (const _event of stream) {
    // The callback intentionally aborts before any network request is made.
  }
  assert.equal(payload?.prompt_cache_retention, undefined);
  assert.equal(payload?.prompt_cache_key, "stable-session");
});
