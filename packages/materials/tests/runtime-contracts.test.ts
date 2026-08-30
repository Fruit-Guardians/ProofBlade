import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "../src/config.js";
import { createServices, demoTask } from "../src/app/demo.js";
import { reconstructRequestEpoch, createRequestEpoch, hashRequestHeaders, hashRequestValue } from "../src/runtime/request-epoch.js";
import { MemoryTelemetryBackend, RunTelemetryExporter, type TelemetryBackend } from "../src/observability/telemetry-backend.js";
import { SpillStore, type SpillArtifactWriter } from "../src/storage/spill-store.js";
import type { ArtifactRef } from "../src/domain/types.js";
import { sha256 } from "../src/domain/utils.js";
import { createEvaluationProtocol, summarizeEvaluationAttempts, compareEvaluationAttempts } from "../src/evaluation/protocol.js";
import { attributeFailure, createTrajectoryPrefix } from "../src/evaluation/failure-attribution.js";
import { CapabilityLifecycleRegistry, registrationIdentity } from "../src/capabilities/lifecycle.js";
import { reconcileRuntimeConfig } from "../src/runtime/config-reconciliation.js";
import { Scope } from "../src/runtime/scope.js";
import { DEFAULT_AGENT_STRATEGY, DisabledMultiAgentControlPort, projectAgentControlOperation, selectAgentStrategy, validateAgentHandoff, winnerSettlementKey } from "../src/orchestration/multi-agent-contract.js";
import { auditRunLifecycles, scanOrphanLifecycles, scanRecoveryRequiredLifecycles } from "../src/observability/lifecycle-audit.js";
import type { HarnessEvent } from "../src/domain/types.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", model: "test-model",
      modelDiscoveryPath: "/models", apiKeyEnv: "TEST_API_KEY", contextWindow: 4096, maxTokens: 512,
      requestTimeoutMs: 1000, maxRetries: 0, input: ["text"],
    },
  },
};

test("RequestEpoch hashes request material without persisting secrets and replays terminal state", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-request-epoch-"));
  try {
    const services = createServices(root, config);
    const runId = "REQUEST-EPOCH-001";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const epoch = createRequestEpoch({
      runId, generation: 0, lane: "executor", provider: "test", model: "test-model", adapter: "openai-completions",
      requestId: "request-1", contextWindow: 4096, toolNames: ["read", "read"],
      requestHeaders: { Authorization: "Bearer do-not-persist", "X-Trace": "opaque" },
      requestBody: { messages: [{ role: "user", content: "private" }], token: "do-not-persist" },
      scopePolicy: { allow: ["read"] },
    });
    assert.equal(epoch.generation, 0);
    await services.control.dispatch(runId, { type: "request_epoch_started", epoch, lane: "executor" });
    await services.control.append(runId, [
      { schemaVersion: 1, lane: "executor", correlationId: "request-1", actor: "model", type: "request_epoch_context", payload: { requestEpochId: epoch.id, fields: { requestContextHash: hashRequestValue({ phase: "reconnaissance" }) } } },
      { schemaVersion: 1, lane: "executor", correlationId: "request-1", actor: "model", type: "provider_response_received", payload: { epochId: epoch.id, status: 200 } },
      { schemaVersion: 1, lane: "executor", correlationId: "request-1", actor: "model", type: "model_usage", payload: { epochId: epoch.id, usage: { input: 10, output: 2 } } },
    ]);
    const events = await services.control.events(runId);
    const replayed = reconstructRequestEpoch(events, epoch.id);
    assert.equal(replayed?.status, "COMPLETED");
    assert.deepEqual(replayed?.toolNames, ["read"]);
    assert.equal(replayed?.requestHeadersHash, hashRequestHeaders({ Authorization: "different-secret", "X-Trace": "other" }));
    assert.equal(JSON.stringify(replayed).includes("do-not-persist"), false);
    assert.equal(JSON.stringify(replayed).includes("private"), false);
    assert.equal(replayed?.requestContextHash, hashRequestValue({ phase: "reconnaissance" }));
    assert.equal(hashRequestValue({ b: 2, a: 1 }), hashRequestValue({ a: 1, b: 2 }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RequestEpoch rejects stale generations while accepting legacy epochs without generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-request-epoch-generation-"));
  try {
    const services = createServices(root, config);
    const runId = "REQUEST-EPOCH-GENERATION-001";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const stale = createRequestEpoch({
      runId, generation: 1, lane: "executor", provider: "test", model: "test-model", adapter: "openai-completions", requestId: "stale-request",
    });
    await assert.rejects(
      services.control.dispatch(runId, { type: "request_epoch_started", epoch: stale, lane: "executor" }),
      /generation mismatch/,
    );

    const legacy = createRequestEpoch({
      runId, lane: "executor", provider: "test", model: "test-model", adapter: "openai-completions", requestId: "legacy-request",
    });
    await services.control.dispatch(runId, { type: "request_epoch_started", epoch: legacy, lane: "executor" });
    assert.equal((await services.control.snapshot(runId)).requestEpochs[legacy.id]?.generation, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ArtifactStore text ranges do not emit replacement characters at UTF-8 slice boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-artifact-range-"));
  try {
    const services = createServices(root, config);
    const runId = "ARTIFACT-RANGE-001";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const artifact = await services.artifacts.stageText(runId, "A\u4f60B\u597dC", { filename: "utf8.txt" });

    const incompleteSuffix = await services.artifacts.readTextRange(runId, artifact, 2);
    assert.equal(incompleteSuffix.content, "A");
    assert.equal(incompleteSuffix.bytesRead, 2);
    assert.equal(incompleteSuffix.truncated, true);

    const splitBothEnds = await services.artifacts.readTextRange(runId, artifact, 4, 2);
    assert.equal(splitBothEnds.content, "B");
    assert.doesNotMatch(splitBothEnds.content, /\ufffd/);

    const suffix = await services.artifacts.readTextRange(runId, artifact, 7, 2);
    assert.equal(suffix.content, "B\u597dC");
    assert.equal(suffix.truncated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RunTelemetryExporter creates bounded redacted spans and advances its cursor only after success", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-telemetry-"));
  try {
    const services = createServices(root, config);
    const runId = "TELEMETRY-001";
    await services.control.createRun(runId, demoTask(runId, root, config));
    await services.control.append(runId, [
      { schemaVersion: 1, lane: "executor", correlationId: "trace-1", actor: "tool", type: "tool_result_recorded", payload: { toolCallId: "call-1", artifactId: "A-1", apiKey: "secret-value", content: "Bearer secret-value" } },
    ]);
    const backend = new MemoryTelemetryBackend();
    const exporter = new RunTelemetryExporter(services.control, backend, join(root, "telemetry"));
    const first = await exporter.export(runId);
    assert.equal(first.exported, 2);
    assert.equal((await exporter.export(runId)).exported, 0);
    const spans = backend.records();
    const toolSpan = spans.find((span) => span.kind === "tool_result_recorded");
    assert.ok(toolSpan);
    assert.deepEqual(toolSpan.artifactIds, ["A-1"]);
    assert.equal(JSON.stringify(toolSpan).includes("secret-value"), false);
    assert.equal(toolSpan.attributes.actor, "tool");

    const failingBackend = new FailingBackend();
    const retrying = new RunTelemetryExporter(services.control, failingBackend, join(root, "failed-telemetry"));
    const failed = await retrying.export(runId);
    assert.match(failed.diagnostic ?? "", /backend failed/);
    assert.equal(failed.cursor, 0);
    failingBackend.fail = false;
    const recovered = await retrying.export(runId);
    assert.equal(recovered.exported, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SpillStore keeps canonical value, bounded presentation, and durable content distinct", async () => {
  const writes: string[] = [];
  const stored = new Map<string, string>();
  const writer: SpillArtifactWriter = {
    async putText(_runId, content) {
      writes.push(content);
      const artifact: ArtifactRef = { id: "A-SPILL", runId: "SPILL-001", generation: 0, path: "artifacts/spill.json", sha256: sha256(content), bytes: Buffer.byteLength(content), mime: "application/json", sensitivity: "public" };
      stored.set(artifact.id, content);
      return artifact;
    },
    async readText(_runId, artifact) {
      return stored.get(artifact.id)!;
    },
  };
  const spill = new SpillStore(writer);
  const large = await spill.persist("SPILL-001", { operation: "read", value: { result: "x".repeat(200) }, spillThresholdChars: 64, presentationMaxChars: 80 });
  assert.equal(large.durable.state, "spilled");
  assert.equal(large.presentation.truncated, true);
  assert.equal(large.presentation.content.length <= 80, true);
  assert.equal(large.canonical.value.result.length, 200);
  assert.equal(writes.length, 1);
  const artifact: ArtifactRef = { id: "A-SPILL", runId: "SPILL-001", generation: 0, path: "artifacts/spill.json", sha256: sha256(writes[0]!), bytes: Buffer.byteLength(writes[0]!), mime: "application/json", sensitivity: "public" };
  assert.equal(await spill.read("SPILL-001", large, { "A-SPILL": artifact }), writes[0]);

  const small = await spill.persist("SPILL-001", { operation: "status", value: { ok: true }, spillThresholdChars: 64 });
  assert.equal(small.durable.state, "inline");
  assert.equal(small.durable.artifactId, undefined);
});

test("evaluation protocol rejects arbitrary rubric scripts and reports reliability metrics", () => {
  const protocol = createEvaluationProtocol({
    id: "eval.contract",
    version: "proofblade-evaluation-v1",
    dataset: { id: "dataset-1", version: "1", taskIds: ["task-1", "task-2"], source: "regression", contentHash: "a".repeat(64) },
    environment: { id: "fixture-1", version: "1", reset: "fixture", stateHash: "b".repeat(64) },
    tools: { catalogHash: "c".repeat(64), toolIds: ["read", "evidence"], allowedSideEffects: [] },
    rubric: { checks: [{ type: "run_status", expected: "SUCCEEDED" }], prohibited: ["candidate leak"], review: "mechanical-only" },
    interaction: { maxSteps: 20, maxDurationMs: 60_000, maxCostUsd: 1, termination: "verified" },
  });
  assert.equal(protocol.hash.length, 64);
  assert.throws(() => createEvaluationProtocol({
    ...protocol,
    rubric: { ...protocol.rubric, checks: [{ type: "arbitrary_script" } as never] },
  }), /Unsupported rubric check/);
  const attempts = [
    attempt("task-1", 1, "FAIL", false), attempt("task-1", 2, "PASS", true),
    attempt("task-2", 1, "PASS", true), attempt("task-2", 2, "PASS", true),
  ];
  const metrics = summarizeEvaluationAttempts(attempts, 2);
  assert.equal(metrics.passAtK, 1);
  assert.equal(metrics.passConsecutiveK, 0.5);
  assert.equal(metrics.passAt1, 0.5);
  assert.equal(metrics.flakyRate, 0.5);
  assert.equal(compareEvaluationAttempts(attempts.slice(0, 2), attempts.slice(2)).comparableTaskCount, 0);
  const comparison = compareEvaluationAttempts(
    [attempt("task-1", 1, "FAIL", false), attempt("task-2", 1, "PASS", true)],
    [attempt("task-1", 1, "PASS", true), attempt("task-2", 1, "PASS", true)],
  );
  assert.equal(comparison.failToPass, 1);
  assert.equal(comparison.passToPass, 1);
});

test("failure attribution selects the first causal error and freezes the prefix before it", () => {
  const events = [
    event(1, "tool_call_recorded", { toolCallId: "call-1", evidenceIds: ["EV-1"] }),
    event(2, "provider_response_received", { status: 503, epochId: "RE-1" }),
    event(3, "tool_result_recorded", { isError: true, errorSignature: "later timeout", artifactId: "A-1" }),
    event(4, "run_failed", { category: "provider_transient_error", reason: "final cascade" }),
  ];
  const attribution = attributeFailure(events, { taskId: "task-1", environmentStateHash: "d".repeat(64) });
  assert.ok(attribution);
  assert.equal(attribution.firstErrorStep, 2);
  assert.equal(attribution.rootCauseOwner, "provider");
  assert.equal(attribution.recoverability, "recoverable");
  assert.deepEqual(attribution.supportingEvidenceIds, ["EV-1"]);
  const prefix = createTrajectoryPrefix(events, attribution, "d".repeat(64));
  assert.deepEqual(prefix.frozenEventIds, [events[0]!.id]);
  assert.deepEqual(prefix.frozenEvidenceIds, ["EV-1"]);
  assert.equal(prefix.frozenRequestEpochIds.length, 0);
  assert.equal(prefix.hash.length, 64);
});

test("capability lifecycle fences new bindings during quiescing and releases child scopes first", async () => {
  const registry = new CapabilityLifecycleRegistry();
  const root = new Scope("run");
  const providerScope = root.child("provider");
  const consumerScope = root.child("lane");
  const events: string[] = [];
  registry.subscribe((event) => events.push(event.type));
  const definition = { capabilityId: "proofblade.test", version: "1.0.0", description: "test capability", contractHash: "e".repeat(64), capabilities: ["read"] };
  registry.define(definition);
  const registration = registry.register({ definition, providerId: "provider-a", providerVersion: "2.0.0", registrationId: "registration-1", scopeId: providerScope.id, priority: 10, capabilities: ["read"] }, { value: 42 }, providerScope);
  const identity = registrationIdentity(registration);
  registry.markAvailable(identity);
  registry.registerConsumer({ consumerId: "consumer-1", capabilityId: definition.capabilityId, scopeId: consumerScope.id }, consumerScope);
  const binding = registry.bind("consumer-1");
  assert.equal(registry.resolve<{ value: number }>(binding).value, 42);
  registry.quiesce(identity);
  assert.equal(registry.resolve<{ value: number }>(binding).value, 42);
  registry.registerConsumer({ consumerId: "consumer-2", capabilityId: definition.capabilityId, scopeId: "other" });
  assert.throws(() => registry.bind("consumer-2"), /No available provider/);
  await root.dispose();
  assert.equal(registry.registrationsSnapshot().length, 0);
  assert.equal(registry.bindingsSnapshot().length, 0);
  assert.deepEqual(events.slice(0, 4), ["registered", "available", "bound", "quiescing"]);
});

test("capability teardown failure is observable, retryable, and does not block provider cleanup", async () => {
  const registry = new CapabilityLifecycleRegistry();
  const root = new Scope("run");
  const providerScope = root.child("provider");
  const consumerScope = root.child("consumer");
  const events: string[] = [];
  let attempts = 0;
  registry.subscribe((event) => events.push(event.type));
  const definition = { capabilityId: "proofblade.teardown", version: "1.0.0", description: "teardown test", contractHash: "f".repeat(64), capabilities: ["read"] };
  registry.define(definition);
  const registration = registry.register({ definition, providerId: "provider", providerVersion: "1.0.0", registrationId: "registration", scopeId: providerScope.id, priority: 1, capabilities: ["read"] }, { value: true }, providerScope);
  const identity = registrationIdentity(registration);
  registry.markAvailable(identity);
  registry.registerConsumer({
    consumerId: "consumer",
    capabilityId: definition.capabilityId,
    scopeId: consumerScope.id,
    teardown: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("teardown failed");
    },
  }, consumerScope);
  const binding = registry.bind("consumer");

  await assert.rejects(registry.releaseConsumer("consumer"), /teardown failed/);
  assert.equal(registry.consumersSnapshot()[0]?.status, "ACTIVE");
  assert.ok(events.includes("consumer_teardown_failed"));
  assert.equal(registry.resolve<{ value: boolean }>(binding).value, true);
  assert.equal(registry.bindingsSnapshot().length, 1);
  assert.throws(() => registry.unregister(identity), /active consumers/);
  await registry.releaseConsumer("consumer");
  await registry.releaseConsumer("consumer");
  assert.equal(registry.consumersSnapshot()[0]?.status, "RELEASED");
  assert.equal(attempts, 2);

  let stagedAttempts = 0;
  registry.registerConsumer({
    consumerId: "staged-consumer",
    capabilityId: definition.capabilityId,
    scopeId: consumerScope.id,
    teardown: () => { stagedAttempts += 1; },
  }, consumerScope);
  registry.bind("staged-consumer");
  assert.equal((await registry.beginConsumerTeardown("staged-consumer")).status, "TEARING_DOWN");
  await registry.releaseConsumer("staged-consumer");
  assert.equal(stagedAttempts, 1);
  assert.equal(registry.consumersSnapshot().find((item) => item.consumerId === "staged-consumer")?.status, "RELEASED");

  const cleanupLog: string[] = [];
  const cleanupRoot = new Scope("cleanup");
  cleanupRoot.add("first", () => { cleanupLog.push("first"); });
  cleanupRoot.add("second", () => { cleanupLog.push("second"); throw new Error("second failed"); });
  await assert.rejects(cleanupRoot.dispose(), /disposal had 1 failure/);
  assert.deepEqual(cleanupLog, ["second", "first"]);
  await assert.rejects(cleanupRoot.dispose(), /disposal had 1 failure/);

  await root.dispose();
  assert.equal(registry.registrationsSnapshot().length, 0);
});

test("runtime config reconciliation is field-level, hash-only, and marks catalog/cache refreshes", () => {
  const previous = { provider: { url: "a", apiKey: "secret-a" }, mcp: [], skills: ["base"], workspace: { root: "one" }, routingPolicy: { mode: "single-agent" }, toolContract: { version: 1 } };
  const desired = { ...previous, provider: { url: "b", apiKey: "secret-b" }, toolContract: { version: 2 } };
  const result = reconcileRuntimeConfig(previous, desired, { provider: ["provider-scope"], toolContract: ["lane-scope"] });
  assert.deepEqual(result.changedFields, ["provider", "toolContract"]);
  assert.deepEqual(result.affectedScopes, ["lane-scope", "provider-scope"]);
  assert.equal(result.refreshCatalog, true);
  assert.equal(result.refreshCacheEpoch, true);
  assert.equal(JSON.stringify(result).includes("secret-"), false);
  const unchanged = reconcileRuntimeConfig(previous, previous);
  assert.deepEqual(unchanged.changedFields, []);
  assert.deepEqual(unchanged.affectedScopes, []);
  assert.equal(unchanged.refreshCatalog, false);
});

test("multi-agent contract remains disabled while single-agent is the only runnable strategy", () => {
  assert.deepEqual(selectAgentStrategy(), { status: "ready", strategy: DEFAULT_AGENT_STRATEGY, enabled: true });
  const unsupported = selectAgentStrategy("parallel-race");
  assert.equal(unsupported.status, "unsupported");
  if (unsupported.status === "unsupported") {
    assert.equal(unsupported.enabled, false);
    assert.equal(unsupported.failure.code, "MULTI_AGENT_DISABLED");
  }
  const handoff = {
    taskId: "task-1", workItemId: "work-1", goal: "inspect", constraints: ["read-only"], acceptedFacts: ["F-1"],
    artifactRefs: ["A-1"], evidenceRefs: ["EV-1"], remainingBudget: { tokens: 100, timeMs: 1_000, cost: 0.1 }, visitedAgents: ["single-agent"], expectedOutput: "structured result", generation: 2,
  };
  validateAgentHandoff(handoff, 2);
  assert.equal(winnerSettlementKey(handoff.workItemId, "agent-1", handoff.evidenceRefs).length, 64);
  assert.throws(() => validateAgentHandoff({ ...handoff, visitedAgents: ["a", "a"] }, 2), /cycle/);
  assert.throws(() => validateAgentHandoff(handoff, 3), /generation/);
});

test("reserved agent controls map to one Run WorkItem but remain disabled", async () => {
  const workItem = {
    id: "work-1", runId: "RUN-1", title: "reserved child", objective: "future execution", role: "executor", status: "READY",
    dependsOn: [], evidenceIds: [], artifactIds: [], attempt: 0, maxAttempts: 1, createdSeq: 1, updatedSeq: 1,
  } as const;
  const base = { runId: "RUN-1", generation: 2, workItemId: workItem.id, correlationId: "agent-control", sequence: 3, createdAt: "2026-08-29T00:00:00.000Z", payloadHash: "a".repeat(64) };
  for (const operation of ["spawn", "list", "send_message", "cancel", "wait"] as const) {
    const request = { ...base, operation };
    const projection = projectAgentControlOperation(request, workItem);
    assert.equal(projection.workItemId, workItem.id);
    assert.equal(projection.event.runId, workItem.runId);
    assert.equal(projection.event.source, "agent");
    assert.equal(projection.event.kind, `agent.${operation}`);
    assert.equal(projection.event.generation, 2);
    assert.equal(projection.event.payloadRef?.hash, base.payloadHash);
  }
  const port = new DisabledMultiAgentControlPort();
  const result = await port.spawn({ ...base, operation: "spawn" }, workItem);
  assert.equal(result.status, "unsupported");
  assert.equal(result.enabled, false);
  if (result.status === "unsupported") assert.equal(result.failure.code, "MULTI_AGENT_DISABLED");
  assert.throws(() => projectAgentControlOperation({ ...base, runId: "OTHER", operation: "wait" }, workItem), /does not match/);
});

test("lifecycle audit exposes stalled, recovery-required, and orphan resources", () => {
  const now = "2026-08-29T00:10:00.000Z";
  const events: HarnessEvent[] = [
    event(1, "provider_request_started", { requestId: "PR-stalled", epochId: "RE-stalled" }),
    event(2, "tool_call_recorded", { toolCallId: "TC-orphan" }),
    event(3, "provider_recovery_required", { requestId: "PR-recovery", reason: "retry budget exhausted" }),
    event(4, "provider_request_first_event", { requestId: "PR-orphan" }),
    event(5, "job_started", { jobId: "J-missing" }),
  ];
  const report = auditRunLifecycles(events, {
    jobs: {
      "J-active": {
        id: "J-active", capabilityId: "test", operation: "run", backendId: "b", backendVersion: "1", args: {}, replayPolicy: "idempotent", status: "RUNNING", lane: "executor", generation: 0, createdSeq: 1, startedAt: "2026-08-29T00:00:00.000Z",
      },
      "J-unknown": {
        id: "J-unknown", capabilityId: "test", operation: "run", backendId: "b", backendVersion: "1", args: {}, replayPolicy: "unknown", status: "UNKNOWN", lane: "executor", generation: 0, createdSeq: 2,
      },
    },
  }, { now, providerStallAfterMs: 100, toolStallAfterMs: 100, jobStallAfterMs: 100 });
  assert.equal(report.providers.find((item) => item.key === "PR-stalled")?.status, "STALLED");
  assert.equal(report.providers.find((item) => item.key === "PR-orphan")?.status, "ORPHAN");
  assert.equal(report.providers.find((item) => item.key === "PR-recovery")?.status, "RECOVERY_REQUIRED");
  assert.equal(report.tools.find((item) => item.key === "TC-orphan")?.stalled, true);
  assert.equal(report.jobs.find((item) => item.key === "J-active")?.stalled, true);
  assert.equal(report.jobs.find((item) => item.key === "J-unknown")?.recoveryRequired, true);
  assert.equal(scanOrphanLifecycles(report).length >= 2, true);
  assert.equal(scanRecoveryRequiredLifecycles(report).length >= 2, true);
  assert.equal(report.counts.stalled >= 2, true);
});

class FailingBackend implements TelemetryBackend {
  public fail = true;
  public async write(): Promise<void> {
    if (this.fail) throw new Error("offline sink");
  }
}

function attempt(taskId: string, number: number, outcome: "PASS" | "FAIL", verified: boolean) {
  return { id: `${taskId}-${number}`, protocolId: "eval.contract", taskId, attempt: number, outcome, verified, startedAt: "2026-08-29T00:00:00.000Z", durationMs: number * 100, costUsd: 0.01, evidenceIds: verified ? ["EV-1"] : [] } as const;
}

function event(seq: number, type: HarnessEvent["type"], payload: Record<string, unknown>) {
  return { schemaVersion: 1 as const, id: `E-${seq}`, streamId: "RUN-1", runId: "RUN-1", seq, ts: "2026-08-29T00:00:00.000Z", lane: "executor" as const, correlationId: "corr-1", actor: "orchestrator" as const, type, payload };
}
