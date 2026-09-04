import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { snipText } from "@proofblade/molecules";
import { estimateTokens } from "../domain/utils.js";
import { isRealUserTask, latestExternalUserMessage } from "./user-task-anchor.js";

const MAX_CONTEXT_REFS = 32;
const MAX_CONTEXT_REF_LENGTH = 128;

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
  enforceFinalTokenBudget(output, maxTokens, dropped);
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
  return [...new Set(`${text}\n${detailText}`.match(/\b(?:A|E|F|H|I|C|CP|J)-[a-zA-Z0-9-]+\b/g) ?? [])]
    .sort()
    .slice(0, MAX_CONTEXT_REFS)
    .map((ref) => ref.slice(0, MAX_CONTEXT_REF_LENGTH));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimOldUsers(messages: AgentMessage[], maxTokens: number, dropped: AgentContextPruneResult["dropped"]): void {
  const externalUserIndexes = messages.flatMap((message, index) => isRealUserTask(message) ? [index] : []);
  const internalRecoveryIndexes = messages.flatMap((message, index) => message.role === "user" && !isRealUserTask(message) ? [index] : []);
  for (const index of [...internalRecoveryIndexes, ...externalUserIndexes.slice(0, -2)].sort((a, b) => b - a)) {
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
  const latestUser = latestExternalUserMessage(messages);
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

/**
 * Pruning preserves useful recent state first, but provider input limits are a
 * hard invariant.  The retained tail can still contain one enormous tool
 * result, user task, or historic tool arguments, so finish with a structural
 * cap rather than relying on the four-message retention floor.
 */
function enforceFinalTokenBudget(messages: AgentMessage[], maxTokens: number, dropped: AgentContextPruneResult["dropped"]): void {
  let guard = Math.max(16, messages.length * 4);
  while (messageTokens(messages) > maxTokens && guard-- > 0) {
    const protectedIndexes = latestRecoveryIndexes(messages);
    let index = largestMessageIndex(messages);
    if (index < 0) break;
    const before = messageTokens(messages);
    if (shrinkMessage(messages[index]!)) {
      dropped.push({ kind: "tool_result_snip", id: messageId(messages[index]!, index) });
      if (messageTokens(messages) < before) continue;
    }
    if (protectedIndexes.has(index)) {
      index = largestMessageIndex(messages, (candidate) => !protectedIndexes.has(candidate));
      if (index < 0) break;
    }
    if (!dropExchangeAt(messages, index, dropped)) break;
  }
}

function latestRecoveryIndexes(messages: AgentMessage[]): Set<number> {
  const protectedIndexes = new Set<number>();
  const latestUser = latestExternalUserMessage(messages);
  const latestUserIndex = latestUser ? messages.indexOf(latestUser) : -1;
  if (latestUserIndex >= 0) protectedIndexes.add(latestUserIndex);
  const assistantIndex = [...messages].map((item, position) => ({ item, position }))
    .reverse().find(({ item, position }) => item.role === "assistant" && assistantCalls(item).length > 0 && position + 1 < messages.length && messages[position + 1]?.role === "toolResult")?.position;
  if (assistantIndex === undefined) return protectedIndexes;
  let end = assistantIndex;
  while (end + 1 < messages.length && messages[end + 1]?.role === "toolResult") end += 1;
  for (let index = assistantIndex; index <= end; index += 1) protectedIndexes.add(index);
  return protectedIndexes;
}

function largestMessageIndex(messages: AgentMessage[], include: (index: number) => boolean = () => true): number {
  let selected = -1;
  let largest = 0;
  for (let index = 0; index < messages.length; index += 1) {
    if (!include(index)) continue;
    const size = estimateTokens(JSON.stringify(messages[index]));
    if (size > largest) { largest = size; selected = index; }
  }
  return selected;
}

function shrinkMessage(message: AgentMessage): boolean {
  if (message.role === "toolResult") {
    const original = message.content.map((item) => item.type === "text" ? item.text : `[${item.mimeType} image]`).join("\n");
    const refs = extractContextRefs(original, message.details);
    const text = snipText(original, 256).text;
    message.content = [{ type: "text", text: `${text}\n[context hard cap; refs: ${refs.join(", ") || "see control store"}]` }];
    message.details = { contextMaintenance: { tier: "hard_cap", refs } };
    return true;
  }
  if (message.role === "user" || message.role === "custom") {
    if (typeof message.content !== "string" || message.content.length <= 256) return false;
    message.content = snipText(message.content, 256).text;
    return true;
  }
  if (message.role === "assistant") {
    let changed = false;
    message.content = message.content.map((item) => {
      if (item.type === "text" && item.text.length > 256) { changed = true; return { ...item, text: snipText(item.text, 256).text }; }
      if (item.type === "toolCall" && estimateTokens(JSON.stringify(item.arguments)) > 128) { changed = true; return { ...item, arguments: { contextTruncated: true } }; }
      return item;
    });
    return changed;
  }
  return false;
}

function dropExchangeAt(messages: AgentMessage[], index: number, dropped: AgentContextPruneResult["dropped"]): boolean {
  const message = messages[index];
  if (!message) return false;
  if (message.role === "assistant" && assistantCalls(message).length > 0) {
    let end = index;
    while (end + 1 < messages.length && messages[end + 1]?.role === "toolResult") end += 1;
    messages.splice(index, end - index + 1);
    dropped.push({ kind: "tool_exchange", id: `hard-cap:${index}` });
    return true;
  }
  if (message.role === "toolResult") {
    const assistantIndex = messages.findIndex((candidate) => candidate?.role === "assistant" && assistantCalls(candidate).some((call) => call.id === message.toolCallId));
    if (assistantIndex >= 0) return dropExchangeAt(messages, assistantIndex, dropped);
  }
  messages.splice(index, 1);
  dropped.push({ kind: "message", id: `hard-cap:${messageId(message, index)}` });
  return true;
}

function messageId(message: AgentMessage, index: number): string {
  return message.role === "toolResult" ? message.toolCallId : `${message.role}:${index}`;
}

function messageTokens(messages: AgentMessage[]): number {
  // Keep maintenance thresholds compatible with the provider's character
  // approximation. UTF-8 byte limits are enforced separately by
  // boundModelText for model-facing snippets.
  return Math.ceil(JSON.stringify(messages).length / 4);
}
