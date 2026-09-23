import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialSnapshot } from "../src/control/reducer.js";
import { phaseBudget } from "../src/domain/phase-budget.js";
import { ContextCompiler } from "../src/context/compiler.js";
import { demoTask } from "../src/app/demo.js";
import { createServices } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import type { HarnessEvent } from "../src/domain/types.js";

/**
 * The prompt's tool-call count.
 *
 * CHAT-1790096643438 made ten tool calls while its prompt said
 * `run_tool_calls_used: 2, run_tool_calls_remaining: 998`, because that counter was
 * `Object.keys(snapshot.effects).length` and the coding lane's tools never enter the
 * Effect Journal. PR #250 renamed the counter; these cases pin the real one.
 */

const config = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: { executor: { thinkingLevel: "off" } },
} as unknown as ProofBladeConfig;

function toolResults(runId: string, count: number): HarnessEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    schemaVersion: 1 as const,
    runId,
    streamId: runId,
    lane: "executor" as const,
    correlationId: `tool-call-${index}`,
    actor: "tool" as const,
    type: "tool_result_recorded" as const,
    payload: { toolCallId: `call-${index}`, toolName: "bash", outputBytes: 16, isError: false, durationMs: 1 },
  }));
}

test("the snapshot counts real tool results, not Effect Journal entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-tool-call-count-"));
  try {
    const runId = "TOOL-CALL-COUNT";
    const services = createServices(root, config);
    await services.control.createRun(runId, demoTask(runId, root, config));
    await services.control.append(runId, toolResults(runId, 3));
    const snapshot = await services.control.snapshot(runId);
    assert.equal(snapshot.toolCalls, 3, "three tool results were folded");
    assert.equal(Object.keys(snapshot.effects).length, 0, "and none of them was a journaled Effect");
    assert.equal(phaseBudget(snapshot).toolCallsUsed, 3);

    const compiled = new ContextCompiler().build({ runId, lane: "main", phase: snapshot.phase, task: snapshot.task, snapshot });
    const rendered = compiled.messages.map((message) => message.content).join("\n");
    assert.match(rendered, /"tool_calls_used":\s*3/, "the prompt states the real call count");
    assert.match(rendered, /"journaled_effects_used":\s*0/, "and the enforced counter stays separate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a snapshot that cannot know the count omits it instead of printing a lower bound", async () => {
  const run = createInitialSnapshot("TOOL-CALL-UNKNOWN", demoTask("TOOL-CALL-UNKNOWN", "/workspace", config));
  assert.equal(run.toolCalls, undefined, "a fresh snapshot has folded no tool results");
  const compiled = new ContextCompiler().build({ runId: run.runId, lane: "main", phase: run.phase, task: run.task, snapshot: run });
  const rendered = compiled.messages.map((message) => message.content).join("\n");
  assert.doesNotMatch(rendered, /tool_calls_used/, "nothing to say is said by saying nothing");
  assert.match(rendered, /journaled_effects_used/);
});
