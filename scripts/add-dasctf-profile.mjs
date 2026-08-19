/** Add/replace the DASCTF DeepSeek gateway profile in gui-provider.json and set
 * it active. Pass a standard OpenAI base URL (for example .../v1) for normal
 * SDK path concatenation, or a full .../chat/completions endpoint to opt into
 * endpointMode:exact. The DeepSeek key comes from DEEPSEEK_API_KEY (env) so it
 * is not hardcoded here; existing profiles are preserved. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const key = process.env.DEEPSEEK_API_KEY?.trim();
const gateway = process.env.GATEWAY_BASE_URL?.trim();
const model = (process.env.MODEL ?? "deepseek-v4-flash").trim();
if (!key || !gateway) { console.error("set DEEPSEEK_API_KEY and GATEWAY_BASE_URL"); process.exit(2); }

const path = join(homedir(), ".proofblade", "gui-provider.json");
mkdirSync(join(homedir(), ".proofblade"), { recursive: true });
const doc = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { schemaVersion: 2, activeProfileId: "", profiles: [] };
if (!Array.isArray(doc.profiles)) doc.profiles = [];

const normalizedGateway = gateway.replace(/\/+$/, "");
const isExactEndpoint = /\/chat\/completions$/i.test(normalizedGateway);

const id = "dasctf-deepseek";
const profile = {
  id,
  name: "DASCTF 网关 · DeepSeek",
  provider: "dasctf-deepseek",
  api: "openai-completions",
  baseUrl: normalizedGateway,
  model,
  models: [model, "deepseek-chat", "deepseek-reasoner"],
  thinkingLevel: "off",
  cacheRetention: "short",
  maxConcurrentRequests: 5,
  ...(isExactEndpoint ? { endpointMode: "exact" } : {}),
  apiKey: key,
};

doc.profiles = doc.profiles.filter((p) => p.id !== id);
doc.profiles.push(profile);
doc.activeProfileId = id;

writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
console.log(`✔ profile "${id}" added and set active`);
console.log(`  baseUrl      : ${normalizedGateway}`);
console.log(`  api          : openai-completions  (${isExactEndpoint ? "endpointMode: exact" : "standard base URL"})`);
console.log(`  model        : ${model}`);
console.log(`  apiKey       : set (${key.length} chars, not printed)`);
console.log(`  profiles now : ${doc.profiles.map((p) => p.id).join(", ")}`);
