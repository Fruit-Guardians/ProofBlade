import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelProfileConfig, ProofBladeConfig } from "../config.js";
import type { TargetKind } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";

export const ABLATION_SCHEMA_VERSION = 1 as const;
export const ABLATION_PROTOCOL_VERSION = "ablation-v2" as const;
export type AblationProtocolVersion = "ablation-v1" | typeof ABLATION_PROTOCOL_VERSION;

export type AblationRunOrder = "interleaved" | "stratified";
export type AblationChangedFactor =
  | "none"
  | "first_action"
  | "phase_route"
  | "action_bundle"
  | "duplicate_failure"
  | "circuit_breaker"
  | "context_delivery"
  | "recall"
  | "evidence_curation"
  | "information_value"
  | "compression"
  | "stop_suggestion"
  | "composite";

export type FirstActionMode = "hard_gate" | "soft_advice" | "off";
export type PhaseRouteMode = "hard_gate" | "soft_advice" | "off";
export type ActionBundleMode = "hard_gate" | "soft_advice" | "off";
export type DuplicateFailureMode = "hard_stop" | "advice" | "record";
export type CircuitBreakerMode = "hard_stop" | "adaptive" | "advice" | "off";
export type ContextSelectionMode = "fixed_recent" | "receipt" | "deterministic_broker";
export type RecallMode = "manual" | "advice" | "automatic";
export type EvidenceCurationMode = "manual" | "advice" | "draft";
export type InformationValueEstimator = "off" | "heuristic" | "verified_uplift" | "pmi" | "posterior_eig" | "decision_voi";
export type CompressionMode = "off" | "bounded_summary" | "query_aware" | "rate_distortion";
export type StopSuggestionMode = "off" | "soft_advice" | "verifier_driven";

export interface HarnessPolicy {
  firstAction: FirstActionMode;
  phaseRoute: PhaseRouteMode;
  actionBundle: ActionBundleMode;
  duplicateFailure: DuplicateFailureMode;
  circuitBreaker: CircuitBreakerMode;
  contextSelection: ContextSelectionMode;
  recall: RecallMode;
  evidenceCuration: EvidenceCurationMode;
  informationValue: InformationValueEstimator;
  compression: CompressionMode;
  stopSuggestion: StopSuggestionMode;
}

export const DEFAULT_HARNESS_POLICY: HarnessPolicy = {
  // Cognitive scaffolding should guide a capable agent without turning a
  // preparation guess into a denial of service. Hard modes remain explicit
  // ablation variants; safety and resource boundaries stay enforced.
  firstAction: "soft_advice",
  phaseRoute: "soft_advice",
  actionBundle: "soft_advice",
  duplicateFailure: "advice",
  circuitBreaker: "adaptive",
  contextSelection: "fixed_recent",
  recall: "manual",
  evidenceCuration: "manual",
  informationValue: "off",
  compression: "off",
  stopSuggestion: "off",
};

const LEGACY_V1_HARNESS_POLICY: HarnessPolicy = {
  ...DEFAULT_HARNESS_POLICY,
  firstAction: "hard_gate",
  phaseRoute: "hard_gate",
  actionBundle: "hard_gate",
  duplicateFailure: "hard_stop",
  circuitBreaker: "hard_stop",
};

export interface FixedSafetyBoundary {
  workspaceScope: "enforced";
  secretIsolation: "enforced";
  generationFence: "enforced";
  effectJournal: "enforced";
  userCancellation: "enforced";
  costHardCap: "enforced";
  verifierCompletion: "enforced";
  candidateLeakCheck: "enforced";
}

export const FIXED_SAFETY_BOUNDARY: FixedSafetyBoundary = {
  workspaceScope: "enforced",
  secretIsolation: "enforced",
  generationFence: "enforced",
  effectJournal: "enforced",
  userCancellation: "enforced",
  costHardCap: "enforced",
  verifierCompletion: "enforced",
  candidateLeakCheck: "enforced",
};

export interface AblationCorpusRef {
  path: string;
  hash?: string;
}

export interface AblationModelInput {
  profileId: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  sampling?: { temperature?: number; seed?: number };
  contextWindow?: number;
  maxTokens?: number;
}

export interface AblationVariantInput {
  id: string;
  name: string;
  hypothesis?: string;
  changedFactor: AblationChangedFactor;
  baseline?: boolean;
  policy?: Partial<HarnessPolicy>;
  modelOverride?: { model?: string; thinkingLevel?: ThinkingLevel };
  /** Explicitly permits several policy changes, but is never treated as a single-factor result. */
  multiFactor?: boolean;
}

export interface AblationExperimentInput {
  schemaVersion: 1;
  experimentId: string;
  name: string;
  question: string;
  hypothesis?: string;
  corpus: AblationCorpusRef;
  model: AblationModelInput;
  budget: { attempts: number; maxTurns: number; maxCostUsd: number; deadlineMs: number };
  variants: AblationVariantInput[];
  runOrder?: { mode?: AblationRunOrder; seed?: number };
  safety?: Partial<FixedSafetyBoundary>;
}

export interface AblationModelSnapshot {
  profileId: string;
  provider: string;
  api: ModelProfileConfig["api"];
  baseUrl: string;
  /** Optional proxy endpoint used by the immutable Provider transport. */
  proxyUrl?: string;
  apiKeyEnv: string;
  endpointMode?: "exact";
  model: string;
  thinkingLevel?: ThinkingLevel;
  sampling?: { temperature?: number; seed?: number };
  contextWindow: number;
  maxTokens: number;
  profileFingerprint: string;
}

export interface AblationPolicySnapshot {
  policy: HarnessPolicy;
  policyFingerprint: string;
  changedFactors: AblationChangedFactor[];
  multiFactor: boolean;
}

export interface AblationVariantSnapshot extends AblationVariantInput {
  baseline: boolean;
  policySnapshot: AblationPolicySnapshot;
  modelSnapshot: AblationModelSnapshot;
}

export interface AblationExperimentSnapshot {
  protocolVersion: AblationProtocolVersion;
  schemaVersion: 1;
  experimentId: string;
  name: string;
  question: string;
  hypothesis?: string;
  corpus: Required<AblationCorpusRef>;
  model: AblationModelSnapshot;
  budget: AblationExperimentInput["budget"];
  variants: AblationVariantSnapshot[];
  runOrder: Required<NonNullable<AblationExperimentInput["runOrder"]>>;
  safety: FixedSafetyBoundary;
  experimentFingerprint: string;
}

export type AblationExperimentStatus = "draft" | "ready" | "running" | "paused" | "completed" | "failed";
export type AblationAttemptStatus = "ready" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";

export interface AblationPairing {
  pairingId: string;
  caseId: string;
  attempt: number;
  variantId: string;
  ordinal: number;
}

export interface AblationAttemptRecord extends AblationPairing {
  status: AblationAttemptStatus;
  runId?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** Bounded, prompt/candidate-free result snapshot for crash recovery. */
  result?: Record<string, unknown>;
}

export interface AblationCaseRef {
  id: string;
  targetKind?: TargetKind;
}

function canonicalProviderBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function validateAblationExperiment(value: unknown, profile?: ModelProfileConfig): AblationExperimentSnapshot {
  if (!isRecord(value)) throw new Error("Ablation experiment must be a JSON object");
  if (value.schemaVersion !== 1) throw new Error("Ablation experiment schemaVersion must be 1");
  const experimentId = requiredId(value.experimentId, "experimentId");
  const name = requiredText(value.name, "name", 256);
  const question = requiredText(value.question, "question", 4096);
  const hypothesis = value.hypothesis === undefined ? undefined : requiredText(value.hypothesis, "hypothesis", 4096);
  const corpus = validateCorpus(value.corpus);
  const modelInput = validateModelInput(value.model);
  if (modelInput.model === "auto") throw new Error("Ablation experiments require a concrete model; model=auto is only allowed for exploration");
  const model = snapshotModel(modelInput, profile);
  const budget = validateBudget(value.budget);
  const variants = validateVariants(value.variants, model, profile);
  const baselineCount = variants.filter((item) => item.baseline).length;
  if (baselineCount !== 1) throw new Error(`Ablation experiment requires exactly one baseline variant (found ${baselineCount})`);
  const baseline = variants.find((item) => item.baseline)!;
  if (baseline.changedFactor !== "none") throw new Error("Baseline variant must declare changedFactor=none");
  const runOrder = validateRunOrder(value.runOrder);
  const safety = validateSafety(value.safety);
  const withoutFingerprint = { protocolVersion: ABLATION_PROTOCOL_VERSION, schemaVersion: 1 as const, experimentId, name, question, ...(hypothesis === undefined ? {} : { hypothesis }), corpus, model, budget, variants, runOrder, safety };
  return { ...withoutFingerprint, experimentFingerprint: sha256(canonicalJson(withoutFingerprint)) };
}

export function snapshotModel(input: AblationModelInput, profile?: ModelProfileConfig): AblationModelSnapshot {
  const resolved = profile ?? ({ provider: input.profileId, api: "openai-completions", baseUrl: "", model: input.model, modelDiscoveryPath: "/models", apiKeyEnv: "", contextWindow: input.contextWindow ?? 0, maxTokens: input.maxTokens ?? 0, requestTimeoutMs: 1, maxRetries: 0, input: ["text"] } satisfies ModelProfileConfig);
  const model = input.model.trim();
  if (profile && profile.model !== "auto" && model !== profile.model && model !== "auto") throw new Error(`Experiment model ${model} does not match Provider profile model ${profile.model}`);
  const snapshot = {
    profileId: input.profileId.trim(), provider: resolved.provider, api: resolved.api, baseUrl: canonicalProviderBaseUrl(resolved.baseUrl),
    ...(resolved.proxyUrl ? { proxyUrl: resolved.proxyUrl } : {}),
    apiKeyEnv: resolved.apiKeyEnv, ...(resolved.endpointMode === undefined ? {} : { endpointMode: resolved.endpointMode }), model,
    ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
    ...(input.sampling === undefined ? {} : { sampling: input.sampling }), contextWindow: input.contextWindow ?? resolved.contextWindow, maxTokens: input.maxTokens ?? resolved.maxTokens,
  } as Omit<AblationModelSnapshot, "profileFingerprint">;
  return { ...snapshot, profileFingerprint: sha256(canonicalJson({ provider: resolved.provider, api: resolved.api, baseUrl: snapshot.baseUrl, endpointMode: resolved.endpointMode ?? "", apiKeyEnv: resolved.apiKeyEnv, proxyUrl: resolved.proxyUrl ?? "", model, contextWindow: resolved.contextWindow, maxTokens: resolved.maxTokens, thinkingLevel: snapshot.thinkingLevel ?? "", sampling: snapshot.sampling ?? {} })) };
}

export interface AblationPreflightCheck { id: string; passed: boolean; actual: string | number; expected: string | number; }
export interface AblationPreflightSummary {
  schemaVersion: 1;
  experimentId: string;
  provider: { id: string; api: string; baseUrl: string; model: string; apiKeyEnv: string; credentialPresent: boolean; pricingPresent: boolean };
  estimatedMaxRequests: number;
  checks: AblationPreflightCheck[];
  ready: boolean;
}

/** Validate an immutable snapshot against the selected local Provider profile. */
export function preflightAblationExperiment(experiment: AblationExperimentSnapshot, profile: ModelProfileConfig, options: { probe?: boolean; fetch?: typeof globalThis.fetch } = {}): Promise<AblationPreflightSummary> {
  return (async () => {
    const envName = profile.apiKeyEnv.trim();
    const credentialPresent = envName.length > 0 && Boolean(process.env[envName]?.trim());
    const pricingPresent = profile.pricing !== undefined && profile.pricing.inputUsdPerMillion > 0 && profile.pricing.outputUsdPerMillion > 0;
    const currentSnapshot = snapshotModel({
      profileId: experiment.model.profileId,
      model: experiment.model.model,
      ...(experiment.model.thinkingLevel === undefined ? {} : { thinkingLevel: experiment.model.thinkingLevel }),
      ...(experiment.model.sampling === undefined ? {} : { sampling: experiment.model.sampling }),
      contextWindow: experiment.model.contextWindow,
      maxTokens: experiment.model.maxTokens,
    }, profile);
    const checks: AblationPreflightCheck[] = [
      { id: "concrete_model", passed: experiment.model.model !== "auto", actual: experiment.model.model, expected: "concrete model" },
      { id: "provider_match", passed: experiment.model.profileFingerprint === currentSnapshot.profileFingerprint, actual: experiment.model.profileFingerprint, expected: currentSnapshot.profileFingerprint },
      { id: "credential", passed: credentialPresent, actual: credentialPresent ? "present" : "missing", expected: "present" },
      { id: "pricing", passed: pricingPresent, actual: pricingPresent ? "valid" : "missing_or_invalid", expected: "valid" },
    ];
    if (options.probe) {
      const probe = await probeAblationProvider(experiment, profile, options.fetch);
      checks.push({ id: "provider_probe", passed: probe.ok, actual: probe.status, expected: "2xx" });
    }
    return { schemaVersion: 1, experimentId: experiment.experimentId, provider: { id: profile.provider, api: profile.api, baseUrl: profile.baseUrl, model: experiment.model.model, apiKeyEnv: envName, credentialPresent, pricingPresent }, estimatedMaxRequests: experiment.budget.attempts * experiment.budget.maxTurns * experiment.variants.length, checks, ready: checks.every((item) => item.passed) };
  })();
}

export interface AblationProviderProbe { ok: boolean; status: number | string; modelId?: string; modelsHash?: string; }

/** Probe only the model-discovery endpoint; task content is never sent. */
export async function probeAblationProvider(experiment: AblationExperimentSnapshot, profile: ModelProfileConfig, providerFetch: typeof globalThis.fetch = fetch): Promise<AblationProviderProbe> {
  const path = profile.modelDiscoveryPath.startsWith("/") ? profile.modelDiscoveryPath : `/${profile.modelDiscoveryPath}`;
  const endpoint = `${profile.baseUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = profile.api === "anthropic-messages" ? { "x-api-key": process.env[profile.apiKeyEnv] ?? "", "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${process.env[profile.apiKeyEnv] ?? ""}` };
  try {
    const response = await providerFetch(endpoint, { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { ok: false, status: response.status };
    const body = await response.json() as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? []).map((item) => item.id).filter((item): item is string => Boolean(item)).sort();
    const modelId = ids.find((id) => id === experiment.model.model);
    return { ok: Boolean(modelId), status: response.status, ...(modelId ? { modelId } : {}), modelsHash: sha256(canonicalJson(ids)) };
  } catch (error) { return { ok: false, status: error instanceof Error ? error.name : "error" }; }
}

export class AblationExperimentStore {
  public constructor(private readonly directory: string) {}
  public async save(experiment: AblationExperimentSnapshot): Promise<string> {
    const root = resolve(this.directory);
    await mkdir(root, { recursive: true });
    const path = join(root, `${experiment.experimentId}.json`);
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(experiment, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
    return path;
  }
  public async load(experimentId: string): Promise<AblationExperimentSnapshot> {
    const id = requiredId(experimentId, "experimentId");
    const parsed = JSON.parse(await readFile(join(resolve(this.directory), `${id}.json`), "utf8")) as AblationExperimentSnapshot;
    assertSnapshotIntegrity(parsed);
    return hydrateLegacySnapshot(parsed);
  }
  public async list(): Promise<Array<Pick<AblationExperimentSnapshot, "experimentId" | "name" | "experimentFingerprint">>> {
    let names: string[];
    try { names = await readdir(resolve(this.directory)); } catch (error) { if ((error as { code?: string }).code === "ENOENT") return []; throw error; }
    const results: Array<Pick<AblationExperimentSnapshot, "experimentId" | "name" | "experimentFingerprint">> = [];
    // Mutable runtime projections share this directory; only an exact
    // experiment snapshot is valid input to list().
    for (const name of names.filter((item) => item.endsWith(".json") && !item.endsWith(".ledger.json") && !item.endsWith(".results.json") && !item.endsWith(".status.json")).sort()) {
      const parsed = JSON.parse(await readFile(join(resolve(this.directory), name), "utf8")) as AblationExperimentSnapshot;
      assertSnapshotIntegrity(parsed);
      results.push({ experimentId: parsed.experimentId, name: parsed.name, experimentFingerprint: parsed.experimentFingerprint });
    }
    return results;
  }
}

function assertSnapshotIntegrity(snapshot: AblationExperimentSnapshot): void {
  if (!snapshot || snapshot.schemaVersion !== 1 || (snapshot.protocolVersion !== "ablation-v1" && snapshot.protocolVersion !== ABLATION_PROTOCOL_VERSION)) throw new Error("Invalid ablation experiment snapshot");
  const { experimentFingerprint: _fingerprint, ...content } = snapshot;
  if (_fingerprint !== sha256(canonicalJson(content))) throw new Error("Ablation experiment snapshot fingerprint mismatch");
}

/** v1 snapshots preceded advisory defaults. Preserve their historical meaning
 * when an old file omitted an expanded policy object. */
function hydrateLegacySnapshot(snapshot: AblationExperimentSnapshot): AblationExperimentSnapshot {
  if (snapshot.protocolVersion !== "ablation-v1") return snapshot;
  return {
    ...snapshot,
    variants: snapshot.variants.map((variant) => {
      const policy = normalizePolicy(variant.policy ?? variant.policySnapshot?.policy, LEGACY_V1_HARNESS_POLICY);
      return {
        ...variant,
        policy,
        policySnapshot: {
          policy,
          policyFingerprint: sha256(canonicalJson(policy)),
          changedFactors: policyDiff(policy, LEGACY_V1_HARNESS_POLICY),
          multiFactor: variant.multiFactor === true || variant.changedFactor === "composite" || policyDiff(policy, LEGACY_V1_HARNESS_POLICY).length > 1,
        },
      };
    }),
  };
}

export function buildAblationPairings(experiment: Pick<AblationExperimentSnapshot, "experimentId" | "variants" | "runOrder" | "budget">, cases: readonly AblationCaseRef[]): AblationPairing[] {
  const sortedCases = [...cases].sort((a, b) => a.id.localeCompare(b.id));
  const variants = [...experiment.variants].sort((a, b) => a.id.localeCompare(b.id));
  const rows: AblationPairing[] = [];
  for (let attempt = 1; attempt <= experiment.budget.attempts; attempt += 1) {
    for (const item of sortedCases) for (const variant of variants) rows.push({ pairingId: `${experiment.experimentId}:${item.id}:${attempt}:${variant.id}`, caseId: item.id, attempt, variantId: variant.id, ordinal: rows.length });
  }
  if (experiment.runOrder.mode === "stratified") return stableShuffle(rows, experiment.runOrder.seed);
  return interleaveByCase(rows, sortedCases, variants);
}

function validateVariants(value: unknown, model: AblationModelSnapshot, profile?: ModelProfileConfig): AblationVariantSnapshot[] {
  if (!Array.isArray(value) || value.length < 2) throw new Error("Ablation experiment requires at least two variants");
  const ids = new Set<string>();
  return value.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`Variant ${index} must be an object`);
    const id = requiredId(raw.id, `variant ${index} id`);
    if (ids.has(id)) throw new Error(`Duplicate ablation variant id: ${id}`);
    ids.add(id);
    const name = requiredText(raw.name, `variant ${id} name`, 256);
    const changedFactor = raw.changedFactor;
    if (!["none", "first_action", "phase_route", "action_bundle", "duplicate_failure", "circuit_breaker", "context_delivery", "recall", "evidence_curation", "information_value", "compression", "stop_suggestion", "composite"].includes(String(changedFactor))) throw new Error(`Variant ${id} has an invalid changedFactor`);
    const policy = normalizePolicy(raw.policy);
    const baseline = raw.baseline === true;
    const modelOverride = validateModelOverride(raw.modelOverride, id);
    if (modelOverride?.model && modelOverride.model !== model.model) throw new Error(`Variant ${id} changes the concrete model; strict ablation variants must share one model`);
    const changedFactors = policyDiff(policy);
    const multiFactor = raw.multiFactor === true || changedFactor === "composite" || changedFactors.length > 1;
    if (changedFactor !== "none" && changedFactors.length === 0) throw new Error(`Variant ${id} declares ${changedFactor} but does not change any ablation policy`);
    if (changedFactor !== "none" && changedFactor !== "composite" && changedFactors.some((item) => item !== changedFactor)) throw new Error(`Variant ${id} changes ${changedFactors.join(", ")} but declares ${changedFactor}`);
    if (changedFactor === "composite" && !multiFactor) throw new Error(`Variant ${id} must set multiFactor for composite experiments`);
    const variantModel = modelOverride ? snapshotModel({ profileId: model.profileId, model: modelOverride.model ?? model.model, thinkingLevel: modelOverride.thinkingLevel ?? model.thinkingLevel, contextWindow: model.contextWindow, maxTokens: model.maxTokens }, profile) : model;
    const policySnapshot = { policy, policyFingerprint: sha256(canonicalJson(policy)), changedFactors, multiFactor };
    return { id, name, ...(raw.hypothesis === undefined ? {} : { hypothesis: requiredText(raw.hypothesis, `variant ${id} hypothesis`, 4096) }), changedFactor: changedFactor as AblationChangedFactor, baseline, ...(modelOverride === undefined ? {} : { modelOverride }), policy, policySnapshot, modelSnapshot: variantModel, ...(raw.multiFactor === undefined ? {} : { multiFactor: raw.multiFactor === true }) };
  });
}

function normalizePolicy(value: unknown, defaults: HarnessPolicy = DEFAULT_HARNESS_POLICY): HarnessPolicy {
  if (value !== undefined && !isRecord(value)) throw new Error("Variant policy must be an object");
  const input = (value ?? {}) as Record<string, unknown>;
  const policy = { ...defaults } as HarnessPolicy;
  for (const key of Object.keys(defaults) as Array<keyof HarnessPolicy>) {
    if (input[key] !== undefined) {
      if (!allowedPolicyValues(key).includes(String(input[key]))) throw new Error(`Invalid harness policy ${key}: ${String(input[key])}`);
      (policy[key] as string) = String(input[key]);
    }
  }
  for (const key of Object.keys(input)) if (!(key in defaults)) throw new Error(`Unknown harness policy field: ${key}`);
  return policy;
}

function policyDiff(policy: HarnessPolicy, defaults: HarnessPolicy = DEFAULT_HARNESS_POLICY): AblationChangedFactor[] {
  const mapping: Array<[keyof HarnessPolicy, AblationChangedFactor]> = [["firstAction", "first_action"], ["phaseRoute", "phase_route"], ["actionBundle", "action_bundle"], ["duplicateFailure", "duplicate_failure"], ["circuitBreaker", "circuit_breaker"], ["contextSelection", "context_delivery"], ["recall", "recall"], ["evidenceCuration", "evidence_curation"], ["informationValue", "information_value"], ["compression", "compression"], ["stopSuggestion", "stop_suggestion"]];
  return mapping.filter(([key]) => policy[key] !== defaults[key]).map(([, factor]) => factor);
}

function validateCorpus(value: unknown): Required<AblationCorpusRef> {
  if (!isRecord(value)) throw new Error("Ablation corpus must be an object");
  const path = requiredText(value.path, "corpus.path", 1024);
  const hash = value.hash === undefined ? "unbound" : requiredText(value.hash, "corpus.hash", 128);
  if (hash !== "unbound" && !/^[a-f0-9]{64}$/i.test(hash)) throw new Error("corpus.hash must be a SHA-256 hash");
  return { path, hash: hash.toLowerCase() };
}

function validateModelInput(value: unknown): AblationModelInput {
  if (!isRecord(value)) throw new Error("Ablation model must be an object");
  const profileId = requiredId(value.profileId, "model.profileId");
  const model = requiredText(value.model, "model.model", 256);
  const thinkingLevel = value.thinkingLevel as ThinkingLevel | undefined;
  if (thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingLevel)) throw new Error("Invalid model.thinkingLevel");
  const sampling = value.sampling === undefined ? undefined : validateSampling(value.sampling);
  const contextWindow = value.contextWindow === undefined ? undefined : positiveInt(value.contextWindow, "model.contextWindow");
  const maxTokens = value.maxTokens === undefined ? undefined : positiveInt(value.maxTokens, "model.maxTokens");
  return { profileId, model, ...(thinkingLevel === undefined ? {} : { thinkingLevel }), ...(sampling === undefined ? {} : { sampling }), ...(contextWindow === undefined ? {} : { contextWindow }), ...(maxTokens === undefined ? {} : { maxTokens }) };
}

function validateModelOverride(value: unknown, id: string): AblationVariantInput["modelOverride"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Variant ${id} modelOverride must be an object`);
  const model = value.model === undefined ? undefined : requiredText(value.model, `Variant ${id} modelOverride.model`, 256);
  const thinkingLevel = value.thinkingLevel as ThinkingLevel | undefined;
  if (thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingLevel)) throw new Error(`Invalid Variant ${id} modelOverride.thinkingLevel`);
  return model === undefined && thinkingLevel === undefined ? undefined : { ...(model === undefined ? {} : { model }), ...(thinkingLevel === undefined ? {} : { thinkingLevel }) };
}

function validateSampling(value: unknown): NonNullable<AblationModelInput["sampling"]> {
  if (!isRecord(value)) throw new Error("model.sampling must be an object");
  const temperature = value.temperature === undefined ? undefined : finiteRange(value.temperature, "model.sampling.temperature", 0, 2);
  const seed = value.seed === undefined ? undefined : integer(value.seed, "model.sampling.seed");
  if (temperature === undefined && seed === undefined) throw new Error("model.sampling must contain temperature or seed");
  return { ...(temperature === undefined ? {} : { temperature }), ...(seed === undefined ? {} : { seed }) };
}

function validateBudget(value: unknown): AblationExperimentInput["budget"] {
  if (!isRecord(value)) throw new Error("Ablation budget must be an object");
  return { attempts: positiveInt(value.attempts, "budget.attempts"), maxTurns: positiveInt(value.maxTurns, "budget.maxTurns"), maxCostUsd: positiveNumber(value.maxCostUsd, "budget.maxCostUsd"), deadlineMs: positiveInt(value.deadlineMs, "budget.deadlineMs") };
}

function validateRunOrder(value: unknown): Required<NonNullable<AblationExperimentInput["runOrder"]>> {
  if (value !== undefined && !isRecord(value)) throw new Error("runOrder must be an object");
  const input = (value ?? {}) as Record<string, unknown>;
  const mode = input.mode === undefined ? "interleaved" : input.mode;
  if (mode !== "interleaved" && mode !== "stratified") throw new Error("runOrder.mode must be interleaved or stratified");
  const seed = input.seed === undefined ? 0 : integer(input.seed, "runOrder.seed");
  return { mode, seed };
}

function validateSafety(value: unknown): FixedSafetyBoundary {
  if (value !== undefined && !isRecord(value)) throw new Error("safety must be an object");
  for (const [key, expected] of Object.entries(FIXED_SAFETY_BOUNDARY)) if (value !== undefined && (value as Record<string, unknown>)[key] !== undefined && (value as Record<string, unknown>)[key] !== expected) throw new Error(`Safety boundary ${key} cannot be disabled or changed`);
  if (value !== undefined) for (const key of Object.keys(value)) if (!(key in FIXED_SAFETY_BOUNDARY)) throw new Error(`Unknown safety boundary: ${key}`);
  return FIXED_SAFETY_BOUNDARY;
}

function allowedPolicyValues(key: keyof HarnessPolicy): string[] {
  const values: Record<keyof HarnessPolicy, string[]> = { firstAction: ["hard_gate", "soft_advice", "off"], phaseRoute: ["hard_gate", "soft_advice", "off"], actionBundle: ["hard_gate", "soft_advice", "off"], duplicateFailure: ["hard_stop", "advice", "record"], circuitBreaker: ["hard_stop", "adaptive", "advice", "off"], contextSelection: ["fixed_recent", "receipt", "deterministic_broker"], recall: ["manual", "advice", "automatic"], evidenceCuration: ["manual", "advice", "draft"], informationValue: ["off", "heuristic", "verified_uplift", "pmi", "posterior_eig", "decision_voi"], compression: ["off", "bounded_summary", "query_aware", "rate_distortion"], stopSuggestion: ["off", "soft_advice", "verifier_driven"] };
  return values[key];
}

function interleaveByCase(rows: AblationPairing[], cases: readonly AblationCaseRef[], variants: readonly AblationVariantSnapshot[]): AblationPairing[] {
  const output: AblationPairing[] = [];
  for (let attempt = 1; attempt <= Math.max(...rows.map((item) => item.attempt), 0); attempt += 1) for (const item of [...cases].sort((a, b) => a.id.localeCompare(b.id))) for (const variant of [...variants].sort((a, b) => a.id.localeCompare(b.id))) {
    const row = rows.find((candidate) => candidate.attempt === attempt && candidate.caseId === item.id && candidate.variantId === variant.id);
    if (row) output.push({ ...row, ordinal: output.length });
  }
  return output;
}

function stableShuffle(rows: AblationPairing[], seed: number): AblationPairing[] {
  return rows.map((row, index) => ({ row, key: sha256(`${seed}:${row.pairingId}`), index })).sort((a, b) => a.key.localeCompare(b.key) || a.index - b.index).map(({ row }, ordinal) => ({ ...row, ordinal }));
}

function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function requiredText(value: unknown, label: string, max: number): string { if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > max) throw new Error(`${label} must be non-empty and at most ${max} characters`); return value.trim(); }
function requiredId(value: unknown, label: string): string { const text = requiredText(value, label, 128); if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(text)) throw new Error(`${label} must be a stable alphanumeric identifier`); return text; }
function positiveInt(value: unknown, label: string): number { if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`); return value as number; }
function integer(value: unknown, label: string): number { if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`); return value as number; }
function positiveNumber(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number`); return value; }
function finiteRange(value: unknown, label: string, min: number, max: number): number { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`); return value; }
