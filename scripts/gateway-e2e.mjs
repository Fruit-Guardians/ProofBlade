/**
 * End-to-end proof that endpointMode:"exact" makes a full-endpoint gateway work
 * through the real pi-ai stack (not just a raw fetch). Builds the configured
 * model via createConfiguredModels and streams ONE trivial completion.
 * Key from env, never printed.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=sk-... GATEWAY_BASE_URL='https://.../e/<code>/v1' MODEL=deepseek-v4-flash \
 *   node scripts/gateway-e2e.mjs
 */
import { createConfiguredModels } from "../packages/materials/dist/runtime/lmstudio-provider.js";

const key = process.env.DEEPSEEK_API_KEY?.trim();
const baseUrl = process.env.GATEWAY_BASE_URL?.trim();
const model = (process.env.MODEL ?? "deepseek-v4-flash").trim();
if (!key || !baseUrl) { console.error("set DEEPSEEK_API_KEY and GATEWAY_BASE_URL"); process.exit(2); }

process.env.DASCTF_MODEL_KEY = key;

const config = {
  provider: "dasctf-deepseek",
  api: "openai-completions",
  baseUrl,
  model,
  modelId: model,
  modelDiscoveryPath: "/models",
  apiKeyEnv: "DASCTF_MODEL_KEY",
  endpointMode: "exact",
  contextWindow: 65536,
  maxTokens: 64,
  requestTimeoutMs: 30000,
  maxRetries: 0,
  input: ["text"],
};

console.log(`baseUrl : ${baseUrl}  (endpointMode: exact)`);
console.log(`model   : ${model}\n`);

const { models, model: built, closeTransport } = createConfiguredModels(config);
try {
  const stream = models.streamSimple(built, { messages: [{ role: "user", content: "Reply with the single word: OK", timestamp: Date.now() }] });
  let text = "";
  let stopReason;
  for await (const event of stream) {
    if (event.type === "done") { text = event.message.content.filter((c) => c.type === "text").map((c) => c.text).join(""); stopReason = event.message.stopReason; }
    else if (event.type === "error") { console.error(`✖ error: ${event.error.errorMessage}`); process.exit(1); }
  }
  console.log(`✔ stopReason: ${stopReason}`);
  console.log(`✔ reply     : ${JSON.stringify(text)}`);
  console.log("\nRESULT: OK — the exact-endpoint shim routes pi-ai through the gateway to DeepSeek.");
} catch (error) {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  await closeTransport();
}
