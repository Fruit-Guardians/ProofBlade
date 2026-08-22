import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "../src/config.js";
import type { Evidence, RawEffectResult } from "../src/domain/types.js";
import { canonicalJson, sha256 } from "../src/domain/utils.js";
import { createServicesForTesting, demoTask, type TestAppServices } from "../src/app/demo.js";
import { createEffectInput } from "../src/control/control-store.js";
import { makeEvent } from "../src/storage/jsonl-store.js";

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
      contextWindow: 4096,
      maxTokens: 512,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      input: ["text"],
    },
  },
};

type EvidenceInput = Omit<Evidence, "createdSeq" | "provenance">;

interface Harness {
  root: string;
  runId: string;
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

async function createHarness(label: string, requiredReproductions = 2): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `proofblade-evidence-${label}-`));
  const runId = `EVIDENCE-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const services = createServicesForTesting(root, config);
  const task = demoTask(runId, root, config);
  task.verification = { ...task.verification, required_reproductions: requiredReproductions };
  await services.control.createRun(runId, task);
  return { root, runId, services };
}

async function destroyHarness(harness: Harness): Promise<void> {
  await Promise.allSettled([harness.services.sandbox.close()]);
  await rm(harness.root, { recursive: true, force: true });
}

async function putArtifact(harness: Harness, content: string, filename: string) {
  return await harness.services.artifacts.putText(harness.runId, content, {
    filename,
    mime: "text/plain",
    sensitivity: "public",
  });
}

async function proposeCandidate(harness: Harness, completionId: string, candidate: string): Promise<CandidateRef> {
  const artifact = await putArtifact(harness, candidate, `${completionId}.txt`);
  const candidateHash = sha256(candidate);
  await harness.services.control.dispatch(harness.runId, {
    type: "completion_proposed",
    completion: { id: completionId, candidateHash, artifactId: artifact.id, purpose: "harness_verification" },
    lane: "executor",
  });
  return { completionId, candidateHash, artifactId: artifact.id };
}

async function runFakeEffect(harness: Harness, operation: string, attempt: number): Promise<EffectRef> {
  const result = await harness.services.journal.executeWith(
    harness.runId,
    { operation, args: { attempt }, replayPolicy: "pure" },
    async (): Promise<RawEffectResult> => ({
      stdout: `fake ${operation} result ${attempt}`,
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    }),
  );
  return { effectId: result.effectId, artifactId: result.artifactId };
}

async function runFakeVerifierEffect(harness: Harness, candidate: CandidateRef, attempt: number, accepted = true): Promise<EffectRef> {
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
        attemptId: `${harness.runId}:${candidate.completionId}:attempt-${attempt}`,
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

function evidenceInput(input: Partial<EvidenceInput> & Pick<EvidenceInput, "id" | "source">): EvidenceInput {
  return {
    kind: "observation",
    summary: `Evidence ${input.id}`,
    confidence: 0.5,
    supports: [],
    refutes: [],
    ...input,
  };
}

function verifierEvidence(
  id: string,
  candidate: CandidateRef,
  effect: EffectRef,
  generation: number,
  kind: "reproduction" | "negative" = "reproduction",
): EvidenceInput {
  return evidenceInput({
    id,
    kind,
    summary: `${kind} ${id} for ${candidate.completionId}`,
    source: {
      tool: "fixture_score",
      effectId: effect.effectId,
      artifactId: effect.artifactId,
      generation,
    },
    confidence: 1,
    supports: kind === "reproduction" ? [candidate.completionId] : [],
    refutes: kind === "negative" ? [candidate.completionId] : [],
  });
}

async function acceptCandidate(harness: Harness, completionId: string, candidateText: string, attemptBase: number) {
  const candidate = await proposeCandidate(harness, completionId, candidateText);
  const first = await runFakeVerifierEffect(harness, candidate, attemptBase);
  const second = await runFakeVerifierEffect(harness, candidate, attemptBase + 1);
  const generation = (await harness.services.control.snapshot(harness.runId)).generation;
  const evidenceIds = [`EV-${completionId}-1`, `EV-${completionId}-2`];
  await harness.services.verifier.dispatchBatch(harness.runId, [
    { type: "evidence", evidence: verifierEvidence(evidenceIds[0]!, candidate, first, generation) },
    { type: "evidence", evidence: verifierEvidence(evidenceIds[1]!, candidate, second, generation) },
    { type: "completion_verified", completionId, accepted: true, evidenceIds },
  ]);
  return { candidate, evidenceIds };
}

test("public callers cannot forge verifier authority by spelling lane=verifier", async () => {
  const harness = await createHarness("AUTHORITY");
  try {
    const candidate = await proposeCandidate(harness, "C-AUTH", "authority-candidate");
    const beforeVerifier = await harness.services.control.snapshot(harness.runId);
    await assert.rejects(
      harness.services.journal.executeWith(harness.runId, {
        operation: "fixture_score",
        args: {
          runId: harness.runId,
          taskId: beforeVerifier.task.task_id,
          generation: beforeVerifier.generation,
          completionId: candidate.completionId,
          candidateHash: candidate.candidateHash,
          candidateArtifactId: candidate.artifactId,
          taskHash: beforeVerifier.taskHash,
          targetHash: sha256(beforeVerifier.task.target),
          verificationRuleHash: sha256(canonicalJson(beforeVerifier.task.verification)),
          attemptId: "ordinary-lane-forgery",
        },
        replayPolicy: "pure",
        cwd: beforeVerifier.task.scope.allowed_workspace,
        sessionId: "ordinary-lane-forgery",
      }, async () => ({ stdout: "should not execute", stderr: "", exitCode: 0, durationMs: 1 })),
      /requires trusted verifier authority/,
    );
    await assert.rejects(
      (harness.services.verifier as unknown as { dispatch(runId: string, command: unknown): Promise<unknown> }).dispatch(harness.runId, {
        type: "effect_proposed",
        effect: { id: "EF-RESULT-PORT-FORGERY" },
      }),
      /only accepts Evidence, Completion, Fact/,
    );
    const effect = await runFakeVerifierEffect(harness, candidate, 1);
    const generation = (await harness.services.control.snapshot(harness.runId)).generation;

    await assert.rejects(
      harness.services.control.dispatch(harness.runId, {
        type: "evidence",
        evidence: verifierEvidence("EV-FORGED", candidate, effect, generation),
        lane: "verifier",
      }),
      /trusted verifier service/,
    );
    await assert.rejects(
      harness.services.control.dispatch(harness.runId, {
        type: "completion_verified",
        completionId: candidate.completionId,
        accepted: true,
        evidenceIds: [],
        lane: "verifier",
      }),
      /trusted verifier service/,
    );
    await assert.rejects(
      harness.services.control.dispatch(harness.runId, {
        type: "finish",
        verified: true,
        completionId: candidate.completionId,
        evidenceIds: [],
        reason: "forged finish",
        lane: "verifier",
      }),
      /trusted verifier service/,
    );

    const snapshot = await harness.services.control.snapshot(harness.runId);
    assert.equal(snapshot.evidence["EV-FORGED"], undefined);
    assert.equal(snapshot.completions[candidate.completionId]?.status, "PROPOSED");
    assert.equal(snapshot.status, "READY");
  } finally {
    await destroyHarness(harness);
  }
});

test("evidence confidence is finite, bounded, and confidence=1 requires verifier authority", async () => {
  const harness = await createHarness("CONFIDENCE");
  try {
    const artifact = await putArtifact(harness, "confidence source", "confidence.txt");
    const generation = (await harness.services.control.snapshot(harness.runId)).generation;
    const source = { tool: "fixture_read", artifactId: artifact.id, generation };
    const candidate = await proposeCandidate(harness, "C-CONFIDENCE", "confidence-candidate");
    const verifierEffect = await runFakeVerifierEffect(harness, candidate, 1);
    const verifierSource = { tool: "fixture_score", effectId: verifierEffect.effectId, artifactId: verifierEffect.artifactId, generation };

    await harness.services.control.dispatch(harness.runId, {
      type: "evidence",
      evidence: evidenceInput({ id: "EV-CONF-0", source, confidence: 0 }),
      lane: "executor",
    });
    await harness.services.verifier.dispatch(harness.runId, {
      type: "evidence",
      evidence: evidenceInput({ id: "EV-CONF-1", source: verifierSource, confidence: 1, supports: [candidate.completionId] }),
    });
    await harness.services.control.dispatch(harness.runId, {
      type: "evidence",
      evidence: evidenceInput({ id: "EV-CONF-LABEL", source, confidence: 0.5 }),
      lane: "verifier",
    });
    await assert.rejects(
      harness.services.control.dispatch(harness.runId, {
        type: "evidence",
        evidence: evidenceInput({ id: "EV-CONF-FORGED-1", source: verifierSource, confidence: 1 }),
        lane: "executor",
      }),
      /trusted verifier service/,
    );

    for (const [suffix, confidence] of [
      ["NEG", -0.001],
      ["OVER", 1.001],
      ["NAN", Number.NaN],
      ["POS-INF", Number.POSITIVE_INFINITY],
      ["NEG-INF", Number.NEGATIVE_INFINITY],
    ] as const) {
      await assert.rejects(
        harness.services.control.dispatch(harness.runId, {
          type: "evidence",
          evidence: evidenceInput({ id: `EV-CONF-${suffix}`, source, confidence }),
          lane: "executor",
        }),
        /finite number in the range 0\.\.1/,
      );
    }

    const snapshot = await harness.services.control.snapshot(harness.runId);
    assert.equal(snapshot.evidence["EV-CONF-0"]?.confidence, 0);
    assert.equal(snapshot.evidence["EV-CONF-1"]?.confidence, 1);
    assert.equal(snapshot.evidence["EV-CONF-1"]?.provenance.recordedBy, "verifier");
    assert.equal(snapshot.evidence["EV-CONF-LABEL"]?.provenance.recordedBy, "agent", "a caller-controlled lane label must not attest verifier provenance");
    assert.equal(Object.keys(snapshot.evidence).length, 3);
  } finally {
    await destroyHarness(harness);
  }
});

test("evidence rejects dangling, duplicate, and cross-generation references without mutation", async () => {
  const harness = await createHarness("REFERENCES");
  try {
    const artifact = await putArtifact(harness, "reference source", "references.txt");
    const candidate = await proposeCandidate(harness, "C-REF", "reference-candidate");
    const generation = (await harness.services.control.snapshot(harness.runId)).generation;
    const source = { tool: "fixture_read", artifactId: artifact.id, generation };

    await assert.rejects(
      harness.services.control.dispatch(harness.runId, {
        type: "evidence",
        evidence: evidenceInput({ id: "EV-DANGLING-DEP", source, dependsOn: ["EV-MISSING"] }),
      }),
      /Unknown evidence dependency EV-MISSING/,
    );
    await assert.rejects(
      harness.services.control.dispatch(harness.runId, {
        type: "evidence",
        evidence: evidenceInput({ id: "EV-DANGLING-SUPPORT", source, supports: ["C-MISSING"] }),
      }),
      /Unknown support references: C-MISSING/,
    );
    await assert.rejects(
      harness.services.control.dispatch(harness.runId, {
        type: "evidence",
        evidence: evidenceInput({ id: "EV-DANGLING-REFUTE", source, refutes: ["H-MISSING"] }),
      }),
      /Unknown refute references: H-MISSING/,
    );
    await assert.rejects(
      harness.services.control.dispatch(harness.runId, {
        type: "evidence",
        evidence: evidenceInput({ id: "EV-DUP-SUPPORT", source, supports: [candidate.completionId, candidate.completionId] }),
      }),
      /supports must not contain duplicates/,
    );

    await harness.services.control.dispatch(harness.runId, {
      type: "evidence",
      evidence: evidenceInput({ id: "EV-OLD", source, supports: [candidate.completionId] }),
      lane: "executor",
    });
    await assert.rejects(
      harness.services.control.dispatch(harness.runId, {
        type: "evidence",
        evidence: evidenceInput({ id: "EV-OLD", source, summary: "attempted overwrite" }),
      }),
      /Evidence already exists: EV-OLD/,
    );

    await harness.services.fixtureControl.reset(harness.runId, 1);
    await assert.rejects(
      harness.services.fixtureControl.reset(harness.runId, 1),
      /increase monotonically/,
    );
    await assert.rejects(
      harness.services.fixtureControl.reset(harness.runId, 0),
      /increase monotonically/,
    );
    const currentArtifact = await putArtifact(harness, "new generation source", "generation-1.txt");
    const currentSource = { tool: "fixture_read", artifactId: currentArtifact.id, generation: 1 };
    await assert.rejects(
      harness.services.control.dispatch(harness.runId, {
        type: "evidence",
        evidence: evidenceInput({ id: "EV-CROSS-DEP", source: currentSource, dependsOn: ["EV-OLD"] }),
      }),
      /dependency EV-OLD is from another run or generation/,
    );
    await assert.rejects(
      harness.services.control.dispatch(harness.runId, {
        type: "evidence",
        evidence: evidenceInput({ id: "EV-CROSS-SUPPORT", source: currentSource, supports: [candidate.completionId] }),
      }),
      /Unknown support references: C-REF/,
    );
    await assert.rejects(
      harness.services.control.dispatch(harness.runId, {
        type: "evidence",
        evidence: evidenceInput({
          id: "EV-CROSS-ARTIFACT",
          source: { tool: "fixture_read", artifactId: artifact.id, generation: 1 },
        }),
      }),
      /artifact .* is from another run or generation/,
    );

    const snapshot = await harness.services.control.snapshot(harness.runId);
    assert.equal(snapshot.evidence["EV-OLD"]?.summary, "Evidence EV-OLD");
    assert.equal(Object.keys(snapshot.evidence).length, 1);
  } finally {
    await destroyHarness(harness);
  }
});

test("evidence source effect must be finished and exactly bound to its artifact and operation", async () => {
  const harness = await createHarness("EFFECT-BINDING");
  try {
    const completed = await runFakeEffect(harness, "fake_inspect", 1);
    const standalone = await putArtifact(harness, "unrelated", "unrelated.txt");
    const generation = (await harness.services.control.snapshot(harness.runId)).generation;

    await harness.services.control.dispatch(harness.runId, {
      type: "evidence",
      evidence: evidenceInput({
        id: "EV-EFFECT-VALID",
        source: {
          tool: "fake_inspect",
          effectId: completed.effectId,
          artifactId: completed.artifactId,
          generation,
        },
        confidence: 0.9,
      }),
      lane: "executor",
    });
    await assert.rejects(
      harness.services.control.dispatch(harness.runId, {
        type: "evidence",
        evidence: evidenceInput({
          id: "EV-EFFECT-UNKNOWN",
          source: { tool: "fake_inspect", effectId: "EF-MISSING", artifactId: standalone.id, generation },
        }),
      }),
      /Unknown evidence effect EF-MISSING/,
    );
    await assert.rejects(
      harness.services.control.dispatch(harness.runId, {
        type: "evidence",
        evidence: evidenceInput({
          id: "EV-EFFECT-WRONG-PRIMARY",
          source: {
            tool: "fake_inspect",
            effectId: completed.effectId,
            artifactId: standalone.id,
            artifactIds: [completed.artifactId],
            generation,
          },
        }),
      }),
      /Primary evidence artifact must equal effect artifact/,
    );
    await assert.rejects(
      harness.services.control.dispatch(harness.runId, {
        type: "evidence",
        evidence: evidenceInput({
          id: "EV-EFFECT-WRONG-TOOL",
          source: {
            tool: "different_operation",
            effectId: completed.effectId,
            artifactId: completed.artifactId,
            generation,
          },
        }),
      }),
      /Evidence tool must equal effect operation fake_inspect/,
    );

    const pendingArgs = {};
    await harness.services.control.dispatch(harness.runId, {
      type: "effect_proposed",
      effect: {
        id: "EF-UNFINISHED",
        idempotencyKey: createEffectInput(harness.runId, "fake_pending", pendingArgs, "pure", generation).idempotencyKey,
        replayPolicy: "pure",
        operation: "fake_pending",
        args: pendingArgs,
        status: "PROPOSED",
      },
      lane: "executor",
    });
    await harness.services.control.dispatch(harness.runId, { type: "effect_started", effectId: "EF-UNFINISHED", lane: "executor" });
    const pendingArtifact = await harness.services.artifacts.putText(harness.runId, "pending", {
      filename: "pending.txt",
      sourceEffectId: "EF-UNFINISHED",
    });
    await assert.rejects(
      harness.services.control.dispatch(harness.runId, {
        type: "evidence",
        evidence: evidenceInput({
          id: "EV-EFFECT-UNFINISHED",
          source: {
            tool: "fake_pending",
            effectId: "EF-UNFINISHED",
            artifactId: pendingArtifact.id,
            generation,
          },
        }),
      }),
      /effect EF-UNFINISHED is not FINISHED/,
    );

    const snapshot = await harness.services.control.snapshot(harness.runId);
    assert.deepEqual(Object.keys(snapshot.evidence), ["EV-EFFECT-VALID"]);
    assert.equal(snapshot.evidence["EV-EFFECT-VALID"]?.provenance.effect?.id, completed.effectId);
  } finally {
    await destroyHarness(harness);
  }
});

test("completion verification rejects empty, unknown, wrong-kind, insufficient, duplicate, and terminal-overwrite evidence", async () => {
  const harness = await createHarness("COMPLETION", 2);
  try {
    const candidate = await proposeCandidate(harness, "C-COMP", "completion-candidate");

    await assert.rejects(
      harness.services.verifier.dispatch(harness.runId, {
        type: "completion_verified",
        completionId: "C-MISSING",
        accepted: true,
        evidenceIds: [],
      }),
      /Unknown completion C-MISSING/,
    );
    await assert.rejects(
      harness.services.verifier.dispatch(harness.runId, {
        type: "completion_verified",
        completionId: candidate.completionId,
        accepted: true,
        evidenceIds: [],
      }),
      /Completion verification requires evidence/,
    );
    await assert.rejects(
      harness.services.verifier.dispatch(harness.runId, {
        type: "completion_verified",
        completionId: candidate.completionId,
        accepted: true,
        evidenceIds: ["EV-MISSING"],
      }),
      /Unknown completion evidence EV-MISSING/,
    );

    const first = await runFakeVerifierEffect(harness, candidate, 1);
    const generation = (await harness.services.control.snapshot(harness.runId)).generation;
    await harness.services.verifier.dispatch(harness.runId, {
      type: "evidence",
      evidence: evidenceInput({
        id: "EV-WRONG-KIND",
        kind: "observation",
        source: { tool: "fixture_score", effectId: first.effectId, artifactId: first.artifactId, generation },
        confidence: 0.9,
        supports: [candidate.completionId],
      }),
    });
    await assert.rejects(
      harness.services.verifier.dispatch(harness.runId, {
        type: "completion_verified",
        completionId: candidate.completionId,
        accepted: true,
        evidenceIds: ["EV-WRONG-KIND"],
      }),
      /not bound to completion|must all be reproduction evidence/,
    );

    await harness.services.verifier.dispatch(harness.runId, {
      type: "evidence",
      evidence: verifierEvidence("EV-COMP-1", candidate, first, generation),
    });
    await assert.rejects(
      harness.services.verifier.dispatch(harness.runId, {
        type: "completion_verified",
        completionId: candidate.completionId,
        accepted: true,
        evidenceIds: ["EV-COMP-1", "EV-COMP-1"],
      }),
      /evidence ids must not contain duplicates/,
    );
    await assert.rejects(
      harness.services.verifier.dispatch(harness.runId, {
        type: "completion_verified",
        completionId: candidate.completionId,
        accepted: true,
        evidenceIds: ["EV-COMP-1"],
      }),
      /requires 2 independent reproduction effects/,
    );
    assert.equal((await harness.services.control.snapshot(harness.runId)).completions[candidate.completionId]?.status, "PROPOSED");

    const second = await runFakeVerifierEffect(harness, candidate, 2);
    await harness.services.verifier.dispatchBatch(harness.runId, [
      { type: "evidence", evidence: verifierEvidence("EV-COMP-2", candidate, second, generation) },
      {
        type: "completion_verified",
        completionId: candidate.completionId,
        accepted: true,
        evidenceIds: ["EV-COMP-1", "EV-COMP-2"],
      },
    ]);
    assert.equal((await harness.services.control.snapshot(harness.runId)).completions[candidate.completionId]?.status, "ACCEPTED");

    for (const accepted of [true, false]) {
      await assert.rejects(
        harness.services.verifier.dispatch(harness.runId, {
          type: "completion_verified",
          completionId: candidate.completionId,
          accepted,
          evidenceIds: ["EV-COMP-1", "EV-COMP-2"],
        }),
        /already ACCEPTED/,
      );
    }
    const snapshot = await harness.services.control.snapshot(harness.runId);
    assert.equal(snapshot.completions[candidate.completionId]?.status, "ACCEPTED");
    assert.deepEqual(snapshot.completions[candidate.completionId]?.evidenceIds, ["EV-COMP-1", "EV-COMP-2"]);

    const rejectedCandidate = await proposeCandidate(harness, "C-REJECTED", "rejected-candidate");
    const rejectedEffect = await runFakeVerifierEffect(harness, rejectedCandidate, 99, false);
    const rejectedEvidenceId = "EV-COMP-NEGATIVE";
    await harness.services.verifier.dispatchBatch(harness.runId, [
      { type: "evidence", evidence: verifierEvidence(rejectedEvidenceId, rejectedCandidate, rejectedEffect, generation, "negative") },
      { type: "completion_verified", completionId: rejectedCandidate.completionId, accepted: false, evidenceIds: [rejectedEvidenceId] },
    ]);
    assert.equal((await harness.services.control.snapshot(harness.runId)).completions[rejectedCandidate.completionId]?.status, "REJECTED");
    for (const accepted of [false, true]) {
      await assert.rejects(
        harness.services.verifier.dispatch(harness.runId, { type: "completion_verified", completionId: rejectedCandidate.completionId, accepted, evidenceIds: [rejectedEvidenceId] }),
        /already REJECTED/,
      );
    }
  } finally {
    await destroyHarness(harness);
  }
});

test("finish binds the explicit accepted completion and exact evidence set", async () => {
  const harness = await createHarness("FINISH", 2);
  try {
    const first = await acceptCandidate(harness, "C-FIRST", "candidate-first", 1);
    const second = await acceptCandidate(harness, "C-SECOND", "candidate-second", 101);

    await assert.rejects(
      harness.services.verifier.finish(harness.runId, { completionId: "C-MISSING", reason: "unknown" }),
      /Unknown completion C-MISSING/,
    );
    await assert.rejects(
      harness.services.verifier.dispatch(harness.runId, {
        type: "finish",
        verified: true,
        completionId: second.candidate.completionId,
        evidenceIds: first.evidenceIds,
        reason: "mismatched evidence",
      }),
      /only accepts Evidence, Completion, Fact/,
    );

    await harness.services.verifier.finish(harness.runId, {
      completionId: second.candidate.completionId,
      reason: "explicit second completion",
    });
    const snapshot = await harness.services.control.snapshot(harness.runId);
    assert.equal(snapshot.status, "SUCCEEDED");
    assert.equal(snapshot.finalResult?.completionId, second.candidate.completionId);
    assert.equal(snapshot.finalResult?.candidateHash, second.candidate.candidateHash);
    assert.equal(snapshot.finalResult?.artifactId, second.candidate.artifactId);
    assert.deepEqual(snapshot.finalResult?.evidenceIds, second.evidenceIds);
    assert.notEqual(snapshot.finalResult?.completionId, first.candidate.completionId);

    const finishEvent = (await harness.services.control.events(harness.runId)).findLast((event) => event.type === "run_finished");
    assert.equal(finishEvent?.payload.completionId, second.candidate.completionId);
    assert.equal(finishEvent?.payload.candidateHash, second.candidate.candidateHash);
    assert.deepEqual(finishEvent?.payload.evidenceIds, second.evidenceIds);
  } finally {
    await destroyHarness(harness);
  }
});

test("raw append rejects projection-changing evidence events while telemetry remains appendable", async () => {
  const harness = await createHarness("RAW-APPEND");
  try {
    const before = await harness.services.control.snapshot(harness.runId);
    const beforeEvents = (await harness.services.control.events(harness.runId)).length;
    await assert.rejects(
      harness.services.control.append(harness.runId, [{
        schemaVersion: 1,
        lane: "verifier",
        correlationId: `${harness.runId}:forged`,
        actor: "orchestrator",
        type: "evidence_added",
        payload: {
          evidence: {
            id: "EV-RAW-FORGED",
            kind: "reproduction",
            summary: "raw append bypass",
            source: { generation: 0 },
            confidence: 1,
            supports: [],
            refutes: [],
          },
        },
      }]),
      /Raw append is restricted to telemetry events/,
    );
    assert.equal((await harness.services.control.snapshot(harness.runId)).evidence["EV-RAW-FORGED"], undefined);
    assert.equal((await harness.services.control.events(harness.runId)).length, beforeEvents);
    assert.equal((await harness.services.control.snapshot(harness.runId)).lastSeq, before.lastSeq);

    await harness.services.control.append(harness.runId, [{
      schemaVersion: 1,
      lane: "executor",
      correlationId: `${harness.runId}:telemetry`,
      actor: "orchestrator",
      type: "turn_started",
      payload: { test: true },
    }]);
    assert.equal((await harness.services.control.events(harness.runId)).length, beforeEvents + 1);
  } finally {
    await destroyHarness(harness);
  }
});

test("pwn verifier effects bind task command, endpoint tuple, workspace, and harness-owned rules", async () => {
  const harness = await createHarness("PWN-BINDING", 1);
  try {
    const task = (await harness.services.control.snapshot(harness.runId)).task;
    task.target_kind = "pwn";
    task.target = "REMOTE:pwn.example:31337";
    task.verification.command = "node trusted-pwn-verifier.mjs";
    task.scope.external_network = true;
    task.scope.allowed_hosts = ["pwn.example", "decoy.example"];
    task.scope.allowed_ports = [31337, 4444];
    task.scope.allowed_endpoints = [{ host: "pwn.example", port: 31337 }, { host: "decoy.example", port: 4444 }];
    // Recreate this isolated run so the immutable task hash contains the pwn policy.
    await rm(join(harness.root, "runs", harness.runId), { recursive: true, force: true });
    await harness.services.control.createRun(harness.runId, task);
    const candidate = await proposeCandidate(harness, "C-PWN", "flag{pwn_binding}");
    const snapshot = await harness.services.control.snapshot(harness.runId);
    const command = task.verification.command;
    const args = {
      runId: harness.runId,
      taskId: task.task_id,
      generation: snapshot.generation,
      completionId: candidate.completionId,
      candidateHash: candidate.candidateHash,
      candidateArtifactId: candidate.artifactId,
      taskHash: snapshot.taskHash,
      targetHash: sha256(task.target),
      verificationRuleHash: sha256(canonicalJson(task.verification)),
      commandHash: sha256(command),
    };
    const effect = (id: string, extraArgs: Record<string, unknown>, cwd = task.scope.allowed_workspace) => {
      const effectArgs = { ...args, attemptId: `ATTEMPT-${id}`, ...extraArgs };
      return {
        replayPolicy: "manual" as const,
        operation: "pwn_reproduce",
        args: effectArgs,
        command,
        cwd,
        sessionId: `SESSION-${id}`,
      };
    };
    const fakePwnResult = async (): Promise<RawEffectResult> => ({ stdout: "not trusted", stderr: "", exitCode: 0, durationMs: 1 });

    await assert.rejects(
      harness.services.verifierTestHarness.executeWith(harness.runId, effect("EF-PWN-MISSING-ENDPOINT", {}), fakePwnResult),
      /requires a task-bound endpoint tuple/,
    );
    await assert.rejects(
      harness.services.verifierTestHarness.executeWith(harness.runId, effect("EF-PWN-CROSS", { endpoint: { host: "pwn.example", port: 4444 } }), fakePwnResult),
      /endpoint is outside task scope/,
    );
    await assert.rejects(
      harness.services.verifierTestHarness.executeWith(harness.runId, effect("EF-PWN-RULE", { endpoint: { host: "pwn.example", port: 31337 }, flagRegex: "flag\\{.*\\}" }), fakePwnResult),
      /target, rules, and stages cannot be supplied by the model/,
    );
    await assert.rejects(
      harness.services.verifierTestHarness.executeWith(harness.runId, effect("EF-PWN-TARGET", { endpoint: { host: "pwn.example", port: 31337 }, target: "model-selected", stages: ["shell"] }), fakePwnResult),
      /target, rules, and stages cannot be supplied by the model/,
    );
    await assert.rejects(
      harness.services.verifierTestHarness.executeWith(harness.runId, effect("EF-PWN-CWD", { endpoint: { host: "pwn.example", port: 31337 } }, join(harness.root, "outside")), fakePwnResult),
      /cwd escapes allowed_workspace/,
    );
    assert.equal(Object.keys((await harness.services.control.snapshot(harness.runId)).effects).length, 0);
  } finally {
    await destroyHarness(harness);
  }
});

test("legacy durable projections replay but unverifiable success is downgraded fail-closed", async () => {
  const harness = await createHarness("LEGACY-REPLAY", 1);
  try {
    const candidate = await proposeCandidate(harness, "C-LEGACY", "legacy-candidate");
    const eventsPath = join(harness.root, "runs", harness.runId, "events.jsonl");
    const events = (await harness.services.control.events(harness.runId)).map((event) => structuredClone(event));
    for (const event of events) {
      if (event.type === "artifact_registered") {
        const artifact = event.payload.artifact as Record<string, unknown>;
        delete artifact.runId;
        delete artifact.generation;
        delete artifact.origin;
      }
      if (event.type === "completion_proposed") {
        const completion = event.payload.completion as Record<string, unknown>;
        delete completion.runId;
        delete completion.generation;
        delete completion.purpose;
      }
    }
    events.push(makeEvent(harness.runId, events.length + 1, "run_finished", "orchestrator", "verifier", {
      status: "SUCCEEDED",
      verified: true,
      evidenceIds: ["EV-LEGACY-UNBOUND"],
      reason: "legacy unbound success",
    }));
    await writeFile(eventsPath, events.map((event) => `${canonicalJson(event)}\n`).join(""), "utf8");

    const replayed = await harness.services.control.snapshot(harness.runId);
    assert.equal(replayed.artifacts[candidate.artifactId]?.origin.schemaVersion, 1);
    assert.equal(replayed.completions[candidate.completionId]?.purpose, "legacy_unclassified");
    assert.equal(replayed.status, "NEED_HUMAN");
    assert.equal(replayed.failureCategory, "verification_missing");
    assert.equal(replayed.finalResult, undefined);
  } finally {
    await destroyHarness(harness);
  }
});

test("task contract mutation is rejected by the immutable run-start hash", async () => {
  const harness = await createHarness("TASK-HASH");
  try {
    const taskPath = join(harness.root, "runs", harness.runId, "task.json");
    const task = JSON.parse(await readFile(taskPath, "utf8")) as Record<string, unknown>;
    task.target = "TAMPERED_AFTER_RUN_START";
    await writeFile(taskPath, `${JSON.stringify(task)}\n`, "utf8");
    await assert.rejects(
      harness.services.control.snapshot(harness.runId),
      /Task contract hash does not match the immutable run anchor/,
    );
  } finally {
    await destroyHarness(harness);
  }
});
