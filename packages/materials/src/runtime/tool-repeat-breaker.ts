import { canonicalJson, sha256 } from "../domain/utils.js";

export interface ToolFailureObservation {
  toolName: string;
  input: Record<string, unknown>;
  isError: boolean;
  content: Array<{ type: string; text?: string }>;
}

export interface ToolFailureDecision {
  count: number;
  terminate: boolean;
  key: string;
}

/** Stops a lane when the model repeats an identical failing tool call. */
export class RepeatedToolFailureBreaker {
  private lastKey: string | undefined;
  private count = 0;

  public constructor(private readonly threshold = 3) {
    if (!Number.isInteger(threshold) || threshold < 2) throw new Error("Tool failure breaker threshold must be at least 2");
  }

  public observe(observation: ToolFailureObservation): ToolFailureDecision {
    if (!observation.isError) {
      this.reset();
      return { count: 0, terminate: false, key: "" };
    }
    const errorText = observation.content
      .map((item) => item.type === "text" ? item.text ?? "" : "[image]")
      .join("\n")
      .trim()
      .replace(/\s+/g, " ");
    const key = sha256(canonicalJson({
      toolName: observation.toolName,
      input: observation.input,
      error: errorText,
    }));
    this.count = this.lastKey === key ? this.count + 1 : 1;
    this.lastKey = key;
    return { count: this.count, terminate: this.count >= this.threshold, key };
  }

  public reset(): void {
    this.lastKey = undefined;
    this.count = 0;
  }
}

export function repeatedToolFailureMessage(toolName: string, count: number): string {
  return [
    `[ProofBlade repeated tool failure: ${toolName} failed identically ${count} times]`,
    "The current agent turn was stopped to prevent an infinite loop.",
    "Change the operation or arguments, then retry; for evidence curation use evidence record or evidence annotate to resolve pending artifacts.",
  ].join("\n");
}
