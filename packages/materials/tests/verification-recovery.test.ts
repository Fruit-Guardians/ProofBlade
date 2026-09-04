import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices, demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { RunRecoveryService } from "../src/recovery/run-recovery.js";
import { VerificationRecoveryAdapterRegistry, VerificationRecoveryService } from "../src/recovery/verification-recovery.js";
import { beginVerificationRequest } from "../src/verification/verification-key.js";
import { CodingClaimVerifier, TaskResultVerifier } from "../src/verification/claim-verification.js";
import { canonicalJson, sha256 } from "../src/domain/utils.js";
import { serializeVerifierOutcomeEnvelope } from "../src/verification/outcome-envelope.js";

const config = { schemaVersion: 1, runtime: { piVersion: "0.83.0" }, storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" }, modelProfiles: { executor: { thinkingLevel: "off" } } } as unknown as ProofBladeConfig;

test("verification recovery adapter registry rejects ambiguous backend composition", async () => {
  const adapter = {
    kind: "web" as const,
    resumeProposed: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
    reconcileStarted: async () => ({ status: "UNKNOWN" as const, reason: "test" }),
  };
  const registry = new VerificationRecoveryAdapterRegistry([adapter]);
  assert.equal(registry.get("web"), adapter);
  assert.deepEqual(registry.list(), [adapter]);
  assert.throws(() => new VerificationRecoveryAdapterRegistry([adapter, adapter]), /Duplicate verification recovery adapter for web/);
});

test("RunRecoveryService resumes a proposed pure claim command through the sandbox adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-verification-claim-recovery-"));
  try {
    let interrupted = false;
    const services = createServices(root, config, (point) => {
      if (!interrupted && point === "after_proposed") {
        interrupted = true;
        throw new Error("interrupt-before-claim-start");
      }
    });
    const runId = "VERIFICATION-CLAIM-RECOVERY";
    const task = demoTask(runId, root, config);
    task.target = `LOCAL_WORKSPACE:${root}`;
    task.scope.allowed_workspace = root;
    task.verification.command = "node solve.mjs";
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);
    const candidate = "flag{claim-recovery}";
    await writeFile(join(root, "solve.mjs"), `process.stdout.write(${JSON.stringify(candidate)});\n`, "utf8");
    const verifier = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
    await assert.rejects(verifier.record({ candidate, command: task.verification.command, cwd: root, toolCallId: "claim-recovery-call" }), /interrupt-before-claim-start/);
    const before = await services.control.snapshot(runId);
    const proposed = Object.values(before.effects).find((effect) => effect.operation === "claim_reproduction");
    assert.equal(proposed?.status, "PROPOSED");

    const first = await new RunRecoveryService(services.control, services.journal, services.sandbox, services.fixtureControl, undefined, services.verificationRecovery).recover(runId, task);
    assert.equal(first.verification.items[0]?.status, "AMBIGUOUS");
    const after = await services.control.snapshot(runId);
    const resumed = after.effects[proposed!.id];
    assert.equal(resumed?.status, "FINISHED");
    assert.equal(resumed?.verification?.valid, true);
    assert.equal(resumed?.verification?.accepted, true);
    const seq = after.lastSeq;
    const second = await new RunRecoveryService(services.control, services.journal, services.sandbox, services.fixtureControl, undefined, services.verificationRecovery).recover(runId, task);
    assert.equal(second.verification.items[0]?.status, "AMBIGUOUS");
    assert.equal((await services.control.snapshot(runId)).lastSeq, seq);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TaskResultVerifier records generic result verification with a domain-neutral operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-result-verification-operation-"));
  const runId = "RESULT-VERIFICATION-OPERATION";
  const candidate = "analysis-result-verified";
  try {
    const services = createServices(root, config);
    const task = demoTask(runId, root, config);
    task.target = `LOCAL_WORKSPACE:${root}`;
    task.scope.allowed_workspace = root;
    task.verification.command = "node verify.mjs";
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);
    await writeFile(join(root, "verify.mjs"), `process.stdout.write(${JSON.stringify(candidate)});\n`, "utf8");

    const verifier = new TaskResultVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
    const reproduction = await verifier.recordResult({
      result: candidate,
      command: task.verification.command,
      cwd: root,
      toolCallId: "result-verification-call",
    });
    const snapshot = await services.control.snapshot(runId);
    const effect = Object.values(snapshot.effects).find((item) => item.operation === "result_verification");
    assert.equal(effect?.operation, "result_verification");
    assert.equal(effect?.verification?.operation, "result_verification");
    const receipt = JSON.parse(await services.artifacts.readText(runId, snapshot.artifacts[reproduction.artifactId]!)) as { kind?: string };
    assert.equal(receipt.kind, "result_verification");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification recovery persists RECOVERY_REQUIRED for a request with no durable Effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-verification-recovery-required-"));
  try {
    const runId = "VERIFICATION-RECOVERY-REQUIRED";
    const services = createServices(root, config);
    const task = demoTask(runId, root, config);
    await services.control.createRun(runId, task);
    const request = await beginVerificationRequest(services.control, runId, {
      kind: "web",
      policyHash: sha256("policy-required"),
      recipeHash: sha256("recipe-required"),
    });
    const before = await services.control.snapshot(runId);
    const first = await new VerificationRecoveryService(services.control, undefined, [], services.verificationRecovery).reconcile(runId);
    assert.equal(first.items[0]?.status, "PENDING");
    assert.equal(first.items[0]?.recoveryState, "RECOVERY_REQUIRED");
    assert.equal(first.recoveryRequired, 1);
    const marked = await services.control.snapshot(runId);
    assert.equal(marked.verificationRequests[request.request.id]?.recoveryState, "RECOVERY_REQUIRED");
    assert.equal(marked.lastSeq, before.lastSeq + 1);
    const second = await new VerificationRecoveryService(services.control, undefined, [], services.verificationRecovery).reconcile(runId);
    assert.equal(second.recoveryRequired, 1);
    assert.equal((await services.control.snapshot(runId)).lastSeq, marked.lastSeq);
    await assert.rejects(
      services.control.dispatch(runId, { type: "verification_recovery_required", requestId: request.request.id, reason: "forged", lane: "verifier" }),
      /restricted to the recovery service/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifier replay Effect is durable before an external session and never becomes a completion verdict", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-verification-replay-effect-"));
  try {
    const runId = "VERIFICATION-REPLAY-EFFECT";
    const services = createServices(root, config);
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    task.scope.allowed_workspace = root;
    task.verification.web = { flag_pattern: "flag\\{[^}]+\\}" };
    await services.control.createRun(runId, task);
    const policyHash = sha256("policy-replay");
    const recipeHash = sha256("recipe-replay");
    const request = await beginVerificationRequest(services.control, runId, { kind: "web", policyHash, recipeHash });
    const prepared = await services.journal.prepareVerifierReplay(runId, {
      verificationRequestId: request.request.id,
      verificationKey: request.request.key,
      kind: "web",
      policyHash,
      recipeHash,
      attemptId: sha256("replay-attempt"),
      cwd: root,
      recoveryInput: { content: JSON.stringify({ schemaVersion: 1, kind: "web", steps: [{ path: "/admin" }] }), filename: "web-replay.json" },
    });
    let snapshot = await services.control.snapshot(runId);
    const proposed = snapshot.effects[prepared.effectId];
    assert.equal(proposed?.operation, "verification_replay");
    assert.equal(proposed?.status, "PROPOSED");
    assert.equal(proposed?.verification, undefined);
    assert.equal(proposed?.sessionId?.startsWith("replay:"), true);
    assert.equal((await new VerificationRecoveryService(services.control).inspect(runId)).items[0]?.status, "PROPOSED_EFFECT");

    await services.journal.startVerifierReplay(runId, prepared.effectId, "HTTP-REPLAY-SESSION");
    await services.journal.finishVerifierReplay(runId, prepared.effectId, {
      stdout: serializeVerifierOutcomeEnvelope({
        schemaVersion: 1,
        requestKey: request.request.key,
        runId,
        generation: 0,
        kind: "web",
        policyHash,
        recipeHash,
        externalId: "HTTP-REPLAY-SESSION",
        externalStatus: "CONFIRMED",
        attempts: [{ id: sha256("replay-attempt"), phase: "web_replay", status: "FAILED", externalId: "HTTP-REPLAY-SESSION", summary: "replay failed" }],
        transcriptArtifactIds: [],
        evidenceIds: [],
        terminal: false,
      }, { replay: true }),
      stderr: "",
      exitCode: 1,
      durationMs: 3,
      externalId: "HTTP-REPLAY-SESSION",
    });
    snapshot = await services.control.snapshot(runId);
    const finished = snapshot.effects[prepared.effectId];
    assert.equal(finished?.status, "FINISHED");
    assert.equal(finished?.sessionId, "HTTP-REPLAY-SESSION");
    assert.equal(finished?.verification, undefined);
    assert.equal(snapshot.artifacts[finished!.artifactId!]?.origin.registeredBy, "verifier");
    assert.equal((await new VerificationRecoveryService(services.control).inspect(runId)).items[0]?.status, "AMBIGUOUS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification recovery reports a durable terminal outcome without external work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-verification-recovery-terminal-"));
  try {
    const runId = "VERIFICATION-RECOVERY-TERMINAL";
    const services = createServices(root, config);
    const task = demoTask(runId, root, config);
    task.scope.allowed_workspace = root;
    task.verification.required_reproductions = 1;
    task.verification.command = "node solve.mjs";
    await services.control.createRun(runId, task);
    const candidate = "flag{recovery-terminal}";
    await writeFile(join(root, "solve.mjs"), `process.stdout.write(${JSON.stringify(candidate)});\n`, "utf8");
    const verifier = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
    const result = await verifier.record({ candidate, command: "node solve.mjs", cwd: root, toolCallId: "recovery-terminal-call" });

    const report = await new VerificationRecoveryService(services.control).inspect(runId);
    assert.equal(report.terminal, 1);
    assert.equal(report.requiresRecovery, 0);
    assert.deepEqual(report.items.map((item) => ({ status: item.status, completionId: item.completionId })), [{ status: "TERMINAL", completionId: result.completionId }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RunRecoveryService resumes a verifier proposal from durable input without external work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-verification-recovery-proposed-"));
  try {
    let interrupted = false;
    const services = createServices(root, config, (point) => {
      if (!interrupted && point === "after_proposed") {
        interrupted = true;
        throw new Error("interrupt-before-verifier-start");
      }
    });
    const runId = "VERIFICATION-RECOVERY-PROPOSED";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    task.scope.allowed_workspace = root;
    task.verification.web = { flag_pattern: "flag\\{[^}]+\\}" };
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);
    const request = await beginVerificationRequest(services.control, runId, {
      kind: "web",
      policyHash: sha256("policy"),
      recipeHash: sha256("recipe"),
    });
    const candidate = "flag{pending-verifier}";
    const candidateArtifact = await services.artifacts.putText(runId, candidate, { filename: "candidate.txt", sensitivity: "flag_candidate" });
    const candidateHash = sha256(candidate);
    const completionId = "C-VERIFICATION-RECOVERY";
    await services.control.dispatch(runId, {
      type: "completion_proposed",
      completion: { id: completionId, purpose: "harness_verification", candidateHash, artifactId: candidateArtifact.id, verificationKey: request.request.key },
      lane: "main",
    });
    await assert.rejects(services.verifierJournal.execute(runId, {
      operation: "web_reproduce",
      args: {
        runId,
        taskId: task.task_id,
        generation,
        completionId,
        candidateHash,
        candidateArtifactId: candidateArtifact.id,
        taskHash: sha256(canonicalJson(task)),
        targetHash: sha256(task.target),
        verificationRuleHash: sha256(canonicalJson(task.verification)),
        attemptId: sha256("attempt"),
      },
      replayPolicy: "pure",
      cwd: root,
      sessionId: "SES-VERIFICATION-RECOVERY",
      recoveryInput: { content: JSON.stringify({ accepted: false, candidateHash }), filename: "web-recovery-input.json", mime: "application/json", sensitivity: "flag_candidate" },
    }), /interrupt-before-verifier-start/);

    const recovered = await new RunRecoveryService(services.control, services.journal, services.sandbox, services.fixtureControl).recover(runId, task);
    assert.equal(recovered.verification.requiresRecovery, 1);
    assert.equal(recovered.verification.items[0]?.status, "AMBIGUOUS");
    const snapshot = await services.control.snapshot(runId);
    const effect = Object.values(snapshot.effects)[0];
    assert.equal(effect?.status, "FINISHED");
    assert.equal(effect?.operation, "web_reproduce");

    assert.equal(Object.keys((await services.control.snapshot(runId)).effects).length, 1);
    assert.equal((await new VerificationRecoveryService(services.control).inspect(runId)).items[0]?.status, "AMBIGUOUS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification recovery adopts a verifier result artifact without rerunning the external effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-verification-recovery-artifact-"));
  try {
    let interrupted = false;
    const services = createServices(root, config, (point) => {
      if (!interrupted && point === "after_artifact") {
        interrupted = true;
        throw new Error("interrupt-after-verifier-artifact");
      }
    });
    const runId = "VERIFICATION-RECOVERY-ARTIFACT";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    task.scope.allowed_workspace = root;
    task.verification.web = { flag_pattern: "flag\\{[^}]+\\}" };
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);
    const request = await beginVerificationRequest(services.control, runId, {
      kind: "web",
      policyHash: sha256("policy-artifact"),
      recipeHash: sha256("recipe-artifact"),
    });
    const candidate = "flag{artifact-recovery}";
    const candidateArtifact = await services.artifacts.putText(runId, candidate, { filename: "candidate.txt", sensitivity: "flag_candidate" });
    const candidateHash = sha256(candidate);
    const completionId = "C-VERIFICATION-RECOVERY-ARTIFACT";
    await services.control.dispatch(runId, {
      type: "completion_proposed",
      completion: { id: completionId, purpose: "harness_verification", candidateHash, artifactId: candidateArtifact.id, verificationKey: request.request.key },
      lane: "main",
    });
    await assert.rejects(services.verifierJournal.execute(runId, {
      operation: "web_reproduce",
      args: {
        runId,
        taskId: task.task_id,
        generation,
        completionId,
        candidateHash,
        candidateArtifactId: candidateArtifact.id,
        taskHash: sha256(canonicalJson(task)),
        targetHash: sha256(task.target),
        verificationRuleHash: sha256(canonicalJson(task.verification)),
        attemptId: sha256("attempt-artifact"),
      },
      replayPolicy: "pure",
      cwd: root,
      sessionId: "SES-VERIFICATION-RECOVERY-ARTIFACT",
    }), /interrupt-after-verifier-artifact/);

    const before = await services.control.snapshot(runId);
    const effect = Object.values(before.effects)[0]!;
    const resultArtifact = Object.values(before.artifacts).find((artifact) => artifact.sourceEffectId === effect.id && artifact.origin.registeredBy === "verifier");
    assert.equal(effect.status, "STARTED");
    assert.ok(resultArtifact);
    const recovered = await new RunRecoveryService(services.control, services.journal, services.sandbox, services.fixtureControl).recover(runId, task);
    assert.equal(recovered.verification.items[0]?.status, "AMBIGUOUS");
    const after = await services.control.snapshot(runId);
    assert.equal(after.effects[effect.id]?.status, "FINISHED");
    assert.equal(after.effects[effect.id]?.artifactId, resultArtifact!.id);
    assert.equal(Object.values(after.artifacts).filter((artifact) => artifact.sourceEffectId === effect.id).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification recovery accepts a backend-confirmed STARTED result under the original Effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-verification-recovery-started-"));
  try {
    let interrupted = false;
    const services = createServices(root, config, (point) => {
      if (!interrupted && point === "after_started") {
        interrupted = true;
        throw new Error("interrupt-after-verifier-start");
      }
    });
    const runId = "VERIFICATION-RECOVERY-STARTED";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    task.scope.allowed_workspace = root;
    task.verification.web = { flag_pattern: "flag\\{[^}]+\\}" };
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);
    const request = await beginVerificationRequest(services.control, runId, { kind: "web", policyHash: sha256("policy-started"), recipeHash: sha256("recipe-started") });
    const candidate = "flag{started-recovery}";
    const candidateArtifact = await services.artifacts.putText(runId, candidate, { filename: "candidate.txt", sensitivity: "flag_candidate" });
    const candidateHash = sha256(candidate);
    const completionId = "C-VERIFICATION-RECOVERY-STARTED";
    await services.control.dispatch(runId, {
      type: "completion_proposed",
      completion: { id: completionId, purpose: "harness_verification", candidateHash, artifactId: candidateArtifact.id, verificationKey: request.request.key },
      lane: "main",
    });
    await assert.rejects(services.verifierJournal.execute(runId, {
      operation: "web_reproduce",
      args: {
        runId,
        taskId: task.task_id,
        generation,
        completionId,
        candidateHash,
        candidateArtifactId: candidateArtifact.id,
        taskHash: sha256(canonicalJson(task)),
        targetHash: sha256(task.target),
        verificationRuleHash: sha256(canonicalJson(task.verification)),
        attemptId: sha256("attempt-started"),
      },
      replayPolicy: "pure",
      cwd: root,
      sessionId: "SES-VERIFICATION-RECOVERY-STARTED",
    }), /interrupt-after-verifier-start/);
    const before = await services.control.snapshot(runId);
    const effect = Object.values(before.effects)[0]!;
    assert.equal(effect.status, "STARTED");
    let inspected = 0;
    let providerCalled = false;
    const recovery = new RunRecoveryService(
      services.control,
      services.journal,
      services.sandbox,
      services.fixtureControl,
      undefined,
      services.verificationRecovery,
      async ({ runId: contextRunId, task: contextTask, snapshot: contextSnapshot, fixture }) => {
        providerCalled = true;
        assert.equal(contextRunId, runId);
        assert.equal(contextTask.task_id, task.task_id);
        assert.equal(contextSnapshot.generation, generation);
        assert.equal(fixture.generation, generation);
        return [{
          kind: "web",
          resumeProposed: async () => { throw new Error("started effects must not resume"); },
          reconcileStarted: async ({ effect: started }) => {
            inspected += 1;
            assert.equal(started.id, effect.id);
            return { status: "CONFIRMED", result: { stdout: JSON.stringify({ accepted: false, candidateHash }), stderr: "", exitCode: 0, durationMs: 2 } };
          },
        }];
      },
    );
    const report = await recovery.recover(runId, task);
    assert.equal(providerCalled, true);
    assert.equal(inspected, 1);
    assert.equal(report.verification.items[0]?.status, "AMBIGUOUS");
    const after = await services.control.snapshot(runId);
    assert.equal(after.effects[effect.id]?.status, "FINISHED");
    assert.equal(Object.values(after.artifacts).filter((artifact) => artifact.sourceEffectId === effect.id).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
