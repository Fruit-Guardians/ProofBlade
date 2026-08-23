import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices, demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { CodingClaimVerifier } from "../src/verification/claim-verification.js";

test("claim verification rebuilds from durable state, matches the exact final candidate, and rejects a stale generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-claim-recovery-"));
  try {
    const config = testConfig();
    const runId = "CLAIM-RECOVERY-001";
    const services = createServices(root, config);
    const task = demoTask(runId, root, config);
    task.scope.allowed_workspace = root;
    task.verification.required_reproductions = 1;
    task.verification.command = "node solve.mjs";
    await services.control.createRun(runId, task);

    const candidate = "flag{durable_projection_recovery}";
    const verifier = new CodingClaimVerifier(
      runId,
      services.control,
      services.artifacts,
      services.journal,
      services.verifierJournal,
      services.verifier,
    );
    await writeFile(join(root, "solve.mjs"), `process.stdout.write(${JSON.stringify(candidate)});\n`, "utf8");
    const reproduction = await verifier.record({
      candidate,
      command: "node solve.mjs",
      cwd: root,
      toolCallId: "claim-recovery-call-1",
    });
    assert.equal(reproduction.verified, true);

    const live = await verifier.project("完成这道题并找出 flag", `最终结果：${candidate}`);
    assert.equal(live.status, "verified");
    assert.equal(live.candidateHash, reproduction.candidateHash);
    assert.equal(live.completionId, reproduction.completionId);
    assert.equal(live.evidenceId, reproduction.evidenceId);
    assert.equal(live.commandHash, reproduction.commandHash);

    const wrongFinalCandidate = await verifier.project(
      "完成这道题并找出 flag",
      `分析中曾考虑 ${candidate}，但最终答案：flag{different_candidate}`,
    );
    assert.equal(wrongFinalCandidate.status, "unverified");
    assert.match(wrongFinalCandidate.reason ?? "", /候选哈希精确匹配/);

    // Recreate every service object over the same JSONL/artifact directory. The
    // new verifier has no process-memory reproduction index to inherit.
    const restarted = createServices(root, config);
    const recoveredVerifier = new CodingClaimVerifier(
      runId,
      restarted.control,
      restarted.artifacts,
      restarted.journal,
      restarted.verifierJournal,
      restarted.verifier,
    );
    const recovered = await recoveredVerifier.project("完成这道题并找出 flag", `最终结果：${candidate}`);
    assert.deepEqual(recovered, live);

    const recoveredSnapshot = await restarted.control.snapshot(runId);
    const completion = recoveredSnapshot.completions[reproduction.completionId];
    assert.equal(completion?.status, "ACCEPTED");
    assert.equal(completion?.candidateHash, reproduction.candidateHash);
    assert.deepEqual(completion?.evidenceIds, [reproduction.evidenceId]);
    const recoveredEvidence = recoveredSnapshot.evidence[reproduction.evidenceId];
    assert.equal(recoveredEvidence?.provenance.recordedBy, "verifier");
    const effectId = recoveredEvidence?.provenance.effect?.id;
    assert.ok(effectId);
    assert.equal(recoveredSnapshot.effects[effectId]?.status, "FINISHED");

    await services.fixtureControl.reset(runId, recoveredSnapshot.generation + 1);
    const stale = await recoveredVerifier.project("完成这道题并找出 flag", `最终结果：${candidate}`);
    assert.equal(stale.status, "unverified");
    assert.match(stale.reason ?? "", /当前 generation/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task-required claim reproductions use independent durable verifier attempts before atomic acceptance", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-claim-multi-"));
  try {
    const config = testConfig();
    const runId = "CLAIM-MULTI-001";
    const services = createServices(root, config);
    const task = demoTask(runId, root, config);
    task.scope.allowed_workspace = root;
    task.verification.required_reproductions = 2;
    task.verification.command = "node solve.mjs";
    await services.control.createRun(runId, task);
    const candidate = "flag{two_independent_durable_attempts}";
    await writeFile(join(root, "solve.mjs"), `process.stdout.write(${JSON.stringify(candidate)});\n`, "utf8");
    const verifier = new CodingClaimVerifier(
      runId,
      services.control,
      services.artifacts,
      services.journal,
      services.verifierJournal,
      services.verifier,
    );

    const reproduction = await verifier.record({
      candidate,
      command: "node solve.mjs",
      cwd: root,
      toolCallId: "claim-multi-call-1",
    });
    assert.equal(reproduction.verified, true);
    const snapshot = await services.control.snapshot(runId);
    const completion = snapshot.completions[reproduction.completionId];
    assert.equal(completion?.status, "ACCEPTED");
    assert.equal(completion?.evidenceIds.length, 2);
    const effects = completion!.evidenceIds.map((evidenceId) => snapshot.effects[snapshot.evidence[evidenceId]!.provenance.effect!.id]!);
    assert.equal(new Set(effects.map((effect) => effect.id)).size, 2);
    assert.equal(new Set(effects.map((effect) => effect.verification?.sessionId)).size, 2);
    assert.equal(new Set(effects.map((effect) => effect.verification?.attemptId)).size, 2);
    assert.equal(new Set(effects.map((effect) => effect.verification?.transcriptHash)).size, 2);

    const restarted = createServices(root, config);
    const recovered = await new CodingClaimVerifier(
      runId,
      restarted.control,
      restarted.artifacts,
      restarted.journal,
      restarted.verifierJournal,
      restarted.verifier,
    ).project("完成这道题并找出 flag", `最终结果：${candidate}`);
    assert.equal(recovered.status, "verified");
    assert.equal(recovered.completionId, reproduction.completionId);
    assert.equal(recovered.candidateHash, reproduction.candidateHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function testConfig(): ProofBladeConfig {
  return {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: { thinkingLevel: "off" } },
  } as ProofBladeConfig;
}
