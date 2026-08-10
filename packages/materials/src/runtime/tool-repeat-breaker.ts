import { canonicalJson, sha256 } from "../domain/utils.js";
import type { ProofBladeToolContract } from "../tools/contracts.js";

export type ToolEffectPolicy = Pick<ProofBladeToolContract, "readOnly" | "sideEffect">;

export type ToolEffectPolicyResolver = (
  toolName: string,
  input: Record<string, unknown>,
) => ToolEffectPolicy | undefined;

export interface ToolFailureObservation {
  toolName: string;
  input: Record<string, unknown>;
  isError: boolean;
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
  effectPolicy?: ToolEffectPolicy;
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

/** Stops read-only investigation loops that repeatedly recover identical information. */
export class NoProgressToolBreaker {
  private readonly readWindow = new ObservationWindow();
  private readonly declaredNoProgressWindow = new ObservationWindow();

  public constructor(
    private readonly threshold = 3,
    private readonly windowSize = 12,
  ) {
    if (!Number.isInteger(threshold) || threshold < 2) throw new Error("No-progress breaker threshold must be at least 2");
    if (!Number.isInteger(windowSize) || windowSize < threshold) throw new Error("No-progress breaker window must cover the threshold");
  }

  public observe(observation: ToolFailureObservation): ToolFailureDecision {
    if (observation.isError) return { count: 0, terminate: false, key: "" };
    const declaredProgress = stableBoolean(observation.details, "durableProgress");
    if (declaredProgress === true) {
      this.reset();
      return { count: 0, terminate: false, key: "" };
    }
    if (declaredProgress === false) return this.observeWindow(this.declaredNoProgressWindow, observation);
    if (isDurableEffect(observation)) {
      this.reset();
      return { count: 0, terminate: false, key: "" };
    }
    if (!isPureReadOnlyObservation(observation)) {
      this.readWindow.reset();
      return { count: 0, terminate: false, key: "" };
    }
    return this.observeWindow(this.readWindow, observation);
  }

  private observeWindow(window: ObservationWindow, observation: ToolFailureObservation): ToolFailureDecision {
    const key = observationKey(observation);
    if (!key) return { count: 0, terminate: false, key: "" };
    const count = window.observe(key, this.windowSize);
    return { count, terminate: count >= this.threshold, key };
  }

  public isProgress(observation: ToolFailureObservation): boolean {
    if (observation.isError) return false;
    const declaredProgress = stableBoolean(observation.details, "durableProgress");
    if (declaredProgress !== undefined) return declaredProgress;
    // Unresolved tools retain the conservative potential-progress behavior.
    if (!observation.effectPolicy) return true;
    return isDurableEffect(observation);
  }

  public reset(): void {
    this.readWindow.reset();
    this.declaredNoProgressWindow.reset();
  }
}

class ObservationWindow {
  private readonly recentKeys: string[] = [];
  private readonly counts = new Map<string, number>();

  public observe(key: string, windowSize: number): number {
    this.recentKeys.push(key);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    if (this.recentKeys.length > windowSize) {
      const expired = this.recentKeys.shift()!;
      const remaining = (this.counts.get(expired) ?? 1) - 1;
      if (remaining === 0) this.counts.delete(expired);
      else this.counts.set(expired, remaining);
    }
    return this.counts.get(key) ?? 0;
  }

  public reset(): void {
    this.recentKeys.length = 0;
    this.counts.clear();
  }
}

/** Stops a turn when many different tool failures alternate without durable progress. */
export class ToolFailureStormBreaker {
  private count = 0;

  public constructor(private readonly threshold = 12) {
    if (!Number.isInteger(threshold) || threshold < 3) throw new Error("Tool failure storm threshold must be at least 3");
  }

  public observe(observation: ToolFailureObservation): ToolFailureDecision {
    if (observation.isError) {
      this.count += 1;
      return { count: this.count, terminate: this.count >= this.threshold, key: "failure-storm" };
    }
    if (!isNoProgressObservation(observation)) this.reset();
    return { count: this.count, terminate: false, key: "failure-storm" };
  }

  public reset(): void {
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

export function noProgressToolMessage(toolName: string, count: number): string {
  return [
    `[ProofBlade no-progress guard: ${toolName} returned the same observation ${count} times without durable progress]`,
    "The current agent turn was stopped because repeated exploration produced no new information.",
    "Continue in a new turn with a different hypothesis, input range, tool, or analysis method; existing Artifacts and Evidence remain available.",
  ].join("\n");
}

export function toolFailureStormMessage(count: number): string {
  return [
    `[ProofBlade tool failure budget: ${count} failures occurred without durable progress]`,
    "The current agent turn was stopped because changing invalid arguments did not advance the task.",
    "Inspect the relevant tool schema or evidence curation_status, then continue in a new turn with valid arguments; existing Artifacts and Evidence remain available.",
  ].join("\n");
}

function observationKey(observation: ToolFailureObservation): string | undefined {
  const declaredProgressKey = stableString(observation.details, "progressKey");
  if (declaredProgressKey) return sha256(canonicalJson({ toolName: observation.toolName, progressKey: declaredProgressKey }));
  const artifactHash = stableArtifactHash(observation.details);
  const output = artifactHash ?? observation.content
    .map((item) => item.type === "text" ? item.text ?? "" : "[image]")
    .join("\n")
    .replace(/\[ProofBlade artifact A-[^;\]]+;[^\]]+\]/g, "[ProofBlade artifact]")
    .replace(/\[ProofBlade evidence curation[\s\S]*$/g, "")
    .trim()
    .replace(/\s+/g, " ");
  return sha256(canonicalJson({ toolName: observation.toolName, input: observation.input, output }));
}

function isPureReadOnlyObservation(observation: ToolFailureObservation): boolean {
  return observation.effectPolicy?.readOnly === true && observation.effectPolicy.sideEffect === "none";
}

function isDurableEffect(observation: ToolFailureObservation): boolean {
  return observation.effectPolicy?.sideEffect === "workspace"
    || observation.effectPolicy?.sideEffect === "network"
    || observation.effectPolicy?.sideEffect === "platform";
}

function isNoProgressObservation(observation: ToolFailureObservation): boolean {
  return stableBoolean(observation.details, "durableProgress") === false || isPureReadOnlyObservation(observation);
}

function stableArtifactHash(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  if (typeof details.artifactHash === "string") return details.artifactHash;
  const outputRewrite = details.outputRewrite;
  return isRecord(outputRewrite) && typeof outputRewrite.artifactHash === "string" ? outputRewrite.artifactHash : undefined;
}

function stableString(details: unknown, key: string): string | undefined {
  return isRecord(details) && typeof details[key] === "string" ? details[key] : undefined;
}

function stableBoolean(details: unknown, key: string): boolean | undefined {
  return isRecord(details) && typeof details[key] === "boolean" ? details[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
