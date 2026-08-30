import { captureProviderPrefixShape } from "@proofblade/molecules";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProofBladeConfig } from "../config.js";
import { createServices, demoTask } from "../app/demo.js";
import { createInitialSnapshot, projectionHash } from "../control/reducer.js";
import type { HarnessEvent } from "../domain/types.js";
import { LeaseManager } from "../control/lease-manager.js";
import { ContextCompiler } from "../context/compiler.js";
import { prepareContextMaintenance } from "../context/maintenance-coordinator.js";
import { AUTOMATIC_CONTEXT_RECOVERY_PROMPT, latestExternalUserMessage, userMessageText } from "../context/user-task-anchor.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import { auditRunLifecycles } from "../observability/lifecycle-audit.js";
import { RunEventIngress } from "../orchestration/event-ingress.js";
import { acknowledgeObservationItems, projectObservationQueue } from "../orchestration/observation-queue.js";
import { DEFAULT_AGENT_STRATEGY, selectAgentStrategy } from "../orchestration/multi-agent-contract.js";
import { EvidenceCurationGate } from "../knowledge/evidence-curation-gate.js";
import { CodingEvidenceGraph } from "../knowledge/evidence-graph.js";
import { RunTelemetry } from "../observability/run-telemetry.js";
import { RunCoordinator } from "../orchestration/run-coordinator.js";
import { ProofBladeToolRuntime } from "../tools/runtime.js";
import { createRequestEpoch, reconstructRequestEpoch } from "../runtime/request-epoch.js";
import { Scope } from "../runtime/scope.js";
import {
  NoProgressToolBreaker,
  RepeatedToolFailureBreaker,
  ToolFailureStormBreaker,
  type ToolFailureObservation,
} from "../runtime/tool-repeat-breaker.js";
import { SpillStore, type SpillArtifactWriter } from "../storage/spill-store.js";
import { JsonlControlStore } from "../storage/jsonl-store.js";

export const RUNTIME_SCENARIO_PROTOCOL_VERSION = "runtime-scenarios-v1";

export type RuntimeScenarioCategory = "cache" | "context" | "convergence" | "evidence" | "durability" | "events" | "recovery";

export interface RuntimeScenarioContext {
  root: string;
  config: ProofBladeConfig;
  runPrefix: string;
}

export interface RuntimeScenarioDefinition {
  id: string;
  category: RuntimeScenarioCategory;
  description: string;
  evaluate(context: RuntimeScenarioContext): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface RuntimeScenarioCase {
  id: string;
  category: RuntimeScenarioCategory;
  success: boolean;
  durationMs: number;
  detailsHash?: string;
  error?: string;
}

export interface RuntimeScenarioSummary {
  protocolVersion: typeof RUNTIME_SCENARIO_PROTOCOL_VERSION;
  catalogHash: string;
  requiredIds: string[];
  total: number;
  successCount: number;
  successRate: number;
  categoryCounts: Record<RuntimeScenarioCategory, { total: number; passed: number }>;
  cases: RuntimeScenarioCase[];
}

export const DEFAULT_RUNTIME_SCENARIOS: readonly RuntimeScenarioDefinition[] = [
  {
    id: "cache.context-prefix-stability",
    category: "cache",
    description: "Dynamic evidence changes must not rewrite the stable L0/L1 provider prefix.",
    evaluate: evaluateContextPrefixStability,
  },
  {
    id: "cache.usage-and-prefix-observability",
    category: "cache",
    description: "Cache token usage and provider prefix drift must remain independently observable.",
    evaluate: evaluateCacheObservability,
  },
  {
    id: "context.monotonic-tool-prefix",
    category: "context",
    description: "Adding a tool turn must not rewrite the already-snipped provider history prefix.",
    evaluate: evaluateMonotonicToolPrefix,
  },
  {
    id: "context.external-task-anchor",
    category: "context",
    description: "Automatic recovery prompts must not replace the latest external user task anchor.",
    evaluate: evaluateExternalTaskAnchor,
  },
  {
    id: "convergence.identical-failure-breaker",
    category: "convergence",
    description: "Three identical failing tool calls must terminate the current turn.",
    evaluate: evaluateRepeatedFailureBreaker,
  },
  {
    id: "convergence.read-no-progress-breaker",
    category: "convergence",
    description: "Repeated identical read-only observations must terminate without blocking mutations.",
    evaluate: evaluateNoProgressBreaker,
  },
  {
    id: "convergence.failure-storm-breaker",
    category: "convergence",
    description: "Varied tool failures must remain bounded and durable progress must reset the budget.",
    evaluate: evaluateFailureStormBreaker,
  },
  {
    id: "evidence.curation-backpressure",
    category: "evidence",
    description: "Unreviewed artifacts must trigger backpressure and curation must release it.",
    evaluate: evaluateEvidenceCurationBackpressure,
  },
  {
    id: "evidence.concurrent-deduplication",
    category: "evidence",
    description: "Concurrent equivalent findings must create one evidence-backed reasoning tree.",
    evaluate: evaluateConcurrentEvidenceDeduplication,
  },
  {
    id: "durability.pause-resume-replay",
    category: "durability",
    description: "Pause must survive phase changes and resume must preserve replay parity.",
    evaluate: evaluatePauseResumeReplay,
  },
  {
    id: "durability.verifier-authority",
    category: "durability",
    description: "Executor lanes must not accept their own completion proposals.",
    evaluate: evaluateVerifierAuthority,
  },
  {
    id: "durability.lease-owner-fencing",
    category: "durability",
    description: "A live resource lease must fence a competing lane and release cleanly.",
    evaluate: evaluateLeaseOwnerFencing,
  },
  {
    id: "events.ingress-ordering-and-fencing",
    category: "events",
    description: "Ingress must deduplicate, prioritize, coalesce and defer stale-generation events at a safe point.",
    evaluate: evaluateEventIngress,
  },
  {
    id: "events.job-monitor-observation-queue",
    category: "events",
    description: "A completed monitored Job must leave a visible, replayable observation that is acknowledged exactly once.",
    evaluate: evaluateJobMonitorObservationQueue,
  },
  {
    id: "recovery.request-epoch-reconstruction",
    category: "recovery",
    description: "A Provider request must be reconstructable from durable events without exposing secrets.",
    evaluate: evaluateRequestEpochRecovery,
  },
  {
    id: "recovery.lifecycle-audit",
    category: "recovery",
    description: "Lifecycle auditing must identify stalled, orphaned and recovery-required work after restart.",
    evaluate: evaluateLifecycleRecovery,
  },
  {
    id: "recovery.scope-disposal",
    category: "recovery",
    description: "Scope recovery must dispose children first, use LIFO order and remain idempotent.",
    evaluate: evaluateScopeRecovery,
  },
  {
    id: "recovery.spill-fallback",
    category: "recovery",
    description: "Spill failure must retain the canonical Tool result and expose a controlled durable failure state.",
    evaluate: evaluateSpillFallback,
  },
  {
    id: "recovery.single-agent-capability-gate",
    category: "recovery",
    description: "Unsupported multi-agent strategies must fail explicitly while single-agent execution remains enabled.",
    evaluate: evaluateSingleAgentCapabilityGate,
  },
] as const;

export class RuntimeScenarioEvaluator {
  public constructor(
    private readonly root: string,
    private readonly config: ProofBladeConfig,
    private readonly definitions: readonly RuntimeScenarioDefinition[] = DEFAULT_RUNTIME_SCENARIOS,
  ) {}

  public async run(runPrefix: string): Promise<RuntimeScenarioSummary> {
    validateDefinitions(this.definitions);
    const ordered = [...this.definitions].sort((left, right) => left.id.localeCompare(right.id));
    const cases: RuntimeScenarioCase[] = [];
    for (const definition of ordered) {
      const started = Date.now();
      try {
        const details = await definition.evaluate({ root: this.root, config: this.config, runPrefix });
        cases.push({
          id: definition.id,
          category: definition.category,
          success: true,
          durationMs: Date.now() - started,
          detailsHash: sha256(canonicalJson(details)),
        });
      } catch (caught) {
        cases.push({
          id: definition.id,
          category: definition.category,
          success: false,
          durationMs: Date.now() - started,
          error: caught instanceof Error ? caught.message : String(caught),
        });
      }
    }
    const successCount = cases.filter((item) => item.success).length;
    return {
      protocolVersion: RUNTIME_SCENARIO_PROTOCOL_VERSION,
      catalogHash: scenarioCatalogHash(ordered),
      requiredIds: ordered.map((item) => item.id),
      total: cases.length,
      successCount,
      successRate: rate(successCount, cases.length),
      categoryCounts: categoryCounts(cases),
      cases,
    };
  }
}

function evaluateContextPrefixStability(context: RuntimeScenarioContext): Record<string, unknown> {
  const runId = `${context.runPrefix}-scenario-context-prefix`;
  const task = demoTask(runId, context.root, context.config);
  const snapshot = createInitialSnapshot(runId, task);
  snapshot.status = "RUNNING";
  snapshot.phase = "reconnaissance";
  const compiler = new ContextCompiler();
  const first = compiler.build({ runId, lane: "executor", phase: snapshot.phase, task, snapshot });
  snapshot.evidence["EV-DYNAMIC"] = {
    id: "EV-DYNAMIC",
    kind: "observation",
    summary: "A dynamic observation entered the working context.",
    source: { tool: "scenario", generation: 0 },
    provenance: { schemaVersion: 1, runId, generation: 0, recordedBy: "agent", artifactIds: [] },
    confidence: 0.5,
    supports: [],
    refutes: [],
    createdSeq: 1,
  };
  snapshot.lastSeq = 1;
  const second = compiler.build({ runId, lane: "executor", phase: snapshot.phase, task, snapshot });
  requireCondition(first.manifest.cache.prefixHash === second.manifest.cache.prefixHash, "stable context prefix changed with dynamic evidence");
  requireCondition(first.manifest.cache.dynamicHash !== second.manifest.cache.dynamicHash, "dynamic context hash did not reflect new evidence");
  return { prefixStable: true, dynamicChanged: true, prefixLayers: second.manifest.cache.prefixLayerIds };
}

async function evaluateCacheObservability(context: RuntimeScenarioContext): Promise<Record<string, unknown>> {
  const services = createServices(context.root, context.config);
  const runId = `${context.runPrefix}-scenario-cache-observability`;
  await services.control.createRun(runId, demoTask(runId, context.root, context.config));
  const shapes = [
    captureProviderPrefixShape({ messages: [{ role: "system", content: "stable" }, { role: "user", content: "one" }], tools: [{ name: "read" }] }),
    captureProviderPrefixShape({ messages: [{ role: "system", content: "stable" }, { role: "user", content: "two" }], tools: [{ name: "read" }] }),
    captureProviderPrefixShape({ messages: [{ role: "system", content: "stable" }, { role: "user", content: "three" }], tools: [{ name: "read" }, { name: "bash" }] }),
  ];
  const cacheReads = [0, 80, 160];
  await services.control.append(runId, shapes.map((cachePrefix, index) => ({
    schemaVersion: 1 as const,
    lane: "executor" as const,
    correlationId: `cache-${index}`,
    actor: "model" as const,
    type: "model_usage" as const,
    payload: {
      provider: "scenario",
      model: "deterministic",
      cachePrefix,
      usage: { input: 100, output: 1, cacheRead: cacheReads[index], totalTokens: 101 + cacheReads[index]!, cost: { total: 0 } },
    },
  })));
  const report = await new RunTelemetry(services.control).report(runId);
  requireCondition(report.provider.tokens.cacheRead === 240, `cacheRead aggregation was ${report.provider.tokens.cacheRead}, expected 240`);
  requireCondition(report.provider.cacheHitRate === 0.444444, `cache hit rate was ${report.provider.cacheHitRate}, expected 0.444444`);
  requireCondition(report.provider.cachePrefix.stabilityRate === 0.5, `prefix stability was ${report.provider.cachePrefix.stabilityRate}, expected 0.5`);
  requireCondition(report.provider.cachePrefix.changeReasons.tools === 1, "tool schema drift was not classified");
  return { cacheRead: 240, cacheHitRate: 0.444444, prefixStabilityRate: 0.5, toolChanges: 1 };
}

function evaluateMonotonicToolPrefix(): Record<string, unknown> {
  const firstRaw = toolHistory(1);
  const first = prepareContextMaintenance({ messages: firstRaw, availableTokens: 6_000, messageBudget: 6_000 });
  const second = prepareContextMaintenance({ messages: toolHistory(2), availableTokens: 6_000, messageBudget: 6_000 });
  requireCondition(first.plan.shouldSnip, "first oversized tool output was not snipped");
  requireCondition(canonicalJson(second.messages.slice(0, first.messages.length)) === canonicalJson(first.messages), "a later tool turn rewrote the provider prefix");
  return { firstMessages: first.messages.length, secondMessages: second.messages.length, prefixMonotonic: true };
}

function evaluateExternalTaskAnchor(): Record<string, unknown> {
  const messages = [
    { role: "user", content: "Recover the firmware key and verify the result.", timestamp: 1 },
    { role: "assistant", content: "Working", api: "openai-completions", provider: "scenario", model: "deterministic", usage: zeroUsage(), stopReason: "stop", timestamp: 2 },
    { role: "user", content: AUTOMATIC_CONTEXT_RECOVERY_PROMPT, timestamp: 3 },
  ] as AgentMessage[];
  const anchor = latestExternalUserMessage(messages);
  requireCondition(userMessageText(anchor) === "Recover the firmware key and verify the result.", "automatic recovery prompt replaced the external task anchor");
  return { anchorPreserved: true, recoveryPromptIgnored: true };
}

function evaluateRepeatedFailureBreaker(): Record<string, unknown> {
  const breaker = new RepeatedToolFailureBreaker(3);
  const observation = failureObservation("read", { path: "missing.bin" }, "ENOENT");
  const decisions = [breaker.observe(observation), breaker.observe(observation), breaker.observe(observation)];
  requireCondition(!decisions[0]!.terminate && !decisions[1]!.terminate && decisions[2]!.terminate, "identical failure breaker did not terminate exactly at threshold");
  return { counts: decisions.map((item) => item.count), terminatedAt: 3 };
}

function evaluateNoProgressBreaker(): Record<string, unknown> {
  const breaker = new NoProgressToolBreaker(3, 6);
  const observation: ToolFailureObservation = {
    toolName: "read",
    input: { path: "firmware.bin", offset: 0, length: 32 },
    isError: false,
    content: [{ type: "text", text: "same bytes" }],
    effectPolicy: { readOnly: true, sideEffect: "none" },
  };
  const decisions = [breaker.observe(observation), breaker.observe(observation), breaker.observe(observation)];
  requireCondition(decisions[2]!.terminate, "read-only no-progress breaker did not terminate at threshold");
  const mutation = breaker.observe({
    toolName: "write",
    input: { path: "notes.txt" },
    isError: false,
    content: [{ type: "text", text: "written" }],
    effectPolicy: { readOnly: false, sideEffect: "workspace" },
  });
  requireCondition(!mutation.terminate && mutation.count === 0, "productive mutation did not reset no-progress state");
  return { terminatedAt: 3, mutationReset: true };
}

function evaluateFailureStormBreaker(): Record<string, unknown> {
  const breaker = new ToolFailureStormBreaker(4);
  const decisions = Array.from({ length: 4 }, (_, index) => breaker.observe(failureObservation("bash", { command: `bad-${index}` }, `failure-${index}`)));
  requireCondition(decisions[3]!.terminate, "varied failure storm was not bounded");
  const progress = breaker.observe({
    toolName: "evidence",
    input: { action: "record" },
    isError: false,
    content: [{ type: "text", text: "recorded" }],
    details: { durableProgress: true },
    effectPolicy: { readOnly: false, sideEffect: "workspace" },
  });
  requireCondition(progress.count === 0 && !progress.terminate, "durable progress did not reset failure storm budget");
  return { terminatedAt: 4, durableProgressReset: true };
}

async function evaluateEvidenceCurationBackpressure(context: RuntimeScenarioContext): Promise<Record<string, unknown>> {
  const services = createServices(context.root, context.config);
  const runId = `${context.runPrefix}-scenario-curation`;
  await services.control.createRun(runId, scenarioTask(runId, context));
  const graph = new CodingEvidenceGraph(runId, services.control, services.artifacts);
  const gate = new EvidenceCurationGate(runId, services.control);
  const artifactIds: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const artifact = await services.artifacts.putText(runId, `observation ${index}`, {
      filename: `observation-${index}.txt`,
      mime: "text/plain",
      sensitivity: "public",
      semantic: {
        name: `Observation ${index}`,
        summary: `Unreviewed investigation output ${index}.`,
        tags: ["read", "file-content"],
        role: "intermediate",
        relatedIds: [],
        annotatedBy: "harness",
      },
    });
    artifactIds.push(artifact.id);
  }
  const blocked = await gate.inspect();
  requireCondition(blocked.stage === "required" && blocked.pendingCount === 8, "curation did not stop an eight-artifact backlog");
  await graph.recordEvidence({
    name: "Reviewed finding",
    summary: "The first observation advances the active hypothesis.",
    artifactIds: [artifactIds[0]!],
    claim: "The reviewed observation is relevant.",
  });
  const released = await gate.inspect();
  requireCondition(released.stage === "checkpoint" && released.pendingCount === 7, "recording evidence did not release hard curation backpressure");
  await gate.assertInvestigationAllowed();
  return { blockedAt: 8, releasedAt: 7, releasedStage: released.stage };
}

async function evaluateConcurrentEvidenceDeduplication(context: RuntimeScenarioContext): Promise<Record<string, unknown>> {
  const services = createServices(context.root, context.config);
  const runId = `${context.runPrefix}-scenario-evidence-dedup`;
  await services.control.createRun(runId, scenarioTask(runId, context));
  const graph = new CodingEvidenceGraph(runId, services.control, services.artifacts);
  const artifact = await services.artifacts.putText(runId, "shared observation", { filename: "shared.txt", mime: "text/plain", sensitivity: "public" });
  const input = {
    name: "Shared finding",
    summary: "A shared observation supports the same claim.",
    artifactIds: [artifact.id],
    claim: "The observation has one durable interpretation.",
  };
  const results = await Promise.all([graph.recordEvidence(input), graph.recordEvidence(input)]);
  const snapshot = await services.control.snapshot(runId);
  requireCondition(results[0]!.evidenceId === results[1]!.evidenceId, "concurrent findings produced different evidence ids");
  requireCondition(Object.keys(snapshot.evidence).length === 1, "concurrent findings persisted duplicate evidence");
  requireCondition(Object.keys(snapshot.reasoningTrees).length === 1, "concurrent findings persisted duplicate reasoning trees");
  return { evidence: 1, facts: Object.keys(snapshot.facts).length, trees: 1, reused: results.filter((item) => item.reused).length };
}

async function evaluatePauseResumeReplay(context: RuntimeScenarioContext): Promise<Record<string, unknown>> {
  const services = createServices(context.root, context.config);
  const runId = `${context.runPrefix}-scenario-pause-replay`;
  const task = demoTask(runId, context.root, context.config);
  await services.control.createRun(runId, task);
  const coordinator = new RunCoordinator(services.control, services.verifier);
  await coordinator.setDomainPhase(runId, "RECON");
  await services.control.dispatch(runId, { type: "pause", reason: "scenario pause" });
  await coordinator.setDomainPhase(runId, "HYPOTHESIS");
  requireCondition((await services.control.snapshot(runId)).status === "PAUSED", "phase transition implicitly resumed a paused run");
  await services.control.dispatch(runId, { type: "resume" });
  const replayed = await services.control.replay(runId);
  const persisted = await new JsonlControlStore(services.runsRoot).loadProjection(runId);
  requireCondition(replayed.status === "RUNNING", "explicit resume did not restore RUNNING status");
  requireCondition(Boolean(persisted) && projectionHash(replayed) === projectionHash(persisted!), "pause/resume replay projection diverged");
  return { status: replayed.status, phase: replayed.phase, replayParity: true };
}

async function evaluateVerifierAuthority(context: RuntimeScenarioContext): Promise<Record<string, unknown>> {
  const services = createServices(context.root, context.config);
  const runId = `${context.runPrefix}-scenario-verifier-authority`;
  await services.control.createRun(runId, demoTask(runId, context.root, context.config));
  const candidate = await services.artifacts.putText(runId, "candidate", { filename: "candidate.txt", sensitivity: "flag_candidate" });
  await services.control.dispatch(runId, {
    type: "completion_proposed",
    completion: { id: "C-SCENARIO", purpose: "harness_verification", candidateHash: sha256("candidate"), artifactId: candidate.id },
    lane: "executor",
  });
  const rejected = await rejects(async () => await services.control.dispatch(runId, {
    type: "completion_verified",
    completionId: "C-SCENARIO",
    accepted: true,
    evidenceIds: [],
    lane: "executor",
  }), /trusted verifier service/);
  requireCondition(rejected, "executor accepted its own completion proposal");
  requireCondition((await services.control.snapshot(runId)).completions["C-SCENARIO"]?.status === "PROPOSED", "rejected verification mutated durable state");
  return { executorRejected: true, completionStatus: "PROPOSED" };
}

async function evaluateLeaseOwnerFencing(context: RuntimeScenarioContext): Promise<Record<string, unknown>> {
  const services = createServices(context.root, context.config);
  const runId = `${context.runPrefix}-scenario-lease-fencing`;
  await services.control.createRun(runId, demoTask(runId, context.root, context.config));
  const leases = new LeaseManager(services.control);
  const lease = await leases.acquire(runId, "workspace:scenario", "executor", 30_000);
  const rejected = await rejects(async () => await leases.acquire(runId, lease.resourceKey, "planner", 30_000), /leased by executor/);
  requireCondition(rejected, "competing lane acquired a live resource lease");
  await leases.release(runId, lease);
  requireCondition(Object.keys((await services.control.snapshot(runId)).leases).length === 0, "released lease remained in durable state");
  return { competingOwnerRejected: true, released: true };
}

async function evaluateEventIngress(context: RuntimeScenarioContext): Promise<Record<string, unknown>> {
  const services = createServices(context.root, context.config);
  const runId = `${context.runPrefix}-scenario-event-ingress`;
  await services.control.createRun(runId, demoTask(runId, context.root, context.config));
  const ingress = new RunEventIngress(services.control);
  const first = await ingress.enqueue(runId, {
    source: "job",
    kind: "job.output",
    correlationId: "job-1",
    coalescingKey: "job:output",
    payload: { cursor: 1 },
  });
  const duplicate = await ingress.enqueue(runId, {
    source: "job",
    kind: "job.output",
    correlationId: "job-1",
    coalescingKey: "job:output",
    payload: { cursor: 1 },
  });
  await ingress.enqueue(runId, {
    source: "user",
    kind: "user.cancel",
    priority: "urgent",
    correlationId: "user-1",
    payload: { reason: "scenario" },
  });
  await ingress.enqueue(runId, {
    source: "job",
    kind: "job.output",
    correlationId: "job-2",
    coalescingKey: "job:output",
    payload: { cursor: 2 },
  });
  await ingress.enqueue(runId, {
    source: "job",
    kind: "job.output",
    generation: 99,
    correlationId: "stale-job",
    payload: { cursor: 3 },
  });
  const drained = await ingress.drain(runId, "job_safe_point", 8);
  for (const action of drained.admitted) await ingress.complete(runId, action, "applied");
  const replayed = await ingress.drain(runId, "job_safe_point", 8);
  requireCondition(duplicate.id === first.id, "duplicate ingress event was not idempotent");
  requireCondition(drained.admitted.map((item) => item.kind).join(",") === "user.cancel,job.output", "ingress priority or coalescing order changed");
  requireCondition(drained.coalesced.length === 1 && drained.failed.length === 1 && drained.deferred.length === 0, "ingress did not fence stale events and coalesce current events");
  requireCondition(replayed.admitted.length === 0, "processed ingress event was replayed twice");
  return { admitted: drained.admitted.length, duplicateStable: true, coalesced: drained.coalesced.length, staleFailed: drained.failed.length, deferred: drained.deferred.length };
}

async function evaluateJobMonitorObservationQueue(context: RuntimeScenarioContext): Promise<Record<string, unknown>> {
  const services = createServices(context.root, context.config);
  const runId = `${context.runPrefix}-scenario-job-observations`;
  const task = demoTask(runId, context.root, context.config);
  await services.control.createRun(runId, task);
  const fixture = await services.sandbox.build(task);
  const generation = await services.sandbox.reset(fixture);
  await services.fixtureControl.reset(runId, generation);
  const runtime = new ProofBladeToolRuntime(runId, fixture, services.runsRoot, services.control, services.artifacts, services.journal);
  try {
    const started = await runtime.runBackground({
      capabilityId: "proofblade.target",
      operation: "delay",
      input: { milliseconds: 50 },
      timeoutMs: 2_000,
    });
    const monitored = await runtime.monitorJob(String(started.jobId), {
      triggers: ["keyword", "exit"],
      keywords: ["milliseconds"],
      waitMs: 2_000,
    });
    requireCondition(monitored.trigger === "keyword", "completed Job keyword trigger was not observed");
    requireCondition(monitored.status === "SUCCEEDED", "monitored Job did not complete successfully");

    const events = await services.control.events(runId);
    const snapshot = await services.control.snapshot(runId);
    const queue = projectObservationQueue(events, snapshot);
    const item = queue.items.find((candidate) => candidate.relatedIds.includes(String(started.jobId)));
    requireCondition(Boolean(item), "completed Job did not produce a visible observation");
    requireCondition(item!.artifactIds.length === 1, "Job observation lost its output Artifact reference");

    // Reopen the durable store before acknowledgement to prove the queue is
    // reconstructed from JSONL events rather than the original runtime object.
    const replayed = await services.control.replay(runId);
    const rebuilt = projectObservationQueue(await services.control.events(runId), replayed);
    requireCondition(rebuilt.ids.includes(item!.id), "restarted queue did not retain the pending Job observation");
    await acknowledgeObservationItems(services.control, runId, [item!]);
    const acknowledged = projectObservationQueue(await services.control.events(runId), await services.control.snapshot(runId));
    requireCondition(!acknowledged.ids.includes(item!.id), "acknowledged Job observation remained pending");
    await acknowledgeObservationItems(services.control, runId, [item!]);
    requireCondition((await services.control.events(runId)).filter((event) => event.type === "observation_consumed").length === 1, "observation acknowledgement was not idempotent");
    return { trigger: monitored.trigger, jobFinished: true, replayRebuilt: true, acknowledgedOnce: true, artifactLinked: true };
  } finally {
    await runtime.close();
  }
}

async function evaluateRequestEpochRecovery(context: RuntimeScenarioContext): Promise<Record<string, unknown>> {
  const services = createServices(context.root, context.config);
  const runId = `${context.runPrefix}-scenario-request-epoch`;
  await services.control.createRun(runId, demoTask(runId, context.root, context.config));
  const epoch = createRequestEpoch({
    runId,
    lane: "executor",
    provider: "scenario-provider",
    model: "deterministic",
    adapter: "openai-completions",
    requestId: "scenario-request-1",
    contextWindow: 4_096,
    systemPrompt: "stable system prompt",
    toolNames: ["read", "read"],
    toolCatalog: { tools: ["read"] },
    contextManifest: { phase: "reconnaissance" },
    requestHeaders: { Authorization: "Bearer scenario-secret", "X-Trace": "opaque" },
    requestBody: { messages: [{ role: "user", content: "private request" }], token: "scenario-secret" },
    stablePrefixHash: sha256("stable-prefix"),
    dynamicSuffixHash: sha256("dynamic-suffix"),
  });
  await services.control.dispatch(runId, { type: "request_epoch_started", epoch, lane: "executor" });
  const contextHash = sha256("reconstructed-context");
  await services.control.append(runId, [
    { schemaVersion: 1, lane: "executor", correlationId: epoch.requestId, actor: "model", type: "request_epoch_context", payload: { requestEpochId: epoch.id, fields: { requestContextHash: contextHash } } },
    { schemaVersion: 1, lane: "executor", correlationId: epoch.requestId, actor: "model", type: "provider_response_received", payload: { epochId: epoch.id, status: 200 } },
    { schemaVersion: 1, lane: "executor", correlationId: epoch.requestId, actor: "model", type: "model_usage", payload: { epochId: epoch.id, usage: { input: 1, output: 1 } } },
  ]);
  const events = await services.control.events(runId);
  const reconstructed = reconstructRequestEpoch(events, epoch.id);
  requireCondition(reconstructed?.status === "COMPLETED", "request epoch did not reach a reconstructable terminal status");
  requireCondition(reconstructed.requestContextHash === contextHash, "request context hash was not rebuilt from durable events");
  requireCondition(reconstructed.toolNames.join(",") === "read", "request Tool catalog was not normalized");
  requireCondition(!JSON.stringify(events).includes("scenario-secret") && !JSON.stringify(events).includes("private request"), "request secrets leaked into durable events");
  return { status: reconstructed.status, contextRebuilt: true, secretsRedacted: true, toolNames: reconstructed.toolNames };
}

function evaluateLifecycleRecovery(): Record<string, unknown> {
  const events: HarnessEvent[] = [
    scenarioEvent(1, "provider_request_started", { requestId: "provider-stalled", epochId: "RE-stalled" }),
    scenarioEvent(2, "provider_recovery_required", { requestId: "provider-recovery", reason: "scenario retry budget" }),
    scenarioEvent(3, "provider_request_first_event", { requestId: "provider-orphan" }),
    scenarioEvent(4, "tool_call_recorded", { toolCallId: "tool-stalled" }),
    scenarioEvent(5, "job_started", { jobId: "job-orphan" }),
  ];
  const report = auditRunLifecycles(events, { jobs: {} }, { now: "2026-08-29T00:10:00.000Z", providerStallAfterMs: 100, toolStallAfterMs: 100, jobStallAfterMs: 100 });
  requireCondition(report.providers.find((item) => item.key === "provider-stalled")?.stalled === true, "stalled Provider was not detected");
  requireCondition(report.providers.find((item) => item.key === "provider-recovery")?.recoveryRequired === true, "Provider recovery requirement was not detected");
  requireCondition(report.providers.find((item) => item.key === "provider-orphan")?.orphan === true, "orphan Provider lifecycle was not detected");
  requireCondition(report.jobs.find((item) => item.key === "job-orphan")?.orphan === true, "orphan Job lifecycle was not detected");
  return { stalled: report.counts.stalled, recoveryRequired: report.counts.recoveryRequired, orphan: report.counts.orphan };
}

async function evaluateScopeRecovery(): Promise<Record<string, unknown>> {
  const order: string[] = [];
  const root = new Scope("scenario-run");
  const child = root.child("scenario-lane");
  root.add("parent-resource", () => { order.push("parent"); });
  child.add("child-first", () => { order.push("child-1"); });
  child.add("child-last", () => { order.push("child-2"); });
  await Promise.all([root.dispose(), root.dispose()]);
  requireCondition(order.join(",") === "child-2,child-1,parent", "Scope disposal order changed");
  await root.dispose();
  requireCondition(order.length === 3, "Scope disposal was not idempotent");
  return { order, idempotent: true };
}

async function evaluateSpillFallback(context: RuntimeScenarioContext): Promise<Record<string, unknown>> {
  const writer: SpillArtifactWriter = {
    async putText() { throw new Error("scenario spill backend unavailable"); },
    async readText() { return ""; },
  };
  const result = await new SpillStore(writer).persist(`${context.runPrefix}-spill`, {
    operation: "read",
    value: { output: "x".repeat(512) },
    spillThresholdChars: 64,
    presentationMaxChars: 80,
  });
  requireCondition(result.canonical.state === "success", "spill fallback changed the canonical Tool result state");
  requireCondition(result.durable.state === "spill_failed", "spill backend failure was hidden as success");
  requireCondition(result.durable.resultHash === result.canonical.resultHash && result.presentation.resultHash === result.canonical.resultHash, "Tool result triple lost its canonical hash binding");
  return { canonicalRetained: true, durableState: result.durable.state, presentationTruncated: result.presentation.truncated };
}

function evaluateSingleAgentCapabilityGate(): Record<string, unknown> {
  const single = selectAgentStrategy();
  const unsupported = selectAgentStrategy("parallel-race");
  requireCondition(single.status === "ready" && single.strategy === DEFAULT_AGENT_STRATEGY && single.enabled, "single-agent strategy is not enabled");
  requireCondition(unsupported.status === "unsupported" && !unsupported.enabled && unsupported.failure.code === "MULTI_AGENT_DISABLED", "unsupported multi-agent strategy was not explicit");
  return { singleAgent: single.strategy, multiAgentEnabled: unsupported.enabled, failureCode: unsupported.failure.code };
}

function toolHistory(turns: number): AgentMessage[] {
  return Array.from({ length: turns }, (_, index) => [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: `call-${index + 1}`, name: "bash", arguments: { command: `step-${index + 1}` } }],
      api: "openai-completions",
      provider: "scenario",
      model: "deterministic",
      usage: zeroUsage(),
      stopReason: "toolUse",
      timestamp: index * 2 + 1,
    },
    {
      role: "toolResult",
      toolCallId: `call-${index + 1}`,
      toolName: "bash",
      content: [{ type: "text", text: `output-${index + 1} ` + String.fromCharCode(97 + index).repeat(16_000) }],
      isError: false,
      timestamp: index * 2 + 2,
    },
  ]).flat() as AgentMessage[];
}

function failureObservation(toolName: string, input: Record<string, unknown>, error: string): ToolFailureObservation {
  return { toolName, input, isError: true, content: [{ type: "text", text: error }] };
}

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function scenarioTask(runId: string, context: RuntimeScenarioContext) {
  return {
    ...demoTask(runId, context.root, context.config),
    mode: "coding_assistant" as const,
    target_kind: "unknown" as const,
    objective: "Evaluate deterministic runtime invariants.",
    verification: { kind: "reproduction" as const, required_reproductions: 0 },
  };
}

function scenarioEvent(seq: number, type: HarnessEvent["type"], payload: Record<string, unknown>): HarnessEvent {
  return {
    schemaVersion: 1,
    id: `SCENARIO-E-${seq}`,
    streamId: "SCENARIO-RUN",
    runId: "SCENARIO-RUN",
    seq,
    ts: "2026-08-29T00:00:00.000Z",
    lane: "executor",
    correlationId: "scenario-correlation",
    actor: "orchestrator",
    type,
    payload,
  };
}

async function rejects(operation: () => Promise<unknown>, expected: RegExp): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch (caught) {
    return expected.test(caught instanceof Error ? caught.message : String(caught));
  }
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function validateDefinitions(definitions: readonly RuntimeScenarioDefinition[]): void {
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (!definition.id.trim()) throw new Error("Runtime scenario id must not be empty");
    if (ids.has(definition.id)) throw new Error(`Duplicate runtime scenario id: ${definition.id}`);
    ids.add(definition.id);
  }
}

function scenarioCatalogHash(definitions: readonly RuntimeScenarioDefinition[]): string {
  return sha256(canonicalJson(definitions.map(({ id, category, description }) => ({ id, category, description }))));
}

function categoryCounts(cases: RuntimeScenarioCase[]): RuntimeScenarioSummary["categoryCounts"] {
  const categories: RuntimeScenarioCategory[] = ["cache", "context", "convergence", "evidence", "durability", "events", "recovery"];
  return Object.fromEntries(categories.map((category) => {
    const selected = cases.filter((item) => item.category === category);
    return [category, { total: selected.length, passed: selected.filter((item) => item.success).length }];
  })) as RuntimeScenarioSummary["categoryCounts"];
}

function rate(value: number, total: number): number {
  return total === 0 ? 0 : Number((value / total).toFixed(4));
}
