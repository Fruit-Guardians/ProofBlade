import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Model, type ProviderStreams } from "@earendil-works/pi-ai";
import { ProviderRequestScheduler } from "../src/runtime/provider-scheduler.js";

const model: Model<"openai-completions"> = {
  id: "scheduler-model", name: "scheduler-model", api: "openai-completions", provider: "scheduler-provider",
  baseUrl: "http://127.0.0.1:1/v1", reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1024, maxTokens: 32,
};

test("provider scheduler limits concurrent streams and drains FIFO", async () => {
  const scheduler = new ProviderRequestScheduler();
  let active = 0;
  let peak = 0;
  const order: string[] = [];
  const source: ProviderStreams = {
    stream: (_model, context) => delayedStream(20, () => { active -= 1; }, () => { active += 1; peak = Math.max(peak, active); order.push(String(context.messages.at(-1)?.content)); }),
    streamSimple: (_model, context) => delayedStream(20, () => { active -= 1; }, () => { active += 1; peak = Math.max(peak, active); order.push(String(context.messages.at(-1)?.content)); }),
  };
  const wrapped = scheduler.wrap(source, { provider: model.provider, model: model.id, endpoint: "endpoint-a", maxConcurrentRequests: 1 });
  const first = collect(wrapped.stream(model, { messages: [{ role: "user", content: "first", timestamp: 1 }] }));
  const second = collect(wrapped.stream(model, { messages: [{ role: "user", content: "second", timestamp: 1 }] }));
  const third = collect(wrapped.stream(model, { messages: [{ role: "user", content: "third", timestamp: 1 }] }));
  await Promise.all([first, second, third]);
  assert.equal(peak, 1);
  assert.deepEqual(order, ["first", "second", "third"]);
});

test("provider scheduler persists a slot grant before starting the Provider stream", async () => {
  const scheduler = new ProviderRequestScheduler();
  const sequence: string[] = [];
  const source: ProviderStreams = {
    stream: () => delayedStream(1, undefined, () => { sequence.push("provider"); }),
    streamSimple: () => delayedStream(1, undefined, () => { sequence.push("provider"); }),
  };
  const wrapped = scheduler.wrap(source, { provider: model.provider, model: model.id, endpoint: "endpoint-a", maxConcurrentRequests: 1 }, {
    queued: () => { sequence.push("queued"); return "PR-1"; },
    started: () => { sequence.push("started"); },
    cancelled: () => { sequence.push("cancelled"); },
  });
  await collect(wrapped.stream(model, { messages: [] }));
  assert.deepEqual(sequence, ["queued", "started", "provider"]);
});

test("provider scheduler cancels a queued request without starting the source", async () => {
  const scheduler = new ProviderRequestScheduler();
  let starts = 0;
  const source: ProviderStreams = { stream: () => { starts += 1; return delayedStream(30); }, streamSimple: () => { starts += 1; return delayedStream(30); } };
  const events: string[] = [];
  const wrapped = scheduler.wrap(source, { provider: model.provider, model: model.id, endpoint: "endpoint-a", maxConcurrentRequests: 1 }, {
    queued: () => "PR-queued",
    started: () => { events.push("started"); },
    cancelled: () => { events.push("cancelled"); },
  });
  const first = collect(wrapped.stream(model, { messages: [{ role: "user", content: "first", timestamp: 1 }] }));
  const controller = new AbortController();
  const second = collect(wrapped.stream(model, { messages: [{ role: "user", content: "second", timestamp: 1 }] }, { signal: controller.signal }));
  controller.abort();
  const result = await second;
  await first;
  assert.equal(starts, 1);
  assert.equal(result.stopReason, "aborted");
  assert.deepEqual(events, ["cancelled", "started"]);
});

test("provider scheduler applies a raised limit to an existing endpoint pool", async () => {
  const scheduler = new ProviderRequestScheduler();
  let active = 0;
  let peak = 0;
  const source: ProviderStreams = {
    stream: () => delayedStream(30, () => { active -= 1; }, () => { active += 1; peak = Math.max(peak, active); }),
    streamSimple: () => delayedStream(30, () => { active -= 1; }, () => { active += 1; peak = Math.max(peak, active); }),
  };
  const firstProfile = scheduler.wrap(source, { provider: model.provider, model: model.id, endpoint: "endpoint-a", maxConcurrentRequests: 1 });
  const secondProfile = scheduler.wrap(source, { provider: model.provider, model: model.id, endpoint: "endpoint-a", maxConcurrentRequests: 4 });
  await Promise.all([
    collect(firstProfile.stream(model, { messages: [] })),
    collect(secondProfile.stream(model, { messages: [] })),
    collect(secondProfile.stream(model, { messages: [] })),
  ]);
  assert.equal(peak, 3);
  assert.equal(scheduler.statuses()[0]?.maxConcurrentRequests, 4);
});

test("provider scheduler isolates equal model names at separate endpoints", async () => {
  const scheduler = new ProviderRequestScheduler();
  let active = 0;
  let peak = 0;
  const source: ProviderStreams = {
    stream: () => delayedStream(20, () => { active -= 1; }, () => { active += 1; peak = Math.max(peak, active); }),
    streamSimple: () => delayedStream(20, () => { active -= 1; }, () => { active += 1; peak = Math.max(peak, active); }),
  };
  const endpointA = scheduler.wrap(source, { provider: model.provider, model: model.id, endpoint: "endpoint-a", maxConcurrentRequests: 1 });
  const endpointB = scheduler.wrap(source, { provider: model.provider, model: model.id, endpoint: "endpoint-b", maxConcurrentRequests: 1 });
  await Promise.all([collect(endpointA.stream(model, { messages: [] })), collect(endpointB.stream(model, { messages: [] }))]);
  assert.equal(peak, 2);
  assert.equal(scheduler.statuses().length, 2);
});

test("idle watchdog aborts a stalled stream and frees the slot", async () => {
  const scheduler = new ProviderRequestScheduler({ idleTimeoutMs: 40 });
  const scope = { provider: model.provider, model: model.id, endpoint: "endpoint-idle", maxConcurrentRequests: 1 };
  // A stream that emits nothing and never completes — the pathological stall.
  const stalled: ProviderStreams = { stream: () => createAssistantMessageEventStream(), streamSimple: () => createAssistantMessageEventStream() };
  const wrapped = scheduler.wrap(stalled, scope);
  const result = await collect(wrapped.stream(model, { messages: [{ role: "user", content: "hang", timestamp: 1 }] }));
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /idle for more than 40ms/);
  // The permit must have been released, otherwise the slot count stays pinned.
  assert.equal(scheduler.statuses().find((s) => s.endpoint === "endpoint-idle")?.active ?? 0, 0);
});

test("idle watchdog resets on each event and lets a healthy stream finish", async () => {
  const scheduler = new ProviderRequestScheduler({ idleTimeoutMs: 60 });
  const scope = { provider: model.provider, model: model.id, endpoint: "endpoint-healthy", maxConcurrentRequests: 1 };
  // Emit a heartbeat every 30ms (< 60ms idle bound), then complete — must NOT trip.
  const healthy: ProviderStreams = { stream: () => heartbeatStream(3, 30), streamSimple: () => heartbeatStream(3, 30) };
  const wrapped = scheduler.wrap(healthy, scope);
  const result = await collect(wrapped.stream(model, { messages: [{ role: "user", content: "ok", timestamp: 1 }] }));
  assert.equal(result.stopReason, "stop");
});

test("a stalled stream does not permanently block the queue behind it", async () => {
  const scheduler = new ProviderRequestScheduler({ idleTimeoutMs: 40 });
  const scope = { provider: model.provider, model: model.id, endpoint: "endpoint-queue", maxConcurrentRequests: 1 };
  let secondStarted = false;
  const source: ProviderStreams = {
    stream: (_m, ctx) => String(ctx.messages.at(-1)?.content) === "stall" ? createAssistantMessageEventStream() : (secondStarted = true, delayedStream(5)),
    streamSimple: () => delayedStream(5),
  };
  const wrapped = scheduler.wrap(source, scope);
  const first = collect(wrapped.stream(model, { messages: [{ role: "user", content: "stall", timestamp: 1 }] }));
  const second = collect(wrapped.stream(model, { messages: [{ role: "user", content: "healthy", timestamp: 1 }] }));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.stopReason, "error");        // the stalled one timed out
  assert.equal(b.stopReason, "stop");          // the queued one still ran
  assert.equal(secondStarted, true);
});

function heartbeatStream(beats: number, gapMs: number): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  let n = 0;
  const tick = (): void => {
    if (n < beats) { output.push({ type: "text", text: "." } as never); n += 1; setTimeout(tick, gapMs); }
    else output.push({ type: "done", reason: "stop", message: message() });
  };
  setTimeout(tick, gapMs);
  return output;
}

function delayedStream(delayMs: number, onEnd?: () => void, onStart?: () => void): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  onStart?.();
  setTimeout(() => { output.push({ type: "done", reason: "stop", message: message() }); onEnd?.(); }, delayMs);
  return output;
}

function message(): AssistantMessage {
  return { role: "assistant", api: "openai-completions", provider: model.provider, model: model.id, content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessage> {
  let result: AssistantMessage | undefined;
  for await (const event of stream) if (event.type === "done" || event.type === "error") result = event.type === "done" ? event.message : event.error;
  assert.ok(result);
  return result;
}
