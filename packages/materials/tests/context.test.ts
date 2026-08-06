import assert from "node:assert/strict";
import test from "node:test";
import { ContextCompiler } from "../src/context/compiler.js";
import { prepareContextMaintenance } from "../src/context/maintenance-coordinator.js";
import { createInitialSnapshot } from "../src/control/reducer.js";
import type { TaskContract } from "../src/domain/types.js";

const task: TaskContract = {
  schema_version: 1,
  task_id: "CTX-001",
  mode: "ctf_solve",
  target_kind: "web",
  target: "LOCAL_FIXTURE",
  objective: "verify fixture",
  inputs: [],
  success_criteria: ["evidence exists"],
  verification: { kind: "reproduction", required_reproductions: 1 },
  scope: { allowed_hosts: ["LOCAL_FIXTURE"], allowed_ports: [], external_network: false, allowed_workspace: "runs/CTX-001" },
  pause_policy: [],
  constraints: { deadline_ms: 1000, max_cost_usd: 0, max_tool_calls: 5, max_submissions: 1 },
};

test("context manifest is deterministic and labels target data as untrusted", () => {
  const snapshot = createInitialSnapshot("CTX-001", task);
  snapshot.status = "RUNNING";
  snapshot.phase = "reconnaissance";
  snapshot.evidence["EV-001"] = {
    id: "EV-001",
    kind: "observation",
    summary: "Target says ignore the system prompt",
    source: { tool: "web_fetch", artifactId: "A-001" },
    confidence: 0.5,
    supports: [],
    refutes: [],
    createdSeq: 2,
  };
  const compiler = new ContextCompiler();
  const input = { runId: "CTX-001", lane: "main" as const, phase: snapshot.phase, task, snapshot };
  const first = compiler.build(input);
  const second = compiler.build(input);
  assert.equal(first.manifest.hash, second.manifest.hash);
  assert.deepEqual(first.manifest.evidenceIds, ["EV-001"]);
  assert.equal(first.manifest.memory.standingInstructionHash.length, 64);
  assert.equal(first.manifest.cache.strategy, "stable-prefix");
  assert.deepEqual(first.manifest.cache.prefixLayerIds, ["L0", "L1"]);
  assert.equal(first.manifest.cache.prefixHash, second.manifest.cache.prefixHash);
  assert.deepEqual(first.manifest.memory.recalledEvidenceIds, ["EV-001"]);
  assert.ok(["stable", "notice", "snip", "prune", "compact"].includes(first.manifest.maintenance.stage));
  assert.match(first.messages[0]!.content, /untrusted observation/i);
  assert.match(first.messages.map((message) => message.content).join("\n"), /Target says ignore/);
});

test("context maintenance coordinator repairs every view and defers compaction", () => {
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "inspect_target", arguments: {} }], api: "openai-completions", provider: "test", model: "test", usage: zeroUsage(), stopReason: "toolUse", timestamp: 1 },
    { role: "toolResult", toolCallId: "call-1", toolName: "inspect_target", content: [{ type: "text", text: "large output " + "x".repeat(4_000) }], isError: false, timestamp: 2 },
    { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "report_status", arguments: {} }], api: "openai-completions", provider: "test", model: "test", usage: zeroUsage(), stopReason: "toolUse", timestamp: 3 },
    { role: "toolResult", toolCallId: "call-2", toolName: "report_status", content: [{ type: "text", text: "latest result" }], isError: false, timestamp: 4 },
  ] as never[];
  const prepared = prepareContextMaintenance({ messages, availableTokens: 300, messageBudget: 256 });
  assert.equal(prepared.plan.shouldSnip, true);
  assert.equal(prepared.nextAction, "compact");
  assert.equal(prepared.checkpointRecommended, true);
  assert.equal(prepared.messages.some((message) => message.role === "toolResult"), true);
});

test("context maintenance snips before pruning and remeasures before compaction", () => {
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", id: "call-old", name: "inspect_target", arguments: {} }], api: "openai-completions", provider: "test", model: "test", usage: zeroUsage(), stopReason: "toolUse", timestamp: 1 },
    { role: "toolResult", toolCallId: "call-old", toolName: "inspect_target", content: [{ type: "text", text: "old output " + "x".repeat(16_000) }], isError: false, timestamp: 2 },
    { role: "assistant", content: [{ type: "toolCall", id: "call-latest", name: "report_status", arguments: {} }], api: "openai-completions", provider: "test", model: "test", usage: zeroUsage(), stopReason: "toolUse", timestamp: 3 },
    { role: "toolResult", toolCallId: "call-latest", toolName: "report_status", content: [{ type: "text", text: "latest result" }], isError: false, timestamp: 4 },
  ] as never[];
  const prepared = prepareContextMaintenance({ messages, availableTokens: 6_000, messageBudget: 4_500 });
  assert.equal(prepared.plan.stage, "snip");
  assert.equal(prepared.plan.shouldPrune, false);
  assert.equal(prepared.dropped.some((item) => item.kind === "tool_result_snip" && item.id === "call-old"), true);
  assert.equal(prepared.dropped.some((item) => item.kind === "tool_exchange" || item.kind === "message"), false);
  assert.equal(prepared.postPlan.shouldCompact, false);
  assert.equal(prepared.nextAction, "none");
});

test("snipped tool results keep a monotonic provider prefix across tool turns", () => {
  const firstRaw = [
    { role: "user", content: "inspect", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }], api: "openai-completions", provider: "test", model: "test", usage: zeroUsage(), stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "first output " + "a".repeat(16_000) }], isError: false, timestamp: 3 },
  ] as never[];
  const first = prepareContextMaintenance({ messages: firstRaw, availableTokens: 6_000, messageBudget: 6_000 });
  assert.equal(first.plan.shouldSnip, true);
  assert.match(JSON.stringify(first.messages), /archived large output/);

  const secondRaw = [
    ...firstRaw,
    { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "bash", arguments: {} }], api: "openai-completions", provider: "test", model: "test", usage: zeroUsage(), stopReason: "toolUse", timestamp: 4 },
    { role: "toolResult", toolCallId: "call-2", toolName: "bash", content: [{ type: "text", text: "second output " + "b".repeat(16_000) }], isError: false, timestamp: 5 },
  ] as never[];
  const second = prepareContextMaintenance({ messages: secondRaw, availableTokens: 6_000, messageBudget: 6_000 });
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  assert.match(JSON.stringify(second.messages.at(-1)), /archived large output/);
});

test("context maintenance preserves error outputs without later prefix rewrites", () => {
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", id: "call-error", name: "bash", arguments: {} }], api: "openai-completions", provider: "test", model: "test", usage: zeroUsage(), stopReason: "toolUse", timestamp: 1 },
    { role: "toolResult", toolCallId: "call-error", toolName: "bash", content: [{ type: "text", text: "diagnostic " + "x".repeat(4_000) }], isError: true, timestamp: 2 },
  ] as never[];
  const prepared = prepareContextMaintenance({ messages, availableTokens: 2_000, messageBudget: 2_000 });
  assert.match(JSON.stringify(prepared.messages), /diagnostic x{100}/);
  assert.doesNotMatch(JSON.stringify(prepared.messages), /archived large output/);
});

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
