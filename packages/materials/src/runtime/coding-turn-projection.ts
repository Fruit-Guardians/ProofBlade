import { AgentHarness } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ControlStore } from "../control/control-store.js";
import { rewriteUnverifiedClaimText, type CodingClaimVerifier } from "../verification/claim-verification.js";
import type { AgentOutcome } from "./pi-adapter.js";
import { persistedAssistantText } from "./assistant-message.js";
import { ExperimentBudgetBreaker, NoProgressToolBreaker, RepeatedToolFailureBreaker, ToolFailureStormBreaker, experimentBudgetNudge, noProgressToolMessage, noProgressToolNudge, repeatedToolFailureMessage, toolFailureStormMessage, type NoProgressWindow, type ToolEffectPolicyResolver } from "./tool-repeat-breaker.js";
import type { AblationDecisionEvent, AblationPolicyController } from "../evaluation/ablation-policy.js";

export type CodingTurnTerminationReason = "repeated_tool_failure" | "no_progress" | "tool_failure_storm" | "experiment_budget" | "tool_budget_exhausted";

export interface ToolCallBudget {
  max: number;
  count: number;
}

/**
 * Tracks the prepared first-action recommendation independently from the
 * generic tool-call budget. The recommendation can explain a better initial
 * probe, but it never replaces the safety or resource boundaries.
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
  /** Current durable route, refreshed before each provider turn. */
  route?: () => AblationRouteSnapshot | undefined;
  turn?: () => number;
  onDecision?: (event: AblationDecisionEvent) => void | Promise<void>;
}

export interface AblationRouteSnapshot {
  domainPhase: string;
  actionBundles: Array<{ domainPhase: string; toolNames: readonly string[] }>;
}

export interface CodingTurnTermination {
  message?: string;
  requested?: boolean;
  confirmed?: boolean;
  reason?: CodingTurnTerminationReason;
  noProgressWindow?: NoProgressWindow;
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
  deferClaimAcceptance = false,
): () => void {
  let batchOpen = false;
  let batchHasSuccess = false;
  // Cognitive routing is guidance, not a second safety plane. Keep advice
  // attached to the exact tool call so the model receives it alongside the
  // real result instead of losing the reason at the hook boundary.
  const pendingCognitiveAdvice = new Map<string, string[]>();
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
    const cognitiveAdvice = pendingCognitiveAdvice.get(event.toolCallId) ?? [];
    pendingCognitiveAdvice.delete(event.toolCallId);
    const withCognitiveAdvice = (content: typeof event.content) => cognitiveAdvice.length === 0
      ? content
      : [...content, { type: "text" as const, text: cognitiveAdvice.join("\n") }];
    if (firstActionBudget && !firstActionBudget.completed && !event.isError && matchesFirstActionTool(event.toolName, firstActionBudget.allowedToolNames)) {
      firstActionBudget.completed = true;
    }
    if (termination.reason === "tool_budget_exhausted" && !termination.continuousRecovery) {
      return {
        content: withCognitiveAdvice([{ type: "text" as const, text: termination.message ?? "[ProofBlade tool budget exhausted]" }]),
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
      const details = isRecord(event.details) ? event.details : {};
      const verifierReady = event.toolName === "verify_claim" && details.verified === true;
      if (verifierReady && ablationPolicy) {
        const policyEvent = ablationPolicy.controller.decide({
          experimentId: ablationPolicy.experimentId,
          variantId: ablationPolicy.variantId,
          caseId: ablationPolicy.caseId,
          attempt: ablationPolicy.attempt,
          runId: ablationPolicy.runId,
          turn: ablationPolicy.turn?.() ?? 1,
          requestedAction: "tool_result",
          requestedTool: event.toolName,
          stopSuggested: true,
          reasonInputs: { toolName: event.toolName, verified: true, completionId: typeof details.completionId === "string" ? details.completionId : "" },
        });
        void ablationPolicy.onDecision?.(policyEvent);
        if (policyEvent.decision === "advise") {
          return {
            content: withCognitiveAdvice([...event.content, { type: "text" as const, text: stopSuggestionMessage(policyEvent.policyMode) }]),
            details: { ...details, stopSuggestion: true, stopSuggestionMode: policyEvent.policyMode },
            isError: false,
            ...(deferClaimAcceptance ? { terminate: true } : {}),
          };
        }
      }
      const experiment = experimentBudgetBreaker?.observe(observation);
      if (experiment?.terminate) {
        if (termination.continuousRecovery) {
          experimentBudgetBreaker?.reset();
          return {
            content: withCognitiveAdvice([...event.content.map((item) => item.type === "text" ? { type: "text" as const, text: item.text } : item), { type: "text" as const, text: experimentBudgetNudge(experiment) }]),
            details: { experimentBudget: true, advisory: true, count: experiment.count, key: experiment.key, reason: experiment.reason, family: experiment.family },
            isError: event.isError,
          };
        }
        // Advisory, non-terminating: keep the model in control and append a
        // change-tactics nudge to the real tool output instead of stopping the
        // turn and forcing a replan (which interrupts a legitimate multi-step
        // solve). Reset the window so the nudge is periodic, not per-call spam.
        experimentBudgetBreaker?.reset();
        const nudge = experimentBudgetNudge(experiment);
        return {
          content: withCognitiveAdvice([...event.content.map((item) => item.type === "text" ? { type: "text" as const, text: item.text } : item), { type: "text" as const, text: nudge }]),
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
            ].concat(cognitiveAdvice.length === 0 ? [] : [{ type: "text" as const, text: cognitiveAdvice.join("\n") }]),
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
          content: withCognitiveAdvice([{ type: "text" as const, text: terminationMessage }]),
          details: { noProgress: true, toolName: event.toolName, count: progress.count, key: progress.key, window: termination.noProgressWindow },
          isError: false,
          terminate: true,
        };
      }
      if (batchOpen) batchHasSuccess = true;
      else repeatBreaker.reset();
      return cognitiveAdvice.length === 0 ? undefined : { content: withCognitiveAdvice(event.content) };
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
      // Advisory, non-terminating (same as the success path): append the nudge
      // to the real error output and reset the window; do not stop the turn.
      experimentBudgetBreaker?.reset();
      const nudge = experimentBudgetNudge(experiment);
      return {
        content: withCognitiveAdvice([...event.content.map((item) => item.type === "text" ? { type: "text" as const, text: item.text } : item), { type: "text" as const, text: nudge }]),
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
        content: withCognitiveAdvice([...event.content.map((item) => item.type === "text" ? { type: "text" as const, text: item.text } : item), { type: "text" as const, text: toolFailureStormMessage(storm.count) }]),
        details: { failureStorm: true, advisory: true, count: storm.count, key: storm.key },
        isError: true,
      };
    }
    if (ablationRelaxesFailureGuard && decision.terminate) {
      repeatBreaker.reset();
      return {
        content: withCognitiveAdvice([...event.content.map((item) => item.type === "text" ? { type: "text" as const, text: item.text } : item), { type: "text" as const, text: repeatedToolFailureMessage(event.toolName, decision.count) }]),
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
    if (!decision.terminate) return cognitiveAdvice.length === 0 ? undefined : { content: withCognitiveAdvice(event.content) };
    if (termination.continuousRecovery) {
      repeatBreaker.reset();
      return {
        content: withCognitiveAdvice([{ type: "text" as const, text: `${repeatedToolFailureMessage(event.toolName, decision.count)}\n${experimentBudgetNudge({ count: decision.count, terminate: false, key: decision.key, reason: "tool_calls" })}` }]),
        details: { repeatedFailure: true, advisory: true, toolName: event.toolName, count: decision.count, key: decision.key },
        isError: true,
      };
    }
    termination.message = repeatedToolFailureMessage(event.toolName, decision.count);
    termination.reason = "repeated_tool_failure";
    termination.requested = true;
    return {
      content: withCognitiveAdvice([{ type: "text" as const, text: termination.message }]),
      details: { repeatedFailure: true, toolName: event.toolName, count: decision.count, key: decision.key },
      isError: true,
      terminate: true,
    };
  });
  const unsubscribeToolCall = harness.on("tool_call", (event) => {
    const firstActionViolation = firstActionBudget && !firstActionBudget.completed
      && !isFirstActionCompletionTool(event.toolName)
      && !matchesFirstActionTool(event.toolName, firstActionBudget.allowedToolNames);
    const route = ablationPolicy?.route?.();
    const completionTool = isCompletionTool(event.toolName);
    const activeBundle = route?.actionBundles.find((bundle) => bundle.domainPhase === route.domainPhase);
    const matchesActiveBundle = activeBundle ? matchesActionBundleTool(event.toolName, activeBundle.toolNames) : true;
    const appearsInAnotherPhase = route?.actionBundles.some((bundle) => bundle.domainPhase !== route.domainPhase && matchesActionBundleTool(event.toolName, bundle.toolNames)) ?? false;
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
      ...(activeBundle && !completionTool && !matchesActiveBundle ? { actionBundleViolation: true } : {}),
      ...(activeBundle && !completionTool && !matchesActiveBundle && appearsInAnotherPhase ? { phaseRouteViolation: true } : {}),
      reasonInputs: {
        toolName: event.toolName,
        firstActionViolation: Boolean(firstActionViolation),
        domainPhase: route?.domainPhase ?? "",
        activeBundleId: activeBundle?.domainPhase ?? "",
        actionBundleViolation: Boolean(activeBundle && !completionTool && !matchesActiveBundle),
        phaseRouteViolation: Boolean(activeBundle && !completionTool && !matchesActiveBundle && appearsInAnotherPhase),
      },
    });
    if (policyEvent) void ablationPolicy?.onDecision?.(policyEvent);
    if (policyEvent?.decision === "terminate" || policyEvent?.decision === "block") {
      return { block: true, reason: cognitiveGateBlockReason(policyEvent.reasonCode, event.toolName, firstActionBudget, route?.domainPhase, activeBundle?.toolNames) };
    }
    const cognitiveAdvice: string[] = [];
    const adviceEnabled = policyEvent?.policyMode !== "off";
    if (firstActionBudget && !firstActionBudget.completed && adviceEnabled) {
      if (isFirstActionCompletionTool(event.toolName)) {
        firstActionBudget.completed = true;
      } else if (!matchesFirstActionTool(event.toolName, firstActionBudget.allowedToolNames)) {
        cognitiveAdvice.push(`[ProofBlade advisory: first action] ${event.toolName} is outside the suggested initial probe (${firstActionBudget.allowedToolNames.join(", ")}). The call was allowed; keep it if it is the best next step, and persist the resulting fact before branching.`);
      } else if (firstActionBudget.count >= firstActionBudget.maxCalls) {
        cognitiveAdvice.push(`[ProofBlade advisory: first action budget] The suggested initial probe has reached ${firstActionBudget.maxCalls} call${firstActionBudget.maxCalls === 1 ? "" : "s"}. This is guidance only; preserve the strongest observation and choose the next bounded action.`);
      } else {
        firstActionBudget.count += 1;
      }
    }
    if (adviceEnabled && activeBundle && !completionTool && !matchesActiveBundle) {
      cognitiveAdvice.push(`[ProofBlade advisory: action bundle] ${event.toolName} is outside the suggested ${activeBundle.domainPhase} bundle (${activeBundle.toolNames.join(", ")}). The call was allowed; continue when justified and record the observation.`);
    }
    if (adviceEnabled && activeBundle && !completionTool && !matchesActiveBundle && appearsInAnotherPhase) {
      cognitiveAdvice.push(`[ProofBlade advisory: phase route] ${event.toolName} belongs to another suggested phase while the durable phase is ${route?.domainPhase ?? "unknown"}. The route is advisory; continue if this is the best action and explain the phase transition in evidence.`);
    }
    const queueCognitiveAdvice = () => {
      if (cognitiveAdvice.length > 0) pendingCognitiveAdvice.set(event.toolCallId, cognitiveAdvice);
    };
    if (!toolBudget || (termination.reason === "tool_budget_exhausted" && !termination.continuousRecovery)) {
      if (termination.reason === "tool_budget_exhausted") return { block: true, reason: termination.message };
      queueCognitiveAdvice();
      return undefined;
    }
    if (toolBudget.count >= toolBudget.max) {
      if (termination.continuousRecovery) {
        return { block: true, reason: `[ProofBlade tool budget advisory: ${toolBudget.max} calls reached] Continue only after consolidating current findings into one bounded next action.` };
      }
      termination.message = `[ProofBlade tool budget exhausted: ${toolBudget.max} calls per run] Stop probing and preserve the strongest evidence.`;
      termination.reason = "tool_budget_exhausted";
      termination.requested = true;
      return { block: true, reason: termination.message };
    }
    toolBudget.count += 1;
    queueCognitiveAdvice();
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
  return isCompletionTool(toolName);
}

function isCompletionTool(toolName: string): boolean {
  return toolName === "verify_claim" || toolName === "submit_flag" || toolName === "pwn_reproduce" || toolName === "web_reproduce";
}

function matchesFirstActionTool(toolName: string, allowedToolNames: readonly string[]): boolean {
  return allowedToolNames.some((allowed) => allowed === toolName || (allowed === "mcp__*" && toolName.startsWith("mcp__")));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stopSuggestionMessage(mode: string): string {
  return mode === "verifier_driven"
    ? "[ProofBlade stop suggestion] The candidate has passed the deterministic claim check. Stop exploratory calls and let the outer independent Verifier finish the Completion; keep the existing Artifact/Evidence references."
    : "[ProofBlade stop suggestion] The candidate has passed the deterministic claim check. Prefer stopping exploration and preserving the current Artifact/Evidence while the outer Verifier completes the run.";
}

function matchesActionBundleTool(toolName: string, allowedToolNames: readonly string[]): boolean {
  return matchesFirstActionTool(toolName, allowedToolNames);
}

function cognitiveGateBlockReason(
  reasonCode: string,
  toolName: string,
  firstActionBudget: FirstActionBudget | undefined,
  domainPhase: string | undefined,
  activeBundleTools: readonly string[] | undefined,
): string {
  if (reasonCode === "first_action_gate") {
    const tools = firstActionBudget?.allowedToolNames.join(", ") || "the prepared first-action tool";
    return `[ProofBlade ablation] Experimental first-action gate rejected ${toolName}: use ${tools} first, persist its observation, then retry this action.`;
  }
  if (reasonCode === "phase_route_gate") {
    return `[ProofBlade ablation] Experimental phase-route gate rejected ${toolName}: the durable phase is ${domainPhase ?? "unknown"}. Complete or explicitly record the current phase before moving to another phase.`;
  }
  if (reasonCode === "action_bundle_gate") {
    const tools = activeBundleTools?.join(", ") || "the current phase bundle";
    return `[ProofBlade ablation] Experimental action-bundle gate rejected ${toolName}: use one of ${tools} for ${domainPhase ?? "the current phase"}, or record why the route must change.`;
  }
  return `[ProofBlade ablation] ${reasonCode}; the experimental policy did not allow ${toolName}.`;
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
