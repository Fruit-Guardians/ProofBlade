/** One tiny Anthropic-format probe to a full-endpoint gateway (endpointMode:exact).
 * Determines empirically: (1) does the gateway need a key, (2) what model string
 * it accepts. Sends max_tokens:1 — negligible. Key (if any) from env, never printed.
 *
 *   GATEWAY_URL='https://.../llm-gateway/proxy/e/CODE' \
 *   MODEL='claude-3-5-sonnet-20241022' \
 *   [ANTHROPIC_API_KEY=sk-...] \
 *   node scripts/anthropic-gateway-probe.mjs
 */
const url = process.env.GATEWAY_URL?.trim();
const model = (process.env.MODEL ?? "claude-3-5-sonnet-20241022").trim();
const key = process.env.ANTHROPIC_API_KEY?.trim();
if (!url) { console.error("set GATEWAY_URL"); process.exit(2); }

const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
if (key) headers["x-api-key"] = key;

const body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "OK" }] });
console.log(`POST ${url}`);
console.log(`model: ${model}   key: ${key ? `set(${key.length})` : "NONE"}`);
try {
  const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(text.slice(0, 600));
} catch (e) {
  console.log(`ERR ${e instanceof Error ? e.message : String(e)}`);
}
