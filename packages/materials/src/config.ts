import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface ModelProfileConfig {
  provider: string;
  api: "openai-completions";
  baseUrl: string;
  model: string;
  modelDiscoveryPath: string;
  apiKeyEnv: string;
  contextWindow: number;
  maxTokens: number;
  requestTimeoutMs: number;
  maxRetries: number;
  input: Array<"text" | "image">;
}

export interface ProofBladeConfig {
  schemaVersion: 1;
  runtime: { piVersion: string };
  storage: { runsDir: string; fixturesDir: string };
  modelProfiles: { executor: ModelProfileConfig };
}

export async function loadConfig(root: string, configPath = "proofblade.config.json"): Promise<ProofBladeConfig> {
  const path = isAbsolute(configPath) ? configPath : resolve(root, configPath);
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ProofBladeConfig>;
  validateConfig(parsed, path);
  return parsed as ProofBladeConfig;
}

function validateConfig(config: Partial<ProofBladeConfig>, path: string): void {
  if (config.schemaVersion !== 1) throw new Error(`Unsupported config schema in ${path}`);
  if (config.runtime?.piVersion !== "0.83.0") throw new Error(`Config ${path} must lock Pi to 0.83.0`);
  const profile = config.modelProfiles?.executor;
  if (!profile) throw new Error(`Config ${path} is missing modelProfiles.executor`);
  if (profile.api !== "openai-completions") throw new Error(`Unsupported provider API: ${String(profile.api)}`);
  if (!profile.provider || !profile.baseUrl || !profile.model) throw new Error(`Config ${path} has an incomplete executor profile`);
  if (!Number.isFinite(profile.contextWindow) || profile.contextWindow < 1024) throw new Error(`Invalid contextWindow in ${path}`);
  if (!Number.isFinite(profile.maxTokens) || profile.maxTokens < 1) throw new Error(`Invalid maxTokens in ${path}`);
}
