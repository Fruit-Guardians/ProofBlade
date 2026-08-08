import { AgentHarness } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ControlStore } from "../control/control-store.js";
import type { CodingClaimVerifier } from "../verification/claim-verification.js";
import type { AgentOutcome } from "./pi-adapter.js";
import { RepeatedToolFailureBreaker, repeatedToolFailureMessage } from "./tool-repeat-breaker.js";

export interface CodingTurnTermination {
  message?: string;
  requested?: boolean;
  confirmed?: boolean;
}

export function projectCodingAssistantText(output: string, termination: CodingTurnTermination): string {
  return output.trim().length > 0 ? output : termination.confirmed ? termination.message ?? output : output;
}

export function attachRepeatedToolFailureBreaker<TContext extends object | undefined>(
  harness: AgentHarness<TContext>,
  repeatBreaker: RepeatedToolFailureBreaker,
  termination: CodingTurnTermination,
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
    if (!event.isError) {
      if (batchOpen) batchHasSuccess = true;
      else repeatBreaker.reset();
      return undefined;
    }
    const decision = repeatBreaker.observe({
      toolName: event.toolName,
      input: event.input,
      isError: event.isError,
      content: event.content.map((item) => item.type === "text" ? { type: item.type, text: item.text } : { type: item.type }),
    });
    if (!decision.terminate) return undefined;
    termination.message = repeatedToolFailureMessage(event.toolName, decision.count);
    termination.requested = true;
    return {
      content: [{ type: "text" as const, text: termination.message }],
      details: { repeatedFailure: true, toolName: event.toolName, count: decision.count, key: decision.key },
      isError: true,
      terminate: true,
    };
  });
  const unsubscribeProvider = harness.on("before_provider_request", () => {
    if (!termination.requested) return undefined;
    throw new Error(termination.message ?? "ProofBlade stopped a repeated tool failure loop.");
  });
  return () => {
    unsubscribeEvents();
    unsubscribeResult();
    unsubscribeProvider();
  };
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
  claimVerifier: Pick<CodingClaimVerifier, "project">;
  maintainAfterTurn: () => Promise<void>;
}): Promise<AgentOutcome> {
  const rawOutput = options.response.content
    .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const confirmed = options.termination.requested === true
    && rawOutput.trim().length === 0
    && (options.response.stopReason === "toolUse" || options.response.stopReason === "error");
  options.termination.confirmed = confirmed;
  const output = projectCodingAssistantText(rawOutput, options.termination);
  const stopReason = confirmed ? "stop" : options.response.stopReason;
  const errorMessage = confirmed
    ? undefined
    : options.recoveryExhausted
      ? `Context length recovery exhausted after ${options.recoveryCount} attempts.`
      : options.response.errorMessage;
  const claimVerification = options.claimVerifier.project(options.userPrompt, output);
  await options.controlStore.append(options.runId, [{
    schemaVersion: 1,
    lane: "main",
    correlationId: options.correlationId,
    actor: "model",
    type: "assistant_message",
    payload: {
      text: output,
      stopReason,
      claimVerification,
      contextRecoveryCount: options.recoveryCount,
      contextRecoveryExhausted: options.recoveryExhausted,
      termination: confirmed ? "repeated_tool_failure" : undefined,
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
    termination: confirmed ? "repeated_tool_failure" : undefined,
  };
}
