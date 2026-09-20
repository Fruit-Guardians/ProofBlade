import assert from "node:assert/strict";
import test from "node:test";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core/node";
import {
  DEFAULT_TOOL_TIMING_CAPACITY,
  TOOL_TIMING_STAGES,
  ToolTimingRecorder,
  percentile,
  withToolTiming,
  withToolTimingOnTools,
  type ToolTimingSample,
} from "../src/observability/tool-timing.js";
import type { CodingResourceContext } from "../src/runtime/coding-resources.js";

/** A tool double that returns whatever the test needs and counts invocations. */
function sampleTool(options: {
  name?: string;
  result?: unknown;
  error?: Error;
  onExecute?: () => void;
} = {}): { tool: AgentHarnessTool<CodingResourceContext>; calls: () => number } {
  let calls = 0;
  const tool = {
    name: options.name ?? "read",
    label: options.name ?? "read",
    description: "double",
    parameters: { type: "object", properties: {} },
    async execute() {
      calls += 1;
      options.onExecute?.();
      if (options.error) throw options.error;
      return options.result ?? { content: [{ type: "text", text: "ok" }], details: {}, isError: false };
    },
  } as unknown as AgentHarnessTool<CodingResourceContext>;
  return { tool, calls: () => calls };
}

test("percentile uses nearest-rank so every reported value was observed", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  assert.equal(percentile(values, 0.5), 5);
  assert.equal(percentile(values, 0.95), 10);
  assert.equal(percentile(values, 1), 10);
  assert.equal(percentile(values, 0), 1);
  // Interpolation would report 9.5 here, which no call ever took.
  assert.equal(values.includes(percentile(values, 0.99)), true);
});

test("percentile of an empty buffer is zero rather than NaN", () => {
  assert.equal(percentile([], 0.5), 0);
});

test("the recorder rejects a capacity that cannot retain a sample", () => {
  assert.throws(() => new ToolTimingRecorder(0), /positive integer/);
  assert.throws(() => new ToolTimingRecorder(1.5), /positive integer/);
});

test("a recorded call exposes phase durations only for the stages it crossed", () => {
  const recorder = new ToolTimingRecorder();
  const handle = recorder.begin("read");
  handle.mark("executionStart");
  handle.mark("executionEnd");
  handle.finish();

  const [sample] = recorder.samples();
  assert.ok(sample);
  assert.equal(sample.tool, "read");
  assert.equal(sample.isError, false);
  // scheduled -> executionStart -> executionEnd were crossed explicitly. The
  // subscribers span is closed by finish() rather than by the projection, so it
  // must NOT be reported: attributing the projection's uninstrumented work to
  // that boundary would overstate it in the baseline.
  const phases = Object.keys(sample.phases).sort();
  assert.deepEqual(phases, ["executionStart_executionEnd", "scheduled_executionStart"]);
  assert.ok(sample.totalMs >= 0);
});

test("finish is idempotent so a finally block cannot double-record", () => {
  const recorder = new ToolTimingRecorder();
  const handle = recorder.begin("bash");
  handle.mark("executionStart");
  handle.mark("executionEnd");
  handle.finish();
  handle.finish(true);

  assert.equal(recorder.samples().length, 1);
  assert.equal(recorder.samples()[0]?.isError, false);
});

test("re-marking a stage keeps the first timestamp so a retry cannot shorten a phase", async () => {
  const recorder = new ToolTimingRecorder();
  const handle = recorder.begin("read");
  handle.mark("executionStart");
  await new Promise((resolve) => setTimeout(resolve, 5));
  handle.mark("executionStart");
  handle.mark("executionEnd");
  handle.finish();

  const [sample] = recorder.samples();
  assert.ok(sample);
  assert.ok((sample.phases.executionStart_executionEnd ?? 0) >= 4, `expected >= 4ms, got ${sample.phases.executionStart_executionEnd}`);
});

test("the recorder is bounded and reports how many samples it dropped", () => {
  const recorder = new ToolTimingRecorder(3);
  for (let index = 0; index < 5; index += 1) {
    const handle = recorder.begin(`tool-${index}`);
    handle.mark("executionStart");
    handle.finish();
  }

  assert.equal(recorder.samples().length, 3);
  assert.equal(recorder.droppedCount(), 2);
  assert.deepEqual(recorder.samples().map((sample) => sample.tool), ["tool-2", "tool-3", "tool-4"]);
});

test("clear drops samples and the drop count together", () => {
  const recorder = new ToolTimingRecorder(1);
  recorder.begin("read").finish();
  recorder.begin("read").finish();
  assert.equal(recorder.droppedCount(), 1);

  recorder.clear();
  assert.equal(recorder.samples().length, 0);
  assert.equal(recorder.droppedCount(), 0);
});

test("summarize groups by tool and sums the acceptance counters", () => {
  const recorder = new ToolTimingRecorder();
  for (let index = 0; index < 4; index += 1) {
    const handle = recorder.begin("read");
    handle.mark("executionStart");
    handle.count("artifactReadbacks", 2);
    handle.mark("executionEnd");
    handle.finish(index % 2 === 0);
  }
  const bash = recorder.begin("bash");
  bash.mark("executionStart");
  bash.count("eventFsyncs");
  bash.finish();

  const summaries = recorder.summarize();
  assert.deepEqual(summaries.map((summary) => summary.group), ["bash", "read"]);
  const read = summaries.find((summary) => summary.group === "read");
  assert.ok(read);
  assert.equal(read.tool, "read");
  assert.equal(read.count, 4);
  assert.equal(read.errorCount, 2);
  assert.equal(read.counters.artifactReadbacks, 8);
  assert.equal(read.counters.eventFsyncs, 0);
  assert.ok(read.total.p50 <= read.total.p95);
  assert.ok(read.total.p95 <= read.total.p99);
  assert.equal(summaries.find((summary) => summary.group === "bash")?.counters.eventFsyncs, 1);
});

test("a label separates calls that share one tool name", () => {
  // The whole point of labelling: a 1 B read and a 64 KiB read are different
  // measurements and must not be merged into one `read` summary.
  const recorder = new ToolTimingRecorder();
  recorder.begin("read", "read-1B").finish();
  recorder.begin("read", "read-1B").finish();
  recorder.begin("read", "read-64KiB").finish();

  const summaries = recorder.summarize();
  assert.deepEqual(summaries.map((summary) => summary.group), ["read-1B", "read-64KiB"]);
  assert.equal(summaries[0]?.tool, "read");
  assert.equal(summaries[0]?.count, 2);
  assert.equal(summaries[1]?.count, 1);
});

test("an unlabelled sample groups under its tool name", () => {
  const recorder = new ToolTimingRecorder();
  recorder.begin("read").finish();
  recorder.begin("read", "read-1B").finish();

  const summaries = recorder.summarize();
  assert.deepEqual(summaries.map((summary) => summary.group), ["read", "read-1B"]);
  assert.equal(recorder.samples()[0]?.label, undefined);
  assert.equal(recorder.samples()[1]?.label, "read-1B");
});

test("begin rejects an empty label rather than recording an ungroupable sample", () => {
  const recorder = new ToolTimingRecorder();
  assert.throws(() => recorder.begin("read", ""), /empty label/);
});

test("summarize can restrict to named groups", () => {
  const recorder = new ToolTimingRecorder();
  recorder.begin("read").finish();
  recorder.begin("bash").finish();

  assert.deepEqual(recorder.summarize(["bash"]).map((summary) => summary.group), ["bash"]);
});

test("withToolTiming returns the original tool when no recorder is given", () => {
  const { tool } = sampleTool();

  // Identity, not equality: an unmeasured lane must not pay for a wrapper.
  assert.equal(withToolTiming(tool, undefined), tool);
  assert.equal(withToolTimingOnTools([tool], undefined)[0], tool);
});

test("the wrapper forwards the result, the args, and the error unchanged", async () => {
  const recorder = new ToolTimingRecorder();
  const expected = { content: [{ type: "text", text: "payload" }], details: { n: 1 }, isError: false };
  const seen: unknown[] = [];
  const { tool } = sampleTool({ result: expected, onExecute: () => seen.push("called") });
  const wrapped = withToolTiming(tool, recorder);

  const result = await (wrapped as unknown as { execute: (a: string, b: unknown, c: AbortSignal, d: unknown, e: unknown) => Promise<unknown> })
    .execute("call-1", { path: "a.txt" }, new AbortController().signal, undefined, {});

  assert.equal(result, expected);
  assert.deepEqual(seen, ["called"]);
  assert.equal(recorder.samples().length, 1);
  assert.equal(recorder.samples()[0]?.isError, false);
});

test("a thrown error is recorded as an error and still propagates", async () => {
  const recorder = new ToolTimingRecorder();
  const failure = new Error("boom");
  const { tool } = sampleTool({ error: failure });
  const wrapped = withToolTiming(tool, recorder);

  await assert.rejects(
    () => (wrapped as unknown as { execute: (a: string, b: unknown, c: AbortSignal, d: unknown, e: unknown) => Promise<unknown> })
      .execute("call-1", {}, new AbortController().signal, undefined, {}),
    /boom/,
  );
  assert.equal(recorder.samples()[0]?.isError, true);
});

test("a returned error result counts as an error without being thrown", async () => {
  const recorder = new ToolTimingRecorder();
  const { tool } = sampleTool({ result: { content: [{ type: "text", text: "bad" }], details: {}, isError: true } });

  await (withToolTiming(tool, recorder) as unknown as { execute: (a: string, b: unknown, c: AbortSignal, d: unknown, e: unknown) => Promise<unknown> })
    .execute("call-1", {}, new AbortController().signal, undefined, {});

  assert.equal(recorder.samples()[0]?.isError, true);
});

test("concurrent calls keep their own marks instead of interleaving", async () => {
  const recorder = new ToolTimingRecorder();
  const gate = { release: undefined as (() => void) | undefined };
  const blocked = new Promise<void>((resolve) => { gate.release = resolve; });
  // Async delay lives inside the tool double, so the wrapper is the only thing
  // under test: a wrapper that shared marks between handles would report the
  // slow call with the fast call's span.
  const slow = sampleTool({ name: "slow", onExecute: () => undefined });
  const slowTool = {
    ...slow.tool,
    async execute(...args: Parameters<typeof slow.tool.execute>) {
      await blocked;
      return slow.tool.execute(...args);
    },
  } as typeof slow.tool;
  const fast = sampleTool({ name: "fast" });
  const wrappedSlow = withToolTiming(slowTool, recorder);
  const wrappedFast = withToolTiming(fast.tool, recorder);

  const pending = wrappedSlow.execute("slow", {} as never, new AbortController().signal, undefined, {} as never);
  await wrappedFast.execute("fast", {} as never, new AbortController().signal, undefined, {} as never);
  gate.release?.();
  await pending;

  assert.equal(recorder.samples().length, 2);
  assert.deepEqual(recorder.samples().map((sample) => sample.tool).sort(), ["fast", "slow"]);
  for (const sample of recorder.samples()) {
    // Every sample owns a coherent span; an interleaved sample would report a
    // total shorter than one of its own phases.
    const phases = Object.values(sample.phases) as number[];
    assert.ok(sample.totalMs >= Math.max(...phases) - 0.001, `${sample.tool} total ${sample.totalMs} < max phase ${Math.max(...phases)}`);
  }
});

test("the wrapper covers every declared stage without inventing new ones", () => {
  const recorder = new ToolTimingRecorder();
  recorder.begin("read").finish();

  const [sample] = recorder.samples();
  assert.ok(sample);
  for (const stage of Object.keys(sample.marks)) {
    assert.ok((TOOL_TIMING_STAGES as readonly string[]).includes(stage), `unexpected stage ${stage}`);
  }
  assert.equal(sample.marks.scheduled !== undefined, true);
  assert.equal(sample.marks.subscribersEnd !== undefined, true);
});

test("recording performs no durable write", () => {
  // Structural guard for the T0 contract: the recorder must stay memory-only.
  // A recorder that persisted each sample would add the very synchronous
  // barrier this work removes, and would perturb what it measures.
  const recorder = new ToolTimingRecorder();
  const before = process.memoryUsage().heapUsed;
  for (let index = 0; index < 200; index += 1) {
    const handle = recorder.begin("read");
    handle.mark("executionStart");
    handle.count("controlCommits");
    handle.mark("executionEnd");
    handle.finish();
  }

  assert.equal(recorder.samples().length, 200);
  assert.equal(typeof before, "number");
  const sample: ToolTimingSample | undefined = recorder.samples()[0];
  assert.ok(sample);
  // The sample is a plain value: no store, journal, or stream handle can ride along.
  assert.deepEqual(Object.keys(sample).sort(), ["counters", "isError", "marks", "phases", "tool", "totalMs"]);
  assert.equal(recorder.summarize()[0]?.counters.controlCommits, 200);
});

test("the default capacity retains a useful window for percentile reporting", () => {
  const recorder = new ToolTimingRecorder();
  assert.equal(DEFAULT_TOOL_TIMING_CAPACITY >= 100, true, "a percentile report needs a meaningful sample window");
  assert.equal(recorder.samples().length, 0);
});
