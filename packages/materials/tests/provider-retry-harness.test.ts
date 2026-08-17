import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentHarness, JsonlSessionRepo, NodeExecutionEnv, type AgentHarnessTool } from "@earendil-works/pi-agent-core/node";
import {
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ProviderRequestScheduler } from "../src/runtime/provider-scheduler.js";

// End-to-end proof for the PR #53 review's P1#2: a TRANSIENT provider-stream
// error is retried at the stream boundary (inside ProviderRequestScheduler), so
// a real AgentHarness turn is NOT restarted — the user message is not duplicated
// and tools are not re-run. The old lane-level approach retried harness.prompt()
// and would have produced two identical user messages plus a doubled tool call.
test("a mid-stream provider error retried at the scheduler does NOT duplicate the user message or re-run tools (real AgentHarness)", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-provider-retry-"));
  const env = new NodeExecutionEnv({ cwd: root });
  try {
    const faux = fauxProvider({ provider: "faux-retry" });
    const models = createModels();

    // Faux scripts TWO real assistant turns: (1) call the tool, (2) finish.
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("noop", {}, { id: "call-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);

    // A flaky wrapper: the FIRST provider stream call errors mid-stream with a
    // retryable message; every later call delegates to faux. The scheduler's
    // retry consumes that error and re-issues — which lands on faux response #1.
    let streamCalls = 0;
    // The harness drives turns through streamSimple, so the flaky+count logic
    // lives there; stream mirrors it for completeness.
    const flake = (delegate: ProviderStreams["stream"]): ProviderStreams["stream"] => (model, context, options) => {
      streamCalls += 1;
      if (streamCalls === 1) return erroringStream("Provider returned error 503");
      return delegate(model, context, options);
    };
    const flaky: ProviderStreams = {
      stream: flake((m, c, o) => faux.provider.stream(m, c, o)),
      streamSimple: flake((m, c, o) => faux.provider.streamSimple(m, c, o)),
    };
    const scheduler = new ProviderRequestScheduler({ idleTimeoutMs: 0, maxRetries: 2, retryBaseDelayMs: 1 });
    const scoped = scheduler.wrap(flaky, { provider: "faux-retry", model: faux.getModel().id, endpoint: "faux-endpoint", maxConcurrentRequests: 1 });
    // Re-expose the scheduled streams as a Provider for models.setProvider.
    models.setProvider({ ...faux.provider, stream: scoped.stream, streamSimple: scoped.streamSimple });

    let toolRuns = 0;
    const noop: AgentHarnessTool<undefined> = {
      name: "noop",
      label: "noop",
      description: "Counts how many times it runs.",
      parameters: Type.Object({}),
      async execute() {
        toolRuns += 1;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const sessionRepo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "pi-sessions") });
    const session = await sessionRepo.create({ id: "retry-chat", cwd: root, metadata: { runId: "retry", lane: "main" } });
    const harness = new AgentHarness({ session, models, model: faux.getModel(), tools: [noop], activeToolNames: ["noop"], systemPrompt: "test" });

    const response = await harness.prompt("solve once");

    assert.equal(response.stopReason, "stop");
    // 3 provider stream calls: attempt#1 errored, retry landed faux#1 (toolUse),
    // then a second harness iteration made faux#2 (stop).
    assert.equal(streamCalls, 3);
    // The tool ran exactly ONCE — the mid-stream retry did not re-run it.
    assert.equal(toolRuns, 1);
    // Exactly ONE user message in the persisted session — no duplicate from retry.
    const userMessages = (await session.getBranch()).filter((entry) => entry.type === "message" && entry.message.role === "user");
    assert.equal(userMessages.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function erroringStream(errorText: string): ReturnType<typeof createAssistantMessageEventStream> {
  const output = createAssistantMessageEventStream();
  setTimeout(() => { output.push({ type: "error", reason: "error", error: errorMsg(errorText) }); }, 1);
  return output;
}

function errorMsg(text: string): AssistantMessage {
  return { role: "assistant", api: "openai-completions", provider: "faux-retry", model: "faux", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: text, timestamp: Date.now() };
}
