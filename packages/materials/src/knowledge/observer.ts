import type { ControlStore } from "../control/control-store.js";
import type { RawEffectResult } from "../domain/types.js";
import { id } from "../domain/utils.js";
import { containsCtfCandidate } from "../domain/candidate.js";

export interface ObservedEffect {
  operation: string;
  /** Journal effect id when the producer is journal-backed. Coding read/bash
   * artifacts are already registered by the lane and intentionally use the
   * artifact identity without inventing a fake Effect record. */
  effectId?: string;
  artifactId: string;
  generation: number;
  result: RawEffectResult;
}

export interface ObservationOutcome {
  observationId: string;
  evidenceId: string;
  candidateKinds: string[];
}

export class DeterministicObserver {
  public constructor(private readonly controlStore: ControlStore) {}

  public async observe(runId: string, effect: ObservedEffect): Promise<ObservationOutcome> {
    const snapshot = await this.controlStore.snapshot(runId);
    const journalEffect = effect.effectId ? snapshot.effects[effect.effectId] : undefined;
    if (effect.effectId && !journalEffect) throw new Error(`Unknown observed effect ${effect.effectId}`);
    if (journalEffect && (journalEffect.status !== "FINISHED" || journalEffect.artifactId !== effect.artifactId || journalEffect.generation !== snapshot.generation)) {
      throw new Error(`Observed effect ${effect.effectId} is not a current finished effect bound to artifact ${effect.artifactId}`);
    }
    const existing = Object.values(snapshot.observations).find((item) => effect.effectId
      ? item.source.effectId === effect.effectId
      : item.source.artifactId === effect.artifactId && item.source.operation === effect.operation);
    if (existing) {
      const evidence = Object.values(snapshot.evidence).find((item) => effect.effectId
        ? item.source.effectId === effect.effectId
        : item.source.artifactId === effect.artifactId && item.source.tool === effect.operation);
      if (!evidence) throw new Error(`Observation ${existing.id} has no evidence`);
      return { observationId: existing.id, evidenceId: evidence.id, candidateKinds: existing.candidateKinds };
    }
    const combined = `${effect.result.stdout}\n${effect.result.stderr}`;
    const candidateKinds = [
      containsCtfCandidate(combined) ? "flag-shaped-value" : undefined,
      /(?:error|exception|rejected|invalid)/i.test(combined) ? "failure-signature" : undefined,
    ].filter((value): value is string => value !== undefined);
    const observationId = id("O");
    const evidenceId = id("EV");
    const outcome = effect.result.exitCode === 0 ? "completed" : effect.result.exitCode === null ? "timed out" : "failed";
    // Observation and its derived Evidence are one logical write. Keeping them
    // in one ControlStore transaction halves snapshot/replay work on every
    // read/bash result while preserving the same append-only facts.
    await this.controlStore.dispatchTransaction(runId, () => ({
      commands: [
        {
          type: "observation" as const,
          observation: {
            id: observationId,
            summary: `${effect.operation} ${outcome}; ${Buffer.byteLength(combined, "utf8")} bytes; candidates=${candidateKinds.join(",") || "none"}`,
            source: { operation: effect.operation, ...(effect.effectId ? { effectId: effect.effectId } : {}), artifactId: effect.artifactId, generation: effect.generation },
            candidateKinds,
          },
          lane: "executor" as const,
        },
        {
          type: "evidence" as const,
          evidence: {
            id: evidenceId,
            // A failed tool call is an observed failure signature, not verifier-grade
            // negative Evidence. Only the trusted verifier may promote a failed
            // reproduction into terminal negative Evidence.
            kind: "observation" as const,
            summary: `Deterministic observation ${observationId} from ${effect.operation}.`,
            source: { tool: journalEffect?.operation ?? effect.operation, ...(effect.effectId ? { effectId: effect.effectId } : {}), artifactId: effect.artifactId, generation: effect.generation },
            confidence: 0.9,
            supports: [observationId],
            refutes: [],
          },
          lane: "executor" as const,
        },
      ],
      project: () => undefined,
    }));
    return { observationId, evidenceId, candidateKinds };
  }
}
