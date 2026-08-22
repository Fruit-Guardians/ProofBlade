/** Update the confirmed-working models list on the dasctf-anthropic profile.
 * Preserves apiKey/baseUrl/etc. Default model from MODEL env (kept active). */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const path = join(homedir(), ".proofblade", "gui-provider.json");
if (!existsSync(path)) { console.error("gui-provider.json not found"); process.exit(2); }
copyFileSync(path, `${path}.bak-${Date.now()}`);
const doc = JSON.parse(readFileSync(path, "utf8"));
const p = (doc.profiles ?? []).find((x) => x.id === "dasctf-anthropic");
if (!p) { console.error("profile dasctf-anthropic not found"); process.exit(2); }

// Probed HTTP 200 on this gateway (non-stream, max_tokens:1) on 2026-08-21.
p.models = [
  "qwen3-max",
  "qwen3-coder-plus",
  "qwen3-235b-a22b",
  "deepseek-v4-pro",
  "deepseek-v3.1",
  "deepseek-v3",
  "deepseek-r1",
  "glm-5.2",
  "Moonshot-Kimi-K2-Instruct",
];
const wanted = process.env.MODEL?.trim();
if (wanted) { if (!p.models.includes(wanted)) p.models.unshift(wanted); p.model = wanted; }
else if (!p.models.includes(p.model)) p.model = p.models[0];

writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
console.log(`✔ dasctf-anthropic models updated (${p.models.length})`);
console.log(`  default model : ${p.model}`);
console.log(`  models        : ${p.models.join(", ")}`);
