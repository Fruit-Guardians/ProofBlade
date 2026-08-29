import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "../src/config.js";
import {
  DEFAULT_RUNTIME_SCENARIOS,
  RUNTIME_SCENARIO_PROTOCOL_VERSION,
  RuntimeScenarioEvaluator,
  type RuntimeScenarioDefinition,
} from "../src/evaluation/runtime-scenario-evaluator.js";

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

test("[contract:runtime-scenario-baseline] runtime scenario evaluator covers cache, context, convergence, evidence, durability, events, and recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-runtime-eval-"));
  try {
    const summary = await new RuntimeScenarioEvaluator(root, config).run("RUNTIME-EVAL");
    assert.equal(summary.protocolVersion, RUNTIME_SCENARIO_PROTOCOL_VERSION);
    assert.equal(summary.total, 19);
    assert.equal(summary.successCount, 19);
    assert.equal(summary.successRate, 1);
    assert.equal(summary.catalogHash.length, 64);
    assert.deepEqual(summary.requiredIds, [...DEFAULT_RUNTIME_SCENARIOS].map((item) => item.id).sort());
    assert.deepEqual(summary.categoryCounts, {
      cache: { total: 2, passed: 2 },
      context: { total: 2, passed: 2 },
      convergence: { total: 3, passed: 3 },
      evidence: { total: 2, passed: 2 },
      durability: { total: 3, passed: 3 },
      events: { total: 2, passed: 2 },
      recovery: { total: 5, passed: 5 },
    });
    assert.ok(summary.cases.every((item) => item.success && item.detailsHash?.length === 64 && !item.error));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:runtime-scenario-failure-isolation] runtime scenario evaluator isolates a failed scenario and preserves ordered output", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-runtime-eval-failure-"));
  const definitions: RuntimeScenarioDefinition[] = [
    { id: "context.passes", category: "context", description: "pass", evaluate: () => ({ passed: true }) },
    { id: "cache.fails", category: "cache", description: "fail", evaluate: () => { throw new Error("scenario failed"); } },
  ];
  try {
    const summary = await new RuntimeScenarioEvaluator(root, config, definitions).run("RUNTIME-FAILURE");
    assert.equal(summary.total, 2);
    assert.equal(summary.successCount, 1);
    assert.equal(summary.successRate, 0.5);
    assert.deepEqual(summary.cases.map((item) => item.id), ["cache.fails", "context.passes"]);
    assert.equal(summary.cases[0]?.error, "scenario failed");
    assert.equal(summary.cases[1]?.success, true);
    assert.deepEqual(summary.categoryCounts.cache, { total: 1, passed: 0 });
    assert.deepEqual(summary.categoryCounts.context, { total: 1, passed: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime scenario evaluator rejects duplicate scenario ids", async () => {
  const duplicate: RuntimeScenarioDefinition = { id: "cache.duplicate", category: "cache", description: "duplicate", evaluate: () => ({}) };
  await assert.rejects(
    new RuntimeScenarioEvaluator(process.cwd(), config, [duplicate, duplicate]).run("RUNTIME-DUPLICATE"),
    /Duplicate runtime scenario id/,
  );
});
