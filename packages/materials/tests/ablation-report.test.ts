import assert from "node:assert/strict";
import test from "node:test";
import { buildAblationReport, renderAblationReportZh, validateAblationExperiment } from "../src/index.js";

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
  assert.match(renderAblationReportZh(report), /消融实验报告/);
  assert.equal(report.reportHash.length, 64);
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
