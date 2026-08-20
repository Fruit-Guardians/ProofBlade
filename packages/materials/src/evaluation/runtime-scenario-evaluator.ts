import { captureProviderPrefixShape } from "@proofblade/molecules";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProofBladeConfig } from "../config.js";
import { createServices, demoTask } from "../app/demo.js";
import { createInitialSnapshot, projectionHash } from "../control/reducer.js";
import { LeaseManager } from "../control/lease-manager.js";
import { ContextCompiler } from "../context/compiler.js";
import { prepareContextMaintenance } from "../context/maintenance-coordinator.js";
import { AUTOMATIC_CONTEXT_RECOVERY_PROMPT, latestExternalUserMessage, userMessageText } from "../context/user-task-anchor.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import { EvidenceCurationGate } from "../knowledge/evidence-curation-gate.js";
import { CodingEvidenceGraph } from "../knowledge/evidence-graph.js";
import { RunTelemetry } from "../observability/run-telemetry.js";
import {
  NoProgressToolBreaker,
  RepeatedToolFailureBreaker,
  ToolFailureStormBreaker,
  type ToolFailureObservation,
} from "../runtime/tool-repeat-breaker.js";
import { JsonlControlStore } from "../storage/jsonl-store.js";

export const RUNTIME_SCENARIO_PROTOCOL_VERSION = "runtime-scenarios-v1";

export type RuntimeScenarioCategory = "cache" | "context" | "convergence" | "evidence" | "durability";

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
  await services.control.createRun(runId, demoTask(runId, context.root, context.config));
  await services.control.dispatch(runId, { type: "start_phase", phase: "reconnaissance" });
  await services.control.dispatch(runId, { type: "pause", reason: "scenario pause" });
  await services.control.dispatch(runId, { type: "start_phase", phase: "hypothesis" });
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
  const categories: RuntimeScenarioCategory[] = ["cache", "context", "convergence", "evidence", "durability"];
  return Object.fromEntries(categories.map((category) => {
    const selected = cases.filter((item) => item.category === category);
    return [category, { total: selected.length, passed: selected.filter((item) => item.success).length }];
  })) as RuntimeScenarioSummary["categoryCounts"];
}

function rate(value: number, total: number): number {
  return total === 0 ? 0 : Number((value / total).toFixed(4));
}
