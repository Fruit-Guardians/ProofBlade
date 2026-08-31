import { AgentHarness } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ControlStore } from "../control/control-store.js";
import { rewriteUnverifiedClaimText, type CodingClaimVerifier } from "../verification/claim-verification.js";
import type { AgentOutcome } from "./pi-adapter.js";
import { persistedAssistantText } from "./assistant-message.js";
import { ExperimentBudgetBreaker, NoProgressToolBreaker, RepeatedToolFailureBreaker, ToolFailureStormBreaker, experimentBudgetMessage, experimentBudgetNudge, noProgressToolMessage, noProgressToolNudge, repeatedToolFailureMessage, toolFailureStormMessage, type NoProgressWindow, type ToolEffectPolicyResolver } from "./tool-repeat-breaker.js";
import type { AblationDecisionEvent, AblationPolicyController } from "../evaluation/ablation-policy.js";

export type CodingTurnTerminationReason = "repeated_tool_failure" | "no_progress" | "tool_failure_storm" | "experiment_budget" | "tool_budget_exhausted";

export interface ToolCallBudget {
  max: number;
  count: number;
}

/**
 * Guard for the first challenge action. It is intentionally independent from
 * the generic tool-call budget: the first action constrains *which* tools may
 * establish the initial fact, while the run budget constrains total volume.
 */
export interface FirstActionBudget {
  allowedToolNames: readonly string[];
  maxCalls: number;
  count: number;
  completed: boolean;
}

export interface AblationPolicyBinding {
  controller: AblationPolicyController;
  experimentId: string;
  variantId: string;
  caseId: string;
  runId: string;
  attempt: number;
  turn?: () => number;
  onDecision?: (event: AblationDecisionEvent) => void | Promise<void>;
}

export interface CodingTurnTermination {
  message?: string;
  requested?: boolean;
  confirmed?: boolean;
  reason?: CodingTurnTerminationReason;
  noProgressWindow?: NoProgressWindow;
  /** Set for a challenge prompt so experiment limits stop the turn, not just nudge it. */
  ctfMode?: boolean;
  /** Coding chat uses a nudge for repeated observations; Solver keeps hard stops. */
  softNoProgress?: boolean;
  /** Keep the lane alive and turn guard pressure into an in-band recovery hint. */
  continuousRecovery?: boolean;
}

export function projectCodingAssistantText(output: string, termination: CodingTurnTermination): string {
  return output.trim().length > 0 ? output : termination.confirmed ? termination.message ?? output : output;
}

export function attachRepeatedToolFailureBreaker<TContext extends object | undefined>(
  harness: AgentHarness<TContext>,
  repeatBreaker: RepeatedToolFailureBreaker,
  termination: CodingTurnTermination,
): () => void {
  return attachCodingTurnGuards(harness, repeatBreaker, undefined, termination);
}

export function attachCodingTurnGuards<TContext extends object | undefined>(
  harness: AgentHarness<TContext>,
  repeatBreaker: RepeatedToolFailureBreaker,
  progressBreaker: NoProgressToolBreaker | undefined,
  termination: CodingTurnTermination,
  resolveEffectPolicy?: ToolEffectPolicyResolver,
  failureStormBreaker?: ToolFailureStormBreaker,
  experimentBudgetBreaker?: ExperimentBudgetBreaker,
  toolBudget?: ToolCallBudget,
  firstActionBudget?: FirstActionBudget,
  ablationPolicy?: AblationPolicyBinding,
): () => void {
  let batchOpen = false;
  let batchHasSuccess = false;
  const unsubscribeEvents = harness.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      batchOpen = event.message.content.some((item) => item.type === "toolCall");
      batchHasSuccess = false;
    }
    if (event.type === "turn_end" && batchOpen) {
      if (batchHasSuccess && !termination.requested) repeatBreaker.reset();
      batchOpen = false;
      batchHasSuccess = false;
    }
  });
  const unsubscribeResult = harness.on("tool_result", (event) => {
    if (firstActionBudget && !firstActionBudget.completed && !event.isError && matchesFirstActionTool(event.toolName, firstActionBudget.allowedToolNames)) {
      firstActionBudget.completed = true;
    }
    if (termination.reason === "tool_budget_exhausted" && !termination.continuousRecovery) {
      return {
        content: [{ type: "text" as const, text: termination.message ?? "[ProofBlade tool budget exhausted]" }],
        details: { toolBudget: true, count: toolBudget?.count ?? 0, max: toolBudget?.max ?? 0 },
        isError: true,
        terminate: true,
      };
    }
    if (!event.isError) {
      const observation = {
        toolName: event.toolName,
        input: event.input,
        isError: false,
        content: event.content.map((item) => item.type === "text" ? { type: item.type, text: item.text } : { type: item.type }),
        details: event.details,
        effectPolicy: resolveEffectPolicy?.(event.toolName, event.input),
      };
      const experiment = experimentBudgetBreaker?.observe(observation);
      if (experiment?.terminate) {
        if (termination.continuousRecovery) {
          experimentBudgetBreaker?.reset();
          return {
            content: [...event.content.map((item) => item.type === "text" ? { type: "text" as const, text: item.text } : item), { type: "text" as const, text: experimentBudgetNudge(experiment) }],
            details: { experimentBudget: true, advisory: true, count: experiment.count, key: experiment.key, reason: experiment.reason, family: experiment.family },
            isError: event.isError,
          };
        }
        if (termination.ctfMode) {
          termination.message = experimentBudgetMessage(experiment);
          termination.reason = "experiment_budget";
          termination.requested = true;
          return {
            content: [{ type: "text" as const, text: termination.message }],
            details: { experimentBudget: true, count: experiment.count, key: experiment.key, reason: experiment.reason, family: experiment.family },
            isError: false,
            terminate: true,
          };
        }
        // Advisory, non-terminating: keep the model in control and append a
        // change-tactics nudge to the real tool output instead of stopping the
        // turn and forcing a replan (which interrupts a legitimate multi-step
        // solve). Reset the window so the nudge is periodic, not per-call spam.
        experimentBudgetBreaker?.reset();
        const nudge = experimentBudgetNudge(experiment);
        return {
          content: [...event.content.map((item) => item.type === "text" ? { type: "text" as const, text: item.text } : item), { type: "text" as const, text: nudge }],
          details: { experimentBudget: true, advisory: true, count: experiment.count, key: experiment.key, reason: experiment.reason, family: experiment.family },
          isError: false,
        };
      }
      failureStormBreaker?.observe(observation);
      if (progressBreaker?.isProgress(observation, termination.noProgressWindow) && termination.reason === "no_progress") {
        delete termination.message;
        delete termination.reason;
        delete termination.noProgressWindow;
        termination.requested = false;
      }
      const progress = progressBreaker?.observe(observation);
      if (progress?.terminate) {
        const preservesDeclaredTermination = termination.reason === "no_progress"
          && termination.noProgressWindow === "declared_no_progress"
          && progress.window === "read";
        const terminationMessage = preservesDeclaredTermination
          ? termination.message ?? noProgressToolMessage(event.toolName, progress.count)
          : noProgressToolMessage(event.toolName, progress.count);
        if (termination.continuousRecovery || termination.softNoProgress) {
          progressBreaker?.reset();
          return {
            content: [
              ...event.content.map((item) => item.type === "text" ? { type: "text" as const, text: item.text } : item),
              { type: "text" as const, text: noProgressToolNudge(event.toolName, progress.count) },
            ],
            details: { noProgress: true, advisory: true, toolName: event.toolName, count: progress.count, key: progress.key, window: progress.window },
            isError: false,
          };
        }
        if (!preservesDeclaredTermination) {
          termination.message = terminationMessage;
          termination.reason = "no_progress";
          termination.noProgressWindow = progress.window;
          termination.requested = true;
        }
        return {
          content: [{ type: "text" as const, text: terminationMessage }],
          details: { noProgress: true, toolName: event.toolName, count: progress.count, key: progress.key, window: termination.noProgressWindow },
          isError: false,
          terminate: true,
        };
      }
      if (batchOpen) batchHasSuccess = true;
      else repeatBreaker.reset();
      return undefined;
    }
    const observation = {
      toolName: event.toolName,
      input: event.input,
      isError: event.isError,
      content: event.content.map((item) => item.type === "text" ? { type: item.type, text: item.text } : { type: item.type }),
      details: event.details,
      effectPolicy: resolveEffectPolicy?.(event.toolName, event.input),
    };
    const experiment = experimentBudgetBreaker?.observe(observation);
    if (experiment?.terminate) {
      if (termination.ctfMode) {
        termination.message = experimentBudgetMessage(experiment);
        termination.reason = "experiment_budget";
        termination.requested = true;
        return {
          content: [{ type: "text" as const, text: termination.message }],
          details: { experimentBudget: true, count: experiment.count, key: experiment.key, reason: experiment.reason, family: experiment.family },
          isError: event.isError,
          terminate: true,
        };
      }
      // Advisory, non-terminating (same as the success path): append the nudge
      // to the real error output and reset the window; do not stop the turn.
      experimentBudgetBreaker?.reset();
      const nudge = experimentBudgetNudge(experiment);
      return {
        content: [...event.content.map((item) => item.type === "text" ? { type: "text" as const, text: item.text } : item), { type: "text" as const, text: nudge }],
        details: { experimentBudget: true, advisory: true, count: experiment.count, key: experiment.key, reason: experiment.reason, family: experiment.family },
        isError: event.isError,
      };
    }
    const storm = failureStormBreaker?.observe(observation);
    const decision = repeatBreaker.observe(observation);
    const policyEvent = ablationPolicy && ablationPolicy.controller.decide({
      experimentId: ablationPolicy.experimentId,
      variantId: ablationPolicy.variantId,
      caseId: ablationPolicy.caseId,
      attempt: ablationPolicy.attempt,
      runId: ablationPolicy.runId,
      turn: ablationPolicy.turn?.() ?? 1,
      requestedAction: "tool_result",
      requestedTool: event.toolName,
      ...(decision.terminate ? { duplicateFailure: true } : {}),
      ...(storm?.terminate ? { circuitBreakerTriggered: true } : {}),
      reasonInputs: { toolName: event.toolName, duplicateFailure: decision.terminate, circuitBreakerTriggered: Boolean(storm?.terminate) },
    });
    if (policyEvent) void ablationPolicy?.onDecision?.(policyEvent);
    const ablationRelaxesFailureGuard = policyEvent?.decision === "allow" || policyEvent?.decision === "advise";
    if (ablationRelaxesFailureGuard && storm?.terminate) {
      failureStormBreaker?.reset();
      return {
        content: [...event.content.map((item) => item.type === "text" ? { type: "text" as const, text: item.text } : item), { type: "text" as const, text: toolFailureStormMessage(storm.count) }],
        details: { failureStorm: true, advisory: true, count: storm.count, key: storm.key },
        isError: true,
      };
    }
    if (ablationRelaxesFailureGuard && decision.terminate) {
      repeatBreaker.reset();
      return {
        content: [...event.content.map((item) => item.type === "text" ? { type: "text" as const, text: item.text } : item), { type: "text" as const, text: repeatedToolFailureMessage(event.toolName, decision.count) }],
        details: { repeatedFailure: true, advisory: true, toolName: event.toolName, count: decision.count, key: decision.key },
        isError: true,
      };
    }
    if (storm?.terminate && !decision.terminate) {
      if (termination.continuousRecovery) {
        failureStormBreaker?.reset();
        return {
          content: [{ type: "text" as const, text: `${toolFailureStormMessage(storm.count)}\n${experimentBudgetNudge({ count: storm.count, terminate: false, key: "failure-storm", reason: "tool_calls" })}` }],
          details: { failureStorm: true, advisory: true, count: storm.count, key: storm.key },
          isError: true,
        };
      }
      termination.message = toolFailureStormMessage(storm.count);
      termination.reason = "tool_failure_storm";
      termination.requested = true;
      return {
        content: [{ type: "text" as const, text: termination.message }],
        details: { failureStorm: true, count: storm.count, key: storm.key },
        isError: true,
        terminate: true,
      };
    }
    if (!decision.terminate) return undefined;
    if (termination.continuousRecovery) {
      repeatBreaker.reset();
      return {
        content: [{ type: "text" as const, text: `${repeatedToolFailureMessage(event.toolName, decision.count)}\n${experimentBudgetNudge({ count: decision.count, terminate: false, key: decision.key, reason: "tool_calls" })}` }],
        details: { repeatedFailure: true, advisory: true, toolName: event.toolName, count: decision.count, key: decision.key },
        isError: true,
      };
    }
    termination.message = repeatedToolFailureMessage(event.toolName, decision.count);
    termination.reason = "repeated_tool_failure";
    termination.requested = true;
    return {
      content: [{ type: "text" as const, text: termination.message }],
      details: { repeatedFailure: true, toolName: event.toolName, count: decision.count, key: decision.key },
      isError: true,
      terminate: true,
    };
  });
  const unsubscribeToolCall = harness.on("tool_call", (event) => {
    const firstActionViolation = firstActionBudget && !firstActionBudget.completed
      && !isFirstActionCompletionTool(event.toolName)
      && !matchesFirstActionTool(event.toolName, firstActionBudget.allowedToolNames);
    const policyEvent = ablationPolicy && ablationPolicy.controller.decide({
      experimentId: ablationPolicy.experimentId,
      variantId: ablationPolicy.variantId,
      caseId: ablationPolicy.caseId,
      attempt: ablationPolicy.attempt,
      runId: ablationPolicy.runId,
      turn: ablationPolicy.turn?.() ?? 1,
      requestedAction: "tool_call",
      requestedTool: event.toolName,
      ...(firstActionViolation ? { firstActionViolation: true } : {}),
      reasonInputs: { toolName: event.toolName, firstActionViolation: Boolean(firstActionViolation) },
    });
    if (policyEvent) void ablationPolicy?.onDecision?.(policyEvent);
    if (policyEvent?.decision === "terminate" || policyEvent?.decision === "block") {
      return { block: true, reason: ablationBlockMessage(policyEvent, firstActionBudget) };
    }
    // First-action plans rank useful opening probes. They do not restrict
    // in-scope hands-on investigation: a model may have evidence that makes a
    // different first call better. The counter is retained as evaluation
    // telemetry; hard experimental variants are enforced above with feedback.
    if (firstActionBudget && !firstActionBudget.completed) {
      if (isFirstActionCompletionTool(event.toolName)) firstActionBudget.completed = true;
      else if (matchesFirstActionTool(event.toolName, firstActionBudget.allowedToolNames)) firstActionBudget.count += 1;
    }
    if (!toolBudget || (termination.reason === "tool_budget_exhausted" && !termination.continuousRecovery)) {
      if (termination.reason === "tool_budget_exhausted") return { block: true, reason: termination.message };
      return undefined;
    }
    if (toolBudget.count >= toolBudget.max) {
      if (termination.continuousRecovery) {
        // Blocking only this tool call causes Pi to ask the Provider again in
        // the same turn, which can spin through a costly sequence of rejected
        // calls. Preserve the run for a later replan, but end this turn.
        termination.message = `[ProofBlade tool budget blocked this call]\nReason: the run has used all ${toolBudget.max} permitted tool calls. No tool was executed.\nNext: preserve the strongest observation and candidate in the run record, then replan or start a new run with an authorized larger budget before requesting another Provider turn.`;
        termination.reason = "tool_budget_exhausted";
        termination.requested = true;
        return { block: true, reason: termination.message };
      }
      termination.message = `[ProofBlade tool budget blocked this call]\nReason: the run has used all ${toolBudget.max} permitted tool calls. No tool was executed.\nNext: preserve the strongest observation and candidate; a new authorized run or replan is required before more probing.`;
      termination.reason = "tool_budget_exhausted";
      termination.requested = true;
      return { block: true, reason: termination.message };
    }
    toolBudget.count += 1;
    return undefined;
  });
  const unsubscribeProvider = harness.on("before_provider_request", () => {
    if (!termination.requested) return undefined;
    throw new Error(termination.message ?? "ProofBlade stopped a non-converging tool loop.");
  });
  return () => {
    unsubscribeEvents();
    unsubscribeResult();
    unsubscribeToolCall();
    unsubscribeProvider();
  };
}

function isFirstActionCompletionTool(toolName: string): boolean {
  return toolName === "verify_claim" || toolName === "submit_flag" || toolName === "pwn_reproduce" || toolName === "web_reproduce";
}

function matchesFirstActionTool(toolName: string, allowedToolNames: readonly string[]): boolean {
  return allowedToolNames.some((allowed) => allowed === toolName || (allowed === "mcp__*" && toolName.startsWith("mcp__")));
}

/** Give hard experimental gates an actionable tool result, never a bare denial. */
export function ablationBlockMessage(event: AblationDecisionEvent, firstAction?: FirstActionBudget): string {
  const prefix = "[ProofBlade policy blocked this call]";
  if (event.policyName === "first_action") {
    const suggested = firstAction?.allowedToolNames.join(", ") || "the prepared opening tools";
    return `${prefix}\nReason: this explicit ablation hard gate requires an initial observation before ${event.requestedTool ?? "this tool"}; the call was not executed.\nNext: use ${suggested} to establish one target fact, persist its result, then retry the next hypothesis. If existing evidence makes that route wrong, record the deviation for the evaluation run.`;
  }
  if (event.policyName === "phase_route" || event.policyName === "action_bundle") {
    return `${prefix}\nReason: this explicit ablation hard gate found that ${event.requestedTool ?? "the requested tool"} is outside the prepared phase route; the call was not executed.\nNext: use the current phase's suggested observation first, or persist the evidence that justifies a route change and then replan.`;
  }
  if (event.policyName === "duplicate_failure") {
    return `${prefix}\nReason: this explicit ablation hard gate detected a repeated failed call; the call was not executed.\nNext: change the input, tool, or hypothesis and record the prior negative result before retrying.`;
  }
  if (event.policyName === "circuit_breaker") {
    return `${prefix}\nReason: this explicit ablation stop detected a non-converging tool sequence; the call was not executed.\nNext: preserve the strongest observation, choose a materially different probe, and replan before continuing.`;
  }
  return `${prefix}\nReason: ${event.reasonCode}. The call was not executed.\nNext: inspect the current task scope and use an in-scope alternative or request an authorized task update.`;
}

export async function finalizeCodingTurn(options: {
  runId: string;
  controlStore: ControlStore;
  correlationId: string;
  userPrompt: string;
  response: AssistantMessage;
  recoveryCount: number;
  recoveryExhausted: boolean;
  termination: CodingTurnTermination;
  piEntryId?: string;
  claimVerifier: Pick<CodingClaimVerifier, "project">;
  maintainAfterTurn: () => Promise<void>;
}): Promise<AgentOutcome> {
  const rawOutput = options.response.content
    .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  // A guard can interrupt a provider response after the model has emitted a
  // short explanation alongside its tool call. The explanation remains visible
  // below, but the loop must still receive the guard reason and schedule the
  // evidence-first replan; requiring an empty text response would silently lose
  // that signal.
  const confirmed = options.termination.requested === true
    && options.termination.reason !== undefined
    && (options.response.stopReason === "toolUse" || options.response.stopReason === "error");
  options.termination.confirmed = confirmed;
  const projectedOutput = projectCodingAssistantText(rawOutput, options.termination)
    || interruptedTurnMessage(options.response.stopReason, options.response.errorMessage);
  const stopReason = confirmed ? "stop" : options.response.stopReason;
  const errorMessage = confirmed
    ? undefined
    : options.recoveryExhausted
      ? `Context length recovery exhausted after ${options.recoveryCount} attempts.`
      : options.response.errorMessage;
  const initialClaimVerification = await options.claimVerifier.project(options.userPrompt, projectedOutput);
  const output = initialClaimVerification.status === "unverified"
    ? rewriteUnverifiedClaimText(projectedOutput, initialClaimVerification.reason)
    : projectedOutput;
  const claimVerification = initialClaimVerification;
  const task = await options.controlStore.snapshot(options.runId);
  await options.controlStore.append(options.runId, [{
    schemaVersion: 1,
    lane: "main",
    correlationId: options.correlationId,
    actor: "model",
    type: "assistant_message",
    payload: {
      ...persistedAssistantText(task.task.mode, output),
      stopReason,
      claimVerification,
      contextRecoveryCount: options.recoveryCount,
      contextRecoveryExhausted: options.recoveryExhausted,
      piEntryId: options.piEntryId,
      termination: confirmed ? options.termination.reason : undefined,
      providerStopReason: confirmed ? options.response.stopReason : undefined,
    },
  }]);
  await options.maintainAfterTurn();
  return {
    text: output,
    stopReason,
    usage: options.response.usage,
    errorMessage,
    claimVerification,
    termination: confirmed ? options.termination.reason : undefined,
  };
}

function interruptedTurnMessage(stopReason: AssistantMessage["stopReason"], errorMessage?: string): string {
  if (stopReason === "aborted") {
    return [
      "[ProofBlade] 本轮已停止。",
      "当前已完成的 Tool 结果、Artifact 和 Evidence 已保留；恢复后将从最近的完整工具交互继续。",
    ].join("\n");
  }
  const reason = errorMessage?.trim() || "Provider 请求未完成";
  return [
    `[ProofBlade] 本轮未完成：${reason}`,
    "当前已完成的 Tool 结果、Artifact 和 Evidence 已保留；请更换策略后继续。",
  ].join("\n");
}
