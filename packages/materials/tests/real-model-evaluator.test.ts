import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "../src/config.js";
import { loadRealEvaluationCorpus } from "../src/evaluation/real-corpus.js";
import { RealModelEvaluationRunner } from "../src/evaluation/real-model-evaluator.js";
import type { AgentLaneFactory } from "../src/orchestration/single-agent-loop.js";

const solver: AgentLaneFactory = async ({ runtime }) => testAgentLane(runtime, true);

const failingSolver: AgentLaneFactory = async ({ runtime }) => testAgentLane(runtime, false);

const baselineSolver: AgentLaneFactory = async ({ runtime, config }) => testAgentLane(runtime, config.modelProfiles.executor.provider === "alpha");

function testAgentLane(runtime: Parameters<AgentLaneFactory>[0]["runtime"], succeeds: boolean) {
  return {
  async prompt() {
    if (!succeeds) return { text: "no supported candidate", stopReason: "stop", usage: zeroUsage() };
    const inspected = await runtime.inspectTarget("target.bin");
    const candidate = inspected.output.match(/[A-Za-z][A-Za-z0-9_-]{0,31}\{[^{}\r\n]{1,512}\}/)?.[0];
    if (!candidate) throw new Error("test corpus target has no candidate");
    await runtime.proposeHypothesis({ statement: "The observed target candidate is correct.", evidenceIds: [inspected.evidenceId] });
    await runtime.submitCandidate(candidate);
    return { text: "candidate proposed", stopReason: "stop", usage: zeroUsage() };
  },
  async compact() {},
  async abort() {},
  async isIdle() { return true; },
  async close() {},
  };
}

test("real model evaluator stages a hash-bound local corpus and compares variants without exposing the answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-real-eval-"));
  const expected = "flag{real_model_corpus}";
  const source = `firmware marker\n${expected}\n`;
  const sourceHash = createHash("sha256").update(source).digest("hex");
  try {
    await writeFile(join(root, "target.bin"), source, "utf8");
    await writeFile(join(root, "corpus.json"), JSON.stringify({
      schemaVersion: 1,
      id: "local-reverse-corpus",
      cases: [{
        id: "elf-check-1",
        targetKind: "reverse",
        objective: "Analyze target.bin and recover the accepted flag.",
        expected,
        files: [{ source: "target.bin", sha256: sourceHash }],
      }],
    }), "utf8");
    const runner = new RealModelEvaluationRunner(root, solver);
    const options = {
      corpusPath: join(root, "corpus.json"),
      variants: [{ id: "alpha", config: config("alpha") }, { id: "beta", config: config("beta") }],
      allowLive: true as const,
      attempts: 1,
      maxTurns: 1,
      maxCostUsd: 1,
    };
    const first = await runner.run({ ...options, runPrefix: "REAL-A" });
    const second = await runner.run({ ...options, runPrefix: "REAL-B" });
    assert.deepEqual(first.variants.map((item) => item.id), ["alpha", "beta"]);
    assert.equal(first.gate.passed, true);
    assert.equal(first.comparisons.length, 1);
    assert.ok(first.variants.every((item) => item.successRate === 1 && item.candidateLeakCount === 0));
    assert.ok(first.variants.every((item) => item.cases.every((candidate) => candidate.success && candidate.evidenceBacked && candidate.replayParity)));
    assert.equal(first.reportHash, second.reportHash);
    assert.doesNotMatch(JSON.stringify(first.corpus), new RegExp(expected.replace(/[{}]/g, "\\$&")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real evaluation corpus rejects an input whose content changed after manifest creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-real-corpus-hash-"));
  try {
    await writeFile(join(root, "sample.bin"), "first", "utf8");
    const hash = createHash("sha256").update("first").digest("hex");
    await writeFile(join(root, "corpus.json"), JSON.stringify({
      schemaVersion: 1,
      id: "hash-bound",
      cases: [{ id: "sample", targetKind: "reverse", objective: "Inspect sample.bin", expected: "flag{hash_bound}", files: [{ source: "sample.bin", sha256: hash }] }],
    }), "utf8");
    await loadRealEvaluationCorpus(join(root, "corpus.json"));
    await writeFile(join(root, "sample.bin"), "second", "utf8");
    await assert.rejects(loadRealEvaluationCorpus(join(root, "corpus.json")), /hash mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real evaluation corpus canonicalizes equivalent case order", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-real-corpus-order-"));
  try {
    const first = "one";
    const second = "two";
    await writeFile(join(root, "one.bin"), first, "utf8");
    await writeFile(join(root, "two.bin"), second, "utf8");
    const cases = [
      corpusCase("z-case", "one.bin", "flag{one}", first),
      corpusCase("a-case", "two.bin", "flag{two}", second),
    ];
    await writeFile(join(root, "first.json"), JSON.stringify({ schemaVersion: 1, id: "ordered", cases }), "utf8");
    await writeFile(join(root, "second.json"), JSON.stringify({ schemaVersion: 1, id: "ordered", cases: [...cases].reverse() }), "utf8");
    const one = await loadRealEvaluationCorpus(join(root, "first.json"));
    const two = await loadRealEvaluationCorpus(join(root, "second.json"));
    assert.deepEqual(one.cases.map((item) => item.id), ["a-case", "z-case"]);
    assert.equal(one.snapshot.hash, two.snapshot.hash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real evaluation corpus rejects case-folded reserved paths and duplicate targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-real-corpus-case-fold-"));
  const source = "payload";
  const sourceHash = createHash("sha256").update(source).digest("hex");
  try {
    await writeFile(join(root, "payload.bin"), source, "utf8");
    const manifest = (files: unknown[]) => JSON.stringify({
      schemaVersion: 1,
      id: "case-folding",
      cases: [{ id: "sample", targetKind: "reverse", objective: "Inspect payload", expected: "flag{case_fold}", files }],
    });
    await writeFile(join(root, "challenge.json"), manifest([{ source: "payload.bin", path: "Challenge.txt", sha256: sourceHash }]), "utf8");
    await assert.rejects(loadRealEvaluationCorpus(join(root, "challenge.json")), /reserved target path/);
    await writeFile(join(root, "private.json"), manifest([{ source: "payload.bin", path: ".ProofBlade/scorer.json", sha256: sourceHash }]), "utf8");
    await assert.rejects(loadRealEvaluationCorpus(join(root, "private.json")), /reserved target path/);
    await writeFile(join(root, "duplicate.json"), manifest([
      { source: "payload.bin", path: "A.bin", sha256: sourceHash },
      { source: "payload.bin", path: "a.bin", sha256: sourceHash },
    ]), "utf8");
    await assert.rejects(loadRealEvaluationCorpus(join(root, "duplicate.json")), /target paths must be unique/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real model evaluation rejects unsafe run prefixes before staging a Fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-real-eval-path-"));
  try {
    const source = "flag{path_guard}";
    await writeFile(join(root, "target.bin"), source, "utf8");
    await writeFile(join(root, "corpus.json"), JSON.stringify({
      schemaVersion: 1,
      id: "path-guard",
      cases: [corpusCase("safe-case", "target.bin", "flag{path_guard}", source)],
    }), "utf8");
    const runner = new RealModelEvaluationRunner(root, solver);
    await assert.rejects(runner.run({
      corpusPath: join(root, "corpus.json"),
      variants: [{ id: "alpha", config: config("alpha") }, { id: "beta", config: config("beta") }],
      allowLive: true,
      attempts: 1,
      maxTurns: 1,
      maxCostUsd: 1,
      runPrefix: "..\\..\\escaped",
    }), /Run ID/);
    await assert.rejects(stat(join(root, "fixtures")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real evaluation corpus rejects a traversal-shaped case id", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-real-corpus-case-id-"));
  try {
    const source = "flag{case_id_guard}";
    await writeFile(join(root, "target.bin"), source, "utf8");
    await writeFile(join(root, "corpus.json"), JSON.stringify({
      schemaVersion: 1,
      id: "case-id-guard",
      cases: [corpusCase("..\\escape", "target.bin", "flag{case_id_guard}", source)],
    }), "utf8");
    await assert.rejects(loadRealEvaluationCorpus(join(root, "corpus.json")), /safe Run ID segment/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real model evaluation refuses variants without explicit token pricing", async () => {
  const unpriced = config("unpriced");
  delete unpriced.modelProfiles.executor.pricing;
  await assert.rejects(new RealModelEvaluationRunner(process.cwd(), solver).run({
    corpusPath: "not-read-before-variant-validation.json",
    variants: [{ id: "unpriced", config: unpriced }, { id: "priced", config: config("priced") }],
    allowLive: true,
  }), /requires positive executor pricing/);
});

test("real evaluation gate fails when every Variant fails its minimum success rate", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-real-eval-min-success-"));
  const source = "not-a-flag";
  try {
    await writeFile(join(root, "target.bin"), source, "utf8");
    await writeFile(join(root, "corpus.json"), JSON.stringify({
      schemaVersion: 1,
      id: "minimum-success",
      cases: [corpusCase("sample", "target.bin", "flag{minimum_success}", source)],
    }), "utf8");
    const summary = await new RealModelEvaluationRunner(root, failingSolver).run({
      corpusPath: join(root, "corpus.json"),
      variants: [{ id: "alpha", config: config("alpha") }, { id: "beta", config: config("beta") }],
      allowLive: true,
      attempts: 1,
      maxTurns: 1,
      maxCostUsd: 1,
      runPrefix: "REAL-MIN-SUCCESS",
    });
    assert.equal(summary.gate.passed, false);
    assert.equal(summary.gate.policy.minimumSuccessRate, 0.5);
    assert.ok(summary.gate.checks.filter((item) => item.id.startsWith("minimum_success_rate:")).every((item) => !item.passed));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real evaluation gate rejects a Variant that regresses beyond its baseline allowance", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-real-eval-baseline-"));
  const expected = "flag{baseline_gate}";
  try {
    await writeFile(join(root, "target.bin"), expected, "utf8");
    await writeFile(join(root, "corpus.json"), JSON.stringify({
      schemaVersion: 1,
      id: "baseline-gate",
      cases: [corpusCase("sample", "target.bin", expected, expected)],
    }), "utf8");
    const summary = await new RealModelEvaluationRunner(root, baselineSolver).run({
      corpusPath: join(root, "corpus.json"),
      variants: [{ id: "alpha", config: config("alpha") }, { id: "beta", config: config("beta") }],
      allowLive: true,
      attempts: 1,
      maxTurns: 1,
      maxCostUsd: 1,
      minimumSuccessRate: 0,
      baselineVariantId: "alpha",
      maxBaselineSuccessRateDrop: 0.1,
      runPrefix: "REAL-BASELINE-GATE",
    });
    assert.equal(summary.gate.passed, false);
    assert.equal(summary.gate.policy.baselineVariantId, "alpha");
    assert.equal(summary.gate.checks.find((item) => item.id === "baseline_success_rate_drop:beta")?.passed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function config(id: string): ProofBladeConfig {
  return {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: {
      executor: {
        provider: id,
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1/v1",
        model: `${id}-model`,
        modelDiscoveryPath: "/models",
        apiKeyEnv: `TEST_${id.toUpperCase()}_KEY`,
        contextWindow: 8_192,
        maxTokens: 1_024,
        requestTimeoutMs: 1_000,
        maxRetries: 0,
        input: ["text"],
        pricing: {
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 1,
          cacheReadUsdPerMillion: 0.1,
          cacheWriteUsdPerMillion: 1,
        },
      },
    },
  };
}

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function corpusCase(id: string, source: string, expected: string, content: string) {
  return {
    id,
    targetKind: "reverse",
    objective: `Inspect ${source}`,
    expected,
    files: [{ source, sha256: createHash("sha256").update(content).digest("hex") }],
  };
}
