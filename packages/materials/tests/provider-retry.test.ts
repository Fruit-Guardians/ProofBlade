import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createConfiguredModels, type ResolvedModelProfile } from "../src/runtime/lmstudio-provider.js";

test("OpenAI-compatible provider retries transient 429 responses", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    if (requests < 3) {
      response.writeHead(429, { "content-type": "application/json", "retry-after-ms": "1" });
      response.end(JSON.stringify({ message: "Too many pending requests, please retry later", type: "rate_limit_error" }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const profile: ResolvedModelProfile = {
    provider: "retry-test",
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "test-model",
    modelId: "test-model",
    modelDiscoveryPath: "/models",
    apiKeyEnv: "PROOFBLADE_RETRY_TEST_KEY",
    contextWindow: 4_096,
    maxTokens: 256,
    requestTimeoutMs: 5_000,
    maxRetries: 2,
    maxRetryDelayMs: 100,
    input: ["text"],
  };
  const { models, model, closeTransport } = createConfiguredModels(profile);
  try {
    const message = await models.completeSimple(model, {
      messages: [{ role: "user", content: "test", timestamp: Date.now() }],
    }, {
      maxRetries: profile.maxRetries,
      maxRetryDelayMs: profile.maxRetryDelayMs,
    });
    assert.equal(message.stopReason, "stop");
    assert.equal(message.content.find((item) => item.type === "text")?.text, "ok");
    assert.equal(requests, 3);
  } finally {
    await closeTransport();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.PROOFBLADE_RETRY_TEST_KEY;
  }
});
