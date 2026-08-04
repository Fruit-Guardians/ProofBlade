import { join } from "node:path";
import type { ControlStore } from "../control/control-store.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { EffectJournal } from "../effects/effect-journal.js";
import type { FixtureRef } from "../sandbox/fixture.js";
import { id, sha256 } from "../domain/utils.js";

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
    private readonly journal: EffectJournal,
    private readonly runsRoot: string,
  ) {}

  public async verify(runId: string, fixture: FixtureRef, completionId?: string): Promise<VerificationOutcome> {
    const snapshot = await this.controlStore.snapshot(runId);
    const completion = completionId
      ? snapshot.completions[completionId]
      : Object.values(snapshot.completions).filter((item) => item.status === "PROPOSED").sort((a, b) => b.createdSeq - a.createdSeq)[0];
    if (!completion) throw new Error("No completion proposal is waiting for verification");
    if (completion.status !== "PROPOSED") throw new Error(`Completion ${completion.id} is already ${completion.status}`);
    const artifact = snapshot.artifacts[completion.artifactId];
    if (!artifact) throw new Error(`Candidate artifact is missing: ${completion.artifactId}`);
    const candidate = (await this.artifactStore.readText(runId, artifact)).trim();
    if (sha256(candidate) !== completion.candidateHash) throw new Error(`Candidate hash mismatch: ${completion.id}`);
    const candidatePath = join(this.runsRoot, runId, artifact.path);
    const evidenceIds: string[] = [];
    const accepted: boolean[] = [];
    for (let attempt = 1; attempt <= snapshot.task.verification.required_reproductions; attempt += 1) {
      const scored = await this.journal.execute(runId, {
        operation: "fixture_score",
        args: { candidatePath, candidateArtifactId: artifact.id, generation: snapshot.generation, attempt },
        replayPolicy: "pure",
        cwd: fixture.path,
      });
      const result = JSON.parse(scored.result.stdout) as { accepted?: boolean; candidateHash?: string };
      const acceptedAttempt = result.accepted === true && result.candidateHash === completion.candidateHash;
      accepted.push(acceptedAttempt);
      const evidenceId = id("EV");
      evidenceIds.push(evidenceId);
      await this.controlStore.dispatch(runId, {
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
        lane: "verifier",
      });
    }
    const verified = accepted.length > 0 && accepted.every(Boolean);
    await this.controlStore.dispatch(runId, { type: "completion_verified", completionId: completion.id, accepted: verified, evidenceIds, lane: "verifier" });
    let factId: string | undefined;
    if (verified) {
      factId = id("F");
      await this.controlStore.dispatch(runId, {
        type: "fact",
        fact: { id: factId, statement: `Hidden scorer verified candidate sha256=${completion.candidateHash}`, status: "CONFIRMED", evidenceIds },
        lane: "verifier",
      });
    }
    return { completionId: completion.id, accepted: verified, candidate, candidateHash: completion.candidateHash, evidenceIds, factId };
  }
}
