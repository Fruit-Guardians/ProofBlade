/**
 * Model-gateway connectivity self-check.
 *
 * Sends ONE minimal chat completion through the competition's LLM gateway to
 * confirm: (1) the gateway forwards to DeepSeek, (2) the DeepSeek API key is
 * valid, (3) the baseUrl path concatenation is correct. It sends a trivial
 * 1-token prompt — negligible cost, no challenge data, no platform API.
 *
 * The DeepSeek API key is read from the environment and is never printed.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=sk-... \
 *   GATEWAY_BASE_URL='https://llm-gateway.dasctf.com/llm-gateway/proxy/e/<code>/v1' \
 *   MODEL=deepseek-chat \
 *   node scripts/gateway-selfcheck.mjs
 */

const key = process.env.DEEPSEEK_API_KEY?.trim();
const baseUrl = process.env.GATEWAY_BASE_URL?.trim();
const model = (process.env.MODEL ?? "deepseek-chat").trim();

if (!key) { console.error("✖ DEEPSEEK_API_KEY is not set (the key is never printed)."); process.exit(2); }
if (!baseUrl) { console.error("✖ GATEWAY_BASE_URL is not set."); process.exit(2); }

const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
console.log(`gateway url : ${url}`);
console.log(`model       : ${model}`);
console.log(`api key     : set (${key.length} chars, value hidden)`);
console.log("mode        : 1 trivial completion (negligible cost)\n");

const body = {
  model,
  messages: [{ role: "user", content: "Reply with the single word: OK" }],
  max_tokens: 8,
  stream: false,
};

try {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`✖ HTTP ${res.status}: ${text.slice(0, 400)}`);
    console.error("\nRESULT: FAIL — gateway/key/path issue (see status + body above).");
    process.exit(1);
  }
  let json;
  try { json = JSON.parse(text); } catch { console.error(`✖ non-JSON response: ${text.slice(0, 400)}`); process.exit(1); }
  const reply = json?.choices?.[0]?.message?.content ?? "(no content field)";
  const usage = json?.usage;
  console.log(`✔ HTTP 200`);
  console.log(`✔ model reply : ${JSON.stringify(reply)}`);
  console.log(`✔ resolved model: ${json?.model ?? "(none)"}`);
  if (usage) console.log(`✔ usage       : prompt=${usage.prompt_tokens} completion=${usage.completion_tokens}`);
  console.log("\nRESULT: OK — gateway forwards to DeepSeek, key valid, path correct.");
} catch (error) {
  console.error(`✖ request failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error("\nRESULT: FAIL — could not reach the gateway.");
  process.exit(1);
}
