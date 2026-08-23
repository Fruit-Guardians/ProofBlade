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
  private readonly runLocks = new Map<string, Promise<void>>();

  public constructor(private readonly controlStore: ControlStore) {}

  /**
   * Serialize one model experiment from assertion through outcome recording.
   * The durable record remains the source of truth; this in-process lock also
   * prevents concurrent pwn calls from passing a stale preflight snapshot and
   * reaching the target after the repeat budget is exhausted.
   */
  public async runExclusive<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runLocks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.runLocks.set(runId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.runLocks.get(runId) === current) this.runLocks.delete(runId);
    }
  }

  public async record(input: ExperimentGateInput): Promise<ExperimentGateResult> {
    return await this.controlStore.dispatchTransaction<ExperimentGateResult>(input.runId, (snapshot) => {
      const domainPhase = input.domainPhase ?? snapshot.domainPhase;
      const inputHash = sha256(canonicalJson(clearCallArguments(input.input)));
      const repeatKey = repeatKeyFor({ domainPhase, generation: snapshot.generation, hypothesisId: input.hypothesisId, action: input.action, inputHash });
      const previousFailures = Object.values(snapshot.experiments).filter((item) => item.repeatKey === repeatKey && item.outcome !== "success").length;
      if (previousFailures >= 2 && input.outcome !== "success") return { commands: [], project: () => ({ allowed: false, repeatKey, previousFailures }) };
      const experiment: Omit<ExperimentRecord, "createdSeq"> = {
        id: id("EXP"), runId: input.runId, generation: snapshot.generation, domainPhase,
        hypothesisId: input.hypothesisId, repeatKey, action: normalizeAction(input.action), inputHash,
        outcome: input.outcome, summary: input.summary.trim(),
      };
      return {
        commands: [{ type: "experiment", experiment, lane: "executor" }],
        project: (after) => ({ allowed: true, repeatKey, previousFailures, record: after.experiments[experiment.id] }),
      };
    });
  }

  public async assertAllowed(input: Omit<ExperimentGateInput, "outcome" | "summary">): Promise<{ repeatKey: string; previousFailures: number }> {
    const snapshot = await this.controlStore.snapshot(input.runId);
    const repeatKey = repeatKeyFor({ domainPhase: input.domainPhase ?? snapshot.domainPhase, generation: snapshot.generation, hypothesisId: input.hypothesisId, action: input.action, inputHash: sha256(canonicalJson(clearCallArguments(input.input))) });
    const previousFailures = Object.values(snapshot.experiments).filter((item) => item.repeatKey === repeatKey && item.outcome !== "success").length;
    if (previousFailures >= 2) throw new Error(`Experiment repeat gate blocked action after ${previousFailures} failed attempts: ${repeatKey}`);
    return { repeatKey, previousFailures };
  }
}

function repeatKeyFor(input: { domainPhase: DomainPhase; generation: number; hypothesisId?: string; action: string; inputHash: string }): string {
  return sha256(canonicalJson({ domainPhase: input.domainPhase, generation: input.generation, hypothesisId: input.hypothesisId ?? "", action: normalizeAction(input.action), inputHash: input.inputHash }));
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
