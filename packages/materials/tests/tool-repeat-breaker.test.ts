import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentHarness, JsonlSessionRepo, NodeExecutionEnv, type AgentHarnessTool } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ControlStore } from "../src/control/control-store.js";
import type { TaskContract } from "../src/domain/types.js";
import { attachCodingTurnGuards, attachRepeatedToolFailureBreaker, finalizeCodingTurn, projectCodingAssistantText, type CodingTurnTermination } from "../src/runtime/coding-turn-projection.js";
import { NoProgressToolBreaker, RepeatedToolFailureBreaker, ToolFailureStormBreaker, noProgressToolMessage, repeatedToolFailureMessage, toolFailureStormMessage } from "../src/runtime/tool-repeat-breaker.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";

const readOnlyEffect = { readOnly: true, sideEffect: "none" as const };
const workspaceEffect = { readOnly: false, sideEffect: "workspace" as const };
const testEffectPolicy = (toolName: string) => toolName === "read" ? readOnlyEffect : toolName === "write" ? workspaceEffect : undefined;

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

test("[contract:no-progress-breaker] repeated successful observations stop without constraining productive mutations", () => {
  const breaker = new NoProgressToolBreaker(3);
  const repeatedRead = {
    toolName: "read",
    input: { path: "firmware.asm", offset: 100, limit: 80 },
    isError: false,
    content: [{ type: "text", text: "same disassembly with a new artifact id" }],
    details: { artifactId: "A-volatile", artifactHash: "content-hash" },
    effectPolicy: readOnlyEffect,
  };
  assert.equal(breaker.observe(repeatedRead).terminate, false);
  assert.equal(breaker.observe({ ...repeatedRead, details: { artifactId: "A-other", artifactHash: "content-hash" } }).terminate, false);
  const decision = breaker.observe(repeatedRead);
  assert.equal(decision.count, 3);
  assert.equal(decision.terminate, true);
  assert.match(noProgressToolMessage("read", decision.count), /no new information/i);

  breaker.reset();
  breaker.observe(repeatedRead);
  breaker.observe({ toolName: "evidence", input: { operation: "record" }, isError: false, content: [{ type: "text", text: "recorded" }], details: {}, effectPolicy: workspaceEffect });
  assert.equal(breaker.observe(repeatedRead).count, 1);
  breaker.observe({ toolName: "write", input: { path: "solve.py", content: "print('new')" }, isError: false, content: [{ type: "text", text: "ok" }], details: {}, effectPolicy: workspaceEffect });
  assert.equal(breaker.observe(repeatedRead).count, 1);
});

test("idempotent workspace operations use their durable progress key as no-progress observations", () => {
  const breaker = new NoProgressToolBreaker(3);
  const reused = (summary: string) => ({
    toolName: "evidence",
    input: { operation: "record", summary },
    isError: false,
    content: [{ type: "text", text: `reused with ${summary}` }],
    details: { reused: true, durableProgress: false, progressKey: "stable-evidence-key" },
    effectPolicy: workspaceEffect,
  });
  assert.equal(breaker.observe(reused("first wording")).terminate, false);
  assert.equal(breaker.observe(reused("second wording")).terminate, false);
  const decision = breaker.observe(reused("third wording"));
  assert.equal(decision.count, 3);
  assert.equal(decision.terminate, true);
});

test("declared non-progress evidence survives intervening process observations", () => {
  const breaker = new NoProgressToolBreaker(3, 12);
  const duplicateEvidence = {
    toolName: "evidence",
    input: { operation: "record" },
    isError: false,
    content: [{ type: "text", text: "wording changes between calls" }],
    details: { durableProgress: false, progressKey: "same-content-evidence" },
    effectPolicy: { readOnly: false, sideEffect: "workspace" as const },
  };
  const processObservation = {
    toolName: "bash",
    input: { command: "sed -n '1,240p' solver.py" },
    isError: false,
    content: [{ type: "text", text: "solver source" }],
    effectPolicy: { readOnly: false, sideEffect: "process" as const },
  };

  assert.equal(breaker.observe(duplicateEvidence).count, 1);
  assert.equal(breaker.observe(processObservation).terminate, false);
  assert.equal(breaker.observe(duplicateEvidence).count, 2);
  assert.equal(breaker.observe(processObservation).terminate, false);
  assert.equal(breaker.observe(duplicateEvidence).terminate, true);
});

test("[contract:tool-failure-storm] varied failures stop after a bounded budget without durable progress", () => {
  const breaker = new ToolFailureStormBreaker(4);
  for (const input of [
    { operation: "record", artifactId: "A-1" },
    { operation: "record", role: "supporting" },
    { operation: "record", tags: Array.from({ length: 17 }, (_, index) => `tag-${index}`) },
  ]) assert.equal(breaker.observe(failed(input)).terminate, false);
  const decision = breaker.observe(failed({ operation: "record", artifactId: "A-2", role: "debug" }));
  assert.equal(decision.count, 4);
  assert.equal(decision.terminate, true);
  assert.match(toolFailureStormMessage(decision.count), /changing invalid arguments/i);
  breaker.observe({ toolName: "write", input: { path: "solve.py" }, isError: false, content: [{ type: "text", text: "written" }], effectPolicy: workspaceEffect });
  assert.equal(breaker.observe(failed({ operation: "record", artifactId: "A-3" })).count, 1);
});

test("repeated bash output cannot stop durable workspace changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-bash-progress-"));
  try {
    const path = join(root, "chunks.txt");
    const breaker = new NoProgressToolBreaker(3);
    const decisions = [];
    for (let index = 1; index <= 3; index += 1) {
      await appendFile(path, `chunk-${index}\n`, "utf8");
      decisions.push(breaker.observe({
        toolName: "bash",
        input: { command: "node append-next-chunk.mjs" },
        isError: false,
        content: [{ type: "text", text: "chunk written" }],
        effectPolicy: { readOnly: false, sideEffect: "process" },
      }));
    }
    assert.equal(await readFile(path, "utf8"), "chunk-1\nchunk-2\nchunk-3\n");
    assert.deepEqual(decisions.map(({ count, terminate }) => ({ count, terminate })), [
      { count: 0, terminate: false },
      { count: 0, terminate: false },
      { count: 0, terminate: false },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a side-effecting MCP or plugin call clears the no-progress window", () => {
  const breaker = new NoProgressToolBreaker(3);
  const read = {
    toolName: "objdump",
    input: { path: "firmware.bin" },
    isError: false,
    content: [{ type: "text", text: "stable disassembly" }],
    effectPolicy: readOnlyEffect,
  };
  assert.equal(breaker.observe(read).count, 1);
  assert.equal(breaker.observe(read).count, 2);
  assert.equal(breaker.observe({
    toolName: "mcp_call",
    input: { operation: "call", server: "browser", tool: "page_eval" },
    isError: false,
    content: [{ type: "text", text: "page changed" }],
    effectPolicy: { readOnly: false, sideEffect: "network" },
  }).count, 0);
  assert.equal(breaker.observe(read).count, 1);
  assert.equal(breaker.observe(read).terminate, false);
  assert.equal(breaker.observe(read).terminate, true);
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
    const assistantEntries = (await session.getBranch()).filter((entry) => entry.type === "message" && entry.message.role === "assistant");
    const piEntryId = assistantEntries[assistantEntries.length - 1]?.id;
    assert.ok(piEntryId);
    const outcome = await finalizeCodingTurn({
      runId,
      controlStore,
      correlationId: `${runId}:main:chat-turn`,
      userPrompt: "Inspect the evidence forest.",
      response,
      recoveryCount: 0,
      recoveryExhausted: false,
      termination,
      piEntryId,
      claimVerifier: { project: () => ({ required: false, status: "not_required" }) },
      maintainAfterTurn: async () => undefined,
    });

    assert.equal(response.stopReason, "toolUse");
    assert.deepEqual(response.content.map((item) => item.type), ["toolCall"]);
    assert.match(outcome.text, /current agent turn was stopped/i);
    const assistantEvent = (await controlStore.events(runId)).findLast((event) => event.type === "assistant_message");
    assert.equal(assistantEvent?.payload?.text, outcome.text);
    assert.equal(assistantEvent?.payload?.termination, "repeated_tool_failure");
    assert.equal(assistantEvent?.payload?.piEntryId, piEntryId);
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
    const assistantEntries = (await session.getBranch()).filter((entry) => entry.type === "message" && entry.message.role === "assistant");
    const piEntryId = assistantEntries[assistantEntries.length - 1]?.id;
    assert.ok(piEntryId);
    const outcome = await finalizeCodingTurn({
      runId,
      controlStore,
      correlationId: `${runId}:main:chat-turn`,
      userPrompt: "Inspect the evidence forest.",
      response,
      recoveryCount: 0,
      recoveryExhausted: false,
      termination,
      piEntryId,
      claimVerifier: { project: () => ({ required: false, status: "not_required" }) },
      maintainAfterTurn: async () => undefined,
    });

    assert.equal(faux.state.callCount, 3);
    assert.equal(response.stopReason, "error");
    assert.equal(termination.confirmed, true);
    assert.match(outcome.text, /current agent turn was stopped/i);
    assert.equal(outcome.stopReason, "stop");
    assert.equal(outcome.errorMessage, undefined);
    assert.equal(outcome.termination, "repeated_tool_failure");
    const assistantEvent = (await controlStore.events(runId)).findLast((event) => event.type === "assistant_message");
    assert.equal(assistantEvent?.payload?.termination, "repeated_tool_failure");
    assert.equal(assistantEvent?.payload?.piEntryId, piEntryId);
    assert.equal(assistantEvent?.payload?.stopReason, "stop");
    assert.equal(assistantEvent?.payload?.providerStopReason, "error");
  } finally {
    await env.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:no-progress-visible] real Harness stops repeated successful observations with a normal visible reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-no-progress-visible-"));
  const env = new NodeExecutionEnv({ cwd: root });
  try {
    const runId = "NO-PROGRESS-VISIBLE-001";
    const controlStore = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await controlStore.createRun(runId, task(runId, root));
    const sessionRepo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "pi-sessions") });
    const session = await sessionRepo.create({ id: `${runId}-chat`, cwd: root, metadata: { runId, lane: "main" } });
    const faux = fauxProvider({ provider: `faux-${runId}` });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([1, 2, 3].map((index) => fauxAssistantMessage(
      fauxToolCall("read", { path: "firmware.asm", offset: 100, limit: 80 }, { id: `read-${index}` }),
      { stopReason: "toolUse" },
    )));
    const readTool: AgentHarnessTool<undefined> = {
      name: "read",
      label: "read",
      description: "Returns an unchanged artifact for the convergence test.",
      parameters: Type.Object({ path: Type.String(), offset: Type.Number(), limit: Type.Number() }),
      async execute(_id, params) {
        return {
          content: [{ type: "text" as const, text: `unchanged ${String((params as { path: string }).path)}` }],
          details: { artifactId: "A-changing-id", artifactHash: "stable-content-hash" },
        };
      },
    };
    const harness = new AgentHarness({
      session,
      models,
      model: faux.getModel(),
      tools: [readTool],
      activeToolNames: ["read"],
      systemPrompt: "Read the same range repeatedly.",
    });
    const termination: CodingTurnTermination = {};
    attachCodingTurnGuards(harness, new RepeatedToolFailureBreaker(3), new NoProgressToolBreaker(3), termination, testEffectPolicy);

    const response = await harness.prompt("Continue the investigation.");
    const assistantEntries = (await session.getBranch()).filter((entry) => entry.type === "message" && entry.message.role === "assistant");
    const outcome = await finalizeCodingTurn({
      runId,
      controlStore,
      correlationId: `${runId}:main:chat-turn`,
      userPrompt: "Continue the investigation.",
      response,
      recoveryCount: 0,
      recoveryExhausted: false,
      termination,
      piEntryId: assistantEntries.at(-1)?.id,
      claimVerifier: { project: () => ({ required: false, status: "not_required" }) },
      maintainAfterTurn: async () => undefined,
    });

    assert.equal(faux.state.callCount, 3);
    assert.equal(outcome.stopReason, "stop");
    assert.equal(outcome.errorMessage, undefined);
    assert.equal(outcome.termination, "no_progress");
    assert.match(outcome.text, /no new information/i);
    const assistantEvent = (await controlStore.events(runId)).findLast((event) => event.type === "assistant_message");
    assert.equal(assistantEvent?.payload?.termination, "no_progress");
  } finally {
    await env.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("a durable mutation in the same batch cancels an order-dependent no-progress stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-no-progress-mixed-"));
  const env = new NodeExecutionEnv({ cwd: root });
  try {
    const faux = fauxProvider({ provider: "faux-no-progress-mixed" });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "same" }, { id: "read-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: "same" }, { id: "read-2" }), { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("read", { path: "same" }, { id: "read-3" }),
        fauxToolCall("write", { path: "solve.py", content: "new analysis" }, { id: "write-1" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("continued after durable progress"),
    ]);
    const stableRead: AgentHarnessTool<undefined> = {
      name: "read", label: "read", description: "stable read", parameters: Type.Object({ path: Type.String() }),
      async execute() { return { content: [{ type: "text" as const, text: "same" }], details: { artifactHash: "same-hash" } }; },
    };
    const write: AgentHarnessTool<undefined> = {
      name: "write", label: "write", description: "durable write", parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute() { return { content: [{ type: "text" as const, text: "written" }] }; },
    };
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "pi-sessions") });
    const session = await repo.create({ id: "no-progress-mixed", cwd: root });
    const harness = new AgentHarness({ session, models, model: faux.getModel(), tools: [stableRead, write], activeToolNames: ["read", "write"], systemPrompt: "test" });
    const termination: CodingTurnTermination = {};
    attachCodingTurnGuards(harness, new RepeatedToolFailureBreaker(), new NoProgressToolBreaker(), termination, testEffectPolicy);
    const response = await harness.prompt("continue");
    assert.equal(faux.state.callCount, 4);
    assert.equal(response.stopReason, "stop");
    assert.equal(response.content.find((item) => item.type === "text")?.text, "continued after durable progress");
    assert.equal(termination.requested, false);
    assert.equal(termination.reason, undefined);
  } finally {
    await env.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "platform MCP", effectPolicy: { readOnly: false, sideEffect: "platform" as const } },
  { name: "unresolved plugin", effectPolicy: undefined },
]) {
  test(`${scenario.name} success in a mixed batch cancels a pending no-progress stop`, async () => {
    const root = await mkdtemp(join(tmpdir(), "proofblade-no-progress-policy-"));
    const env = new NodeExecutionEnv({ cwd: root });
    try {
      const faux = fauxProvider({ provider: `faux-no-progress-${scenario.name.replace(/\s+/g, "-")}` });
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("read", { path: "same" }, { id: "read-1" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("read", { path: "same" }, { id: "read-2" }), { stopReason: "toolUse" }),
        fauxAssistantMessage([
          fauxToolCall("read", { path: "same" }, { id: "read-3" }),
          fauxToolCall("side_effect", {}, { id: "side-effect-1" }),
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("continued after potential progress"),
      ]);
      const stableRead: AgentHarnessTool<undefined> = {
        name: "read", label: "read", description: "stable read", parameters: Type.Object({ path: Type.String() }),
        async execute() { return { content: [{ type: "text" as const, text: "same" }], details: { artifactHash: "same-hash" } }; },
      };
      const sideEffect: AgentHarnessTool<undefined> = {
        name: "side_effect", label: "side_effect", description: "successful non-read-only operation", parameters: Type.Object({}),
        async execute() { return { content: [{ type: "text" as const, text: "operation completed" }] }; },
      };
      const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "pi-sessions") });
      const session = await repo.create({ id: `no-progress-${scenario.name}`, cwd: root });
      const harness = new AgentHarness({ session, models, model: faux.getModel(), tools: [stableRead, sideEffect], activeToolNames: ["read", "side_effect"], systemPrompt: "test" });
      const termination: CodingTurnTermination = {};
      attachCodingTurnGuards(
        harness,
        new RepeatedToolFailureBreaker(),
        new NoProgressToolBreaker(),
        termination,
        (toolName) => toolName === "read" ? readOnlyEffect : toolName === "side_effect" ? scenario.effectPolicy : undefined,
      );

      const response = await harness.prompt("continue");
      assert.equal(faux.state.callCount, 4);
      assert.equal(response.stopReason, "stop");
      assert.equal(response.content.find((item) => item.type === "text")?.text, "continued after potential progress");
      assert.equal(termination.requested, false);
      assert.equal(termination.reason, undefined);
    } finally {
      await env.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("process success in an evidence batch preserves a pending no-progress stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-no-progress-process-"));
  const env = new NodeExecutionEnv({ cwd: root });
  try {
    const faux = fauxProvider({ provider: "faux-no-progress-process" });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("evidence", { operation: "record" }, { id: "evidence-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("evidence", { operation: "record" }, { id: "evidence-2" }), { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("evidence", { operation: "record" }, { id: "evidence-3" }),
        fauxToolCall("bash", { command: "sed -n 1,20p solver.py" }, { id: "bash-1" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("must not continue"),
    ]);
    const evidence: AgentHarnessTool<undefined> = {
      name: "evidence", label: "evidence", description: "reused evidence", parameters: Type.Object({ operation: Type.String() }),
      async execute() {
        return {
          content: [{ type: "text" as const, text: "same evidence" }],
          details: { durableProgress: false, progressKey: "same-evidence" },
        };
      },
    };
    const bash: AgentHarnessTool<undefined> = {
      name: "bash", label: "bash", description: "process-only inspection", parameters: Type.Object({ command: Type.String() }),
      async execute() { return { content: [{ type: "text" as const, text: "solver source" }] }; },
    };
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "pi-sessions") });
    const session = await repo.create({ id: "no-progress-process", cwd: root });
    const harness = new AgentHarness({ session, models, model: faux.getModel(), tools: [evidence, bash], activeToolNames: ["evidence", "bash"], systemPrompt: "test" });
    const termination: CodingTurnTermination = {};
    attachCodingTurnGuards(
      harness,
      new RepeatedToolFailureBreaker(),
      new NoProgressToolBreaker(),
      termination,
      (toolName) => toolName === "evidence" ? workspaceEffect : toolName === "bash" ? { readOnly: false, sideEffect: "process" } : undefined,
    );

    const response = await harness.prompt("continue");
    assert.equal(faux.state.callCount, 3);
    assert.equal(response.stopReason, "error");
    assert.equal(termination.requested, true);
    assert.equal(termination.reason, "no_progress");
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
