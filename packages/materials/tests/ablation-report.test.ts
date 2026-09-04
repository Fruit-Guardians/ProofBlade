import assert from "node:assert/strict";
import test from "node:test";
import { buildAblationReport, renderAblationReportZh, validateAblationExperiment } from "../src/index.js";

const experiment = validateAblationExperiment({ schemaVersion: 1, experimentId: "AB-REPORT", name: "Report", question: "q", corpus: { path: "manifest", hash: "b".repeat(64) }, model: { profileId: "p", model: "luna" }, budget: { attempts: 1, maxTurns: 1, maxCostUsd: 1, deadlineMs: 1000 }, variants: [{ id: "baseline", name: "base", baseline: true, changedFactor: "none" }, { id: "candidate", name: "candidate", changedFactor: "recall", policy: { recall: "automatic" } }] });

test("builds paired report with Wilson intervals and Chinese rendering", () => {
  const records = [
    { pairingId: "AB-REPORT:a:1:baseline", variantId: "baseline", caseId: "a", attempt: 1, success: true, evidenceBacked: true, candidateLeaked: false, providerRequests: 1, totalTokens: 10, contextTokens: 4, costUsd: .1, durationMs: 10, firstTool: "read", toolCalls: ["read", "verify_claim"], firstEvidenceMs: 15 },
    { pairingId: "AB-REPORT:a:1:candidate", variantId: "candidate", caseId: "a", attempt: 1, success: false, evidenceBacked: false, candidateLeaked: false, providerRequests: 2, totalTokens: 20, contextTokens: 8, costUsd: .2, durationMs: 20, failureCategory: "verifier_rejected" },
  ];
  const report = buildAblationReport(experiment, records);
  assert.equal(report.variants[0]?.successRate, 1);
  assert.equal(report.variants[1]?.successRate, 0);
  assert.equal(report.pairedComparisons[0]?.baselineOnlySuccess, 1);
  assert.match(renderAblationReportZh(report), /消融实验报告/);
  assert.equal(report.reportHash.length, 64);
  assert.equal(report.closure.successfulTrajectories[0]?.verifyClaimCalls, 1);
});

test("closure report excludes provider and incomplete pairings from strategy denominators", () => {
  const records = [
    { pairingId: "AB-REPORT:a:1:baseline", variantId: "baseline", caseId: "a", attempt: 1, success: true, evidenceBacked: true, candidateLeaked: false, providerRequests: 1, totalTokens: 1, contextTokens: 1, costUsd: 0, durationMs: 1 },
    { pairingId: "AB-REPORT:a:1:candidate", variantId: "candidate", caseId: "a", attempt: 1, success: false, evidenceBacked: false, candidateLeaked: false, providerRequests: 1, totalTokens: 1, contextTokens: 1, costUsd: 0, durationMs: 1, failureCategory: "provider_error" },
    { pairingId: "AB-REPORT:b:1:baseline", variantId: "baseline", caseId: "b", attempt: 1, success: false, evidenceBacked: false, candidateLeaked: false, providerRequests: 0, totalTokens: 0, contextTokens: 0, costUsd: 0, durationMs: 0, status: "running" },
    { pairingId: "AB-REPORT:b:1:candidate", variantId: "candidate", caseId: "b", attempt: 1, success: false, evidenceBacked: false, candidateLeaked: false, providerRequests: 0, totalTokens: 0, contextTokens: 0, costUsd: 0, durationMs: 0, status: "running" },
  ];
  const report = buildAblationReport(experiment, records);
  assert.equal(report.pairedComparisons[0]?.bothCompleted, 0);
  assert.equal(report.pairedComparisons[0]?.excludedPairs, 2);
  assert.equal(report.closure.excludedRecords.provider_error, 1);
  assert.equal(report.closure.excludedRecords.incomplete, 2);
});
