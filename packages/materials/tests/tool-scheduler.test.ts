import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core/node";
import { scheduleAgentTools, ToolBatchScheduler } from "../src/runtime/tool-scheduler.js";

const schema = Type.Object({ value: Type.String() });

function tool(
  name: string,
  executionMode: "parallel" | "sequential",
  events: string[],
  delayMs: number,
): AgentHarnessTool<undefined> {
  return {
    name,
    label: name,
    description: name,
    parameters: schema,
    executionMode,
    async execute() {
      events.push(`${name}:start`);
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      events.push(`${name}:end`);
      return { content: [{ type: "text", text: name }], details: undefined };
    },
  };
}

test("ToolBatchScheduler overlaps parallel calls and fences sequential calls", async () => {
  const events: string[] = [];
  const scheduler = new ToolBatchScheduler();
  const first = scheduler.enqueue("parallel", async () => {
    events.push("read-a:start");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    events.push("read-a:end");
    return "a";
  });
  const second = scheduler.enqueue("parallel", async () => {
    events.push("read-b:start");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    events.push("read-b:end");
    return "b";
  });
  const write = scheduler.enqueue("sequential", async () => {
    events.push("write:start");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    events.push("write:end");
    return "write";
  });
  assert.deepEqual(await Promise.all([first, second, write]), ["a", "b", "write"]);
  assert.deepEqual(events, ["read-a:start", "read-b:start", "read-a:end", "read-b:end", "write:start", "write:end"]);
});

test("scheduled agent tools keep their original barrier class internally", async () => {
  const events: string[] = [];
  const tools = scheduleAgentTools([
    tool("read", "parallel", events, 10),
    tool("write", "sequential", events, 1),
  ], new ToolBatchScheduler());
  assert.equal(tools[0]?.executionMode, "parallel");
  assert.equal(tools[1]?.executionMode, "parallel");
  const context = undefined;
  const signal = new AbortController().signal;
  const [read, write] = await Promise.all([
    tools[0]!.execute("read-call", { value: "a" }, signal, undefined, context),
    tools[1]!.execute("write-call", { value: "b" }, signal, undefined, context),
  ]);
  assert.equal(read.content[0]?.type, "text");
  assert.equal(write.content[0]?.type, "text");
  assert.deepEqual(events, ["read:start", "read:end", "write:start", "write:end"]);
});

test("ToolBatchScheduler caps a large parallel group with a rolling pool", async () => {
  const scheduler = new ToolBatchScheduler(2);
  let active = 0;
  let peak = 0;
  const calls = Array.from({ length: 5 }, (_unused, index) => scheduler.enqueue("parallel", async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return index;
  }));
  assert.deepEqual(await Promise.all(calls), [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
});
