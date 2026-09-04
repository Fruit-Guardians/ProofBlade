import assert from "node:assert/strict";
import { access, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AblationRunLedger, validateAblationExperiment } from "../src/index.js";

const experiment = validateAblationExperiment({ schemaVersion: 1, experimentId: "AB-LEDGER", name: "Ledger", question: "q", corpus: { path: "manifest", hash: "a".repeat(64) }, model: { profileId: "p", model: "luna" }, budget: { attempts: 1, maxTurns: 1, maxCostUsd: 1, deadlineMs: 1000 }, variants: [{ id: "baseline", name: "base", baseline: true, changedFactor: "none" }, { id: "candidate", name: "candidate", changedFactor: "recall", policy: { recall: "automatic" } }] });

test("ledger claims in deterministic order and never reclaims terminal attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-ablation-ledger-"));
  try {
    const ledger = await AblationRunLedger.create(join(root, "ledger.json"), experiment, [{ id: "case-b" }, { id: "case-a" }], () => "2026-08-31T00:00:00.000Z");
    assert.equal(ledger.next()?.caseId, "case-a");
    const first = await ledger.claim(ledger.next()!.pairingId, "run-a", () => "2026-08-31T00:00:01.000Z");
    await ledger.complete(first.pairingId, "succeeded", undefined, () => "2026-08-31T00:00:02.000Z", { success: true, candidate: "secret", providerRequests: 1 });
    const completed = (await AblationRunLedger.load(join(root, "ledger.json"))).snapshot().attempts[first.pairingId];
    assert.deepEqual(completed?.result, { success: true, providerRequests: 1 });
    await assert.rejects(() => ledger.claim(first.pairingId, "run-again"), /terminal or running/);
    assert.equal(ledger.summary().succeeded, 1);
    const second = await ledger.claim(ledger.next()!.pairingId, "run-b");
    assert.equal(second.caseId, "case-a");
    await ledger.markInterrupted();
    assert.equal((await AblationRunLedger.load(join(root, "ledger.json"))).summary().unknown, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ledger recovers a lock left by an exited process", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-ablation-stale-lock-"));
  try {
    const ledgerPath = join(root, "ledger.json");
    const ledger = await AblationRunLedger.create(ledgerPath, experiment, [{ id: "case-a" }]);
    await writeFile(`${ledgerPath}.lock`, "999999999\n0\n", { flag: "wx" });
    const pairing = ledger.next();
    assert.ok(pairing);
    const claimed = await ledger.claim(pairing.pairingId, "run-recovered");
    assert.equal(claimed.status, "running");
    await assert.rejects(() => access(`${ledgerPath}.lock`), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ledger keeps a lock owned by a live process", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-ablation-live-lock-"));
  try {
    const ledgerPath = join(root, "ledger.json");
    const ledger = await AblationRunLedger.create(ledgerPath, experiment, [{ id: "case-a" }]);
    await writeFile(`${ledgerPath}.lock`, `${process.pid}\n${Date.now()}\n`, { flag: "wx" });
    const pairing = ledger.next();
    assert.ok(pairing);
    await assert.rejects(() => ledger.claim(pairing.pairingId, "run-blocked"), /locked by another process/);
    await unlink(`${ledgerPath}.lock`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
