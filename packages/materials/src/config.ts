import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { IntentScoringWeights } from "./domain/intent.js";

export type CacheRetention = "none" | "short" | "long";
export type OutputRewriteProvider = "builtin" | "rtk";
export type ExecutionBackend = "host" | "docker";
export type ContainerProfile = "web" | "pwn" | "pwn-kernel";
export type ContainerNetworkPolicy = "none" | "bridge" | "target-only";
/** Provider protocols that ProofBlade can send through Pi's audited tool loop. */
export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";

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

export interface IntentSchedulerConfig {
  maxOpenIntents?: number;
  maxAttemptsPerIntent?: number;
  scoringWeights?: Partial<IntentScoringWeights>;
}

export interface ModelProfileConfig {
  provider: string;
  api: ProviderApi;
  baseUrl: string;
  model: string;
  modelDiscoveryPath: string;
  apiKeyEnv: string;
  proxyUrl?: string;
  /**
   * "exact" declares that `baseUrl` is ALREADY the full operation endpoint (not a
   * base to append to). Some competition LLM gateways only proxy a whitelisted
   * full URL (e.g. https://host/v1/chat/completions) and 404 any extra path, but
   * the OpenAI/Anthropic SDKs always append their operation path
   * (/chat/completions, /v1/messages, …). When set, the transport strips that
   * appended path so the request lands on the exact gateway URL. Omit for a
   * normal base-URL provider.
   */
  endpointMode?: "exact";
  contextWindow: number;
  maxTokens: number;
  requestTimeoutMs: number;
  maxRetries: number;
  /** Maximum simultaneous HTTP requests for this Provider/model in one process. */
  maxConcurrentRequests?: number;
  /** Maximum provider-requested Retry-After delay accepted for one attempt. */
  maxRetryDelayMs?: number;
  input: Array<"text" | "image">;
  thinkingLevel?: ThinkingLevel;
  /** Provider prompt-cache retention hint. Omitted keeps Pi's provider default. */
  cacheRetention?: CacheRetention;
  reasoning?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Provider-published USD prices per one million tokens. Required for live cost-capped evaluation. */
  pricing?: ModelPricingConfig;
}

export interface ModelPricingConfig {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
  cacheWriteUsdPerMillion: number;
}

export interface ExecutionConfig {
  /** Keep host as the backwards-compatible default; competition profiles can opt into Docker. */
  backend?: ExecutionBackend;
  /** Challenge kinds that must execute inside a per-run container. */
  requireFor?: Array<"web" | "pwn" | "reverse" | "crypto" | "script" | "forensics" | "misc" | "osint" | "malware" | "ai-ml" | "unknown">;
  dockerCommand?: string;
  networkPolicy?: ContainerNetworkPolicy;
  pullPolicy?: "if-missing" | "never" | "always";
  images?: Partial<Record<ContainerProfile | "gateway", string>>;
  commandWaitMs?: number;
  commandHardTimeoutMs?: number;
  outputPreviewBytes?: number;
  staleContainerTtlMs?: number;
}

export interface ResolvedExecutionConfig {
  backend: ExecutionBackend;
  requireFor: ExecutionConfig["requireFor"];
  dockerCommand: string;
  networkPolicy: ContainerNetworkPolicy;
  pullPolicy: NonNullable<ExecutionConfig["pullPolicy"]>;
  images: Record<ContainerProfile | "gateway", string>;
  commandWaitMs: number;
  commandHardTimeoutMs: number;
  outputPreviewBytes: number;
  staleContainerTtlMs: number;
}

export interface ProofBladeConfig {
  schemaVersion: 1;
  runtime: { piVersion: string };
  storage: { runsDir: string; fixturesDir: string };
  tools?: { outputRewrite?: OutputRewriteConfig };
  intentScheduler?: IntentSchedulerConfig;
  execution?: ExecutionConfig;
  modelProfiles: { executor: ModelProfileConfig };
}

const DEFAULT_OUTPUT_REWRITE: ResolvedOutputRewriteConfig = {
  provider: "builtin",
  rtkCommand: "rtk",
  fallback: "builtin",
  rewriteTimeoutMs: 5_000,
  maxRawBytes: 1_048_576,
};

const DEFAULT_EXECUTION: ResolvedExecutionConfig = {
  backend: "host",
  requireFor: [],
  dockerCommand: "docker",
  networkPolicy: "target-only",
  pullPolicy: "if-missing",
  images: {
    web: "proofblade/ctf-web:latest",
    pwn: "proofblade/ctf-pwn:latest",
    "pwn-kernel": "proofblade/ctf-pwn-kernel:latest",
    gateway: "proofblade/ctf-egress-gateway:latest",
  },
  commandWaitMs: 30_000,
  commandHardTimeoutMs: 600_000,
  outputPreviewBytes: 50_000,
  staleContainerTtlMs: 3_600_000,
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

export function resolveExecutionConfig(config: ProofBladeConfig): ResolvedExecutionConfig {
  const input = config.execution ?? {};
  const backend = input.backend ?? DEFAULT_EXECUTION.backend;
  return {
    ...DEFAULT_EXECUTION,
    ...input,
    backend,
    requireFor: input.requireFor ?? (backend === "docker" ? ["web", "pwn"] : []),
    images: { ...DEFAULT_EXECUTION.images, ...input.images },
  };
}

function validateConfig(config: Partial<ProofBladeConfig>, path: string): void {
  if (config.schemaVersion !== 1) throw new Error(`Unsupported config schema in ${path}`);
  if (config.runtime?.piVersion !== "0.83.0") throw new Error(`Config ${path} must lock Pi to 0.83.0`);
  const profile = config.modelProfiles?.executor;
  if (!profile) throw new Error(`Config ${path} is missing modelProfiles.executor`);
  if (!(["openai-completions", "openai-responses", "anthropic-messages"] as const).includes(profile.api)) throw new Error(`Unsupported provider API: ${String(profile.api)}`);
  if (!profile.provider || !profile.baseUrl || !profile.model) throw new Error(`Config ${path} has an incomplete executor profile`);
  if (profile.proxyUrl !== undefined) validateHttpUrl(profile.proxyUrl, `proxyUrl in ${path}`);
  if (profile.endpointMode !== undefined && profile.endpointMode !== "exact") throw new Error(`Invalid endpointMode in ${path} (only "exact" is supported)`);
  if (!Number.isFinite(profile.contextWindow) || profile.contextWindow < 1024) throw new Error(`Invalid contextWindow in ${path}`);
  if (!Number.isFinite(profile.maxTokens) || profile.maxTokens < 1) throw new Error(`Invalid maxTokens in ${path}`);
  if (!Number.isInteger(profile.maxRetries) || profile.maxRetries < 0 || profile.maxRetries > 8) throw new Error(`Invalid maxRetries in ${path}`);
  if (profile.maxConcurrentRequests !== undefined && (!Number.isInteger(profile.maxConcurrentRequests) || profile.maxConcurrentRequests < 1 || profile.maxConcurrentRequests > 32)) throw new Error(`Invalid maxConcurrentRequests in ${path}`);
  if (profile.maxRetryDelayMs !== undefined && (!Number.isInteger(profile.maxRetryDelayMs) || profile.maxRetryDelayMs < 0 || profile.maxRetryDelayMs > 300_000)) throw new Error(`Invalid maxRetryDelayMs in ${path}`);
  if (profile.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(profile.thinkingLevel)) throw new Error(`Invalid thinkingLevel in ${path}`);
  if (profile.cacheRetention !== undefined && !["none", "short", "long"].includes(profile.cacheRetention)) throw new Error(`Invalid cacheRetention in ${path}`);
  if (profile.maxTokensField !== undefined && profile.maxTokensField !== "max_tokens" && profile.maxTokensField !== "max_completion_tokens") throw new Error(`Invalid maxTokensField in ${path}`);
  if (profile.pricing !== undefined) validatePricing(profile.pricing, path);
  const rewrite = config.tools?.outputRewrite;
  if (rewrite !== undefined) {
    if (rewrite.provider !== "builtin" && rewrite.provider !== "rtk") throw new Error(`Invalid outputRewrite provider in ${path}`);
    if (rewrite.rtkCommand !== undefined && rewrite.rtkCommand.trim().length === 0) throw new Error(`Invalid outputRewrite rtkCommand in ${path}`);
    if (rewrite.fallback !== undefined && rewrite.fallback !== "builtin" && rewrite.fallback !== "fail") throw new Error(`Invalid outputRewrite fallback in ${path}`);
    if (rewrite.rewriteTimeoutMs !== undefined && (!Number.isInteger(rewrite.rewriteTimeoutMs) || rewrite.rewriteTimeoutMs < 100 || rewrite.rewriteTimeoutMs > 30_000)) throw new Error(`Invalid outputRewrite rewriteTimeoutMs in ${path}`);
    if (rewrite.maxRawBytes !== undefined && (!Number.isInteger(rewrite.maxRawBytes) || rewrite.maxRawBytes < 512 || rewrite.maxRawBytes > 16_777_216)) throw new Error(`Invalid outputRewrite maxRawBytes in ${path}`);
  }
  const scheduler = config.intentScheduler;
  if (scheduler !== undefined) {
    if (!isRecord(scheduler)) throw new Error(`Invalid intentScheduler in ${path}`);
    const maxOpenIntents = scheduler.maxOpenIntents;
    const maxAttemptsPerIntent = scheduler.maxAttemptsPerIntent;
    if (maxOpenIntents !== undefined && (typeof maxOpenIntents !== "number" || !Number.isInteger(maxOpenIntents) || maxOpenIntents < 1)) throw new Error(`Invalid intentScheduler maxOpenIntents in ${path}`);
    if (maxAttemptsPerIntent !== undefined && (typeof maxAttemptsPerIntent !== "number" || !Number.isInteger(maxAttemptsPerIntent) || maxAttemptsPerIntent < 1)) throw new Error(`Invalid intentScheduler maxAttemptsPerIntent in ${path}`);
    const scoringWeights = scheduler.scoringWeights;
    if (scoringWeights !== undefined) {
      if (!isRecord(scoringWeights)) throw new Error(`Invalid intentScheduler scoringWeights in ${path}`);
      const known = new Set<keyof IntentScoringWeights>(["informationGain", "successProbability", "evidenceRelevance", "novelty", "cost", "environmentRisk", "duplicateSimilarity", "dependencyDepth"]);
      for (const [name, value] of Object.entries(scoringWeights)) {
        if (!known.has(name as keyof IntentScoringWeights) || typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid intentScheduler scoring weight ${name} in ${path}`);
      }
    }
  }
  const execution = config.execution;
  if (execution !== undefined) {
    if (execution.backend !== undefined && execution.backend !== "host" && execution.backend !== "docker") throw new Error(`Invalid execution.backend in ${path}`);
    if (execution.networkPolicy !== undefined && !["none", "bridge", "target-only"].includes(execution.networkPolicy)) throw new Error(`Invalid execution.networkPolicy in ${path}`);
    if (execution.pullPolicy !== undefined && !["if-missing", "never", "always"].includes(execution.pullPolicy)) throw new Error(`Invalid execution.pullPolicy in ${path}`);
    if (execution.dockerCommand !== undefined && execution.dockerCommand.trim().length === 0) throw new Error(`Invalid execution.dockerCommand in ${path}`);
    if (execution.requireFor !== undefined && execution.requireFor.some((kind) => !["web", "pwn", "reverse", "crypto", "script", "forensics", "misc", "osint", "malware", "ai-ml", "unknown"].includes(kind))) throw new Error(`Invalid execution.requireFor in ${path}`);
    if (execution.commandWaitMs !== undefined && (!Number.isInteger(execution.commandWaitMs) || execution.commandWaitMs < 100 || execution.commandWaitMs > 300_000)) throw new Error(`Invalid execution.commandWaitMs in ${path}`);
    if (execution.commandHardTimeoutMs !== undefined && (!Number.isInteger(execution.commandHardTimeoutMs) || execution.commandHardTimeoutMs < 1_000 || execution.commandHardTimeoutMs > 3_600_000)) throw new Error(`Invalid execution.commandHardTimeoutMs in ${path}`);
    if (execution.outputPreviewBytes !== undefined && (!Number.isInteger(execution.outputPreviewBytes) || execution.outputPreviewBytes < 512 || execution.outputPreviewBytes > 16_777_216)) throw new Error(`Invalid execution.outputPreviewBytes in ${path}`);
    if (execution.staleContainerTtlMs !== undefined && (!Number.isInteger(execution.staleContainerTtlMs) || execution.staleContainerTtlMs < 60_000)) throw new Error(`Invalid execution.staleContainerTtlMs in ${path}`);
    if (execution.images !== undefined) {
      for (const [profile, image] of Object.entries(execution.images)) {
        if (!["web", "pwn", "pwn-kernel", "gateway"].includes(profile) || typeof image !== "string" || image.trim().length === 0) throw new Error(`Invalid execution.images.${profile} in ${path}`);
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePricing(pricing: ModelPricingConfig, path: string): void {
  for (const [field, value] of Object.entries(pricing)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid pricing.${field} in ${path}`);
  }
  if (pricing.inputUsdPerMillion <= 0 || pricing.outputUsdPerMillion <= 0) {
    throw new Error(`pricing inputUsdPerMillion and outputUsdPerMillion must be positive in ${path}`);
  }
}

function validateHttpUrl(value: string, label: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`Invalid ${label}`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`Invalid ${label}`);
}
