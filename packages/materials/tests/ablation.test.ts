import assert from "node:assert/strict";
import test from "node:test";
import { buildAblationPairings, DEFAULT_HARNESS_POLICY, validateAblationExperiment } from "../src/index.js";

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
