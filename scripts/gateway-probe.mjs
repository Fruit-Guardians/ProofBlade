/** Diagnostic: probe several path tails against the gateway to find the one that
 * actually reaches DeepSeek. A DeepSeek response (JSON, even an auth error) means
 * the path is right; an empty-body 404 means the gateway rejected that path.
 * Key from env, never printed. */
const key = process.env.DEEPSEEK_API_KEY?.trim();
const gw = process.env.GATEWAY_URL?.trim();
if (!key || !gw) { console.error("set DEEPSEEK_API_KEY and GATEWAY_URL"); process.exit(2); }
const base = gw.replace(/\/+$/, "");
const model = process.env.MODEL ?? "deepseek-chat";

const tails = ["/chat/completions", "/v1/chat/completions", "/v1/v1/chat/completions", ""];
const body = JSON.stringify({ model, messages: [{ role: "user", content: "OK" }], max_tokens: 4, stream: false });

for (const tail of tails) {
  const url = base + tail;
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    const shape = text.trim() ? (text.trim().startsWith("{") ? "JSON" : "text") : "EMPTY";
    console.log(`POST ${tail || "(exact)"}  ->  HTTP ${res.status}  [${shape}]  ${text.slice(0, 160).replace(/\s+/g, " ")}`);
  } catch (e) {
    console.log(`POST ${tail || "(exact)"}  ->  ERR ${e instanceof Error ? e.message : String(e)}`);
  }
}
