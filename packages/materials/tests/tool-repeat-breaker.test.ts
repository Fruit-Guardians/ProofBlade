import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentHarness, JsonlSessionRepo, NodeExecutionEnv, type AgentHarnessTool } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ControlStore } from "../src/control/control-store.js";
import type { TaskContract } from "../src/domain/types.js";
import { attachRepeatedToolFailureBreaker, finalizeCodingTurn, projectCodingAssistantText, type CodingTurnTermination } from "../src/runtime/coding-turn-projection.js";
import { RepeatedToolFailureBreaker, repeatedToolFailureMessage } from "../src/runtime/tool-repeat-breaker.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";

const failed = (input: Record<string, unknown>, text = "tool rejected the arguments") => ({
  toolName: "evidence",
  input,
  isError: true,
  content: [{ type: "text", text }],
});

test("[contract:evidence-repeat-breaker] repeated tool failures terminate after a bounded number of identical calls", () => {
  const breaker = new RepeatedToolFailureBreaker(3);
  assert.equal(breaker.observe(failed({ operation: "inspect_forest", maxChars: 12000 })).terminate, false);
  assert.equal(breaker.observe(failed({ operation: "inspect_forest", maxChars: 12000 })).terminate, false);
  const decision = breaker.observe(failed({ operation: "inspect_forest", maxChars: 12000 }));
  assert.equal(decision.count, 3);
  assert.equal(decision.terminate, true);
  assert.match(repeatedToolFailureMessage("evidence", decision.count), /infinite loop/);
});

test("successful or different tool calls reset the repeated failure sequence", () => {
  const breaker = new RepeatedToolFailureBreaker(3);
  breaker.observe(failed({ operation: "inspect_forest" }));
  breaker.observe(failed({ operation: "inspect_tree", treeId: "TREE-1" }));
  assert.equal(breaker.observe(failed({ operation: "inspect_forest" })).count, 1);
  assert.equal(breaker.observe({ toolName: "evidence", input: { operation: "record" }, isError: false, content: [{ type: "text", text: "ok" }] }).count, 0);
  assert.equal(breaker.observe(failed({ operation: "inspect_forest" })).count, 1);
});

test("a breaker message only fills an otherwise empty assistant response", () => {
  const termination = { message: "recover with different arguments", confirmed: true };
  assert.equal(projectCodingAssistantText("model explanation", termination), "model explanation");
  assert.equal(projectCodingAssistantText("", termination), termination.message);
  termination.confirmed = false;
  assert.equal(projectCodingAssistantText("", termination), "");
});

test("[contract:repeated-tool-failure-visible] real Harness termination produces and persists a visible assistant reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-repeat-visible-"));
  const env = new NodeExecutionEnv({ cwd: root });
  try {
    const runId = "REPEAT-VISIBLE-001";
    const controlStore = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await controlStore.createRun(runId, task(runId, root));
    const sessionRepo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "pi-sessions") });
    const session = await sessionRepo.create({ id: `${runId}-chat`, cwd: root, metadata: { runId, lane: "main" } });
    const faux = fauxProvider({ provider: `faux-${runId}` });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([1, 2, 3].map((index) => fauxAssistantMessage(
      fauxToolCall("evidence", { operation: "inspect_forest", maxChars: 256 }, { id: `call-${index}` }),
      { stopReason: "toolUse" },
    )));
    const evidenceTool: AgentHarnessTool<undefined> = {
      name: "evidence",
      label: "evidence",
      description: "Always fails for the repeated failure integration test.",
      parameters: Type.Object({
        operation: Type.String(),
        maxChars: Type.Number(),
      }),
      async execute() {
        throw new Error("fixture evidence failure");
      },
    };
    const harness = new AgentHarness({
      session,
      models,
      model: faux.getModel(),
      tools: [evidenceTool],
      activeToolNames: ["evidence"],
      systemPrompt: "Exercise the evidence tool.",
    });
    const breaker = new RepeatedToolFailureBreaker(3);
    const termination: CodingTurnTermination = {};
    attachRepeatedToolFailureBreaker(harness, breaker, termination);

    const response = await harness.prompt("Inspect the evidence forest.");
    const outcome = await finalizeCodingTurn({
      runId,
      controlStore,
      correlationId: `${runId}:main:chat-turn`,
      userPrompt: "Inspect the evidence forest.",
      response,
      recoveryCount: 0,
      recoveryExhausted: false,
      termination,
      claimVerifier: { project: () => ({ required: false, status: "not_required" }) },
      maintainAfterTurn: async () => undefined,
    });

    assert.equal(response.stopReason, "toolUse");
    assert.deepEqual(response.content.map((item) => item.type), ["toolCall"]);
    assert.match(outcome.text, /current agent turn was stopped/i);
    const assistantEvent = (await controlStore.events(runId)).findLast((event) => event.type === "assistant_message");
    assert.equal(assistantEvent?.payload?.text, outcome.text);
    assert.equal(assistantEvent?.payload?.termination, "repeated_tool_failure");
  } finally {
    await env.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:repeated-tool-failure-mixed-batch] a successful sibling cannot bypass the breaker", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-repeat-mixed-"));
  const env = new NodeExecutionEnv({ cwd: root });
  try {
    const runId = "REPEAT-MIXED-001";
    const controlStore = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await controlStore.createRun(runId, task(runId, root));
    const sessionRepo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "pi-sessions") });
    const session = await sessionRepo.create({ id: `${runId}-chat`, cwd: root, metadata: { runId, lane: "main" } });
    const faux = fauxProvider({ provider: `faux-${runId}` });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("evidence", { operation: "inspect_forest", maxChars: 256 }, { id: "fail-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("evidence", { operation: "inspect_forest", maxChars: 256 }, { id: "fail-2" }), { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("evidence", { operation: "inspect_forest", maxChars: 256 }, { id: "fail-3" }),
        fauxToolCall("probe", { value: "sibling" }, { id: "success-1" }),
      ], { stopReason: "toolUse" }),
    ]);
    const evidenceTool: AgentHarnessTool<undefined> = {
      name: "evidence",
      label: "evidence",
      description: "Always fails for the mixed batch test.",
      parameters: Type.Object({ operation: Type.String(), maxChars: Type.Number() }),
      async execute() { throw new Error("fixture evidence failure"); },
    };
    const successTool: AgentHarnessTool<undefined> = {
      name: "probe",
      label: "probe",
      description: "Succeeds for the mixed batch test.",
      parameters: Type.Object({ value: Type.String() }),
      async execute() { return { content: [{ type: "text" as const, text: "sibling succeeded" }] }; },
    };
    const harness = new AgentHarness({
      session,
      models,
      model: faux.getModel(),
      tools: [evidenceTool, successTool],
      activeToolNames: ["evidence", "probe"],
      systemPrompt: "Exercise repeated tool failures.",
    });
    const breaker = new RepeatedToolFailureBreaker(3);
    const termination: CodingTurnTermination = {};
    attachRepeatedToolFailureBreaker(harness, breaker, termination);

    const response = await harness.prompt("Inspect the evidence forest.");
    const outcome = await finalizeCodingTurn({
      runId,
      controlStore,
      correlationId: `${runId}:main:chat-turn`,
      userPrompt: "Inspect the evidence forest.",
      response,
      recoveryCount: 0,
      recoveryExhausted: false,
      termination,
      claimVerifier: { project: () => ({ required: false, status: "not_required" }) },
      maintainAfterTurn: async () => undefined,
    });

    assert.equal(faux.state.callCount, 3);
    assert.equal(response.stopReason, "error");
    assert.equal(termination.confirmed, true);
    assert.match(outcome.text, /current agent turn was stopped/i);
    const assistantEvent = (await controlStore.events(runId)).findLast((event) => event.type === "assistant_message");
    assert.equal(assistantEvent?.payload?.termination, "repeated_tool_failure");
  } finally {
    await env.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

function task(runId: string, root: string): TaskContract {
  return {
    schema_version: 1,
    task_id: runId,
    mode: "coding_assistant",
    target_kind: "unknown",
    target: root,
    objective: "Repeated tool failure projection test",
    inputs: [],
    success_criteria: [],
    verification: { kind: "reproduction", required_reproductions: 0 },
    scope: { allowed_hosts: ["*"], allowed_ports: [], external_network: false, allowed_workspace: root },
    pause_policy: [],
    constraints: { deadline_ms: 10_000, max_cost_usd: 0, max_tool_calls: 10, max_submissions: 0 },
  };
}
