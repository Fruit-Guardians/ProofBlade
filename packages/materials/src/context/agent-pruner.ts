import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { snipText } from "@proofblade/molecules";
import { estimateTokens } from "../domain/utils.js";

export interface AgentContextPruneResult {
  messages: AgentMessage[];
  estimatedTokens: number;
  dropped: Array<{ kind: "tool_result_snip" | "tool_exchange" | "message"; id?: string }>;
}

export type AgentContextPruneMode = "snip" | "prune" | "emergency";

export interface AgentContextPruneOptions {
  mode?: AgentContextPruneMode;
}

export function pruneAgentMessages(messages: AgentMessage[], maxTokens: number, options: AgentContextPruneOptions = {}): AgentContextPruneResult {
  const output = structuredClone(messages);
  const dropped: AgentContextPruneResult["dropped"] = [];
  repairToolPairs(output, dropped);
  const toolResultIndexes = output.flatMap((message, index) => message.role === "toolResult" ? [index] : []);
  for (const index of toolResultIndexes.slice(0, -2)) {
    const message = output[index];
    if (!message || message.role !== "toolResult") continue;
    const text = message.content.map((item) => item.type === "text" ? item.text : `[${item.mimeType} image]`).join("\n");
    const tier = outputTier(text.length);
    if (tier === "small") continue;
    const snipped = snipText(text, tier === "large" ? 1_024 : 768);
    if (!snipped.truncated) continue;
    const refs = extractContextRefs(text, message.details);
    message.content = [{ type: "text", text: `${snipped.text}\n[archived ${tier} output; refs: ${refs.join(", ") || "see control store"}]` }];
    message.details = {
      ...(isRecord(message.details) ? message.details : {}),
      contextMaintenance: { tier, originalChars: snipped.originalChars, omittedChars: snipped.omittedChars, refs },
    };
    dropped.push({ kind: "tool_result_snip", id: message.toolCallId });
  }
  if ((options.mode ?? "prune") !== "snip") {
    trimOldUsers(output, maxTokens, dropped);
    trimToolExchanges(output, maxTokens, dropped);
    trimOldMessages(output, maxTokens, dropped);
  }
  repairToolPairs(output, dropped);
  removeOrphanToolResults(output, dropped);
  return { messages: output, estimatedTokens: messageTokens(output), dropped };
}

function repairToolPairs(messages: AgentMessage[], dropped: AgentContextPruneResult["dropped"]): void {
  for (let index = 0; index < messages.length; index += 1) {
    const assistant = messages[index];
    const callIds = assistantCallIds(assistant);
    if (callIds.length === 0) continue;
    const resultIds = new Set<string>();
    let cursor = index + 1;
    while (cursor < messages.length) {
      const result = messages[cursor];
      if (result?.role !== "toolResult") break;
      resultIds.add(result.toolCallId);
      cursor += 1;
    }
    const missing = callIds.filter((callId) => !resultIds.has(callId));
    if (missing.length === 0) continue;
    const timestamp = typeof (assistant as { timestamp?: unknown }).timestamp === "number"
      ? (assistant as { timestamp: number }).timestamp
      : 0;
    const placeholders = missing.map((toolCallId) => ({
      role: "toolResult" as const,
      toolCallId,
      toolName: "unknown",
      content: [{ type: "text" as const, text: '{"error":"Tool result missing (interrupted)"}' }],
      isError: true,
      timestamp,
    }));
    messages.splice(cursor, 0, ...placeholders);
    dropped.push(...missing.map((toolCallId) => ({ kind: "message" as const, id: `missing-tool-result:${toolCallId}` })));
    index = cursor + placeholders.length - 1;
  }
}

function removeOrphanToolResults(messages: AgentMessage[], dropped: AgentContextPruneResult["dropped"]): void {
  const knownCalls = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      for (const callId of assistantCallIds(message)) knownCalls.add(callId);
      continue;
    }
    if (message?.role === "toolResult" && !knownCalls.has(message.toolCallId)) {
      messages.splice(index, 1);
      dropped.push({ kind: "message", id: `orphan-tool-result:${message.toolCallId}` });
      index -= 1;
    }
  }
}

function assistantCallIds(message: AgentMessage | undefined): string[] {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.flatMap((item) => item.type === "toolCall" ? [item.id] : []);
}

function outputTier(chars: number): "small" | "medium" | "large" {
  if (chars <= 768) return "small";
  if (chars <= 12_000) return "medium";
  return "large";
}

function extractContextRefs(text: string, details: unknown): string[] {
  const detailText = isRecord(details) ? JSON.stringify(details) : "";
  return [...new Set(`${text}\n${detailText}`.match(/\b(?:A|E|F|H|I|C|CP|J)-[a-zA-Z0-9-]+\b/g) ?? [])].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
