import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "@proofblade/materials";
import { ProviderSettingsStore } from "../src/provider-settings.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "local",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "auto",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "PROOFBLADE_GUI_TEST_KEY",
      contextWindow: 20_000,
      maxTokens: 2_048,
      requestTimeoutMs: 10_000,
      maxRetries: 1,
      input: ["text"],
    },
  },
};

test("persists provider overrides outside the repository response without exposing the key", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const tempRoot = join(root, "tmp");
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, "provider-settings-"));
  const path = join(dir, "gui-provider.json");
  delete process.env.PROOFBLADE_GUI_TEST_KEY;
  try {
    const store = await ProviderSettingsStore.create(config, path);
    const settings = await store.save({
      provider: "gateway",
      baseUrl: "https://example.test/v1/",
      model: "small-model",
      thinkingLevel: "low",
      apiKey: "test-secret",
    });
    assert.equal(settings.baseUrl, "https://example.test/v1");
    assert.equal(settings.model, "small-model");
    assert.equal(settings.hasApiKey, true);
    assert.equal("apiKey" in settings, false);
    assert.match(await readFile(path, "utf8"), /test-secret/);

    delete process.env.PROOFBLADE_GUI_TEST_KEY;
    const reloaded = await ProviderSettingsStore.create(config, path);
    assert.equal(reloaded.publicSettings().hasApiKey, true);
    assert.equal(reloaded.modelProfile().thinkingLevel, "low");
    assert.equal(reloaded.modelProfile().reasoning, true);
    assert.equal(reloaded.modelProfile().supportsReasoningEffort, true);
    assert.equal(reloaded.modelProfile().maxTokensField, "max_completion_tokens");
    assert.equal(process.env.PROOFBLADE_GUI_TEST_KEY, "test-secret");
  } finally {
    delete process.env.PROOFBLADE_GUI_TEST_KEY;
    await rm(dir, { recursive: true, force: true });
  }
});

test("discovers OpenAI-compatible models with the configured bearer key", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/v1/models");
    assert.equal(request.headers.authorization, "Bearer discovery-secret");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "chat-b" }, { id: "embed-small" }, { id: "chat-a" }] }));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const root = resolve(import.meta.dirname, "../../..");
  const path = join(root, "tmp", `provider-discovery-${Date.now()}.json`);
  try {
    const store = await ProviderSettingsStore.create(config, path);
    const result = await store.discover({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "discovery-secret" });
    assert.deepEqual(result.models, ["chat-a", "chat-b"]);
  } finally {
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  }
});
