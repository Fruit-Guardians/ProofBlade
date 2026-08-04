import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "../src/config.js";
import { FixtureEvaluationRunner } from "../src/evaluation/fixture-evaluator.js";

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
    assert.equal(summary.total, 1);
    assert.equal(summary.successRate, 1);
    assert.equal(summary.evidenceBackedRate, 1);
    assert.equal(summary.replayParityRate, 1);
    assert.equal(summary.cases[0]?.candidateLeaked, false);
    assert.equal(summary.reportHash.length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
