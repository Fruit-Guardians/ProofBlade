import type { ControlStore } from "../control/control-store.js";
import type { RawEffectResult } from "../domain/types.js";
import { id } from "../domain/utils.js";
import { containsCtfCandidate } from "../domain/candidate.js";

export interface ObservedEffect {
  operation: string;
  effectId: string;
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
    const existing = Object.values(snapshot.observations).find((item) => item.source.effectId === effect.effectId);
    if (existing) {
      const evidence = Object.values(snapshot.evidence).find((item) => item.source.effectId === effect.effectId);
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
    await this.controlStore.dispatch(runId, {
      type: "observation",
      observation: {
        id: observationId,
        summary: `${effect.operation} ${outcome}; ${Buffer.byteLength(combined, "utf8")} bytes; candidates=${candidateKinds.join(",") || "none"}`,
        source: { operation: effect.operation, effectId: effect.effectId, artifactId: effect.artifactId, generation: effect.generation },
        candidateKinds,
      },
      lane: "executor",
    });
    await this.controlStore.dispatch(runId, {
      type: "evidence",
      evidence: {
        id: evidenceId,
        kind: effect.result.exitCode === 0 ? "observation" : "negative",
        summary: `Deterministic observation ${observationId} from ${effect.operation}.`,
        source: { tool: effect.operation, effectId: effect.effectId, artifactId: effect.artifactId, generation: effect.generation },
        confidence: effect.result.exitCode === 0 ? 0.9 : 1,
        supports: [observationId],
        refutes: [],
      },
      lane: "executor",
    });
    return { observationId, evidenceId, candidateKinds };
  }
}
