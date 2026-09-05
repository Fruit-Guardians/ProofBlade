import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createConfiguredModels, type ResolvedModelProfile } from "../src/runtime/lmstudio-provider.js";

const apiKeyEnv = "PROOFBLADE_RESPONSES_CACHE_TEST_KEY";

test("OpenAI Responses usage preserves the full cached input prefix", async () => {
  let requestPath = "";
  let requestBody = "";
  const server = createServer(async (request, response) => {
    requestPath = request.url ?? "";
    const chunks: string[] = [];
    request.setEncoding("utf8");
    for await (const chunk of request) chunks.push(String(chunk));
    requestBody = chunks.join("");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp-cache-test",
        status: "completed",
        output: [],
        usage: {
          input_tokens: 20_000,
          input_tokens_details: { cached_tokens: 17_000 },
          output_tokens: 5,
          total_tokens: 20_005,
        },
      },
    })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env[apiKeyEnv] = "test-key";
  const profile: ResolvedModelProfile = {
    provider: "mock-responses",
    api: "openai-responses",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "mock-model",
    modelId: "mock-model",
    modelDiscoveryPath: "/models",
    apiKeyEnv,
    contextWindow: 32_000,
    maxTokens: 256,
    requestTimeoutMs: 5_000,
    maxRetries: 0,
    input: ["text"],
    cacheRetention: "long",
  };
  const configured = createConfiguredModels(profile);
  try {
    const stream = configured.models.stream(configured.model, {
      systemPrompt: "Stable system instructions.",
      messages: [{ role: "user", content: "Say ok." }],
    }, { sessionId: "responses-cache-session", cacheRetention: "long", maxTokens: 256 });
    let usage: { input: number; cacheRead: number; output: number; totalTokens: number } | undefined;
    for await (const event of stream) {
      if (event.type === "done") usage = event.message.usage;
    }
    assert.equal(requestPath, "/v1/responses");
    const payload = JSON.parse(requestBody) as { prompt_cache_key?: string; prompt_cache_retention?: string };
    assert.equal(payload.prompt_cache_key, "responses-cache-session");
    assert.equal(payload.prompt_cache_retention, "24h");
    assert.equal(usage?.input, 3_000);
    assert.equal(usage?.cacheRead, 17_000);
    assert.equal(usage?.output, 5);
    assert.equal(usage?.totalTokens, 20_005);
  } finally {
    await configured.closeTransport();
    delete process.env[apiKeyEnv];
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
