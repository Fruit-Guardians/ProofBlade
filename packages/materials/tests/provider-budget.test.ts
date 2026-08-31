import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import type { HarnessEvent } from "../src/domain/types.js";
import { assertProviderBudgetPricing, ProviderBudgetExceededError, ProviderBudgetPricingError, ProviderRequestBudget, recoverProviderSpend } from "../src/runtime/provider-budget.js";

const model: Model<"openai-completions"> = {
  id: "budget-test",
  name: "budget-test",
  api: "openai-completions",
  provider: "budget-test",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
  contextWindow: 1_000,
  maxTokens: 100,
};

test("provider budget rejects an over-budget request before the Provider starts", () => {
  let starts = 0;
  const budget = new ProviderRequestBudget({ maxCostUsd: 0.0012, deadlineAt: Date.now() + 10_000 });
  const provider = budget.wrap(completingProvider(() => { starts += 1; return message(0); }));
  try {
    let message = "";
    assert.throws(
      () => provider.stream(model, { messages: [] }, { maxTokens: 500 }),
      (error: unknown) => {
        message = error instanceof Error ? error.message : String(error);
        return error instanceof ProviderBudgetExceededError;
      },
    );
    assert.match(message, /Reason:.*No Provider request was sent[\s\S]*Next:/);
    assert.match(message, /at least 0\.0015 USD available/);
    assert.equal(starts, 0);
    assert.equal(budget.termination, "budget_exhausted");
  } finally {
    budget.close();
  }
});

test("provider budget fails closed without pricing when a cost cap is configured", () => {
  const unpriced = { ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  assert.throws(() => assertProviderBudgetPricing(1, unpriced), ProviderBudgetPricingError);
  let starts = 0;
  const budget = new ProviderRequestBudget({ maxCostUsd: 1, deadlineAt: Date.now() + 10_000 });
  const provider = budget.wrap(completingProvider(() => { starts += 1; return message(0); }));
  try {
    assert.throws(() => provider.stream(unpriced, { messages: [] }), ProviderBudgetPricingError);
    assert.equal(starts, 0);
  } finally {
    budget.close();
  }
});

test("provider budget charges its conservative reservation when a Provider omits usage", async () => {
  const budget = new ProviderRequestBudget({ maxCostUsd: 0.003, deadlineAt: Date.now() + 10_000 });
  let retries: number | undefined;
  const source: ProviderStreams = {
    stream: (_model, _context, options) => {
      retries = options?.maxRetries;
      const output = createAssistantMessageEventStream();
      queueMicrotask(() => output.push({ type: "done", reason: "stop", message: message(0) }));
      return output;
    },
    streamSimple: (_model, _context, options) => {
      retries = options?.maxRetries;
      const output = createAssistantMessageEventStream();
      queueMicrotask(() => output.push({ type: "done", reason: "stop", message: message(0) }));
      return output;
    },
  };
  const provider = budget.wrap(source);
  try {
    const response = await collect(provider.stream(model, { messages: [] }));
    assert.equal(response.usage.cost.total, 0.0011);
    assert.equal(response.usage.cost.output, 0.0011);
    assert.equal(retries, 0);
    assert.equal(budget.termination, undefined);
  } finally {
    budget.close();
  }
});

test("provider budget aborts an in-flight Provider request at the Run deadline", async () => {
  const budget = new ProviderRequestBudget({ maxCostUsd: 0.003, deadlineAt: Date.now() + 20 });
  let sawAbort = false;
  const stalled: ProviderStreams = {
    stream: (_model, _context, options) => abortingStream(options?.signal, () => { sawAbort = true; }),
    streamSimple: (_model, _context, options) => abortingStream(options?.signal, () => { sawAbort = true; }),
  };
  const provider = budget.wrap(stalled);
  try {
    const response = await collect(provider.stream(model, { messages: [] }));
    assert.equal(response.stopReason, "aborted");
    assert.equal(sawAbort, true);
    assert.equal(budget.termination, "deadline_exhausted");
  } finally {
    budget.close();
  }
});

test("provider deadline refusal explains that no request started and how to recover", () => {
  let starts = 0;
  const budget = new ProviderRequestBudget({ deadlineAt: Date.now() - 1 });
  const provider = budget.wrap(completingProvider(() => { starts += 1; return message(0); }));
  try {
    let refusal = "";
    assert.throws(
      () => provider.stream(model, { messages: [] }),
      (error: unknown) => {
        refusal = error instanceof Error ? error.message : String(error);
        return error instanceof ProviderBudgetExceededError;
      },
    );
    assert.match(refusal, /Reason:.*No Provider request was sent[\s\S]*Next:/);
    assert.match(refusal, /new authorized Run with a later deadline/);
    assert.equal(starts, 0);
    assert.equal(budget.termination, "deadline_exhausted");
  } finally {
    budget.close();
  }
});

test("provider budget retains settled usage and an unfinished reservation after restart", () => {
  const history: Array<Pick<HarnessEvent, "type" | "payload">> = [
    { type: "provider_request_started", payload: { requestId: "PR-settled" } },
    { type: "model_usage", payload: { requestId: "PR-settled", usage: { input: 100, output: 30, reasoning: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } },
    { type: "provider_request_started", payload: { requestId: "PR-in-flight" } },
  ];
  const initialSpentUsd = recoverProviderSpend(history, model);
  assert.equal(initialSpentUsd, 0.00123);
  let starts = 0;
  const budget = new ProviderRequestBudget({ maxCostUsd: 0.0023, deadlineAt: Date.now() + 10_000, initialSpentUsd });
  const provider = budget.wrap(completingProvider(() => { starts += 1; return message(0); }));
  try {
    assert.throws(() => provider.stream(model, { messages: [] }), ProviderBudgetExceededError);
    assert.equal(starts, 0);
    assert.equal(budget.termination, "budget_exhausted");
  } finally {
    budget.close();
  }
});

test("provider budget ignores a durable queue cancellation without a started request", () => {
  const history: Array<Pick<HarnessEvent, "type" | "payload">> = [
    { type: "provider_request_queued", payload: { requestId: "PR-queued" } },
    { type: "provider_request_queue_cancelled", payload: { requestId: "PR-queued" } },
    { type: "model_usage", payload: { requestId: "PR-queued", queueCancelled: true, usage: { input: 0, output: 0, cost: { total: 0 } } } },
  ];
  assert.equal(recoverProviderSpend(history, model), 0);
});

function completingProvider(createMessage: () => AssistantMessage): ProviderStreams {
  const stream = (): AssistantMessageEventStream => {
    const output = createAssistantMessageEventStream();
    queueMicrotask(() => output.push({ type: "done", reason: "stop", message: createMessage() }));
    return output;
  };
  return { stream, streamSimple: stream };
}

function abortingStream(signal: AbortSignal | undefined, onAbort: () => void): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const abort = () => {
    onAbort();
    output.push({ type: "error", reason: "aborted", error: { ...message(0), stopReason: "aborted", errorMessage: "aborted by budget" } });
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return output;
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessage> {
  let result: AssistantMessage | undefined;
  for await (const event of stream) {
    if (event.type === "done") result = event.message;
    if (event.type === "error") result = event.error;
  }
  assert.ok(result);
  return result;
}

function message(cost: number): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "budget-test",
    model: "budget-test",
    content: [{ type: "text", text: "ok" }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
