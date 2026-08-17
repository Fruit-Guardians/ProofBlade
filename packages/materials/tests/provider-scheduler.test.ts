import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Model, type ProviderStreams } from "@earendil-works/pi-ai";
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

test("idle watchdog fires the terminal observer completion so telemetry does not leak", async () => {
  const scheduler = new ProviderRequestScheduler({ idleTimeoutMs: 20 });
  let completed = 0;
  let cancelled = 0;
  const observer = { queued: () => "R1", started: () => {}, cancelled: () => { cancelled += 1; }, completed: () => { completed += 1; } };
  const stalled: ProviderStreams = { stream: () => createAssistantMessageEventStream(), streamSimple: () => createAssistantMessageEventStream() };
  const wrapped = scheduler.wrap(stalled, { provider: model.provider, model: model.id, endpoint: "endpoint-telemetry", maxConcurrentRequests: 1 }, observer);
  const result = await collect(wrapped.stream(model, { messages: [{ role: "user", content: "hang", timestamp: 1 }] }));
  assert.equal(result.stopReason, "error");
  assert.equal(completed, 1);   // terminal completion recorded — no leaked in-flight request
  assert.equal(cancelled, 0);   // the stream had started, so this is a completion, not a queue cancel
  assert.equal(scheduler.statuses().find((s) => s.endpoint === "endpoint-telemetry")?.active ?? 0, 0);
});

test("a terminal observer.completed that throws is not retried (no double usage count)", async () => {
  const scheduler = new ProviderRequestScheduler({ idleTimeoutMs: 200 });
  let completed = 0;
  // Mirrors the real observer: it appends model_usage then persists; if persist
  // throws AFTER the append, retrying would double-count usage against the budget.
  const observer = { queued: () => "R1", started: () => {}, cancelled: () => {}, completed: () => { completed += 1; throw new Error("persist failed after appending usage"); } };
  const healthy: ProviderStreams = { stream: () => delayedStream(5), streamSimple: () => delayedStream(5) };
  const wrapped = scheduler.wrap(healthy, { provider: model.provider, model: model.id, endpoint: "endpoint-once", maxConcurrentRequests: 1 }, observer);
  const result = await collect(wrapped.stream(model, { messages: [{ role: "user", content: "ok", timestamp: 1 }] }));
  assert.equal(result.stopReason, "stop");   // the real done event still reaches the consumer
  assert.equal(completed, 1);                // called exactly once despite throwing
  assert.equal(scheduler.statuses().find((s) => s.endpoint === "endpoint-once")?.active ?? 0, 0);
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

test("a retryable mid-stream error is retried at the stream boundary and the eventual success is delivered", async () => {
  const scheduler = new ProviderRequestScheduler({ idleTimeoutMs: 0, maxRetries: 2, retryBaseDelayMs: 1 });
  let calls = 0;
  const source: ProviderStreams = {
    stream: () => (calls += 1) <= 1 ? erroringStream("Provider returned error 503") : delayedStream(2),
    streamSimple: () => (calls += 1) <= 1 ? erroringStream("503") : delayedStream(2),
  };
  const wrapped = scheduler.wrap(source, { provider: model.provider, model: model.id, endpoint: "endpoint-retry", maxConcurrentRequests: 1 });
  const result = await collect(wrapped.stream(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] }));
  assert.equal(result.stopReason, "stop");   // the retry recovered
  assert.equal(calls, 2);                     // initial + 1 re-issue of the SAME request
});

test("retry discards the failed attempt's buffered events — no duplicates downstream", async () => {
  const scheduler = new ProviderRequestScheduler({ idleTimeoutMs: 0, maxRetries: 2, retryBaseDelayMs: 1 });
  let calls = 0;
  const source: ProviderStreams = {
    // Attempt 1: emit a text delta THEN a retryable error. Attempt 2: text + done.
    stream: () => {
      calls += 1;
      const out = createAssistantMessageEventStream();
      setTimeout(() => {
        out.push({ type: "text", text: "hello" } as never);
        if (calls <= 1) out.push({ type: "error", reason: "error", error: errorMsg("socket hang up") });
        else out.push({ type: "done", reason: "stop", message: message() });
      }, 1);
      return out;
    },
    streamSimple: () => delayedStream(1),
  };
  const wrapped = scheduler.wrap(source, { provider: model.provider, model: model.id, endpoint: "endpoint-nodup", maxConcurrentRequests: 1 });
  const events = await collectAll(wrapped.stream(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] }));
  assert.equal(calls, 2);
  // The discarded attempt's "hello" must NOT leak: exactly one text delta survives.
  assert.equal(events.filter((e) => e.type === "text").length, 1);
  assert.equal(events.filter((e) => e.type === "done").length, 1);
  assert.equal(events.filter((e) => e.type === "error").length, 0);
});

test("a persistent retryable error is retried up to the budget then surfaced", async () => {
  const scheduler = new ProviderRequestScheduler({ idleTimeoutMs: 0, maxRetries: 2, retryBaseDelayMs: 1 });
  let calls = 0;
  const source: ProviderStreams = { stream: () => { calls += 1; return erroringStream("502 bad gateway"); }, streamSimple: () => erroringStream("502") };
  const wrapped = scheduler.wrap(source, { provider: model.provider, model: model.id, endpoint: "endpoint-exhaust", maxConcurrentRequests: 1 });
  const result = await collect(wrapped.stream(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] }));
  assert.equal(calls, 3);                     // initial + 2 retries, then give up
  assert.equal(result.stopReason, "error");
  assert.equal(scheduler.statuses().find((s) => s.endpoint === "endpoint-exhaust")?.active ?? 0, 0);
});

test("a non-retryable error (quota/billing) fails fast without retrying", async () => {
  const scheduler = new ProviderRequestScheduler({ idleTimeoutMs: 0, maxRetries: 2, retryBaseDelayMs: 1 });
  let calls = 0;
  const source: ProviderStreams = { stream: () => { calls += 1; return erroringStream("insufficient_quota: monthly billing limit"); }, streamSimple: () => erroringStream("insufficient_quota") };
  const wrapped = scheduler.wrap(source, { provider: model.provider, model: model.id, endpoint: "endpoint-quota", maxConcurrentRequests: 1 });
  const result = await collect(wrapped.stream(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] }));
  assert.equal(calls, 1);                     // deterministic error → no retry
  assert.equal(result.stopReason, "error");
});

test("the retried observer reports the ACTUAL number of re-issues", async () => {
  const scheduler = new ProviderRequestScheduler({ idleTimeoutMs: 0, maxRetries: 3, retryBaseDelayMs: 1 });
  const attempts: number[] = [];
  const observer = { queued: () => "R1", started: () => {}, cancelled: () => {}, retried: (_id: string | undefined, info: { attempt: number }) => { attempts.push(info.attempt); } };
  let calls = 0;
  const source: ProviderStreams = { stream: () => (calls += 1) <= 2 ? erroringStream("503") : delayedStream(2), streamSimple: () => delayedStream(2) };
  const wrapped = scheduler.wrap(source, { provider: model.provider, model: model.id, endpoint: "endpoint-count", maxConcurrentRequests: 1 }, observer);
  const result = await collect(wrapped.stream(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] }));
  assert.equal(result.stopReason, "stop");
  assert.equal(calls, 3);                     // initial + 2 re-issues
  assert.deepEqual(attempts, [1, 2]);         // retried fired once per actual re-issue, 1-indexed
});

test("abort during retry backoff stops further attempts and yields an aborted terminal", async () => {
  const scheduler = new ProviderRequestScheduler({ idleTimeoutMs: 0, maxRetries: 3, retryBaseDelayMs: 200 });
  let calls = 0;
  const source: ProviderStreams = { stream: () => { calls += 1; return erroringStream("503"); }, streamSimple: () => erroringStream("503") };
  const controller = new AbortController();
  const wrapped = scheduler.wrap(source, { provider: model.provider, model: model.id, endpoint: "endpoint-abort", maxConcurrentRequests: 1 });
  const promise = collect(wrapped.stream(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] }, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 20);   // abort while the first backoff (200ms) is sleeping
  const result = await promise;
  assert.equal(result.stopReason, "aborted");
  assert.equal(calls, 1);                     // never re-issued after the abort
  assert.equal(scheduler.statuses().find((s) => s.endpoint === "endpoint-abort")?.active ?? 0, 0);
});

test("a source that throws synchronously after the permit is acquired yields a terminal error and frees the slot", async () => {
  const scheduler = new ProviderRequestScheduler({ idleTimeoutMs: 0, maxRetries: 2, retryBaseDelayMs: 1 });
  // Mirrors ProviderRequestBudget.start() throwing synchronously once the deadline
  // is exhausted (the production stack wraps budget inside the scheduler). Without
  // a catch on the permit-held path this escaped forward() as an unhandled
  // rejection and the output stream never got a terminal event.
  const source: ProviderStreams = {
    stream: () => { throw new Error("Provider deadline exhausted before request"); },
    streamSimple: () => { throw new Error("Provider deadline exhausted before request"); },
  };
  const wrapped = scheduler.wrap(source, { provider: model.provider, model: model.id, endpoint: "endpoint-throw", maxConcurrentRequests: 1 });
  const result = await collect(wrapped.stream(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] }));
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /deadline exhausted/);
  assert.equal(scheduler.statuses().find((s) => s.endpoint === "endpoint-throw")?.active ?? 0, 0);
});

test("an observer.started that throws still yields a terminal error and frees the slot", async () => {
  const scheduler = new ProviderRequestScheduler({ idleTimeoutMs: 0 });
  const observer = { queued: () => "R1", started: () => { throw new Error("started hook failed"); }, cancelled: () => {} };
  const source: ProviderStreams = { stream: () => delayedStream(2), streamSimple: () => delayedStream(2) };
  const wrapped = scheduler.wrap(source, { provider: model.provider, model: model.id, endpoint: "endpoint-started-throw", maxConcurrentRequests: 1 }, observer);
  const result = await collect(wrapped.stream(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] }));
  assert.equal(result.stopReason, "error");
  assert.equal(scheduler.statuses().find((s) => s.endpoint === "endpoint-started-throw")?.active ?? 0, 0);
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

function errorMsg(text: string): AssistantMessage {
  return { role: "assistant", api: "openai-completions", provider: model.provider, model: model.id, content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: text, timestamp: Date.now() };
}

function erroringStream(errorText: string, delayMs = 1): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  setTimeout(() => { output.push({ type: "error", reason: "error", error: errorMsg(errorText) }); }, delayMs);
  return output;
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessage> {
  let result: AssistantMessage | undefined;
  for await (const event of stream) if (event.type === "done" || event.type === "error") result = event.type === "done" ? event.message : event.error;
  assert.ok(result);
  return result;
}

async function collectAll(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
