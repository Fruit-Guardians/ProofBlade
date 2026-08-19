/** Diagnostic: probe a gateway path without accidentally spending four model
 * completions. By default this sends ONE request to the standard
 * /chat/completions operation (or the supplied full endpoint). Use --all only
 * when you explicitly accept up to four requests; it stops after the first
 * JSON/success response. Use --dry-run to print candidate URLs without a POST.
 * Key from env, never printed. */
const key = process.env.DEEPSEEK_API_KEY?.trim();
const gw = process.env.GATEWAY_URL?.trim();
if (!key || !gw) { console.error("set DEEPSEEK_API_KEY and GATEWAY_URL"); process.exit(2); }
const base = gw.replace(/\/+$/, "");
const model = process.env.MODEL ?? "deepseek-chat";
const dryRun = process.argv.includes("--dry-run");
const exhaustive = process.argv.includes("--all") || process.env.GATEWAY_PROBE_ALL === "1";

const tails = /\/chat\/completions$/i.test(base)
  ? [""]
  : exhaustive
    ? ["/chat/completions", "/v1/chat/completions", "/v1/v1/chat/completions", ""]
    : ["/chat/completions"];
const body = JSON.stringify({ model, messages: [{ role: "user", content: "OK" }], max_tokens: 4, stream: false });

if (dryRun) {
  for (const tail of tails) console.log(`DRY-RUN ${base + tail}`);
  process.exit(0);
}

for (const tail of tails) {
  const url = base + tail;
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    const shape = text.trim() ? (text.trim().startsWith("{") ? "JSON" : "text") : "EMPTY";
    console.log(`POST ${tail || "(exact)"}  ->  HTTP ${res.status}  [${shape}]  ${text.slice(0, 160).replace(/\s+/g, " ")}`);
    // A JSON response (including an auth or validation error) proves that the
    // request reached the model gateway. Do not spend the remaining probes.
    if (!exhaustive || res.ok || (shape === "JSON" && res.status !== 404 && res.status !== 405)) break;
  } catch (e) {
    console.log(`POST ${tail || "(exact)"}  ->  ERR ${e instanceof Error ? e.message : String(e)}`);
    if (!exhaustive) break;
  }
}
