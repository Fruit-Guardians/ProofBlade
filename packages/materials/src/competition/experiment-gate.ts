import type { ControlStore } from "../control/control-store.js";
import type { DomainPhase, ExperimentOutcome, ExperimentRecord } from "../domain/types.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";

export interface ExperimentGateInput {
  runId: string;
  domainPhase?: DomainPhase;
  hypothesisId?: string;
  action: string;
  input: unknown;
  outcome: ExperimentOutcome;
  summary: string;
}

export interface ExperimentGateResult {
  allowed: boolean;
  repeatKey: string;
  previousFailures: number;
  record?: ExperimentRecord;
}

/** Durable no-repeat gate for process/network experiments. */
export class ExperimentGate {
  public constructor(private readonly controlStore: ControlStore) {}

  public async record(input: ExperimentGateInput): Promise<ExperimentGateResult> {
    const snapshot = await this.controlStore.snapshot(input.runId);
    const domainPhase = input.domainPhase ?? snapshot.domainPhase;
    const inputHash = sha256(canonicalJson(clearCallArguments(input.input)));
    const repeatKey = sha256(canonicalJson({
      domainPhase,
      generation: snapshot.generation,
      hypothesisId: input.hypothesisId ?? "",
      action: normalizeAction(input.action),
      inputHash,
    }));
    const previousFailures = Object.values(snapshot.experiments).filter((item) => item.repeatKey === repeatKey && item.outcome !== "success").length;
    if (previousFailures >= 2 && input.outcome !== "success") return { allowed: false, repeatKey, previousFailures };
    const experiment: Omit<ExperimentRecord, "createdSeq"> = {
      id: id("EXP"),
      runId: input.runId,
      generation: snapshot.generation,
      domainPhase,
      hypothesisId: input.hypothesisId,
      repeatKey,
      action: normalizeAction(input.action),
      inputHash,
      outcome: input.outcome,
      summary: input.summary.trim(),
    };
    await this.controlStore.dispatch(input.runId, { type: "experiment", experiment, lane: "executor" });
    return { allowed: true, repeatKey, previousFailures, record: (await this.controlStore.snapshot(input.runId)).experiments[experiment.id] };
  }

  public async assertAllowed(input: Omit<ExperimentGateInput, "outcome" | "summary">): Promise<{ repeatKey: string; previousFailures: number }> {
    const snapshot = await this.controlStore.snapshot(input.runId);
    const repeatKey = sha256(canonicalJson({
      domainPhase: input.domainPhase ?? snapshot.domainPhase,
      generation: snapshot.generation,
      hypothesisId: input.hypothesisId ?? "",
      action: normalizeAction(input.action),
      inputHash: sha256(canonicalJson(clearCallArguments(input.input))),
    }));
    const previousFailures = Object.values(snapshot.experiments).filter((item) => item.repeatKey === repeatKey && item.outcome !== "success").length;
    if (previousFailures >= 2) throw new Error(`Experiment repeat gate blocked action after ${previousFailures} failed attempts: ${repeatKey}`);
    return { repeatKey, previousFailures };
  }
}

function normalizeAction(action: string): string {
  return action.trim().replace(/\s+/g, " ").slice(0, 1_000);
}

/** Remove presentation-only fields before repeat comparison. */
export function clearCallArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clearCallArguments);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !["explanation", "description", "display", "label", "title", "comment"].includes(key))
    .map(([key, item]) => [key, clearCallArguments(item)]));
}
