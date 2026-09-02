import assert from "node:assert/strict";
import test from "node:test";
import { buildAblationPairings, DEFAULT_HARNESS_POLICY, preflightAblationExperiment, AblationExperimentStore, validateAblationExperiment } from "../src/index.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const profile = {
  provider: "relay",
  api: "openai-completions" as const,
  baseUrl: "https://aihub.top/v1",
  model: "luna-1",
  modelDiscoveryPath: "/models",
  apiKeyEnv: "TEST_KEY",
  contextWindow: 32768,
  maxTokens: 2048,
  requestTimeoutMs: 120000,
  maxRetries: 2,
  input: ["text"] as Array<"text">,
  pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cacheReadUsdPerMillion: 0, cacheWriteUsdPerMillion: 0 },
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    experimentId: "AB-20260831-001",
    name: "Receipt comparison",
    question: "Does bounded recall preserve verified success?",
    corpus: { path: "fixtures/private/manifest.json", hash: "a".repeat(64) },
    model: { profileId: "relay-a", model: "luna-1", thinkingLevel: "high", sampling: { temperature: 0.2, seed: 17 } },
    budget: { attempts: 2, maxTurns: 4, maxCostUsd: 3, deadlineMs: 600000 },
    variants: [
      { id: "baseline", name: "Full result baseline", baseline: true, changedFactor: "none", policy: {} },
      { id: "receipt", name: "Receipt and recall", changedFactor: "context_delivery", policy: { contextSelection: "receipt" } },
    ],
    ...overrides,
  };
}

test("validates a strict same-model ablation and produces stable fingerprints", () => {
  const first = validateAblationExperiment(input(), profile);
  const second = validateAblationExperiment(input(), profile);
  assert.equal(first.experimentFingerprint, second.experimentFingerprint);
  assert.equal(first.model.model, "luna-1");
  assert.equal(first.variants[0]?.policySnapshot.policy.firstAction, DEFAULT_HARNESS_POLICY.firstAction);
  assert.deepEqual(first.variants[1]?.policySnapshot.changedFactors, ["context_delivery"]);
  assert.equal(first.safety.secretIsolation, "enforced");
});

test("rejects auto model, duplicate baselines, policy mismatch and disabled safety", () => {
  assert.throws(() => validateAblationExperiment(input({ model: { profileId: "relay-a", model: "auto" } }), profile), /concrete model/);
  assert.throws(() => validateAblationExperiment(input({ variants: [input().variants[0], { ...input().variants[1], baseline: true }] }), profile), /exactly one baseline/);
  assert.throws(() => validateAblationExperiment(input({ variants: [input().variants[0], { ...input().variants[1], changedFactor: "recall" }] }), profile), /declares recall/);
  assert.throws(() => validateAblationExperiment(input({ variants: [input().variants[0], { id: "noop", name: "No-op", changedFactor: "recall", policy: {} }] }), profile), /does not change any ablation policy/);
  assert.throws(() => validateAblationExperiment(input({ safety: { verifierCompletion: "disabled" } }), profile), /cannot be disabled/);
});

test("marks composite policy changes and rejects a concrete model override", () => {
  const composite = validateAblationExperiment(input({ variants: [input().variants[0], { id: "combo", name: "Combo", changedFactor: "composite", multiFactor: true, policy: { recall: "automatic", compression: "bounded_summary" } }] }), profile);
  assert.equal(composite.variants[1]?.policySnapshot.multiFactor, true);
  assert.deepEqual(composite.variants[1]?.policySnapshot.changedFactors, ["recall", "compression"]);
  assert.throws(() => validateAblationExperiment(input({ variants: [input().variants[0], { ...input().variants[1], modelOverride: { model: "other-model" } }] }), profile), /strict ablation/);
});

test("builds deterministic interleaved and seeded stratified pairings", () => {
  const experiment = validateAblationExperiment(input(), profile);
  const cases = [{ id: "case-b" }, { id: "case-a" }];
  const interleaved = buildAblationPairings(experiment, cases);
  assert.deepEqual(interleaved.map((item) => `${item.attempt}:${item.caseId}:${item.variantId}`), [
    "1:case-a:baseline", "1:case-a:receipt", "1:case-b:baseline", "1:case-b:receipt",
    "2:case-a:baseline", "2:case-a:receipt", "2:case-b:baseline", "2:case-b:receipt",
  ]);
  const stratified = buildAblationPairings({ ...experiment, runOrder: { mode: "stratified", seed: 9 } }, cases);
  assert.deepEqual(stratified, buildAblationPairings({ ...experiment, runOrder: { mode: "stratified", seed: 9 } }, cases));
  assert.deepEqual(stratified.map((item) => item.ordinal), stratified.map((_, index) => index));
});

test("preflight exposes credential presence without exposing its value and probes only model metadata", async () => {
  process.env.TEST_KEY = "secret-value-that-must-not-be-returned";
  const experiment = validateAblationExperiment(input(), profile);
  const result = await preflightAblationExperiment(experiment, profile, {
    probe: true,
    fetch: async (url, init) => {
      assert.match(String(url), /models$/);
      assert.match(String((init?.headers as Record<string, string>).authorization), /^Bearer secret-value/);
      return new Response(JSON.stringify({ data: [{ id: "luna-1" }] }), { status: 200 });
    },
  });
  assert.equal(result.ready, true);
  assert.equal(result.provider.credentialPresent, true);
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
  delete process.env.TEST_KEY;
});

test("experiment store persists immutable snapshots and rejects tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-ablation-store-"));
  try {
    const store = new AblationExperimentStore(root);
    const experiment = validateAblationExperiment(input(), profile);
    const path = await store.save(experiment);
    assert.match(path, /AB-20260831-001\.json$/);
    assert.deepEqual((await store.list()).map((item) => item.experimentId), [experiment.experimentId]);
    assert.equal((await store.load(experiment.experimentId)).experimentFingerprint, experiment.experimentFingerprint);
    const original = await readFile(path, "utf8");
    await (await import("node:fs/promises")).writeFile(path, original.replace("Receipt comparison", "tampered"));
    await assert.rejects(() => store.load(experiment.experimentId), /fingerprint mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("experiment store ignores mutable ledger, results, and status projections", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-ablation-store-list-"));
  try {
    const store = new AblationExperimentStore(root);
    const experiment = validateAblationExperiment(input(), profile);
    await store.save(experiment);
    await (await import("node:fs/promises")).writeFile(join(root, `${experiment.experimentId}.ledger.json`), JSON.stringify({ schemaVersion: 1, attempts: {} }));
    await (await import("node:fs/promises")).writeFile(join(root, `${experiment.experimentId}.results.json`), JSON.stringify({ variants: [] }));
    await (await import("node:fs/promises")).writeFile(join(root, `${experiment.experimentId}.status.json`), JSON.stringify({ status: "running" }));
    assert.deepEqual((await store.list()).map((item) => item.experimentId), [experiment.experimentId]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
