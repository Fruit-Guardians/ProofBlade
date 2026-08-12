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
  const wrapped = scheduler.wrap(source, { provider: model.provider, model: model.id, maxConcurrentRequests: 1 });
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
  const wrapped = scheduler.wrap(source, { provider: model.provider, model: model.id, maxConcurrentRequests: 1 }, {
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
  const wrapped = scheduler.wrap(source, { provider: model.provider, model: model.id, maxConcurrentRequests: 1 }, {
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
