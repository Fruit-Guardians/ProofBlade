import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureProviderPrefixShape } from "@proofblade/molecules";
import type { ProofBladeConfig } from "../src/config.js";
import { createServices, demoTask } from "../src/app/demo.js";
import { RunTelemetry } from "../src/observability/run-telemetry.js";
import { canonicalJson, sha256 } from "../src/domain/utils.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "auto",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "TEST_API_KEY",
      contextWindow: 4_096,
      maxTokens: 512,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      input: ["text"],
    },
  },
};

test("run telemetry aggregates provider, tool, effect, version, and failure data", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-observe-"));
  try {
    const services = createServices(root, config);
    const runId = "OBSERVE-001";
    const snapshot = await services.control.createRun(runId, demoTask(runId, root, config));
    assert.ok(snapshot.versionSnapshot);
    const { hash: _hash, ...versionBase } = snapshot.versionSnapshot;
    assert.equal(snapshot.versionSnapshot.hash, sha256(canonicalJson(versionBase)));
    assert.equal(snapshot.versionSnapshot.piVersion, "0.83.0");
    assert.equal(snapshot.versionSnapshot.toolContractVersion, "tools@2");

    await services.control.append(runId, [
      { schemaVersion: 1, lane: "executor", correlationId: "provider-1", actor: "model", type: "provider_request_started", payload: { requestId: "PR-1", provider: "local", model: "fixture-model", phase: "intake", contextEstimatedTokens: 800, retryLimit: 0 } },
      { schemaVersion: 1, lane: "executor", correlationId: "provider-queue", actor: "orchestrator", type: "provider_request_queued", payload: { requestId: "PR-1", provider: "local", model: "fixture-model", maxConcurrentRequests: 1, queueDepth: 2 } },
      { schemaVersion: 1, lane: "executor", correlationId: "provider-queue", actor: "orchestrator", type: "provider_request_slot_acquired", payload: { requestId: "PR-1", provider: "local", model: "fixture-model", maxConcurrentRequests: 1, queueDepth: 2, waitMs: 40 } },
      { schemaVersion: 1, lane: "executor", correlationId: "provider-1", actor: "model", type: "provider_response_received", payload: { requestId: "PR-1", status: 200, headerNames: ["content-type"], responseHeaderCount: 1 } },
      { schemaVersion: 1, lane: "executor", correlationId: "provider-1", actor: "model", type: "model_usage", payload: { requestId: "PR-1", provider: "local", model: "fixture-model", phase: "intake", durationMs: 120, finishReason: "toolUse", toolCallCount: 1, usage: { input: 100, output: 20, reasoning: 5, cacheRead: 25, cacheWrite: 10, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
      { schemaVersion: 1, lane: "executor", correlationId: "tool-1", actor: "model", type: "tool_call_recorded", payload: { toolCallId: "TC-1", toolName: "inspect_target", argsHash: sha256("{}"), waitMs: 4, executionMode: "sequential", sensitivity: "target", timeoutMs: 30_000 } },
      { schemaVersion: 1, lane: "executor", correlationId: "tool-1", actor: "tool", type: "tool_result_recorded", payload: { toolCallId: "TC-1", toolName: "inspect_target", durationMs: 30, outputBytes: 64, isError: false, artifactHashes: [], evidenceAdded: true } },
      { schemaVersion: 1, lane: "executor", correlationId: "compact-1", actor: "orchestrator", type: "compaction_recorded", payload: { fromHook: true, tokensBefore: 900 } },
    ]);
    await services.control.dispatch(runId, { type: "effect_proposed", effect: { id: "EF-1", idempotencyKey: "effect-key", replayPolicy: "pure", operation: "fixture_read", args: {}, status: "PROPOSED" }, lane: "executor" });
    await services.control.dispatch(runId, { type: "effect_started", effectId: "EF-1", lane: "executor" });
    await services.control.dispatch(runId, { type: "effect_finished", effectId: "EF-1", outcome: "timeout", durationMs: 80, outputBytes: 12, exitCode: null, errorSignature: "e".repeat(64), lane: "executor" });
    await services.control.dispatch(runId, { type: "fail", reason: "verification did not complete", category: "verification_missing" });

    const telemetry = new RunTelemetry(services.control);
    const report = await telemetry.report(runId);
    assert.equal(report.provider.requestCount, 1);
    assert.equal(report.provider.tokens.input, 100);
    assert.equal(report.provider.tokens.cacheRead, 25);
    assert.equal(report.provider.cacheHitRate, 0.2);
    assert.equal(report.provider.latencyMs.p95, 120);
    assert.equal(report.provider.cost.totalUsd, 0);
    assert.deepEqual(report.provider.scheduling, { queued: 1, cancelled: 0, maxQueueDepth: 2, waitMs: 40, averageWaitMs: 40 });
    assert.equal(report.tools.agentCalls, 1);
    assert.equal(report.tools.effectiveActionRatio, 1);
    assert.equal(report.tools.effectTimeouts, 1);
    assert.equal(report.context.compactions, 1);
    assert.equal(report.failure?.primary, "verification_missing");
    assert.equal(report.reportHash, (await telemetry.report(runId)).reportHash);
    assert.doesNotMatch(await readFile(join(root, "runs", runId, "events.jsonl"), "utf8"), /TEST_API_KEY|http:\/\/127\.0\.0\.1/);

    const sparseRunId = "OBSERVE-USAGE-ONLY";
    await services.control.createRun(sparseRunId, demoTask(sparseRunId, root, config));
    await services.control.append(sparseRunId, [{
      schemaVersion: 1,
      lane: "executor",
      correlationId: "usage-only",
      actor: "model",
      type: "model_usage",
      payload: { provider: "local", model: "fixture-model", finishReason: "stop", usage: { input: 2, output: 1, totalTokens: 3, cost: { total: 0 } } },
    }]);
    const sparse = await telemetry.report(sparseRunId);
    assert.equal(sparse.provider.requestCount, 1);
    assert.equal(sparse.provider.responseCount, 1);

    const prefixRunId = "OBSERVE-CACHE-PREFIX";
    await services.control.createRun(prefixRunId, demoTask(prefixRunId, root, config));
    const stablePrefix = captureProviderPrefixShape({ messages: [{ role: "system", content: "stable" }, { role: "user", content: "turn one" }], tools: [{ name: "read" }] });
    const dynamicOnly = captureProviderPrefixShape({ messages: [{ role: "system", content: "stable" }, { role: "user", content: "turn two" }], tools: [{ name: "read" }] });
    const changedTools = captureProviderPrefixShape({ messages: [{ role: "system", content: "stable" }, { role: "user", content: "turn three" }], tools: [{ name: "read" }, { name: "bash" }] });
    await services.control.append(prefixRunId, [stablePrefix, dynamicOnly, changedTools].map((cachePrefix, index) => ({
      schemaVersion: 1 as const,
      lane: "executor" as const,
      correlationId: `prefix-${index}`,
      actor: "model" as const,
      type: "model_usage" as const,
      payload: { provider: "local", model: "fixture-model", cachePrefix, usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } },
    })));
    const prefix = (await telemetry.report(prefixRunId)).provider.cachePrefix;
    assert.equal(prefix.observedRequests, 3);
    assert.equal(prefix.comparableRequests, 2);
    assert.equal(prefix.stableRequests, 1);
    assert.equal(prefix.changedRequests, 1);
    assert.equal(prefix.stabilityRate, 0.5);
    assert.deepEqual(prefix.changeReasons, { tools: 1 });
    assert.equal(prefix.last?.toolCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
