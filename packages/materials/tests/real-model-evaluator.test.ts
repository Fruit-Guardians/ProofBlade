import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "../src/config.js";
import { loadRealEvaluationCorpus } from "../src/evaluation/real-corpus.js";
import { deriveProviderDiagnostics, preflightRealModelEvaluation, RealModelEvaluationRunner } from "../src/evaluation/real-model-evaluator.js";
import { anonymizeEvaluationSummary, anonymizeRunReplay } from "../src/evaluation/anonymous-replay.js";
import type { AgentLaneFactory } from "../src/orchestration/single-agent-loop.js";
import type { HarnessEvent } from "../src/domain/types.js";

const solver: AgentLaneFactory = async ({ runtime }) => testAgentLane(runtime, true);

const failingSolver: AgentLaneFactory = async ({ runtime }) => testAgentLane(runtime, false);

const throwingSolver: AgentLaneFactory = async () => ({
  async prompt() { throw new Error("provider stream failed"); },
  async compact() {},
  async abort() {},
  async isIdle() { return true; },
  async close() {},
});

const baselineSolver: AgentLaneFactory = async ({ runtime, config }) => testAgentLane(runtime, config.modelProfiles.executor.provider === "alpha");

const deadlineSolver: AgentLaneFactory = async () => {
  let abortPrompt: (() => void) | undefined;
  return {
    prompt: () => new Promise((_resolve, reject) => {
      abortPrompt = () => reject(new Error("test lane aborted"));
    }),
    compact: async () => {},
    abort: async () => abortPrompt?.(),
    isIdle: async () => false,
    close: async () => {},
  };
};

/** A hostile Provider/tool stand-in: acknowledges abort but never settles prompt. */
const abortIgnoringDeadlineSolver: AgentLaneFactory = async () => ({
  prompt: () => new Promise(() => {}),
  async compact() {},
  async abort() {},
  async isIdle() { return false; },
  async close() {},
});

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
      requireProviderTraffic: false,
      attempts: 1,
      maxTurns: 1,
      maxCostUsd: 1,
    };
    const first = await runner.run({ ...options, runPrefix: "REAL-A" });
    const second = await runner.run({ ...options, runPrefix: "REAL-B" });
    assert.deepEqual(first.variants.map((item) => item.id), ["alpha", "beta"]);
    assert.equal(first.gate.passed, true);
    assert.deepEqual(first.gate.policy, { minimumSuccessRate: 0.5, baselineVariantId: "alpha", maxBaselineSuccessRateDrop: 0.1, requireProviderTraffic: false, minimumCorpusCases: 0, requiredTargetKinds: [] });
    assert.equal(first.comparisons.length, 1);
    assert.ok(first.variants.every((item) => item.successRate === 1 && item.candidateLeakCount === 0));
    assert.deepEqual(first.variants[0]?.categoryMetrics, {
      reverse: {
        total: 1,
        successCount: 1,
        successRate: 1,
        providerRequests: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        firstEvidenceMs: first.variants[0]?.categoryMetrics.reverse.firstEvidenceMs,
        repeatedExperimentCount: 0,
        submissionCount: 2,
        contextTokens: 0,
        failureCategories: {},
      },
    });
    assert.ok(first.variants.every((item) => item.cases.every((candidate) => candidate.success && candidate.evidenceBacked && candidate.replayParity)));
    assert.ok(first.variants.every((item) => item.metrics.firstEvidenceMs.total >= 0 && item.metrics.contextTokens >= 0 && item.metrics.submissionCount >= 1));
    assert.ok(first.variants.every((item) => item.cases.every((candidate) => candidate.repeatedExperimentCount >= 0 && candidate.submissionCount >= 1)));
    assert.equal(first.reportHash, second.reportHash);
    assert.doesNotMatch(JSON.stringify(first.corpus), new RegExp(expected.replace(/[{}]/g, "\\$&")));
    const anonymous = anonymizeEvaluationSummary(first);
    assert.doesNotMatch(JSON.stringify(anonymous), /REAL-A|fixtures|expected|real_model_corpus/);
    assert.ok(anonymous.variants.every((variant) => variant.cases.every((candidate) => !Object.hasOwn(candidate, "runId") && !Object.hasOwn(candidate, "error"))));

    const strict = await runner.run({ ...options, requireProviderTraffic: true, requireAnswerLiteralsAbsent: false, runPrefix: "REAL-STRICT" });
    assert.equal(strict.gate.passed, false);
    assert.equal(strict.gate.policy.requireProviderTraffic, true);
    assert.equal(strict.gate.policy.minimumCorpusCases, 20);
    assert.deepEqual(strict.gate.policy.requiredTargetKinds, ["pwn", "web"]);
    assert.equal(strict.gate.checks.find((item) => item.id === "minimum_corpus_cases")?.passed, false);
    assert.ok(strict.gate.checks.filter((item) => item.id.startsWith("provider_traffic:")).every((item) => !item.passed));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real evaluation preflight validates Web/Pwn coverage and never contacts a Provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-real-preflight-"));
  try {
    const web = "web marker";
    const pwn = "pwn marker";
    await writeFile(join(root, "web.txt"), web, "utf8");
    await writeFile(join(root, "pwn.txt"), pwn, "utf8");
    await writeFile(join(root, "corpus.json"), JSON.stringify({
      schemaVersion: 1,
      id: "preflight-corpus",
      cases: [
        { ...corpusCase("web-case", "web.txt", "flag{web}", web), targetKind: "web" },
        { ...corpusCase("pwn-case", "pwn.txt", "flag{pwn}", pwn), targetKind: "pwn" },
      ],
    }), "utf8");
    const variants = [config("alpha"), config("beta")].map((value, index) => ({
      id: index === 0 ? "alpha" : "beta",
      config: { ...value, modelProfiles: { executor: { ...value.modelProfiles.executor, apiKeyEnv: "PATH" } } },
    }));
    const ready = await preflightRealModelEvaluation({
      corpusPath: join(root, "corpus.json"),
      variants,
      requireProviderTraffic: true,
      minimumCorpusCases: 2,
      maxCostUsd: 1,
      attempts: 1,
      maxTurns: 1,
    });
    assert.equal(ready.ready, true);
    assert.deepEqual(ready.corpus.targetKinds, { pwn: 1, web: 1 });
    assert.ok(ready.variants.every((variant) => variant.credentialPresent && variant.pricingPresent));
    assert.ok(ready.checks.every((check) => check.passed));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strict real evaluation preflight rejects an answer literal in target input", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-real-preflight-leak-"));
  try {
    const expected = "flag{answer_in_input}";
    const source = `captured response\n${expected}\n`;
    await writeFile(join(root, "web.txt"), source, "utf8");
    await writeFile(join(root, "corpus.json"), JSON.stringify({
      schemaVersion: 1,
      id: "answer-literal-corpus",
      cases: [corpusCase("web-case", "web.txt", expected, source)],
    }), "utf8");
    const result = await preflightRealModelEvaluation({
      corpusPath: join(root, "corpus.json"),
      variants: [{ id: "alpha", config: config("alpha") }, { id: "beta", config: config("beta") }],
      requireProviderTraffic: true,
      minimumCorpusCases: 1,
    });
    assert.equal(result.checks.find((item) => item.id === "answer_literals_absent")?.passed, false);
    assert.equal(result.ready, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real evaluation preflight reports missing credentials and direction coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-real-preflight-fail-"));
  try {
    const source = "reverse marker";
    await writeFile(join(root, "target.txt"), source, "utf8");
    await writeFile(join(root, "corpus.json"), JSON.stringify({
      schemaVersion: 1,
      id: "preflight-failure-corpus",
      cases: [corpusCase("reverse-case", "target.txt", "flag{reverse}", source)],
    }), "utf8");
    const result = await preflightRealModelEvaluation({
      corpusPath: join(root, "corpus.json"),
      variants: [{ id: "alpha", config: config("alpha") }, { id: "beta", config: config("beta") }],
      requireProviderTraffic: true,
      minimumCorpusCases: 20,
    });
    assert.equal(result.ready, false);
    assert.equal(result.checks.find((check) => check.id === "minimum_corpus_cases")?.passed, false);
    assert.equal(result.checks.find((check) => check.id === "target_kind_coverage:web")?.passed, false);
    assert.equal(result.checks.find((check) => check.id === "target_kind_coverage:pwn")?.passed, false);
    assert.equal(result.checks.find((check) => check.id === "credential:alpha")?.passed, false);
    assert.equal(result.checks.find((check) => check.id === "credential:beta")?.passed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real evaluation rejects two ids that point to the same provider profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-real-preflight-duplicate-profile-"));
  try {
    const source = "private reverse marker";
    await writeFile(join(root, "target.txt"), source, "utf8");
    await writeFile(join(root, "corpus.json"), JSON.stringify({
      schemaVersion: 1,
      id: "duplicate-profile-corpus",
      cases: [corpusCase("reverse-case", "target.txt", "flag{reverse}", source)],
    }), "utf8");
    const result = await preflightRealModelEvaluation({
      corpusPath: join(root, "corpus.json"),
      variants: [{ id: "alpha", config: config("same") }, { id: "beta", config: config("same") }],
      requireProviderTraffic: false,
      minimumCorpusCases: 1,
    });
    assert.equal(result.checks.find((check) => check.id === "distinct_profile_variants")?.passed, false);
    assert.equal(result.ready, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real evaluation keeps separately provisioned credential profiles distinct without exposing secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-real-preflight-credential-profiles-"));
  try {
    const source = "private reverse marker";
    await writeFile(join(root, "target.txt"), source, "utf8");
    await writeFile(join(root, "corpus.json"), JSON.stringify({
      schemaVersion: 1,
      id: "credential-profile-corpus",
      cases: [corpusCase("reverse-case", "target.txt", "flag{reverse}", source)],
    }), "utf8");
    const base = config("same");
    const variants = [
      { id: "account-a", config: { ...base, modelProfiles: { executor: { ...base.modelProfiles.executor, apiKeyEnv: "PROOFBLADE_KEY_A" } } } },
      { id: "account-b", config: { ...base, modelProfiles: { executor: { ...base.modelProfiles.executor, apiKeyEnv: "PROOFBLADE_KEY_B" } } } },
    ];
    const result = await preflightRealModelEvaluation({
      corpusPath: join(root, "corpus.json"),
      variants,
      requireProviderTraffic: false,
      minimumCorpusCases: 1,
    });
    assert.equal(result.checks.find((check) => check.id === "distinct_profile_variants")?.passed, true);
    assert.equal(result.variants[0]?.profileFingerprint === result.variants[1]?.profileFingerprint, false);
    assert.doesNotMatch(JSON.stringify(result), /sk-[A-Za-z0-9]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real model evaluator aborts a provider turn when the case deadline expires", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-real-eval-deadline-"));
  try {
    const source = "deadline fixture";
    await writeFile(join(root, "target.bin"), source, "utf8");
    await writeFile(join(root, "corpus.json"), JSON.stringify({
      schemaVersion: 1,
      id: "deadline-corpus",
      cases: [corpusCase("deadline", "target.bin", "flag{deadline}", source)],
    }), "utf8");
    const summary = await new RealModelEvaluationRunner(root, deadlineSolver).run({
      corpusPath: join(root, "corpus.json"),
      variants: [{ id: "alpha", config: config("alpha") }, { id: "beta", config: config("beta") }],
      allowLive: true,
      attempts: 1,
      maxTurns: 1,
      // Leave enough wall-clock room for the fixture/control-store setup under
      // the full test suite; the lane itself never resolves and must still be
      // interrupted by this case deadline.
      deadlineMs: 2_000,
      maxCostUsd: 1,
      runPrefix: "REAL-DEADLINE",
    });
    assert.ok(summary.variants.every((variant) => variant.cases.every((item) => !item.success
      && item.error
      && ["FAILED", "EXHAUSTED"].includes(item.status)
      && item.failureCategory === "budget_exhausted"
      && item.turns === 1
      && item.providerDiagnostics.deadlineBeforeCompletion)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real model evaluator continues after a lane ignores abort and never settles prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-real-eval-unresponsive-deadline-"));
  const startedAt = Date.now();
  try {
    const source = "unresponsive deadline fixture";
    await writeFile(join(root, "target.bin"), source, "utf8");
    await writeFile(join(root, "corpus.json"), JSON.stringify({
      schemaVersion: 1,
      id: "unresponsive-deadline-corpus",
      cases: [corpusCase("unresponsive", "target.bin", "flag{unresponsive_deadline}", source)],
    }), "utf8");
    const summary = await new RealModelEvaluationRunner(root, abortIgnoringDeadlineSolver).run({
      corpusPath: join(root, "corpus.json"),
      variants: [{ id: "alpha", config: config("alpha") }, { id: "beta", config: config("beta") }],
      allowLive: true,
      attempts: 1,
      maxTurns: 1,
      deadlineMs: 750,
      maxCostUsd: 1,
      runPrefix: "REAL-UNRESPONSIVE-DEADLINE",
    });
    assert.ok(Date.now() - startedAt < 5_000, "case deadlines must not wait forever for an unresponsive lane");
    assert.ok(summary.variants.every((variant) => variant.cases.every((item) => item.failureCategory === "budget_exhausted" && item.providerDiagnostics.deadlineBeforeCompletion)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider diagnostics replay requests, tokens, phases, and first-turn evidence", () => {
  const events = [
    diagnosticEvent(1, "run_started", "main", {}),
    diagnosticEvent(2, "phase_started", "orchestrator", { phase: "reconnaissance" }),
    diagnosticEvent(3, "work_item_claimed", "executor", { ownerLane: "executor" }),
    diagnosticEvent(4, "provider_request_started", "main", { phase: "reconnaissance" }),
    diagnosticEvent(5, "model_usage", "main", { usage: { totalTokens: 120 } }),
    diagnosticEvent(6, "evidence_added", "verifier", {}),
    diagnosticEvent(7, "work_item_completed", "executor", {}),
    diagnosticEvent(8, "phase_started", "orchestrator", { phase: "target_model" }),
    diagnosticEvent(9, "work_item_claimed", "executor", { ownerLane: "executor" }),
    diagnosticEvent(10, "provider_request_started", "main", { phase: "target_model" }),
    diagnosticEvent(11, "model_usage", "main", { usage: { input: 30, output: 50 } }),
  ] satisfies HarnessEvent[];

  assert.deepEqual(deriveProviderDiagnostics(events, false, true), {
    turns: [
      { turn: 1, providerRequests: 1, completedRequests: 1, totalTokens: 120, evidenceAdded: 1, phases: ["reconnaissance"] },
      { turn: 2, providerRequests: 1, completedRequests: 1, totalTokens: 80, evidenceAdded: 0, phases: ["target_model"] },
    ],
    providerRequestsByPhase: { reconnaissance: 1, target_model: 1 },
    firstEvidencePhase: "reconnaissance",
    lastProviderPhase: "target_model",
    deadlineBeforeCompletion: false,
  });
});

test("anonymous Run replay keeps convergence signals without copying secrets or paths", () => {
  const events = [
    {
      schemaVersion: 1,
      runId: "REAL-HISTORY-1",
      seq: 1,
      ts: "2026-08-24T00:00:00.000Z",
      id: "REAL-HISTORY-1-E1",
      streamId: "REAL-HISTORY-1",
      type: "domain_phase_changed",
      lane: "executor",
      actor: "orchestrator",
      payload: {
        domainPhase: "RECON",
        taskPath: "D:\\private\\challenge\\flag.txt",
        summary: "flag{must-not-leak}",
      },
    },
    {
      schemaVersion: 1,
      runId: "REAL-HISTORY-1",
      seq: 2,
      ts: "2026-08-24T00:00:01.000Z",
      id: "REAL-HISTORY-1-E2",
      streamId: "REAL-HISTORY-1",
      type: "tool_result_recorded",
      lane: "tool",
      actor: "tool",
      payload: {
        toolName: "pwn_recv",
        isError: false,
        evidenceAdded: true,
        output: "flag{must-not-leak}",
        command: "cat D:\\private\\challenge\\flag.txt",
      },
    },
    {
      schemaVersion: 1,
      runId: "REAL-HISTORY-1",
      seq: 3,
      ts: "2026-08-24T00:00:02.000Z",
      id: "REAL-HISTORY-1-E3",
      streamId: "REAL-HISTORY-1",
      type: "work_item_completed",
      lane: "executor",
      actor: "orchestrator",
      payload: { outcome: "success", workItemId: "W-SECRET", operation: "pwn_reproduce" },
    },
  ] satisfies HarnessEvent[];

  const first = anonymizeRunReplay(events);
  const second = anonymizeRunReplay(events.map((event) => ({ ...event, ts: "2099-01-01T00:00:00.000Z" })));
  const encoded = JSON.stringify(first);
  assert.equal(first.eventCount, 3);
  assert.equal(first.events[0]?.payload.domainPhase, "RECON");
  assert.equal(first.events[1]?.payload.toolName, "pwn_recv");
  assert.equal(first.events[2]?.payload.operation, "pwn_reproduce");
  assert.doesNotMatch(encoded, /REAL-HISTORY|private|flag\{|W-SECRET|taskPath|output|command/);
  assert.equal(first.replayHash, second.replayHash);
  assert.equal(first.runKey, second.runKey);
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

test("real evaluation preserves a durable failure category when the lane throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-real-eval-throwing-lane-"));
  const source = "throwing lane target";
  try {
    await writeFile(join(root, "target.bin"), source, "utf8");
    await writeFile(join(root, "corpus.json"), JSON.stringify({
      schemaVersion: 1,
      id: "throwing-lane",
      cases: [corpusCase("sample", "target.bin", "flag{throwing_lane}", source)],
    }), "utf8");
    const summary = await new RealModelEvaluationRunner(root, throwingSolver).run({
      corpusPath: join(root, "corpus.json"),
      variants: [{ id: "alpha", config: config("alpha") }, { id: "beta", config: config("beta") }],
      allowLive: true,
      attempts: 1,
      maxTurns: 1,
      maxCostUsd: 1,
      runPrefix: "REAL-THROWING-LANE",
    });
    assert.ok(summary.variants.every((variant) => variant.cases.every((item) => item.error?.includes("provider stream failed"))));
    assert.ok(summary.variants.every((variant) => variant.cases.every((item) => item.failureCategory === "effect_outcome_unknown")));
    assert.ok(summary.variants.every((variant) => variant.failureCategories.effect_outcome_unknown === 1));
    assert.ok(summary.variants.every((variant) => variant.failureCategories.unclassified === undefined));
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

function diagnosticEvent(seq: number, type: HarnessEvent["type"], lane: HarnessEvent["lane"], payload: Record<string, unknown>): HarnessEvent {
  return {
    schemaVersion: 1,
    runId: "DIAGNOSTIC-RUN",
    seq,
    ts: new Date(seq * 1_000).toISOString(),
    id: `DIAGNOSTIC-RUN-E${seq}`,
    streamId: "DIAGNOSTIC-RUN",
    type,
    lane,
    actor: lane === "verifier" ? "orchestrator" : "orchestrator",
    payload,
  };
}
