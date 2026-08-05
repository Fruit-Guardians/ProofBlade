import { join } from "node:path";
import { AgentHarness, JsonlSessionRepo, NodeExecutionEnv, type AgentHarnessEvent } from "@earendil-works/pi-agent-core/node";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ProofBladeConfig } from "../config.js";
import type { ControlStore } from "../control/control-store.js";
import { ContextCompiler } from "../context/compiler.js";
import { prepareContextMaintenance } from "../context/maintenance-coordinator.js";
import { CheckpointService } from "../context/checkpoint.js";
import { DurableCompactionCoordinator, type CompactionFaultInjector } from "../context/durable-compaction.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { ProofBladeToolRuntime } from "../tools/runtime.js";
import { createSolverTools, type SolverToolContext } from "./solver-tools.js";
import { createConfiguredModels, resolveModelProfile } from "./lmstudio-provider.js";
import type { AgentLanePort, AgentOutcome } from "./pi-adapter.js";
import { planContextMaintenance } from "@proofblade/molecules";
import { ProofBladeSkillRegistry } from "../skills/registry.js";
import type { RuntimeResourceSnapshot } from "../domain/types.js";
import { SOLVER_PROTOCOL_INSTRUCTIONS } from "./version.js";
import { attachPiObservability } from "../observability/pi-events.js";

export class PiSolverLane implements AgentLanePort {
  private busy = false;
  private compactRequested = false;

  private constructor(
    private readonly runId: string,
    private readonly controlStore: ControlStore,
    private readonly harness: AgentHarness<SolverToolContext>,
    private readonly checkpointService: CheckpointService,
    private readonly profile: Awaited<ReturnType<typeof resolveModelProfile>>,
    private readonly skills: ProofBladeSkillRegistry,
    private readonly resourceSnapshot: RuntimeResourceSnapshot,
    private readonly closeTransport: () => Promise<void>,
  ) {}

  public static async create(options: {
    runId: string;
    projectRoot: string;
    runDir: string;
    controlStore: ControlStore;
    artifactStore: ArtifactStore;
    config: ProofBladeConfig;
    runtime: ProofBladeToolRuntime;
    compactionFault?: CompactionFaultInjector;
    onEvent?: (event: AgentHarnessEvent) => void | Promise<void>;
  }): Promise<PiSolverLane> {
    const env = new NodeExecutionEnv({ cwd: options.runDir });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(options.runDir, "pi-sessions") });
    const sessionId = `${options.runId}-solver`;
    const known = await repo.list({ cwd: options.runDir });
    const metadata = known.find((item) => item.id === sessionId);
    const session = metadata
      ? await repo.open(metadata)
      : await repo.create({ id: sessionId, cwd: options.runDir, metadata: { runId: options.runId, lane: "executor", purpose: "solve" } });
    const profile = await resolveModelProfile(options.config.modelProfiles.executor);
    const skills = await ProofBladeSkillRegistry.load(options.projectRoot);
    const resourceSnapshot = options.runtime.resourceSnapshot(skills.contextSnapshot());
    const { models, model, closeTransport } = createConfiguredModels(profile);
    const tools = createSolverTools();
    const checkpointService = new CheckpointService(options.controlStore, options.artifactStore);
    const compactionCoordinator = new DurableCompactionCoordinator(checkpointService, options.compactionFault);
    const laneRef: { lane?: PiSolverLane } = {};
    const harness = new AgentHarness<SolverToolContext>({
      session,
      models,
      model,
      tools,
      activeToolNames: tools.map((tool) => tool.name),
      toolContext: { runtime: options.runtime, skills },
      resources: { skills: skills.piSkills() },
      thinkingLevel: profile.thinkingLevel ?? "off",
      systemPrompt: async () => {
        const snapshot = await options.controlStore.snapshot(options.runId);
        const compiled = new ContextCompiler().build({
          runId: options.runId,
          lane: "executor",
          phase: snapshot.phase,
          task: snapshot.task,
          snapshot,
          contextWindow: profile.contextWindow,
          resources: resourceSnapshot,
        });
        return [
          compiled.messages[0]?.content ?? "",
          "[tool-protocol]",
          ...SOLVER_PROTOCOL_INSTRUCTIONS,
        ].join("\n\n");
      },
      streamOptions: { timeoutMs: profile.requestTimeoutMs, maxRetries: profile.maxRetries },
    });
    harness.on("context", async ({ messages }) => {
      const snapshot = await options.controlStore.snapshot(options.runId);
      const compiled = new ContextCompiler().build({ runId: options.runId, lane: "executor", phase: snapshot.phase, task: snapshot.task, snapshot, contextWindow: profile.contextWindow, outputBudget: profile.maxTokens, resources: resourceSnapshot });
      const transcriptBudget = Math.max(256, compiled.manifest.budget.availableInput - compiled.estimatedTokens);
      const prepared = prepareContextMaintenance({ messages, availableTokens: compiled.manifest.budget.availableInput, baseTokens: compiled.estimatedTokens, messageBudget: transcriptBudget });
      if (prepared.checkpointRecommended) await checkpointService.create(options.runId, "context-prune", compiled.manifest);
      if (prepared.nextAction === "compact") laneRef.lane?.requestCompactionAfterTurn();
      const dynamicContext = compiled.messages.filter((message) => message.role !== "system");
      return { messages: [...dynamicContext, ...prepared.messages] as AgentMessage[] };
    });
    harness.on("session_before_compact", async ({ preparation }) => {
      const snapshot = await options.controlStore.snapshot(options.runId);
      const compiled = new ContextCompiler().build({ runId: options.runId, lane: "executor", phase: snapshot.phase, task: snapshot.task, snapshot, contextWindow: profile.contextWindow, outputBudget: profile.maxTokens, resources: resourceSnapshot });
      return { compaction: await compactionCoordinator.provide(options.runId, preparation, compiled.manifest) };
    });
    attachPiObservability(harness, {
      runId: options.runId,
      lane: "executor",
      controlStore: options.controlStore,
      estimateContextTokens: async () => {
        const current = await options.controlStore.snapshot(options.runId);
        return new ContextCompiler().build({ runId: options.runId, lane: "executor", phase: current.phase, task: current.task, snapshot: current, contextWindow: profile.contextWindow, outputBudget: profile.maxTokens, resources: resourceSnapshot }).estimatedTokens;
      },
      getContextSnapshot: async () => {
        const current = await options.controlStore.snapshot(options.runId);
        const compiled = new ContextCompiler().build({ runId: options.runId, lane: "executor", phase: current.phase, task: current.task, snapshot: current, contextWindow: profile.contextWindow, outputBudget: profile.maxTokens, resources: resourceSnapshot });
        return { estimatedTokens: compiled.estimatedTokens, manifestHash: compiled.manifest.hash, cache: compiled.manifest.cache };
      },
    });
    if (options.onEvent) harness.subscribe(options.onEvent);
    const lane = new PiSolverLane(options.runId, options.controlStore, harness, checkpointService, profile, skills, resourceSnapshot, closeTransport);
    laneRef.lane = lane;
    return lane;
  }

  public async prompt(text: string): Promise<AgentOutcome> {
    this.busy = true;
    const correlationId = `${this.runId}:executor:solve-turn`;
    await this.controlStore.append(this.runId, [{ schemaVersion: 1, lane: "executor", correlationId, actor: "orchestrator", type: "turn_started", payload: { promptLength: text.length } }]);
    try {
      const response = await this.harness.prompt(text);
      await this.maintainAfterTurn(response);
      const output = response.content
        .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      await this.controlStore.append(this.runId, [
        { schemaVersion: 1, lane: "executor", correlationId, actor: "model", type: "assistant_message", payload: { text: output, stopReason: response.stopReason } },
      ]);
      return { text: output, stopReason: response.stopReason, usage: response.usage as AssistantMessage["usage"], errorMessage: response.errorMessage };
    } finally {
      this.busy = false;
    }
  }

  public async skill(name: string, additionalInstructions?: string): Promise<AgentOutcome> {
    this.busy = true;
    const correlationId = `${this.runId}:executor:skill:${name}`;
    await this.controlStore.append(this.runId, [{ schemaVersion: 1, lane: "executor", correlationId, actor: "orchestrator", type: "turn_started", payload: { skill: name, skillCatalogHash: this.skills.catalogHash() } }]);
    try {
      const response = await this.harness.skill(name, additionalInstructions);
      await this.maintainAfterTurn(response);
      const output = response.content.filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text").map((item) => item.text).join("\n");
      await this.controlStore.append(this.runId, [
        { schemaVersion: 1, lane: "executor", correlationId, actor: "model", type: "assistant_message", payload: { text: output, stopReason: response.stopReason, skill: name } },
      ]);
      return { text: output, stopReason: response.stopReason, usage: response.usage as AssistantMessage["usage"], errorMessage: response.errorMessage };
    } finally {
      this.busy = false;
    }
  }

  public async abort(_reason: string): Promise<void> {
    await this.harness.abort();
  }

  public async compact(reason: string): Promise<void> {
    await this.harness.compact(reason);
  }

  public async isIdle(): Promise<boolean> {
    return !this.busy;
  }

  public async close(): Promise<void> {
    try {
      await this.harness.waitForIdle();
    } finally {
      await this.closeTransport();
    }
  }

  private requestCompactionAfterTurn(): void {
    this.compactRequested = true;
  }

  private async maintainAfterTurn(response: AssistantMessage): Promise<void> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const compiled = new ContextCompiler().build({
      runId: this.runId,
      lane: "executor",
      phase: snapshot.phase,
      task: snapshot.task,
      snapshot,
      contextWindow: this.profile.contextWindow,
      outputBudget: this.profile.maxTokens,
      resources: this.resourceSnapshot,
    });
    const observedInput = typeof response.usage?.input === "number" ? response.usage.input : 0;
    const plan = planContextMaintenance(Math.max(observedInput, compiled.estimatedTokens), compiled.manifest.budget.availableInput);
    if (!this.compactRequested && !plan.shouldCompact) return;
    const force = this.compactRequested || plan.forceCompact;
    this.compactRequested = false;
    await this.checkpointService.create(this.runId, force ? "context-force-maintenance" : "context-idle-maintenance", compiled.manifest);
    if (response.stopReason === "error" || response.stopReason === "aborted") return;
    try {
      await this.harness.compact(force ? "Preserve all confirmed facts, rejected hypotheses, artifacts, in-flight effects, leases, and the next action." : "Compact stale history while preserving the CTF checkpoint and latest complete tool exchange.");
    } catch {
      // The durable checkpoint remains the recovery source if Pi compaction fails.
    }
  }
}
