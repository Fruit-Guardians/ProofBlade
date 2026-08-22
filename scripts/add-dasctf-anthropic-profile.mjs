/** Merge a DASCTF Anthropic-gateway (Aliyun Bailian) profile into gui-provider.json
 * and set it active. api=anthropic-messages + endpointMode:exact so the SDK's
 * /v1/messages suffix is stripped and the POST lands exactly on the gateway URL.
 * Existing profiles are preserved. Key + gateway from env, never hardcoded. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const key = process.env.GATEWAY_API_KEY?.trim();
const gateway = process.env.GATEWAY_URL?.trim();
const model = (process.env.MODEL ?? "qwen3-max").trim();
if (!key || !gateway) { console.error("set GATEWAY_API_KEY and GATEWAY_URL"); process.exit(2); }

const dir = join(homedir(), ".proofblade");
const path = join(dir, "gui-provider.json");
mkdirSync(dir, { recursive: true });
const doc = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { schemaVersion: 2, activeProfileId: "", profiles: [] };
if (!Array.isArray(doc.profiles)) doc.profiles = [];
if (existsSync(path)) copyFileSync(path, `${path}.bak-${Date.now()}`);

const id = "dasctf-anthropic";
const profile = {
  id,
  name: "DASCTF 网关 · 百炼(Anthropic)",
  provider: "dasctf-anthropic",
  api: "anthropic-messages",
  baseUrl: gateway.replace(/\/+$/, ""),
  model,
  models: ["qwen3-max", "qwen-max", "qwen-plus", "deepseek-v3"],
  thinkingLevel: "off",
  cacheRetention: "short",
  maxConcurrentRequests: 5,
  endpointMode: "exact",
  apiKey: key,
};

doc.schemaVersion = 2;
doc.profiles = doc.profiles.filter((p) => p.id !== id);
doc.profiles.push(profile);
doc.activeProfileId = id;

writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
console.log(`✔ profile "${id}" added and set active`);
console.log(`  baseUrl : ${profile.baseUrl}  (anthropic-messages, endpointMode: exact)`);
console.log(`  model   : ${model}   models: ${profile.models.join(", ")}`);
console.log(`  apiKey  : set (${key.length} chars, not printed)`);
console.log(`  active  : ${doc.activeProfileId}`);
console.log(`  all ids : ${doc.profiles.map((p) => p.id).join(", ")}`);
