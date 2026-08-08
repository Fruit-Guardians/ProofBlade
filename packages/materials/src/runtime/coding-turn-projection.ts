import { AgentHarness } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ControlStore } from "../control/control-store.js";
import type { CodingClaimVerifier } from "../verification/claim-verification.js";
import type { AgentOutcome } from "./pi-adapter.js";
import { RepeatedToolFailureBreaker, repeatedToolFailureMessage } from "./tool-repeat-breaker.js";

export interface CodingTurnTermination {
  message?: string;
}

export function projectCodingAssistantText(output: string, termination: CodingTurnTermination): string {
  return output.trim().length > 0 ? output : termination.message ?? output;
}

export function attachRepeatedToolFailureBreaker<TContext extends object | undefined>(
  harness: AgentHarness<TContext>,
  repeatBreaker: RepeatedToolFailureBreaker,
  termination: CodingTurnTermination,
): () => void {
  return harness.on("tool_result", (event) => {
    const decision = repeatBreaker.observe({
      toolName: event.toolName,
      input: event.input,
      isError: event.isError,
      content: event.content.map((item) => item.type === "text" ? { type: item.type, text: item.text } : { type: item.type }),
    });
    if (!decision.terminate) return undefined;
    termination.message = repeatedToolFailureMessage(event.toolName, decision.count);
    return {
      content: [{ type: "text" as const, text: termination.message }],
      details: { repeatedFailure: true, toolName: event.toolName, count: decision.count, key: decision.key },
      isError: true,
      terminate: true,
    };
  });
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
  const output = projectCodingAssistantText(rawOutput, options.termination);
  const claimVerification = options.claimVerifier.project(options.userPrompt, output);
  await options.controlStore.append(options.runId, [{
    schemaVersion: 1,
    lane: "main",
    correlationId: options.correlationId,
    actor: "model",
    type: "assistant_message",
    payload: {
      text: output,
      stopReason: options.response.stopReason,
      claimVerification,
      contextRecoveryCount: options.recoveryCount,
      contextRecoveryExhausted: options.recoveryExhausted,
      termination: options.termination.message ? "repeated_tool_failure" : undefined,
    },
  }]);
  await options.maintainAfterTurn();
  return {
    text: output,
    stopReason: options.response.stopReason,
    usage: options.response.usage,
    errorMessage: options.recoveryExhausted ? `Context length recovery exhausted after ${options.recoveryCount} attempts.` : options.response.errorMessage,
    claimVerification,
  };
}
