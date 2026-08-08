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

export interface ToolPairViolation {
  kind: "missing-result" | "orphan-result" | "duplicate-result" | "misordered-result";
  toolCallId: string;
  messageIndex: number;
}

export function repairAgentMessages(messages: AgentMessage[]): AgentContextPruneResult {
  const output = structuredClone(messages);
  const dropped: AgentContextPruneResult["dropped"] = [];
  repairToolPairs(output, dropped);
  removeInvalidToolResults(output, dropped);
  repairToolPairs(output, dropped);
  return { messages: output, estimatedTokens: messageTokens(output), dropped };
}

export function toolPairViolations(messages: AgentMessage[]): ToolPairViolation[] {
  const violations: ToolPairViolation[] = [];
  const validResults = new Set<number>();
  for (let index = 0; index < messages.length; index += 1) {
    const calls = assistantCallIds(messages[index]);
    if (calls.length === 0) continue;
    const expected = new Set(calls);
    const seen = new Set<string>();
    let batchIndex = 0;
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor]?.role === "toolResult") {
      const result = messages[cursor];
      if (result?.role === "toolResult" && expected.has(result.toolCallId) && !seen.has(result.toolCallId)) {
        seen.add(result.toolCallId);
        validResults.add(cursor);
        if (calls[batchIndex] !== result.toolCallId) {
          violations.push({ kind: "misordered-result", toolCallId: result.toolCallId, messageIndex: cursor });
        }
      } else if (result?.role === "toolResult") {
        violations.push({
          kind: seen.has(result.toolCallId) ? "duplicate-result" : "orphan-result",
          toolCallId: result.toolCallId,
          messageIndex: cursor,
        });
      }
      batchIndex += 1;
      cursor += 1;
    }
    for (const toolCallId of calls) {
      if (!seen.has(toolCallId)) violations.push({ kind: "missing-result", toolCallId, messageIndex: index });
    }
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "toolResult" && !validResults.has(index) && !violations.some((item) => item.messageIndex === index)) {
      violations.push({ kind: "orphan-result", toolCallId: message.toolCallId, messageIndex: index });
    }
  }
  return violations;
}

export function pruneAgentMessages(messages: AgentMessage[], maxTokens: number, options: AgentContextPruneOptions = {}): AgentContextPruneResult {
  const output = structuredClone(messages);
  const dropped: AgentContextPruneResult["dropped"] = [];
  repairToolPairs(output, dropped);
  const toolResultIndexes = output.flatMap((message, index) => message.role === "toolResult" ? [index] : []);
  for (const index of toolResultIndexes) {
    const message = output[index];
    if (!message || message.role !== "toolResult") continue;
    // Error output is diagnostic tail state. Keeping it verbatim from first
    // appearance avoids a later raw-to-snip transition at an older prefix.
    if (message.isError) continue;
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
  removeInvalidToolResults(output, dropped);
  return { messages: output, estimatedTokens: messageTokens(output), dropped };
}

function repairToolPairs(messages: AgentMessage[], dropped: AgentContextPruneResult["dropped"]): void {
  for (let index = 0; index < messages.length; index += 1) {
    const assistant = messages[index];
    const calls = assistantCalls(assistant);
    if (calls.length === 0) continue;
    const results = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
    let cursor = index + 1;
    while (cursor < messages.length) {
      const result = messages[cursor];
      if (result?.role !== "toolResult") break;
      if (calls.some((call) => call.id === result.toolCallId) && !results.has(result.toolCallId)) results.set(result.toolCallId, result);
      else dropped.push({ kind: "message", id: `orphan-or-duplicate-tool-result:${result.toolCallId}` });
      cursor += 1;
    }
    const timestamp = typeof (assistant as { timestamp?: unknown }).timestamp === "number"
      ? (assistant as { timestamp: number }).timestamp
      : 0;
    const ordered = calls.map((call) => {
      const result = results.get(call.id);
      if (result) return result;
      dropped.push({ kind: "message", id: `missing-tool-result:${call.id}` });
      return {
        role: "toolResult" as const,
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text" as const, text: '{"error":"Tool result missing (interrupted)"}' }],
        isError: true,
        timestamp,
      };
    });
    messages.splice(index + 1, cursor - index - 1, ...ordered);
    index += ordered.length;
  }
}

function removeInvalidToolResults(messages: AgentMessage[], dropped: AgentContextPruneResult["dropped"]): void {
  for (const violation of toolPairViolations(messages).filter((item) => item.kind !== "missing-result" && item.kind !== "misordered-result").sort((a, b) => b.messageIndex - a.messageIndex)) {
    const message = messages[violation.messageIndex];
    if (message?.role !== "toolResult") continue;
    messages.splice(violation.messageIndex, 1);
    dropped.push({ kind: "message", id: `${violation.kind}:${violation.toolCallId}` });
  }
}

function assistantCallIds(message: AgentMessage | undefined): string[] {
  return assistantCalls(message).map((call) => call.id);
}

function assistantCalls(message: AgentMessage | undefined): Array<{ id: string; name: string }> {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.flatMap((item) => item.type === "toolCall" ? [{ id: item.id, name: item.name }] : []);
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
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  let index = 0;
  while (messageTokens(messages) > maxTokens && messages.length > 4 && index < messages.length - 4) {
    const message = messages[index];
    if (message === latestUser || message?.role === "toolResult") {
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
