import assert from "node:assert/strict";
import test from "node:test";
import { createConfiguredModels, discoveryPathForApi, normalizeProviderBaseUrl, resolveModelProfile } from "../src/runtime/lmstudio-provider.js";

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
