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
  window?: NoProgressWindow;
}

export type NoProgressWindow = "read" | "declared_no_progress";

export type ExperimentBudgetReason = "tool_calls" | "long_running" | "timeouts" | "experiment_family";

export interface ExperimentBudgetDecision {
  count: number;
  terminate: boolean;
  key: string;
  reason?: ExperimentBudgetReason;
  family?: string;
}

export interface ExperimentBudgetLimits {
  /** Maximum process/network experiment calls in one provider turn. */
  maxExperimentCalls?: number;
  /** Maximum calls that look like long-running probes in one provider turn. */
  maxLongRunning?: number;
  /** Maximum timeout/deadline failures before requiring a strategy change. */
  maxTimeouts?: number;
  /** Maximum members of one normalized experiment family. */
  maxFamily?: number;
}

/**
 * Bounds successful-but-unproductive probes inside one provider request.
 *
 * The outer competition loop can only see a completed `lane.prompt()`. A
 * coding model may therefore issue dozens of successful bash calls before the
 * outer turn-level replan nudge runs. This breaker deliberately counts only
 * process/network experiments (not ordinary reads or edits), and leaves the
 * durable evidence record as the escape hatch for a genuinely new finding.
 */
export class ExperimentBudgetBreaker {
  private experimentCalls = 0;
  private longRunning = 0;
  private timeouts = 0;
  private readonly families = new Map<string, number>();
  private readonly limits: Required<ExperimentBudgetLimits>;

  public constructor(limits: ExperimentBudgetLimits = {}) {
    this.limits = {
      maxExperimentCalls: limits.maxExperimentCalls ?? 28,
      maxLongRunning: limits.maxLongRunning ?? 4,
      maxTimeouts: limits.maxTimeouts ?? 2,
      maxFamily: limits.maxFamily ?? 6,
    };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`Experiment budget ${name} must be a positive integer`);
    }
  }

  public observe(observation: ToolFailureObservation): ExperimentBudgetDecision {
    if (isDurableProgressObservation(observation)) {
      // A durable note/verification is a real strategy checkpoint. Preserve
      // the hard total-call ceiling, but let the next hypothesis start with a
      // fresh long-running/timeout/family budget.
      this.longRunning = 0;
      this.timeouts = 0;
      this.families.clear();
      return { count: this.experimentCalls, terminate: false, key: "" };
    }
    if (!isExperimentObservation(observation)) return { count: this.experimentCalls, terminate: false, key: "" };

    this.experimentCalls += 1;
    const command = commandText(observation);
    const long = isLongRunningCommand(command, observation);
    if (long) this.longRunning += 1;
    if (isTimeoutObservation(observation, command)) this.timeouts += 1;
    const family = experimentFamily(observation, command);
    const familyCount = family ? (this.families.set(family, (this.families.get(family) ?? 0) + 1), this.families.get(family)!) : 0;

    if (this.experimentCalls >= this.limits.maxExperimentCalls) {
      return { count: this.experimentCalls, terminate: true, key: "experiment-calls", reason: "tool_calls", ...(family ? { family } : {}) };
    }
    if (this.longRunning >= this.limits.maxLongRunning) {
      return { count: this.longRunning, terminate: true, key: "long-running", reason: "long_running", ...(family ? { family } : {}) };
    }
    if (this.timeouts >= this.limits.maxTimeouts) {
      return { count: this.timeouts, terminate: true, key: "timeouts", reason: "timeouts", ...(family ? { family } : {}) };
    }
    if (family && familyCount >= this.limits.maxFamily) {
      return { count: familyCount, terminate: true, key: family, reason: "experiment_family", family };
    }
    return { count: this.experimentCalls, terminate: false, key: family ?? "" };
  }

  public reset(): void {
    this.experimentCalls = 0;
    this.longRunning = 0;
    this.timeouts = 0;
    this.families.clear();
  }
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
    if (declaredProgress === false) return this.observeWindow(this.declaredNoProgressWindow, observation, "declared_no_progress");
    if (isDurableEffect(observation)) {
      this.reset();
      return { count: 0, terminate: false, key: "" };
    }
    if (!isPureReadOnlyObservation(observation)) {
      this.readWindow.reset();
      return { count: 0, terminate: false, key: "" };
    }
    return this.observeWindow(this.readWindow, observation, "read");
  }

  private observeWindow(window: ObservationWindow, observation: ToolFailureObservation, windowKind: NoProgressWindow): ToolFailureDecision {
    const key = observationKey(observation);
    if (!key) return { count: 0, terminate: false, key: "" };
    const count = window.observe(key, this.windowSize);
    return { count, terminate: count >= this.threshold, key, window: windowKind };
  }

  public isProgress(observation: ToolFailureObservation, activeWindow?: NoProgressWindow): boolean {
    if (observation.isError) return false;
    const declaredProgress = stableBoolean(observation.details, "durableProgress");
    if (declaredProgress !== undefined) return declaredProgress;
    if (activeWindow === "read" && !isPureReadOnlyObservation(observation)) return true;
    if (activeWindow === "declared_no_progress") return isDurableEffect(observation);
    // Without a declared no-progress window, unresolved tools retain potential-progress semantics.
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
    "Change the operation or arguments, then retry; for evidence curation use evidence record to promote a finding. Evidence annotate only marks an artifact viewed and does not clear the gate.",
  ].join("\n");
}

export function noProgressToolMessage(toolName: string, count: number): string {
  return [
    `[ProofBlade no-progress guard: ${toolName} returned the same observation ${count} times without durable progress]`,
    "The current agent turn was stopped because repeated exploration produced no new information.",
    "Continue in a new turn with a different hypothesis, input range, tool, or analysis method; existing Artifacts and Evidence remain available.",
  ].join("\n");
}

export function noProgressToolNudge(toolName: string, count: number): string {
  return [
    `[ProofBlade no-progress notice: ${toolName} returned the same observation ${count} times]`,
    "这是软提示，本轮继续；请先记录最强 Evidence，再改变假设、输入范围或工具。不要原样重复同一探测。",
  ].join("\n");
}

export function toolFailureStormMessage(count: number): string {
  return [
    `[ProofBlade tool failure budget: ${count} failures occurred without durable progress]`,
    "The current agent turn was stopped because changing invalid arguments did not advance the task.",
    "Inspect the relevant tool schema or evidence curation_status, then continue in a new turn with valid arguments; existing Artifacts and Evidence remain available.",
  ].join("\n");
}

function experimentBudgetLabel(decision: ExperimentBudgetDecision): string {
  return decision.reason === "experiment_family"
    ? "the same experiment family"
    : decision.reason === "long_running"
      ? "long-running probes"
      : decision.reason === "timeouts"
        ? "timed-out probes"
        : "process/network experiment calls";
}

export function experimentBudgetMessage(decision: ExperimentBudgetDecision): string {
  const label = experimentBudgetLabel(decision);
  return [
    `[ProofBlade experiment budget: ${label} reached the per-turn limit (${decision.count})]`,
    "The current provider turn was stopped before another probe could repeat the same approach.",
    "Preserve the strongest observation in an evidence record or annotate an existing artifact, state one alternative hypothesis, then continue in the next turn with one bounded test.",
  ].join("\n");
}

/**
 * Advisory (non-terminating) variant of {@link experimentBudgetMessage}. Instead
 * of stopping the turn and forcing a replan — which interrupts a legitimate
 * multi-step solve mid-chain — this nudge is appended to the tool output so the
 * model keeps control and can change tactics itself. Emitted once per window;
 * the breaker's counters are reset after it fires.
 */
export function experimentBudgetNudge(decision: ExperimentBudgetDecision): string {
  const label = experimentBudgetLabel(decision);
  return [
    `[ProofBlade experiment budget notice: ${label} is repeating (${decision.count} this window)]`,
    "You are not blocked — but repeating the same kind of probe rarely yields new signal.",
    "Before the next call: record the strongest observation so far, then either change the hypothesis/input meaningfully or reconstruct the logic as a small script instead of probing again.",
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

function isDurableProgressObservation(observation: ToolFailureObservation): boolean {
  if (observation.isError) return false;
  const declaredProgress = stableBoolean(observation.details, "durableProgress");
  if (declaredProgress !== undefined) return declaredProgress;
  if (observation.toolName === "verify_claim" || observation.toolName === "submit_flag") return true;
  if (observation.toolName !== "evidence") return false;
  const operation = isRecord(observation.input) && typeof observation.input.operation === "string"
    ? observation.input.operation
    : undefined;
  return operation === "record" || operation === "annotate";
}

function isExperimentObservation(observation: ToolFailureObservation): boolean {
  if (observation.toolName === "shell_background") return true;
  if (observation.toolName !== "bash") return false;
  const command = commandText(observation);
  return /\b(?:python(?:3)?|node|ruby|perl|nc|socat|curl|wget|ffuf|sqlmap|nmap|gdb|qemu|checksec|timeout|fuzz|afl|probe|exploit)\b/i.test(command)
    || /\b(?:for|while)\b[\s\S]*\b(?:in|do)\b/i.test(command);
}

function isLongRunningCommand(command: string, observation: ToolFailureObservation): boolean {
  if (observation.toolName === "shell_background") return true;
  return /\btimeout\s+\d+|--timeout(?:=|\s+)\d+|\b(?:for|while)\b[\s\S]*\b(?:in|do)\b|\b(?:fuzz|afl|nmap|ffuf|sqlmap)\b/i.test(command);
}

function isTimeoutObservation(observation: ToolFailureObservation, command: string): boolean {
  if (!observation.isError) return false;
  return /timeout|timed out|deadline|killed after/i.test(observation.content.map((item) => item.text ?? "").join("\n"))
    || /\btimeout\s+\d+|--timeout(?:=|\s+)/i.test(command);
}

function commandText(observation: ToolFailureObservation): string {
  if (observation.toolName === "shell_background") {
    return typeof observation.input.command === "string" ? observation.input.command : JSON.stringify(observation.input);
  }
  return typeof observation.input.command === "string" ? observation.input.command : JSON.stringify(observation.input);
}

function experimentFamily(observation: ToolFailureObservation, command: string): string | undefined {
  if (observation.toolName !== "bash" && observation.toolName !== "shell_background") return undefined;
  // Heredoc bodies contain the changing payload; classify by the invocation
  // prefix so probe1.py/probe2.py remain one family without hashing secrets.
  const prefix = command.split(/<<\s*['"]?[A-Za-z_][A-Za-z0-9_-]*['"]?/)[0] ?? command;
  const normalized = prefix
    .replace(/\b(probe|exploit|attempt|trial|run)\d+\b/gi, "$1#")
    .replace(/0x[0-9a-f]+/gi, "0x#")
    .replace(/\b\d+\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return normalized ? sha256(canonicalJson({ toolName: observation.toolName, command: normalized })) : undefined;
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
