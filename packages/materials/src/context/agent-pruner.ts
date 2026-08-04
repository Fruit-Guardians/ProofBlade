import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { snipText } from "@proofblade/molecules";
import { estimateTokens } from "../domain/utils.js";

export interface AgentContextPruneResult {
  messages: AgentMessage[];
  estimatedTokens: number;
  dropped: Array<{ kind: "tool_result_snip" | "tool_exchange" | "message"; id?: string }>;
}

export function pruneAgentMessages(messages: AgentMessage[], maxTokens: number): AgentContextPruneResult {
  const output = structuredClone(messages);
  const dropped: AgentContextPruneResult["dropped"] = [];
  const toolResultIndexes = output.flatMap((message, index) => message.role === "toolResult" ? [index] : []);
  for (const index of toolResultIndexes.slice(0, -2)) {
    const message = output[index];
    if (!message || message.role !== "toolResult") continue;
    const text = message.content.map((item) => item.type === "text" ? item.text : `[${item.mimeType} image]`).join("\n");
    const snipped = snipText(text, 768);
    if (!snipped.truncated) continue;
    const refs = [...new Set(text.match(/A-[a-zA-Z0-9-]+/g) ?? [])];
    message.content = [{ type: "text", text: `${snipped.text}\n[artifact refs: ${refs.join(", ") || "see control store"}]` }];
    message.details = undefined;
    dropped.push({ kind: "tool_result_snip", id: message.toolCallId });
  }
  trimOldUsers(output, maxTokens, dropped);
  trimToolExchanges(output, maxTokens, dropped);
  trimOldMessages(output, maxTokens, dropped);
  return { messages: output, estimatedTokens: messageTokens(output), dropped };
}

function trimOldUsers(messages: AgentMessage[], maxTokens: number, dropped: AgentContextPruneResult["dropped"]): void {
  const userIndexes = messages.flatMap((message, index) => message.role === "user" ? [index] : []);
  for (const index of userIndexes.slice(0, -2).reverse()) {
    if (messageTokens(messages) <= maxTokens) break;
    messages.splice(index, 1);
    dropped.push({ kind: "message", id: `user:${index}` });
  }
}

function trimToolExchanges(messages: AgentMessage[], maxTokens: number, dropped: AgentContextPruneResult["dropped"]): void {
  const spans: Array<{ start: number; end: number; id: string }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const calls = message.content.filter((item) => item.type === "toolCall");
    if (calls.length === 0) continue;
    let end = index;
    while (end + 1 < messages.length && messages[end + 1]?.role === "toolResult") end += 1;
    spans.push({ start: index, end, id: calls.map((item) => item.id).join(",") });
  }
  for (const span of spans.slice(0, -1).reverse()) {
    if (messageTokens(messages) <= maxTokens) break;
    messages.splice(span.start, span.end - span.start + 1);
    dropped.push({ kind: "tool_exchange", id: span.id });
  }
}

function trimOldMessages(messages: AgentMessage[], maxTokens: number, dropped: AgentContextPruneResult["dropped"]): void {
  let index = 0;
  while (messageTokens(messages) > maxTokens && messages.length > 4 && index < messages.length - 4) {
    const message = messages[index];
    if (message?.role === "toolResult") {
      index += 1;
      continue;
    }
    messages.splice(index, 1);
    dropped.push({ kind: "message", id: `${message?.role ?? "unknown"}:${index}` });
  }
}

function messageTokens(messages: AgentMessage[]): number {
  return estimateTokens(JSON.stringify(messages));
}
