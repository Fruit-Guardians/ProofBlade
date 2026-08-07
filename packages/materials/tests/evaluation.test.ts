import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "../src/config.js";
import { BASELINE_PROTOCOL_VERSION, FixtureEvaluationRunner } from "../src/evaluation/fixture-evaluator.js";
import type { SolverLaneFactory } from "../src/orchestration/single-agent-loop.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "TEST_API_KEY",
      contextWindow: 4096,
      maxTokens: 512,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      input: ["text"],
    },
  },
};

test("fixture evaluator reports evidence and replay gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-eval-"));
  try {
    const summary = await new FixtureEvaluationRunner(root, config).run({ fixtureIds: ["web-source-1"], runPrefix: "EVAL-TEST", maxTurns: 1 });
    assert.equal(summary.schemaVersion, 2);
    assert.equal(summary.protocolVersion, BASELINE_PROTOCOL_VERSION);
    assert.deepEqual(summary.budget, { maxTurns: 1 });
    assert.equal(summary.attempts, 3);
    assert.equal(summary.total, 3);
    assert.equal(summary.successRate, 1);
    assert.equal(summary.evidenceBackedRate, 1);
    assert.equal(summary.replayParityRate, 1);
    assert.equal(summary.candidateLeakCount, 0);
    assert.equal(summary.metrics.factEvidenceCoverage, 1);
    assert.equal(summary.metrics.effectiveActionRatio, 1);
    assert.equal(summary.gate.passed, false);
    assert.equal(summary.gate.checks.find((item) => item.id === "fixture_coverage")?.passed, false);
    assert.ok(summary.cases.every((item) => !item.candidateLeaked));
    assert.equal(summary.reportHash.length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture evaluator canonicalizes fixture order and hashes the execution budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-eval-hash-"));
  try {
    const runner = new FixtureEvaluationRunner(root, config);
    const first = await runner.run({ fixtureIds: ["web-source-1", "reverse-strings-1"], attempts: 1, runPrefix: "EVAL-HASH-A", maxTurns: 1 });
    const second = await runner.run({ fixtureIds: ["reverse-strings-1", "web-source-1"], attempts: 1, runPrefix: "EVAL-HASH-B", maxTurns: 1 });
    const differentBudget = await runner.run({ fixtureIds: ["web-source-1", "reverse-strings-1"], attempts: 1, runPrefix: "EVAL-HASH-C", maxTurns: 2 });
    assert.notEqual(first.runPrefix, second.runPrefix);
    assert.notEqual(first.cases[0]?.runId, second.cases[0]?.runId);
    assert.deepEqual(first.fixtureIds, ["reverse-strings-1", "web-source-1"]);
    assert.deepEqual(first.cases.map((item) => item.fixtureId), second.cases.map((item) => item.fixtureId));
    assert.equal(first.reportHash, second.reportHash);
    assert.notEqual(first.reportHash, differentBudget.reportHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture evaluator keeps unclassified failures out of environment statistics", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-eval-failure-"));
  const throwingLane: SolverLaneFactory = async () => ({
    async prompt() { throw new Error("model logic failed"); },
    async compact() {},
    async abort() {},
    async isIdle() { return true; },
    async close() {},
  });
  try {
    const summary = await new FixtureEvaluationRunner(root, config, throwingLane).run({ fixtureIds: ["reverse-strings-1"], attempts: 1, runPrefix: "EVAL-FAILURE", maxTurns: 1 });
    assert.equal(summary.cases[0]?.failureCategory, "unclassified");
    assert.equal(summary.failureCategories.unclassified, 1);
    assert.equal(summary.failureCategories.permission_or_environment, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
