import { join } from "node:path";
import type { ControlStore, VerifierControlPort } from "../control/control-store.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { VerifierEffectJournal } from "../effects/effect-journal.js";
import type { FixtureRef } from "../sandbox/fixture.js";
import type { RunSnapshot } from "../domain/types.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";

export interface VerificationOutcome {
  completionId: string;
  accepted: boolean;
  candidate: string;
  candidateHash: string;
  evidenceIds: string[];
  factId?: string;
}

export class IndependentVerifier {
  public constructor(
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
    private readonly journal: VerifierEffectJournal,
    private readonly runsRoot: string,
    private readonly verifierControl: VerifierControlPort,
  ) {}

  public async verify(runId: string, fixture: FixtureRef, completionId?: string, signal?: AbortSignal): Promise<VerificationOutcome> {
    const snapshot = await this.controlStore.snapshot(runId);
    await ensureVerifierActive(this.controlStore, runId, signal);
    const completion = completionId
      ? snapshot.completions[completionId]
      : Object.values(snapshot.completions).filter((item) => item.status === "PROPOSED").sort((a, b) => b.createdSeq - a.createdSeq)[0];
    if (!completion) throw new Error("No completion proposal is waiting for verification");
    if (completion.runId !== runId || completion.generation !== snapshot.generation) throw new Error(`Completion ${completion.id} is from another run or generation`);
    const artifact = snapshot.artifacts[completion.artifactId];
    if (!artifact) throw new Error(`Candidate artifact is missing: ${completion.artifactId}`);
    const candidate = (await this.artifactStore.readText(runId, artifact)).trim();
    if (sha256(candidate) !== completion.candidateHash) throw new Error(`Candidate hash mismatch: ${completion.id}`);
    if (completion.status !== "PROPOSED") return durableTerminalOutcome(snapshot, completion, candidate);
    const platformSubmission = snapshot.task.verification.kind === "platform_submission";
    const verificationRequest = platformSubmission
      ? completion.verificationKey
        ? Object.values(snapshot.verificationRequests).find((request) => request.key === completion.verificationKey)
        : undefined
      : undefined;
    if (platformSubmission && (!verificationRequest || verificationRequest.status !== "BOUND" || verificationRequest.completionId !== completion.id)) {
      throw new Error(`Platform Completion ${completion.id} is missing its bound verifier request; refusing to submit`);
    }
    if (verificationRequest?.recoveryState === "RECOVERY_REQUIRED") {
      throw new Error(`Verification request ${verificationRequest.id} requires recovery before another external attempt`);
    }
    const candidatePath = join(this.runsRoot, runId, artifact.path);
    const evidenceIds: string[] = [];
    const evidenceCommands: Array<Parameters<VerifierControlPort["dispatch"]>[1]> = [];
    const accepted: boolean[] = [];
    const attemptCount = Math.max(1, snapshot.task.verification.required_reproductions);
    for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
      const attemptId = sha256(`${runId}:${completion.id}:${snapshot.generation}:fixture-score:${attempt}`);
      const scored = await this.journal.execute(runId, {
        operation: "fixture_score",
        args: {
          runId,
          taskId: snapshot.task.task_id,
          generation: snapshot.generation,
          completionId: completion.id,
          candidateHash: completion.candidateHash,
          candidateArtifactId: artifact.id,
          taskHash: sha256(canonicalJson(snapshot.task)),
          targetHash: sha256(snapshot.task.target),
          verificationRuleHash: sha256(canonicalJson(snapshot.task.verification)),
          candidatePath,
          attempt,
          attemptId,
          ...(verificationRequest ? { verificationRequestId: verificationRequest.id, verificationKey: verificationRequest.key, policyHash: verificationRequest.policyHash, recipeHash: verificationRequest.recipeHash } : {}),
        },
        replayPolicy: "pure",
        cwd: fixture.path,
        sessionId: `${runId}:fixture-score:${completion.id}:${attempt}`,
      }, signal);
      await ensureVerifierActive(this.controlStore, runId, signal);
      const result = JSON.parse(scored.result.stdout) as { accepted?: boolean; candidateHash?: string };
      const acceptedAttempt = result.accepted === true && result.candidateHash === completion.candidateHash;
      accepted.push(acceptedAttempt);
      const evidenceId = id("EV");
      evidenceIds.push(evidenceId);
      evidenceCommands.push({
        type: "evidence",
        evidence: {
          id: evidenceId,
          kind: acceptedAttempt ? "reproduction" : "negative",
          summary: `Hidden scorer attempt ${attempt} ${acceptedAttempt ? "accepted" : "rejected"} completion ${completion.id}.`,
          source: { tool: "fixture_score", effectId: scored.effectId, artifactId: scored.artifactId, generation: snapshot.generation },
          confidence: 1,
          supports: acceptedAttempt ? [completion.id] : [],
          refutes: acceptedAttempt ? [] : [completion.id],
        },
      });
    }
    const verified = accepted.length > 0 && accepted.every(Boolean);
    const completionEvidenceIds = verified
      ? [...evidenceIds]
      : accepted.flatMap((acceptedAttempt, index) => acceptedAttempt ? [] : [evidenceIds[index]!]);
    await ensureVerifierActive(this.controlStore, runId, signal);
    await this.verifierControl.dispatchBatch(runId, [
      ...evidenceCommands,
      { type: "completion_verified", completionId: completion.id, accepted: verified, evidenceIds: completionEvidenceIds },
    ]);
    await ensureVerifierActive(this.controlStore, runId, signal);
    let factId: string | undefined;
    if (verified) {
      factId = id("F");
      await this.verifierControl.dispatch(runId, {
        type: "fact",
        fact: { id: factId, statement: `Hidden scorer verified candidate sha256=${completion.candidateHash}`, status: "CONFIRMED", evidenceIds },
      });
      await ensureVerifierActive(this.controlStore, runId, signal);
    }
    return { completionId: completion.id, accepted: verified, candidate, candidateHash: completion.candidateHash, evidenceIds: completionEvidenceIds, factId };
  }
}

async function ensureVerifierActive(controlStore: ControlStore, runId: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Run aborted");
  const snapshot = await controlStore.snapshot(runId);
  if (snapshot.status === "PAUSED") throw new Error("Run paused during verification");
}

function durableTerminalOutcome(snapshot: RunSnapshot, completion: RunSnapshot["completions"][string], candidate: string): VerificationOutcome {
  const accepted = completion.status === "ACCEPTED";
  const evidence = completion.evidenceIds.map((evidenceId) => snapshot.evidence[evidenceId]);
  if (evidence.length === 0 || evidence.some((item) => !item)) {
    throw new Error(`Completion ${completion.id} is already ${completion.status} but has incomplete durable verifier evidence`);
  }
  for (const item of evidence) {
    const effectId = item!.provenance?.effect?.id;
    const effect = effectId ? snapshot.effects[effectId] : undefined;
    const resultArtifact = effect?.artifactId ? snapshot.artifacts[effect.artifactId] : undefined;
    const verdict = effect?.verification;
    const related = accepted
      ? item!.kind === "reproduction" && item!.supports.includes(completion.id)
      : item!.kind === "negative" && item!.refutes.includes(completion.id);
    if (item!.provenance.recordedBy !== "verifier"
      || item!.provenance.runId !== snapshot.runId
      || item!.provenance.generation !== snapshot.generation
      || item!.source.generation !== snapshot.generation
      || item!.source.effectId !== effectId
      || !effect
      || effect.status !== "FINISHED"
      || effect.producerLane !== "verifier"
      || !resultArtifact
      || resultArtifact.sourceEffectId !== effect.id
      || item!.source.artifactId !== resultArtifact.id
      || !verdict?.valid
      || verdict.accepted !== accepted
      || verdict.completionId !== completion.id
      || verdict.candidateHash !== completion.candidateHash
      || verdict.candidateArtifactId !== completion.artifactId
      || !related) {
      throw new Error(`Completion ${completion.id} is already ${completion.status} but its durable verifier evidence is invalid`);
    }
  }
  const fact = Object.values(snapshot.facts).find((item) => completion.evidenceIds.every((evidenceId) => item.evidenceIds.includes(evidenceId)));
  return {
    completionId: completion.id,
    accepted,
    candidate,
    candidateHash: completion.candidateHash,
    evidenceIds: [...completion.evidenceIds],
    ...(fact ? { factId: fact.id } : {}),
  };
}
