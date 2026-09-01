import assert from "node:assert/strict";
import test from "node:test";
import { ablationRecordsFromRealModelSummary, buildAblationReport, renderAblationReportZh, validateAblationExperiment } from "../src/index.js";

const experiment = validateAblationExperiment({ schemaVersion: 1, experimentId: "AB-REPORT", name: "Report", question: "q", corpus: { path: "manifest", hash: "b".repeat(64) }, model: { profileId: "p", model: "luna" }, budget: { attempts: 1, maxTurns: 1, maxCostUsd: 1, deadlineMs: 1000 }, variants: [{ id: "baseline", name: "base", baseline: true, changedFactor: "none" }, { id: "candidate", name: "candidate", changedFactor: "recall", policy: { recall: "automatic" } }] });

test("builds paired report with Wilson intervals and Chinese rendering", () => {
  const records = [
    { pairingId: "AB-REPORT:a:1:baseline", variantId: "baseline", caseId: "a", attempt: 1, status: "SUCCEEDED", success: true, evidenceBacked: true, candidateLeaked: false, providerRequests: 1, totalTokens: 10, contextTokens: 4, costUsd: .1, durationMs: 10 },
    { pairingId: "AB-REPORT:a:1:candidate", variantId: "candidate", caseId: "a", attempt: 1, status: "FAILED", success: false, evidenceBacked: false, candidateLeaked: false, providerRequests: 2, totalTokens: 20, contextTokens: 8, costUsd: .2, durationMs: 20, failureCategory: "verifier_rejected" },
  ];
  const report = buildAblationReport(experiment, records);
  assert.equal(report.variants[0]?.successRate, 1);
  assert.equal(report.variants[1]?.successRate, 0);
  assert.equal(report.pairedComparisons[0]?.baselineOnlySuccess, 1);
  assert.equal(report.stage, "smoke");
  assert.equal(report.metrics.byVariant.baseline?.passAtK, 1);
  assert.equal(report.metrics.byVariant.candidate?.passAtK, 0);
  assert.match(report.validityWarnings.join("\n"), /冒烟阶段/);
  assert.match(renderAblationReportZh(report), /消融实验报告/);
  assert.match(renderAblationReportZh(report), /Pass@k/);
  assert.equal(report.reportHash.length, 64);
  assert.equal(report.closure.comparableRecords, 2);
  assert.match(renderAblationReportZh(report), /可比较性与首错归因/);
});

test("closure report excludes provider contamination while retaining its first-error attribution", () => {
  const records = [
    { pairingId: "AB-REPORT:a:1:baseline", variantId: "baseline", caseId: "a", attempt: 1, status: "SUCCEEDED", success: true, evidenceBacked: true, candidateLeaked: false, providerRequests: 3, totalTokens: 12, contextTokens: 5, costUsd: .1, durationMs: 10, firstTool: "read", toolCalls: ["read", "bash", "verify_claim"], firstEvidenceMs: 4 },
    { pairingId: "AB-REPORT:a:1:candidate", variantId: "candidate", caseId: "a", attempt: 1, status: "FAILED", success: false, evidenceBacked: false, candidateLeaked: false, providerRequests: 1, totalTokens: 0, contextTokens: 0, costUsd: .2, durationMs: 20, failureCategory: "provider_error" },
  ];
  const report = buildAblationReport(experiment, records);
  assert.equal(report.closure.comparableRecords, 1);
  assert.equal(report.closure.excludedRecords.provider_error, 1);
  assert.equal(report.pairedComparisons[0]?.bothCompleted, 0);
  assert.equal(report.pairedComparisons[0]?.excludedPairs, 1);
  assert.deepEqual(report.closure.failureAttribution, [{ variantId: "candidate", owner: "provider", category: "provider_error", count: 1 }]);
  assert.equal(report.closure.successfulTrajectories[0]?.verifyClaimCalls, 1);
  assert.match(report.closure.requiredActions.join("\n"), /Provider 错误/);
});

test("closure report counts incomplete attempts without admitting them to pair denominators", () => {
  const records = [
    { pairingId: "AB-REPORT:a:1:baseline", variantId: "baseline", caseId: "a", attempt: 1, status: "running", success: false, evidenceBacked: false, candidateLeaked: false, providerRequests: 0, totalTokens: 0, contextTokens: 0, costUsd: 0, durationMs: 10 },
    { pairingId: "AB-REPORT:a:1:candidate", variantId: "candidate", caseId: "a", attempt: 1, status: "SUCCEEDED", success: true, evidenceBacked: true, candidateLeaked: false, providerRequests: 1, totalTokens: 2, contextTokens: 1, costUsd: .1, durationMs: 12 },
  ];
  const report = buildAblationReport(experiment, records);
  assert.equal(report.closure.completedRecords, 1);
  assert.equal(report.closure.comparableRecords, 1);
  assert.equal(report.closure.excludedRecords.incomplete, 1);
  assert.equal(report.pairedComparisons[0]?.bothCompleted, 0);
  assert.equal(report.pairedComparisons[0]?.excludedPairs, 1);
});

test("real evaluator summaries retain tool trajectory and failure category in report records", () => {
  const summary = {
    variants: [{ id: "baseline", cases: [{ corpusCaseId: "a", attempt: 1, success: true, evidenceBacked: true, candidateLeaked: false, providerRequests: 1, totalTokens: 2, contextTokens: 1, costUsd: 0.1, durationMs: 3, status: "SUCCEEDED", firstEvidenceMs: 2, ablationDecisions: [
      { requestedAction: "tool_call", requestedTool: "read", createdAt: "2026-09-01T00:00:00.000Z" },
      { requestedAction: "tool_call", requestedTool: "verify_claim", createdAt: "2026-09-01T00:00:01.000Z" },
    ] }] }],
  };
  const records = ablationRecordsFromRealModelSummary(experiment, summary as never);
  assert.deepEqual(records[0]?.toolCalls, ["read", "verify_claim"]);
  assert.equal(records[0]?.firstTool, "read");
  assert.equal(records[0]?.firstEvidenceMs, 2);
});

test("rejects duplicate or malformed pairing records and excludes running records", () => {
  const baseline = { pairingId: "AB-REPORT:a:1:baseline", variantId: "baseline", caseId: "a", attempt: 1, status: "SUCCEEDED", success: true, evidenceBacked: true, candidateLeaked: false, providerRequests: 1, totalTokens: 1, contextTokens: 1, costUsd: 0, durationMs: 1 };
  const running = { pairingId: "AB-REPORT:a:1:candidate", variantId: "candidate", caseId: "a", attempt: 1, status: "running", success: false, evidenceBacked: false, candidateLeaked: false, providerRequests: 0, totalTokens: 0, contextTokens: 0, costUsd: 0, durationMs: 0 };
  const report = buildAblationReport(experiment, [baseline, running]);
  assert.equal(report.variants.find((item) => item.id === "candidate")?.total, 0);
  assert.match(report.validityWarnings.join("\n"), /运行中/);
  assert.throws(() => buildAblationReport(experiment, [baseline, baseline]), /duplicate pairing/);
  assert.throws(() => buildAblationReport(experiment, [{ ...baseline, pairingId: "wrong" }]), /pairing id mismatch/);
});
