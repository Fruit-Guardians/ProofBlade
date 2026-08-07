import type { AssistantMessage } from "@earendil-works/pi-ai";

export const AUTOMATIC_CONTEXT_RECOVERY_MARKER = "[ProofBlade automatic context recovery]";
export const DEFAULT_CONTEXT_LENGTH_RECOVERIES = 2;

export interface ContextLengthRecoveryPort {
  prompt(text: string): Promise<AssistantMessage>;
  compact(reason: string): Promise<unknown>;
}

export interface ContextLengthRecoveryResult {
  response: AssistantMessage;
  recoveryCount: number;
  exhausted: boolean;
}

export async function promptWithContextLengthRecovery(
  port: ContextLengthRecoveryPort,
  prompt: string,
  maxRecoveries = DEFAULT_CONTEXT_LENGTH_RECOVERIES,
): Promise<ContextLengthRecoveryResult> {
  const limit = Math.max(0, Math.floor(maxRecoveries));
  let response = await port.prompt(prompt);
  let recoveryCount = 0;
  while (response.stopReason === "length" && recoveryCount < limit) {
    await port.compact("Context length reached. Preserve verified knowledge and the latest complete tool exchange, then continue the unfinished task.");
    recoveryCount += 1;
    response = await port.prompt(`${AUTOMATIC_CONTEXT_RECOVERY_MARKER}\nContinue the unfinished task from the durable checkpoint. Do not repeat completed exploration.`);
  }
  return { response, recoveryCount, exhausted: response.stopReason === "length" };
}
