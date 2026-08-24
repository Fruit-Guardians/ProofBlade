import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LocalHoldoutEvaluationRunner } from "../src/index.js";
import type { ProofBladeConfig } from "../src/config.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs/local-holdout", fixturesDir: "fixtures/local-holdout" },
  modelProfiles: {
    executor: {
      provider: "local-deterministic",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "local-holdout",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "NOT_USED",
      contextWindow: 4096,
      maxTokens: 512,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      input: ["text"],
    },
  },
};

test("local holdout evaluates Web/Pwn plus Reverse/Crypto/Forensics without Provider requests", async () => {
  const fixtureRoot = fileURLToPath(new URL("../../../fixtures/holdout/", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "proofblade-local-holdout-"));
  try {
    const summary = await new LocalHoldoutEvaluationRunner(root, config).run({
      corpusPath: join(fixtureRoot, "manifest.json"),
      runPrefix: "LOCAL-HOLDOUT-TEST",
    });
    assert.equal(summary.gate.passed, true, JSON.stringify(summary.gate.checks));
    assert.deepEqual(summary.variants.map((variant) => variant.id), ["local-baseline", "local-candidate"]);
    assert.equal(summary.corpus.cases.length, 27);
    assert.equal(summary.corpus.cases.filter((item) => item.targetKind === "web").length, 12);
    assert.equal(summary.corpus.cases.filter((item) => item.targetKind === "pwn").length, 12);
    assert.equal(summary.corpus.cases.filter((item) => item.targetKind === "reverse").length, 1);
    assert.equal(summary.corpus.cases.filter((item) => item.targetKind === "crypto").length, 1);
    assert.equal(summary.corpus.cases.filter((item) => item.targetKind === "misc").length, 1, "the forensics case uses the platform-compatible misc wire kind");
    assert.ok(summary.corpus.cases.every((item) => ["web", "pwn", "reverse", "crypto", "misc"].includes(item.targetKind)));
    assert.ok(summary.variants.every((variant) => variant.successRate === 1 && variant.metrics.providerRequests === 0));
    assert.ok(summary.variants.every((variant) => variant.categoryMetrics.web?.successRate === 1
      && variant.categoryMetrics.web.total === 12
      && variant.categoryMetrics.pwn?.successRate === 1
      && variant.categoryMetrics.pwn.total === 12
      && variant.categoryMetrics.reverse?.total === 1
      && variant.categoryMetrics.crypto?.total === 1
      && variant.categoryMetrics.misc?.total === 1));
    assert.equal(summary.variants.reduce((total, variant) => total + variant.candidateLeakCount, 0), 0);
    const manifest = await readFile(join(fixtureRoot, "manifest.json"), "utf8");
    assert.equal(manifest.includes("PB{holdout_web_debug}"), true, "the local manifest is intentionally a fixture source; reports must still omit expected values");
    assert.doesNotMatch(JSON.stringify(summary.corpus), /holdout_web_debug|holdout_pwn_shell/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
