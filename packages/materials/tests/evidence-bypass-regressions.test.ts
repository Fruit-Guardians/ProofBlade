import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices, createServicesForTesting, demoTask, type TestAppServices } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { createEffectInput } from "../src/control/control-store.js";
import { reduce } from "../src/control/reducer.js";
import type { Evidence, RawEffectResult, TaskContract } from "../src/domain/types.js";
import { canonicalJson, sha256 } from "../src/domain/utils.js";
import { EvidenceCurationGate } from "../src/knowledge/evidence-curation-gate.js";
import { JsonlControlStore, makeEvent } from "../src/storage/jsonl-store.js";
import { ProofBladeToolRuntime } from "../src/tools/runtime.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "TEST_API_KEY",
      contextWindow: 4_096,
      maxTokens: 512,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      input: ["text"],
    },
  },
};

type EvidenceInput = Omit<Evidence, "createdSeq" | "provenance">;

test("production services do not expose the arbitrary verifier executor test seam", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-production-surface-"));
  const services = createServices(root, config);
  try {
    assert.equal("verifierTestHarness" in services, false);
    assert.equal("executeWith" in services.verifierJournal, false);
  } finally {
    await services.sandbox.close();
    await rm(root, { recursive: true, force: true });
  }
});

interface Harness {
  root: string;
  runId: string;
  task: TaskContract;
  services: TestAppServices;
}

interface CandidateRef {
  completionId: string;
  candidateHash: string;
  artifactId: string;
}

interface EffectRef {
  effectId: string;
  artifactId: string;
}

async function createHarness(
  label: string,
  mutateTask: (task: TaskContract) => void = () => undefined,
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `proofblade-bypass-${label}-`));
  const runId = `BYPASS-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const services = createServicesForTesting(root, config);
  const task = demoTask(runId, root, config);
  task.verification = { ...task.verification, required_reproductions: 1 };
  mutateTask(task);
  await services.control.createRun(runId, task);
  return { root, runId, task, services };
}

async function destroyHarness(harness: Harness): Promise<void> {
  await Promise.allSettled([harness.services.sandbox.close()]);
  await rm(harness.root, { recursive: true, force: true });
}

async function proposeCandidate(harness: Harness, completionId: string, candidate: string): Promise<CandidateRef> {
  const artifact = await harness.services.artifacts.putText(harness.runId, candidate, {
    filename: `${completionId}.txt`,
    mime: "text/plain",
    sensitivity: "flag_candidate",
  });
  const candidateHash = sha256(candidate);
  await harness.services.control.dispatch(harness.runId, {
    type: "completion_proposed",
    completion: { id: completionId, purpose: "harness_verification", candidateHash, artifactId: artifact.id },
    lane: "executor",
  });
  return { completionId, candidateHash, artifactId: artifact.id };
}

async function runFixtureScore(
  harness: Harness,
  candidate: CandidateRef,
  attempt: number,
  accepted: boolean,
): Promise<EffectRef> {
  const snapshot = await harness.services.control.snapshot(harness.runId);
  const result = await harness.services.verifierTestHarness.executeWith(
    harness.runId,
    {
      operation: "fixture_score",
      args: {
        runId: harness.runId,
        taskId: snapshot.task.task_id,
        generation: snapshot.generation,
        completionId: candidate.completionId,
        candidateHash: candidate.candidateHash,
        candidateArtifactId: candidate.artifactId,
        taskHash: snapshot.taskHash,
        targetHash: sha256(snapshot.task.target),
        verificationRuleHash: sha256(canonicalJson(snapshot.task.verification)),
        attempt,
        attemptId: `attempt-${attempt}`,
      },
      replayPolicy: "pure",
      cwd: snapshot.task.scope.allowed_workspace,
      sessionId: `${harness.runId}:${candidate.completionId}:attempt-${attempt}`,
    },
    async (): Promise<RawEffectResult> => ({
      stdout: JSON.stringify({ accepted, candidateHash: candidate.candidateHash }),
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    }),
  );
  return { effectId: result.effectId, artifactId: result.artifactId };
}

function scorerEvidence(
  id: string,
  completionId: string,
  effect: EffectRef,
  generation: number,
  kind: "reproduction" | "negative",
): EvidenceInput {
  return {
    id,
    kind,
    summary: `${kind} ${id} for ${completionId}`,
    source: {
      tool: "fixture_score",
      effectId: effect.effectId,
      artifactId: effect.artifactId,
      generation,
    },
    confidence: 1,
    supports: kind === "reproduction" ? [completionId] : [],
    refutes: kind === "negative" ? [completionId] : [],
  };
}

test("a service factory with a different explicit credential cannot mint trusted authority for an existing run", async () => {
  const harness = await createHarness("AUTHORITY-ANCHOR");
  const attacker = createServicesForTesting(harness.root, config, {
    authoritySecret: "different-untrusted-authority-secret-for-regression",
  });
  try {
    const candidate = await proposeCandidate(harness, "C-AUTHORITY-ANCHOR", "PB{owner_only_authority}");
    const snapshot = await attacker.control.snapshot(harness.runId);
    let executorCalls = 0;
    await assert.rejects(attacker.verifierTestHarness.executeWith(harness.runId, {
      operation: "fixture_score",
      args: {
        runId: harness.runId,
        taskId: snapshot.task.task_id,
        generation: snapshot.generation,
        completionId: candidate.completionId,
        candidateHash: candidate.candidateHash,
        candidateArtifactId: candidate.artifactId,
        taskHash: snapshot.taskHash,
        targetHash: sha256(snapshot.task.target),
        verificationRuleHash: sha256(canonicalJson(snapshot.task.verification)),
        attempt: 1,
        attemptId: "forged-second-factory-attempt",
      },
      replayPolicy: "pure",
      cwd: snapshot.task.scope.allowed_workspace,
      sessionId: "forged-second-factory-session",
    }, async () => {
      executorCalls += 1;
      return { stdout: JSON.stringify({ accepted: true, candidateHash: candidate.candidateHash }), stderr: "", exitCode: 0, durationMs: 1 };
    }), /authority does not match the immutable Run anchor/);
    await assert.rejects(attacker.fixtureControl.reset(harness.runId, snapshot.generation + 1), /authority does not match the immutable Run anchor/);
    assert.equal(executorCalls, 0, "an unanchored verifier executor must never be invoked");
    const owner = await harness.services.control.snapshot(harness.runId);
    assert.equal(Object.keys(owner.effects).length, 0);
    assert.equal(owner.completions[candidate.completionId]?.status, "PROPOSED");
    assert.equal(owner.status, "READY");
  } finally {
    await attacker.sandbox.close();
    await destroyHarness(harness);
  }
});

test("an explicit stable authority credential permits trusted reopen while a wrong credential remains read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-authority-reopen-"));
  const runId = `AUTHORITY-REOPEN-${Date.now()}`;
  const authoritySecret = "proofblade-test-authority-credential-0000000000000000000000000001";
  const owner = createServicesForTesting(root, config, { authoritySecret });
  const reopened = createServicesForTesting(root, config, { authoritySecret });
  const wrong = createServicesForTesting(root, config, { authoritySecret: "wrong-proofblade-authority-credential-00000000000000000000000002" });
  try {
    await owner.control.createRun(runId, demoTask(runId, root, config));
    await reopened.control.dispatch(runId, { type: "start_phase", phase: "reconnaissance" });
    await reopened.fixtureControl.assertResetAllowed(runId);
    await reopened.fixtureControl.reset(runId, 1);
    assert.equal((await owner.control.snapshot(runId)).generation, 1);
    await assert.rejects(wrong.fixtureControl.assertResetAllowed(runId), /authority does not match/);
    await assert.rejects(wrong.control.dispatch(runId, { type: "pause", reason: "wrong credential" }), /write authority does not match/);
    assert.equal((await owner.control.snapshot(runId)).status, "RUNNING");
  } finally {
    await Promise.allSettled([owner.sandbox.close(), reopened.sandbox.close(), wrong.sandbox.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture-score Evidence cannot cross-bind an Effect from C1 to C2 or finish C2", async () => {
  const harness = await createHarness("CROSS-COMPLETION");
  try {
    const c1 = await proposeCandidate(harness, "C-BOUND-1", "PB{bound_one}");
    const c2 = await proposeCandidate(harness, "C-BOUND-2", "PB{bound_two}");
    const effect = await runFixtureScore(harness, c1, 1, true);
    const generation = (await harness.services.control.snapshot(harness.runId)).generation;

    await assert.rejects(harness.services.verifier.dispatchBatch(harness.runId, [
      {
        type: "evidence",
        evidence: scorerEvidence("EV-CROSS-COMPLETION", c2.completionId, effect, generation, "reproduction"),
      },
      {
        type: "completion_verified",
        completionId: c2.completionId,
        accepted: true,
        evidenceIds: ["EV-CROSS-COMPLETION"],
      },
    ]));

    const snapshot = await harness.services.control.snapshot(harness.runId);
    assert.equal(snapshot.evidence["EV-CROSS-COMPLETION"], undefined);
    assert.equal(snapshot.completions[c1.completionId]?.status, "PROPOSED");
    assert.equal(snapshot.completions[c2.completionId]?.status, "PROPOSED");
    await assert.rejects(harness.services.verifier.finish(harness.runId, {
      completionId: c2.completionId,
      reason: "must not finish from another completion's scorer Effect",
    }));
    assert.equal((await harness.services.control.snapshot(harness.runId)).status, "READY");
  } finally {
    await destroyHarness(harness);
  }
});

test("fixture-score verdict direction is immutable: rejected output cannot reproduce and accepted output cannot negate", async () => {
  const harness = await createHarness("VERDICT-DIRECTION");
  try {
    const candidate = await proposeCandidate(harness, "C-VERDICT", "PB{verdict_direction}");
    const rejected = await runFixtureScore(harness, candidate, 1, false);
    const accepted = await runFixtureScore(harness, candidate, 2, true);
    const generation = (await harness.services.control.snapshot(harness.runId)).generation;

    await assert.rejects(harness.services.verifier.dispatch(harness.runId, {
      type: "evidence",
      evidence: scorerEvidence("EV-FALSE-AS-REPRO", candidate.completionId, rejected, generation, "reproduction"),
    }));
    await harness.services.verifier.dispatch(harness.runId, {
      type: "evidence",
      evidence: scorerEvidence("EV-FALSE-NEGATIVE", candidate.completionId, rejected, generation, "negative"),
    });
    await assert.rejects(harness.services.verifier.dispatch(harness.runId, {
      type: "completion_verified",
      completionId: candidate.completionId,
      accepted: true,
      evidenceIds: ["EV-FALSE-NEGATIVE"],
    }));
    await assert.rejects(harness.services.verifier.dispatch(harness.runId, {
      type: "evidence",
      evidence: scorerEvidence("EV-TRUE-AS-NEGATIVE", candidate.completionId, accepted, generation, "negative"),
    }));

    const snapshot = await harness.services.control.snapshot(harness.runId);
    assert.equal(snapshot.evidence["EV-FALSE-AS-REPRO"], undefined);
    assert.equal(snapshot.evidence["EV-FALSE-NEGATIVE"]?.kind, "negative");
    assert.equal(snapshot.evidence["EV-TRUE-AS-NEGATIVE"], undefined);
    assert.equal(snapshot.completions[candidate.completionId]?.status, "PROPOSED");
  } finally {
    await destroyHarness(harness);
  }
});

test("effect_proposed rejects terminal status and every preloaded result field", async () => {
  const harness = await createHarness("EFFECT-PROPOSAL");
  try {
    const artifact = await harness.services.artifacts.putText(harness.runId, "unrelated output", {
      filename: "unrelated.txt",
      mime: "text/plain",
    });
    const invalid = [
      { id: "EF-PRE-FINISHED", status: "FINISHED" as const },
      { id: "EF-PRE-OUTCOME", status: "PROPOSED" as const, outcome: "success" as const },
      { id: "EF-PRE-EXIT", status: "PROPOSED" as const, exitCode: 0 },
      { id: "EF-PRE-ARTIFACT", status: "PROPOSED" as const, artifactId: artifact.id },
    ];
    for (const item of invalid) {
      const args = { invalidCase: item.id };
      await assert.rejects(harness.services.control.dispatch(harness.runId, {
        type: "effect_proposed",
        effect: {
          ...item,
          id: item.id,
          idempotencyKey: createEffectInput(harness.runId, "fake_effect", args, "pure", 0).idempotencyKey,
          replayPolicy: "pure",
          operation: "fake_effect",
          args,
        },
        lane: "executor",
      }));
    }
    assert.deepEqual(Object.keys((await harness.services.control.snapshot(harness.runId)).effects), []);
  } finally {
    await destroyHarness(harness);
  }
});

test("ordinary Artifact registration cannot bind an interrupted verifier Effect or let reconcile upgrade it", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-verifier-artifact-authority-"));
  const runId = `VERIFIER-ARTIFACT-AUTHORITY-${Date.now()}`;
  let injected = true;
  const services = createServicesForTesting(root, config, {
    effectFault: (point) => {
      if (injected && point === "after_started") {
        injected = false;
        throw new Error("injected:verifier-after-started");
      }
    },
  });
  const task = demoTask(runId, root, config);
  task.verification = { ...task.verification, required_reproductions: 1 };
  const harness: Harness = { root, runId, task, services };
  try {
    await services.control.createRun(runId, task);
    const candidate = await proposeCandidate(harness, "C-VERIFIER-ARTIFACT", "PB{artifact_authority_boundary}");
    const snapshot = await services.control.snapshot(runId);
    let executorCalls = 0;
    await assert.rejects(services.verifierTestHarness.executeWith(runId, {
      operation: "fixture_score",
      args: {
        runId,
        taskId: snapshot.task.task_id,
        generation: snapshot.generation,
        completionId: candidate.completionId,
        candidateHash: candidate.candidateHash,
        candidateArtifactId: candidate.artifactId,
        taskHash: snapshot.taskHash,
        targetHash: sha256(snapshot.task.target),
        verificationRuleHash: sha256(canonicalJson(snapshot.task.verification)),
        attempt: 1,
        attemptId: "interrupted-verifier-attempt",
      },
      replayPolicy: "forbidden-replay",
      cwd: snapshot.task.scope.allowed_workspace,
      sessionId: "interrupted-verifier-session",
    }, async () => {
      executorCalls += 1;
      return { stdout: JSON.stringify({ accepted: true, candidateHash: candidate.candidateHash }), stderr: "", exitCode: 0, durationMs: 1 };
    }), /injected:verifier-after-started/);
    assert.equal(executorCalls, 0, "the crash point must precede verifier execution");

    const interrupted = await services.control.snapshot(runId);
    const effect = Object.values(interrupted.effects).find((value) => value.operation === "fixture_score")!;
    assert.equal(effect.status, "STARTED");
    assert.equal(effect.producerLane, "verifier");
    await assert.rejects(services.artifacts.putText(runId, "forged verifier output", {
      filename: "forged-verifier-output.json",
      mime: "application/json",
      sourceEffectId: effect.id,
    }), /requires trusted verifier Artifact authority/);
    const laneSpoof = await services.artifacts.stageText(runId, "forged verifier-lane output", {
      filename: "forged-verifier-lane-output.json",
      mime: "application/json",
      sourceEffectId: effect.id,
    });
    await assert.rejects(services.control.dispatch(runId, {
      type: "artifact",
      generation: laneSpoof.generation,
      artifact: laneSpoof,
      lane: "verifier",
    }), /requires trusted verifier Artifact authority/);
    assert.equal(Object.values((await services.control.snapshot(runId)).artifacts).some((artifact) => artifact.sourceEffectId === effect.id), false);

    assert.deepEqual(await services.journal.reconcile(runId), [effect.id]);
    const reconciled = await services.control.snapshot(runId);
    assert.equal(reconciled.effects[effect.id]?.status, "UNKNOWN");
    assert.equal(reconciled.effects[effect.id]?.artifactId, undefined);
    assert.equal(reconciled.effects[effect.id]?.verification, undefined);
    assert.equal(reconciled.completions[candidate.completionId]?.status, "PROPOSED");
  } finally {
    await Promise.allSettled([services.sandbox.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("reconcile adopts exactly one verifier-authority result Artifact after an after_artifact interruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-verifier-artifact-recovery-"));
  const runId = `VERIFIER-ARTIFACT-RECOVERY-${Date.now()}`;
  let injected = true;
  const services = createServicesForTesting(root, config, {
    effectFault: (point) => {
      if (injected && point === "after_artifact") {
        injected = false;
        throw new Error("injected:verifier-after-artifact");
      }
    },
  });
  const task = demoTask(runId, root, config);
  task.verification = { ...task.verification, required_reproductions: 1 };
  const harness: Harness = { root, runId, task, services };
  try {
    await services.control.createRun(runId, task);
    const candidate = await proposeCandidate(harness, "C-VERIFIER-RECOVERY", "PB{trusted_artifact_recovery}");
    const snapshot = await services.control.snapshot(runId);
    let executorCalls = 0;
    await assert.rejects(services.verifierTestHarness.executeWith(runId, {
      operation: "fixture_score",
      args: {
        runId,
        taskId: snapshot.task.task_id,
        generation: snapshot.generation,
        completionId: candidate.completionId,
        candidateHash: candidate.candidateHash,
        candidateArtifactId: candidate.artifactId,
        taskHash: snapshot.taskHash,
        targetHash: sha256(snapshot.task.target),
        verificationRuleHash: sha256(canonicalJson(snapshot.task.verification)),
        attempt: 1,
        attemptId: "trusted-artifact-recovery-attempt",
      },
      replayPolicy: "forbidden-replay",
      cwd: snapshot.task.scope.allowed_workspace,
      sessionId: "trusted-artifact-recovery-session",
    }, async () => {
      executorCalls += 1;
      return { stdout: JSON.stringify({ accepted: true, candidateHash: candidate.candidateHash }), stderr: "", exitCode: 0, durationMs: 1 };
    }), /injected:verifier-after-artifact/);
    assert.equal(executorCalls, 1);

    const interrupted = await services.control.snapshot(runId);
    const effect = Object.values(interrupted.effects).find((value) => value.operation === "fixture_score")!;
    const bound = Object.values(interrupted.artifacts).filter((artifact) => artifact.sourceEffectId === effect.id);
    assert.equal(effect.status, "STARTED");
    assert.equal(bound.length, 1);
    assert.equal(bound[0]?.origin.registeredBy, "verifier");

    assert.deepEqual(await services.journal.reconcile(runId), [effect.id]);
    const recovered = await services.control.snapshot(runId);
    assert.equal(recovered.effects[effect.id]?.status, "FINISHED");
    assert.equal(recovered.effects[effect.id]?.verification?.valid, true);
    assert.equal(recovered.effects[effect.id]?.verification?.accepted, true);
    assert.equal(Object.values(recovered.artifacts).filter((artifact) => artifact.sourceEffectId === effect.id).length, 1);
    assert.equal(executorCalls, 1, "recovery must adopt the durable trusted Artifact without executing again");
  } finally {
    await Promise.allSettled([services.sandbox.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("allowed-looking pwn output remains fail-closed without a task-owned transcript scorer", async () => {
  const verifierCommand = "trusted-pwn-verifier --task-bound-policy";
  const harness = await createHarness("PWN-FAIL-CLOSED", (task) => {
    task.target_kind = "pwn";
    task.verification = { kind: "reproduction", required_reproductions: 1, command: verifierCommand };
  });
  try {
    const candidate = await proposeCandidate(harness, "C-PWN-FAIL-CLOSED", "PB{allowed_looking_pwn_output}");
    const snapshot = await harness.services.control.snapshot(harness.runId);
    const effectResult = await harness.services.verifierTestHarness.executeWith(harness.runId, {
      operation: "pwn_reproduce",
      args: {
        runId: harness.runId,
        taskId: snapshot.task.task_id,
        generation: snapshot.generation,
        completionId: candidate.completionId,
        candidateHash: candidate.candidateHash,
        candidateArtifactId: candidate.artifactId,
        taskHash: snapshot.taskHash,
        targetHash: sha256(snapshot.task.target),
        verificationRuleHash: sha256(canonicalJson(snapshot.task.verification)),
        commandHash: sha256(verifierCommand),
        attempt: 1,
        attemptId: "pwn-fail-closed-attempt",
      },
      replayPolicy: "pure",
      command: verifierCommand,
      cwd: snapshot.task.scope.allowed_workspace,
      sessionId: "pwn-fail-closed-session",
    }, async () => ({
      stdout: "uid=0(root) gid=0(root)\nPB{allowed_looking_pwn_output}\n",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    }));

    const afterEffect = await harness.services.control.snapshot(harness.runId);
    const effect = afterEffect.effects[effectResult.effectId]!;
    assert.equal(effect.status, "FINISHED");
    assert.equal(effect.verification?.valid, false);
    assert.equal(effect.verification?.accepted, false);
    assert.equal(afterEffect.artifacts[effectResult.artifactId]?.origin.registeredBy, "verifier");
    await assert.rejects(harness.services.verifier.dispatch(harness.runId, {
      type: "evidence",
      evidence: {
        id: "EV-PWN-LOOKS-VALID",
        kind: "reproduction",
        summary: "A model-shaped pwn output must not become trusted reproduction Evidence.",
        source: {
          tool: "pwn_reproduce",
          effectId: effect.id,
          artifactId: effectResult.artifactId,
          generation: snapshot.generation,
        },
        confidence: 1,
        supports: [candidate.completionId],
        refutes: [],
      },
    }), /no valid structured verifier verdict/);
    const terminalCheck = await harness.services.control.snapshot(harness.runId);
    assert.equal(terminalCheck.evidence["EV-PWN-LOOKS-VALID"], undefined);
    assert.equal(terminalCheck.completions[candidate.completionId]?.status, "PROPOSED");
  } finally {
    await destroyHarness(harness);
  }
});

test("createRun is create-once and a duplicate runId cannot rewrite task or events", async () => {
  const harness = await createHarness("CREATE-ONCE");
  try {
    const taskPath = join(harness.services.runsRoot, harness.runId, "task.json");
    const eventsPath = join(harness.services.runsRoot, harness.runId, "events.jsonl");
    const beforeTask = await readFile(taskPath);
    const beforeEvents = await readFile(eventsPath);
    const beforeSnapshot = await harness.services.control.snapshot(harness.runId);
    const replacement: TaskContract = {
      ...harness.task,
      objective: "ATTEMPTED DUPLICATE-RUN CONTRACT REWRITE",
      success_criteria: ["must never replace the original task"],
    };

    await assert.rejects(harness.services.control.createRun(harness.runId, replacement));

    const afterTask = await readFile(taskPath);
    const afterEvents = await readFile(eventsPath);
    const afterSnapshot = await harness.services.control.snapshot(harness.runId);
    assert.equal(digest(afterTask), digest(beforeTask), "task.json bytes changed after rejected createRun");
    assert.equal(digest(afterEvents), digest(beforeEvents), "events.jsonl bytes changed after rejected createRun");
    assert.equal(afterSnapshot.taskHash, beforeSnapshot.taskHash);
    assert.equal(afterSnapshot.task.objective, harness.task.objective);
    assert.equal(afterSnapshot.lastSeq, beforeSnapshot.lastSeq);
  } finally {
    await destroyHarness(harness);
  }
});

test("raw JSONL writers cannot replace the Run anchor or append unvalidated domain events", async () => {
  const harness = await createHarness("RAW-STORE-ANCHOR");
  try {
    const store = new JsonlControlStore(harness.services.runsRoot);
    const eventsPath = join(harness.services.runsRoot, harness.runId, "events.jsonl");
    const projectionPath = join(harness.services.runsRoot, harness.runId, "projection.json");
    const beforeBytes = await readFile(eventsPath);
    const beforeProjection = await readFile(projectionPath);
    const snapshot = await harness.services.control.snapshot(harness.runId);
    const forged = makeEvent(
      harness.runId,
      snapshot.lastSeq + 1,
      "run_started",
      "orchestrator",
      "verifier",
      { taskHash: snapshot.taskHash, authorityHash: sha256("guessed-writer-secret"), generation: snapshot.generation },
    );

    await assert.rejects(store.append([forged], "guessed-writer-secret"), /write authority does not match/);
    const forgedProjection = structuredClone(snapshot);
    forgedProjection.authorityHash = sha256("guessed-writer-secret");
    forgedProjection.status = "SUCCEEDED";
    await assert.rejects(store.saveProjection(forgedProjection, "guessed-writer-secret"), /write authority does not match/);
    assert.throws(() => reduce(snapshot, forged), /run_started is immutable/);
    assert.equal(digest(await readFile(eventsPath)), digest(beforeBytes));
    assert.equal(digest(await readFile(projectionPath)), digest(beforeProjection));
    assert.equal((await harness.services.control.snapshot(harness.runId)).authorityHash, snapshot.authorityHash);
  } finally {
    await destroyHarness(harness);
  }
});

test("agent annotations cannot erase immutable investigation classification or clear curation pending", async () => {
  const harness = await createHarness("CURATION-ORIGIN");
  try {
    const gate = new EvidenceCurationGate(harness.runId, harness.services.control);
    const artifactIds: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const artifact = await harness.services.artifacts.putText(harness.runId, `unique observation ${index}`, {
        filename: `read-${index}.txt`,
        mime: "text/plain",
        semantic: {
          name: `Read result ${index}`,
          summary: `Uncurated investigation result ${index}`,
          tags: ["read", "file-content"],
          role: "intermediate",
          relatedIds: [],
          annotatedBy: "harness",
        },
      });
      artifactIds.push(artifact.id);
    }
    assert.equal((await gate.inspect()).pendingCount, 8);

    for (const artifactId of artifactIds) {
      await harness.services.control.dispatch(harness.runId, {
        type: "artifact_annotation",
        artifactId,
        semantic: {
          name: "Viewed output",
          summary: "Agent viewed this output and attempted to remove its investigation tags.",
          tags: [],
          role: "debug",
          relatedIds: [],
          annotatedBy: "agent",
        },
        lane: "executor",
      });
    }

    const snapshot = await harness.services.control.snapshot(harness.runId);
    for (const artifactId of artifactIds) {
      assert.ok(snapshot.artifacts[artifactId]?.origin.tags.includes("read"));
    }
    const after = await gate.inspect();
    assert.equal(after.stage, "required");
    assert.equal(after.pendingCount, 8);
    assert.equal(after.viewedCount, 8);
    const notice = await gate.assertInvestigationAllowed();
    assert.match(notice ?? "", /当前探索仍可继续/);
    assert.match(notice ?? "", /evidence record/i);
  } finally {
    await destroyHarness(harness);
  }
});

test("fixture reset requires FixtureControl authority and refuses terminal runs", async () => {
  const harness = await createHarness("FIXTURE-RESET");
  try {
    await assert.rejects(harness.services.control.dispatch(harness.runId, {
      type: "fixture_reset",
      generation: 1,
      lane: "executor",
    }));
    assert.equal((await harness.services.control.snapshot(harness.runId)).generation, 0);

    await harness.services.fixtureControl.reset(harness.runId, 1);
    assert.equal((await harness.services.control.snapshot(harness.runId)).generation, 1);
    await harness.services.control.dispatch(harness.runId, {
      type: "fail",
      reason: "terminal reset regression",
      category: "verification_missing",
    });
    await assert.rejects(harness.services.fixtureControl.reset(harness.runId, 2));
    const terminal = await harness.services.control.snapshot(harness.runId);
    assert.equal(terminal.status, "FAILED");
    assert.equal(terminal.generation, 1);
  } finally {
    await destroyHarness(harness);
  }
});

test("submission budget counts submissions across every fixture generation in the run", async () => {
  const harness = await createHarness("CROSS-GEN-BUDGET", (task) => {
    task.verification = { kind: "platform_submission", required_reproductions: 1 };
    task.constraints = { ...task.constraints, max_submissions: 1 };
  });
  const runtime = new ProofBladeToolRuntime(
    harness.runId,
    {
      fixtureId: harness.runId,
      generation: 0,
      path: harness.root,
      privatePath: join(harness.root, ".proofblade"),
    },
    harness.services.runsRoot,
    harness.services.control,
    harness.services.artifacts,
    harness.services.journal,
    harness.root,
    { includeMcp: false },
  );
  try {
    const first = await runtime.submitCandidate("PB{generation_zero_submission}");
    await harness.services.fixtureControl.reset(harness.runId, 1);
    await assert.rejects(runtime.submitCandidate("PB{generation_one_submission}"), /Submission budget exhausted/);

    const snapshot = await harness.services.control.snapshot(harness.runId);
    const submissions = Object.values(snapshot.completions).filter((item) => item.purpose === "submission");
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]?.id, first.completionId);
    assert.equal(submissions[0]?.generation, 0);
    assert.equal(snapshot.generation, 1);
  } finally {
    await Promise.allSettled([runtime.close()]);
    await destroyHarness(harness);
  }
});

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
