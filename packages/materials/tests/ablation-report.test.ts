import assert from "node:assert/strict";
import test from "node:test";
import { buildAblationReport, renderAblationReportZh, validateAblationExperiment } from "../src/index.js";

const experiment = validateAblationExperiment({ schemaVersion: 1, experimentId: "AB-REPORT", name: "Report", question: "q", corpus: { path: "manifest", hash: "b".repeat(64) }, model: { profileId: "p", model: "luna" }, budget: { attempts: 1, maxTurns: 1, maxCostUsd: 1, deadlineMs: 1000 }, variants: [{ id: "baseline", name: "base", baseline: true, changedFactor: "none" }, { id: "candidate", name: "candidate", changedFactor: "recall", policy: { recall: "automatic" } }] });

test("builds paired report with Wilson intervals and Chinese rendering", () => {
  const records = [
    { pairingId: "1", variantId: "baseline", caseId: "a", attempt: 1, success: true, evidenceBacked: true, candidateLeaked: false, providerRequests: 1, totalTokens: 10, contextTokens: 4, costUsd: .1, durationMs: 10 },
    { pairingId: "2", variantId: "candidate", caseId: "a", attempt: 1, success: false, evidenceBacked: false, candidateLeaked: false, providerRequests: 2, totalTokens: 20, contextTokens: 8, costUsd: .2, durationMs: 20, failureCategory: "verifier_rejected" },
  ];
  const report = buildAblationReport(experiment, records);
  assert.equal(report.variants[0]?.successRate, 1);
  assert.equal(report.variants[1]?.successRate, 0);
  assert.equal(report.pairedComparisons[0]?.baselineOnlySuccess, 1);
  assert.match(renderAblationReportZh(report), /消融实验报告/);
  assert.equal(report.reportHash.length, 64);
});
