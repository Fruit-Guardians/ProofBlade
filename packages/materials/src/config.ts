import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type CacheRetention = "none" | "short" | "long";
export type OutputRewriteProvider = "builtin" | "rtk";

export interface OutputRewriteConfig {
  provider: OutputRewriteProvider;
  rtkCommand?: string;
  fallback?: "builtin" | "fail";
  rewriteTimeoutMs?: number;
  maxRawBytes?: number;
}

export interface ResolvedOutputRewriteConfig {
  provider: OutputRewriteProvider;
  rtkCommand: string;
  fallback: "builtin" | "fail";
  rewriteTimeoutMs: number;
  maxRawBytes: number;
}

export interface ModelProfileConfig {
  provider: string;
  api: "openai-completions";
  baseUrl: string;
  model: string;
  modelDiscoveryPath: string;
  apiKeyEnv: string;
  proxyUrl?: string;
  contextWindow: number;
  maxTokens: number;
  requestTimeoutMs: number;
  maxRetries: number;
  /** Maximum provider-requested Retry-After delay accepted for one attempt. */
  maxRetryDelayMs?: number;
  input: Array<"text" | "image">;
  thinkingLevel?: ThinkingLevel;
  /** Provider prompt-cache retention hint. Omitted keeps Pi's provider default. */
  cacheRetention?: CacheRetention;
  reasoning?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
}

export interface ProofBladeConfig {
  schemaVersion: 1;
  runtime: { piVersion: string };
  storage: { runsDir: string; fixturesDir: string };
  tools?: { outputRewrite?: OutputRewriteConfig };
  modelProfiles: { executor: ModelProfileConfig };
}

const DEFAULT_OUTPUT_REWRITE: ResolvedOutputRewriteConfig = {
  provider: "builtin",
  rtkCommand: "rtk",
  fallback: "builtin",
  rewriteTimeoutMs: 5_000,
  maxRawBytes: 1_048_576,
};

export async function loadConfig(root: string, configPath = "proofblade.config.json"): Promise<ProofBladeConfig> {
  const path = isAbsolute(configPath) ? configPath : resolve(root, configPath);
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ProofBladeConfig>;
  validateConfig(parsed, path);
  return parsed as ProofBladeConfig;
}

export function resolveOutputRewriteConfig(config: ProofBladeConfig): ResolvedOutputRewriteConfig {
  return { ...DEFAULT_OUTPUT_REWRITE, ...config.tools?.outputRewrite };
}

function validateConfig(config: Partial<ProofBladeConfig>, path: string): void {
  if (config.schemaVersion !== 1) throw new Error(`Unsupported config schema in ${path}`);
  if (config.runtime?.piVersion !== "0.83.0") throw new Error(`Config ${path} must lock Pi to 0.83.0`);
  const profile = config.modelProfiles?.executor;
  if (!profile) throw new Error(`Config ${path} is missing modelProfiles.executor`);
  if (profile.api !== "openai-completions") throw new Error(`Unsupported provider API: ${String(profile.api)}`);
  if (!profile.provider || !profile.baseUrl || !profile.model) throw new Error(`Config ${path} has an incomplete executor profile`);
  if (profile.proxyUrl !== undefined) validateHttpUrl(profile.proxyUrl, `proxyUrl in ${path}`);
  if (!Number.isFinite(profile.contextWindow) || profile.contextWindow < 1024) throw new Error(`Invalid contextWindow in ${path}`);
  if (!Number.isFinite(profile.maxTokens) || profile.maxTokens < 1) throw new Error(`Invalid maxTokens in ${path}`);
  if (!Number.isInteger(profile.maxRetries) || profile.maxRetries < 0 || profile.maxRetries > 8) throw new Error(`Invalid maxRetries in ${path}`);
  if (profile.maxRetryDelayMs !== undefined && (!Number.isInteger(profile.maxRetryDelayMs) || profile.maxRetryDelayMs < 0 || profile.maxRetryDelayMs > 300_000)) throw new Error(`Invalid maxRetryDelayMs in ${path}`);
  if (profile.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(profile.thinkingLevel)) throw new Error(`Invalid thinkingLevel in ${path}`);
  if (profile.cacheRetention !== undefined && !["none", "short", "long"].includes(profile.cacheRetention)) throw new Error(`Invalid cacheRetention in ${path}`);
  if (profile.maxTokensField !== undefined && profile.maxTokensField !== "max_tokens" && profile.maxTokensField !== "max_completion_tokens") throw new Error(`Invalid maxTokensField in ${path}`);
  const rewrite = config.tools?.outputRewrite;
  if (rewrite !== undefined) {
    if (rewrite.provider !== "builtin" && rewrite.provider !== "rtk") throw new Error(`Invalid outputRewrite provider in ${path}`);
    if (rewrite.rtkCommand !== undefined && rewrite.rtkCommand.trim().length === 0) throw new Error(`Invalid outputRewrite rtkCommand in ${path}`);
    if (rewrite.fallback !== undefined && rewrite.fallback !== "builtin" && rewrite.fallback !== "fail") throw new Error(`Invalid outputRewrite fallback in ${path}`);
    if (rewrite.rewriteTimeoutMs !== undefined && (!Number.isInteger(rewrite.rewriteTimeoutMs) || rewrite.rewriteTimeoutMs < 100 || rewrite.rewriteTimeoutMs > 30_000)) throw new Error(`Invalid outputRewrite rewriteTimeoutMs in ${path}`);
    if (rewrite.maxRawBytes !== undefined && (!Number.isInteger(rewrite.maxRawBytes) || rewrite.maxRawBytes < 512 || rewrite.maxRawBytes > 16_777_216)) throw new Error(`Invalid outputRewrite maxRawBytes in ${path}`);
  }
}

function validateHttpUrl(value: string, label: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`Invalid ${label}`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`Invalid ${label}`);
}
