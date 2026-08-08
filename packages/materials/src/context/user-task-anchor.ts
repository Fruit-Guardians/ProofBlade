import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const AUTOMATIC_CONTEXT_RECOVERY_MARKER = "[ProofBlade automatic context recovery]";
export const AUTOMATIC_CONTEXT_RECOVERY_PROMPT = `${AUTOMATIC_CONTEXT_RECOVERY_MARKER}\nContinue the unfinished task from the durable checkpoint. Do not repeat completed exploration.`;

export type UserAgentMessage = Extract<AgentMessage, { role: "user" }>;

export function userMessageText(message: UserAgentMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content.trim();
  return message.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n").trim();
}

export function isRealUserTask(message: AgentMessage | undefined): message is UserAgentMessage {
  if (!message || message.role !== "user") return false;
  return userMessageText(message) !== AUTOMATIC_CONTEXT_RECOVERY_PROMPT;
}

export function latestExternalUserMessage(messages: Iterable<AgentMessage>): UserAgentMessage | undefined {
  const list = Array.from(messages);
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (isRealUserTask(message)) return message;
  }
  return undefined;
}
