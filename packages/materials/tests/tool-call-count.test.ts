import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialSnapshot } from "../src/control/reducer.js";
import { ControlStore } from "../src/control/control-store.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";
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
  assert.equal(run.toolCalls, 0, "a fresh snapshot starts at zero, not unknown");
  const unknown = { ...run };
  delete (unknown as { toolCalls?: number }).toolCalls;
  const compiled = new ContextCompiler().build({ runId: unknown.runId, lane: "main", phase: unknown.phase, task: unknown.task, snapshot: unknown });
  const rendered = compiled.messages.map((message) => message.content).join("\n");
  assert.doesNotMatch(rendered, /tool_calls_used/, "nothing to say is said by saying nothing");
  assert.match(rendered, /journaled_effects_used/);
});

test("a projection from before the counter existed keeps the count unknown instead of reporting the tail", async () => {
  // After a restart, `ControlStore` folds only the events after the projection's
  // `lastSeq`. A projection written before `toolCalls` existed cannot know its own
  // earlier tool results, so accumulating from zero would report the tail's count as
  // the Run's: a hundred historical calls plus one new one would read
  // `tool_calls_used: 1`.
  const root = await mkdtemp(join(tmpdir(), "pb-tool-call-legacy-"));
  const runsRoot = join(root, "runs");
  const secret = "tool-call-legacy-secret-0123456789";
  try {
    const runId = "TOOL-CALL-LEGACY";
    const control = new ControlStore(new JsonlControlStore(runsRoot), undefined, secret);
    await control.createRun(runId, demoTask(runId, root, config));
    await control.append(runId, toolResults(runId, 2));
    const current = await control.snapshot(runId);
    assert.equal(current.toolCalls, 2);

    // A legacy projection: the field is simply absent.
    const legacy = { ...current };
    delete (legacy as { toolCalls?: number }).toolCalls;
    await new JsonlControlStore(runsRoot).saveProjection(legacy, secret);

    // Two more calls land after that projection, without rewriting it.
    await control.append(runId, toolResults(runId, 2), { persistProjection: false });

    // A cold reader has no cached snapshot, so it folds the tail onto the projection.
    const cold = new ControlStore(new JsonlControlStore(runsRoot), undefined, secret);
    const folded = await cold.snapshot(runId);
    assert.equal(folded.lastSeq, current.lastSeq + 2, "the tail was folded");
    assert.equal(folded.toolCalls, undefined, "the tail's two calls must not be reported as the Run's count");
    assert.equal((await new JsonlControlStore(runsRoot).replay(runId)).toolCalls, 4, "a full replay still knows the truth");

    const compiled = new ContextCompiler().build({ runId, lane: "main", phase: folded.phase, task: folded.task, snapshot: folded });
    assert.doesNotMatch(compiled.messages.map((message) => message.content).join("\n"), /tool_calls_used/, "the prompt omits what it cannot know");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a projection written now carries a definite count, so a tail fold is exact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-tool-call-current-"));
  const runsRoot = join(root, "runs");
  const secret = "tool-call-current-secret-0123456789";
  try {
    const runId = "TOOL-CALL-CURRENT";
    const control = new ControlStore(new JsonlControlStore(runsRoot), undefined, secret);
    await control.createRun(runId, demoTask(runId, root, config));
    await control.append(runId, toolResults(runId, 3));
    await control.flushProjection(runId);
    await control.append(runId, toolResults(runId, 2), { persistProjection: false });
    const folded = await new ControlStore(new JsonlControlStore(runsRoot), undefined, secret).snapshot(runId);
    assert.equal(folded.toolCalls, 5, "a projection from this build knows its own count");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
