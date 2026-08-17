import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { promptWithProviderErrorRetry } from "../src/runtime/provider-error-recovery.js";

const FAST = { baseDelayMs: 1 };

test("retries a transient mid-stream error and returns the eventual success", async () => {
  const results = [errorMessage("Provider returned error"), errorMessage("socket hang up"), okMessage()];
  let calls = 0;
  const retries: number[] = [];
  const out = await promptWithProviderErrorRetry(async () => results[calls++]!, {
    ...FAST,
    onRetry: (attempt) => { retries.push(attempt); },
  });
  assert.equal(calls, 3);                 // initial + 2 retries
  assert.equal(out.response.stopReason, "stop");
  assert.equal(out.retryCount, 2);
  assert.equal(out.exhausted, false);
  assert.deepEqual(retries, [1, 2]);      // onRetry fired 1-indexed per attempt
});

test("stops after the retry budget and reports exhausted on a persistent transient error", async () => {
  let calls = 0;
  const out = await promptWithProviderErrorRetry(async () => { calls += 1; return errorMessage("503 service unavailable"); }, {
    ...FAST,
    maxRetries: 2,
  });
  assert.equal(calls, 3);                 // initial + 2 retries, then give up
  assert.equal(out.response.stopReason, "error");
  assert.equal(out.retryCount, 2);
  assert.equal(out.exhausted, true);      // final response is still a retryable error
});

test("fails fast on a deterministic quota/billing error — no retries, no backoff", async () => {
  let calls = 0;
  const out = await promptWithProviderErrorRetry(async () => { calls += 1; return errorMessage("insufficient_quota: monthly billing limit"); }, FAST);
  assert.equal(calls, 1);                 // returned immediately
  assert.equal(out.retryCount, 0);
  assert.equal(out.exhausted, false);     // non-retryable, so not "exhausted"
  assert.equal(out.response.stopReason, "error");
});

test("never retries an aborted turn", async () => {
  let calls = 0;
  const out = await promptWithProviderErrorRetry(async () => { calls += 1; return abortedMessage(); }, FAST);
  assert.equal(calls, 1);
  assert.equal(out.retryCount, 0);
  assert.equal(out.exhausted, false);
  assert.equal(out.response.stopReason, "aborted");
});

test("maxRetries=0 disables the loop and returns the first response unchanged", async () => {
  let calls = 0;
  const out = await promptWithProviderErrorRetry(async () => { calls += 1; return errorMessage("500 internal error"); }, {
    ...FAST,
    maxRetries: 0,
  });
  assert.equal(calls, 1);
  assert.equal(out.retryCount, 0);
  assert.equal(out.exhausted, true);      // it IS a retryable error, we just chose not to retry
});

test("a first-try success reports zero retries", async () => {
  const out = await promptWithProviderErrorRetry(async () => okMessage(), FAST);
  assert.equal(out.retryCount, 0);
  assert.equal(out.exhausted, false);
  assert.equal(out.response.stopReason, "stop");
});

function base(): Omit<AssistantMessage, "stopReason" | "errorMessage"> {
  return {
    role: "assistant", api: "openai-completions", provider: "p", model: "m",
    content: [{ type: "text", text: "" }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  };
}

function okMessage(): AssistantMessage {
  return { ...base(), content: [{ type: "text", text: "ok" }], stopReason: "stop" as StopReason };
}

function errorMessage(message: string): AssistantMessage {
  return { ...base(), stopReason: "error" as StopReason, errorMessage: message };
}

function abortedMessage(): AssistantMessage {
  return { ...base(), stopReason: "aborted" as StopReason };
}
