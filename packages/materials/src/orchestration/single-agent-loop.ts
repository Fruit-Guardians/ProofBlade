import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ProofBladeConfig } from "../config.js";
import type { AgentLanePort, AgentOutcome } from "../runtime/pi-adapter.js";
import { PiCodingLane } from "../runtime/coding-lane.js";
import type { AblationPolicyBinding } from "../runtime/coding-turn-projection.js";
import type { AppServices } from "../app/demo.js";
import type { ExecutionMode, PrimaryFailureCategory, RunSnapshot, TaskContract } from "../domain/types.js";
import { id, isTerminal, remainingRunDeadlineMs } from "../domain/utils.js";
import { ProofBladeToolRuntime } from "../tools/runtime.js";
import { IndependentVerifier, type VerificationOutcome } from "../verification/verifier.js";
import { CodingClaimVerifier } from "../verification/claim-verification.js";
import { CheckpointService } from "../context/checkpoint.js";
import { PlannerCoordinator } from "./planner.js";
import { RefinerCoordinator } from "./refiner.js";
import { RunRecoveryService } from "../recovery/run-recovery.js";
import { SessionRegistry } from "../container/session-registry.js";
import { LeaseManager } from "../control/lease-manager.js";
import type { Intent as SchedulerIntent } from "../domain/intent.js";
import { IntentScheduler } from "./intent-scheduler.js";
import { buildSchedulingContext } from "./scheduling-context.js";
import { RunCoordinator } from "./run-coordinator.js";
import { probeBrowserVerifierFactory, type BrowserVerifierFactory } from "../web/browser-session.js";
import { withBrowserResourceAdapter, type BrowserRuntimeHandoff } from "../web/browser-resource-adapter.js";
import type { ExternalResourceRegistry } from "../recovery/external-resource-registry.js";
import { withSessionResourceAdapters, type SessionRuntimeHandoff } from "../recovery/session-resource-adapter.js";

export interface AgentLaneCreateInput {
  projectRoot: string;
  runId: string;
  runDir: string;
  /** The recovered fixture workspace shared by the loop and its lane. */
  fixture: Awaited<ReturnType<AppServices["sandbox"]["build"]>>;
  runtime: ProofBladeToolRuntime;
  /** Deliberately excludes verifier and fixture lifecycle capabilities. */
  services: Pick<AppServices, "control" | "artifacts" | "journal" | "sessionRuntimeBrokers" | "sessionRuntimeRequired" | "browserRuntimeRequired">;
  /** Safe claim service; the lane never receives verifier control directly. */
  claimVerifier: CodingClaimVerifier;
  config: ProofBladeConfig;
  /** Optional application-owned browser verifier; never exposed to the model. */
  browserVerifierFactory?: BrowserVerifierFactory;
  externalResources?: ExternalResourceRegistry;
  /** Runtime bindings confirmed during recovery and safe to adopt in the lane. */
  sessionHandoffs?: readonly SessionRuntimeHandoff[];
  /** Browser bindings confirmed during recovery and safe for verifier replay. */
  browserHandoffs?: readonly BrowserRuntimeHandoff[];
  ablationPolicy?: AblationPolicyBinding;
  onEvent?: Parameters<typeof PiCodingLane.create>[0]["onEvent"];
}

export type AgentLaneFactory = (input: AgentLaneCreateInput) => Promise<AgentLanePort>;

export interface SingleAgentRunOptions {
  runId: string;
  task: TaskContract;
  /**
   * Execution mode. A function is re-read every turn (tier-2 live control): a
   * mid-run flip to "assist" pauses before the next submission; a flip back to
   * "auto" resumes autonomous verification. A bare value behaves as before.
   */
  mode?: ExecutionMode | (() => ExecutionMode);
  maxTurns?: number;
  onLaneReady?: (lane: AgentLanePort) => void | Promise<void>;
  signal?: AbortSignal;
  /**
   * Convert a caller-owned deadline abort into a durable terminal Run. Normal
   * user cancellation intentionally remains resumable and does not use this.
   */
  terminalizeAbort?: { reason: string; category: PrimaryFailureCategory };
  /** Optional user instruction appended to the durable task prompt for one interactive turn. */
  userPrompt?: string;
  onTurn?: (outcome: AgentOutcome) => void | Promise<void>;
  onEvent?: Parameters<typeof PiCodingLane.create>[0]["onEvent"];
  /** Optional strategy binding for a same-model ablation run. */
  ablationPolicy?: AblationPolicyBinding;
}

export interface SingleAgentRunOutcome {
  runId: string;
  mode: ExecutionMode;
  status: RunSnapshot["status"];
  phase: RunSnapshot["phase"];
  turns: number;
  completionId?: string;
  evidenceIds: string[];
}

export class SingleAgentLoop {
  public constructor(
    private readonly root: string,
    private readonly config: ProofBladeConfig,
    private readonly services: AppServices,
    private readonly createLane: AgentLaneFactory = defaultLaneFactory,
    private readonly browserVerifierFactory?: BrowserVerifierFactory,
  ) {}

  public async run(options: SingleAgentRunOptions): Promise<SingleAgentRunOutcome> {
    const modeSource = options.mode ?? "assist";
    const mode = (): ExecutionMode => (typeof modeSource === "function" ? modeSource() : modeSource);
    const maxTurns = options.maxTurns ?? 3;
    throwIfAborted(options.signal);
    const runDir = join(this.services.runsRoot, options.runId);
    let snapshot: RunSnapshot;
    if (await exists(join(runDir, "task.json"))) snapshot = await this.services.control.snapshot(options.runId);
    else snapshot = await this.services.control.createRun(options.runId, options.task);
    if (isTerminal(snapshot.status)) return outcome(snapshot, mode, 0);
    if (snapshot.status === "PAUSED") {
      await this.services.control.dispatch(options.runId, { type: "resume" });
      snapshot = await this.services.control.snapshot(options.runId);
    }
    // A fresh registry for recovery: any session still durably OPEN belongs to a
    // dead prior process (its docker-exec child died with it), so it is an orphan
    // to supersede rather than revive.
    const browserVerifierFactory = await probeBrowserVerifierFactory(this.browserVerifierFactory, options.signal);
    const recoveryAdapters = withSessionResourceAdapters(
      withBrowserResourceAdapter(this.services.externalResourceAdapters, browserVerifierFactory),
      this.services.sessionRuntimeBrokers ?? [],
    );
    const recovery = await new RunRecoveryService(
      this.services.control,
      this.services.journal,
      this.services.sandbox,
      this.services.fixtureControl,
      SessionRegistry.forRecovery(options.runId, this.services.control, this.services.externalResources),
      this.services.verificationRecovery,
      this.services.verificationRecoveryAdapters,
      this.services.externalResources,
      recoveryAdapters,
    ).recover(options.runId, snapshot.task);
    throwIfAborted(options.signal);
    const fixture = recovery.fixture;
    snapshot = await this.services.control.snapshot(options.runId);
    throwIfAborted(options.signal);
    const intentScheduler = new IntentScheduler(this.services.control, new LeaseManager(this.services.control), this.config.intentScheduler);
    const verifier = new IndependentVerifier(this.services.control, this.services.artifacts, this.services.verifierJournal, this.services.runsRoot, this.services.verifier);
    const coordinator = new RunCoordinator(this.services.control, this.services.verifier, { verifier });
    // A fresh Run remains at INTAKE until the task or verifier has a concrete
    // reason to publish a domain phase. The loop must not infer a CTF-style
    // reconnaissance route from the turn number.
    const claimVerifier = new CodingClaimVerifier(options.runId, this.services.control, this.services.artifacts, this.services.journal, this.services.verifierJournal, this.services.verifier);
    const checkpoints = new CheckpointService(this.services.control, this.services.artifacts);
    const planner = new PlannerCoordinator(this.services.control);
    const refiner = new RefinerCoordinator(this.services.control);
    const pendingAtStart = latestPending(await this.services.control.snapshot(options.runId));
    if (pendingAtStart) {
      throwIfAborted(options.signal);
      let verified: VerificationOutcome;
      try {
        const resumedWorkItem = await coordinator.claim(options.runId, options.task, 0);
        verified = await this.verifyAndFinalize(options.runId, fixture, coordinator, pendingAtStart.id, intentScheduler, resumedWorkItem.id, options.signal);
      } catch (error) {
        const paused = await this.services.control.snapshot(options.runId);
        if (paused.status === "PAUSED") return outcome(paused, mode, 0);
        throw error;
      }
      return outcome(await this.services.control.snapshot(options.runId), mode, 0, verified);
    }
    const acceptedAtStart = latestAcceptedVerification(await this.services.control.snapshot(options.runId), options.task);
    if (acceptedAtStart) {
      const current = await this.services.control.snapshot(options.runId);
      const workItem = Object.values(current.workItems).find((item) => item.status === "RUNNING" && item.ownerLane === "executor");
      const verified = await this.finalizeAcceptedVerification(options.runId, coordinator, intentScheduler, acceptedAtStart.id, workItem?.id, options.signal);
      return outcome(await this.services.control.snapshot(options.runId), mode, 0, verified);
    }
    const runtime = new ProofBladeToolRuntime(options.runId, fixture, this.services.runsRoot, this.services.control, this.services.artifacts, this.services.journal, this.root);
    await runtime.recoverJobs();
    let lane: AgentLanePort | undefined;
    let removeAbortListener: (() => void) | undefined;
    let abortPromise: Promise<void> | undefined;
    let turns = 0;
    let verification: VerificationOutcome | undefined;
    let activeWorkItemId: string | undefined;
    try {
      throwIfAborted(options.signal);
      lane = await this.createLane({
        projectRoot: this.root,
        runId: options.runId,
        runDir,
        runtime,
        fixture,
        services: Object.freeze({
          control: this.services.control,
          artifacts: this.services.artifacts,
          journal: this.services.journal,
          ...(this.services.sessionRuntimeBrokers ? { sessionRuntimeBrokers: this.services.sessionRuntimeBrokers } : {}),
          ...(this.services.sessionRuntimeRequired === undefined ? {} : { sessionRuntimeRequired: this.services.sessionRuntimeRequired }),
          ...(this.services.browserRuntimeRequired === undefined ? {} : { browserRuntimeRequired: this.services.browserRuntimeRequired }),
        }),
        claimVerifier,
        config: this.config,
        ...(browserVerifierFactory ? { browserVerifierFactory } : {}),
        externalResources: this.services.externalResources,
        ...(this.services.sessionRuntimeBrokers ? { sessionRuntimeBrokers: this.services.sessionRuntimeBrokers } : {}),
        ...(this.services.sessionRuntimeRequired === undefined ? {} : { sessionRuntimeRequired: this.services.sessionRuntimeRequired }),
        sessionHandoffs: recovery.sessionHandoffs,
        browserHandoffs: recovery.browserHandoffs,
        ...(options.ablationPolicy ? { ablationPolicy: options.ablationPolicy } : {}),
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      });
      const activeLane = lane;
      const onAbort = () => {
        abortPromise = activeLane.abort(options.signal?.reason ?? "GUI shutting down");
      };
      if (options.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
        if (options.signal.aborted) {
          onAbort();
          throwIfAborted(options.signal);
        }
      }
      await options.onLaneReady?.(lane);
      while (turns < maxTurns) {
        throwIfAborted(options.signal);
        const activeIntent = await this.claimIntent(options.runId, intentScheduler);
        const before = await this.services.control.snapshot(options.runId);
        if (isTerminal(before.status) || before.status === "PAUSED") break;
        const turnContext = await this.services.control.snapshot(options.runId);
        await planner.prepare(options.runId);
        activeWorkItemId = (await coordinator.claim(options.runId, options.task, turns + 1, activeIntent)).id;
        throwIfAborted(options.signal);
        turns += 1;
        // Lane.abort() is cooperative: a provider transport or tool process can
        // ignore it while its prompt promise remains pending. Do not make the
        // Run deadline merely advisory by waiting forever for that promise. The
        // abort listener above still asks the lane to release its resources;
        // this race only lets the durable loop terminalize and proceed.
        const agentOutcome = await awaitWithAbort(lane.prompt(turnPrompt(turnContext, turns, activeIntent, options.userPrompt)), options.signal);
        await options.onTurn?.(agentOutcome);
        throwIfAborted(options.signal);
        if (agentOutcome.termination === "budget_exhausted" || agentOutcome.termination === "deadline_exhausted") {
          await coordinator.fail(options.runId, activeWorkItemId, agentOutcome.termination);
          await this.exhaust(options.runId, agentOutcome.termination === "deadline_exhausted" ? "Run deadline exhausted during a Provider request." : "Run provider cost budget exhausted.");
          break;
        }
        if (isContextOverflow(agentOutcome.stopReason, agentOutcome.errorMessage)) {
          const failed = await this.services.control.snapshot(options.runId);
          if (failed.contextOverflowRecoveries >= 1) {
            await coordinator.fail(options.runId, activeWorkItemId, "context_overflow: recovery already used for this run.");
            await this.services.control.dispatch(options.runId, { type: "fail", reason: "context_overflow: recovery already used for this run.", category: "context_overflow" });
            break;
          }
          await coordinator.blockAndQueue(options.runId, options.task, activeWorkItemId, "context-overflow recovery", "context_overflow");
          activeWorkItemId = undefined;
          const checkpoint = await checkpoints.create(options.runId, "context-overflow-recovery");
          await this.services.control.dispatch(options.runId, { type: "context_recovery", checkpointId: checkpoint.checkpointId });
          try {
            await lane.compact("Use the ProofBlade mechanical checkpoint and retain the latest complete tool exchange.");
          } catch {
            // The durable checkpoint remains the recovery source when Pi compaction cannot run.
          }
          continue;
        }
        const after = await this.services.control.snapshot(options.runId);
        if (after.status === "PAUSED") break;
        const acceptedClaim = latestAcceptedVerification(after, options.task);
        if (acceptedClaim) {
          verification = await this.finalizeAcceptedVerification(options.runId, coordinator, intentScheduler, acceptedClaim.id, activeWorkItemId, options.signal);
          activeWorkItemId = undefined;
          break;
        }
        const pending = latestPending(after);
        if (pending) {
          if (mode() === "assist") {
            await coordinator.setDomainPhase(options.runId, "REPRODUCE");
            await coordinator.block(options.runId, activeWorkItemId, "Completion is waiting for verifier approval.");
            await this.services.control.dispatch(options.runId, { type: "pause", reason: `Completion ${pending.id} is waiting for verifier approval.` });
            break;
          }
          throwIfAborted(options.signal);
          verification = await this.verifyAndFinalize(options.runId, fixture, coordinator, pending.id, intentScheduler, activeWorkItemId, options.signal);
          activeWorkItemId = undefined;
          if (verification.accepted) break;
          await refiner.refineAfterFailure(options.runId, "candidate verification failed");
          // Verification is a real domain phase.  A rejected candidate must
          // explicitly return to EXPERIMENT before the next turn can advance;
          // otherwise the next absolute turn mapping would try to move from
          // REPRODUCE directly to TARGET_MODEL and the durable phase guard
          // would reject the run.
          await coordinator.setDomainPhase(options.runId, "EXPERIMENT");
          await coordinator.moveToPhase(options.runId, "experiment");
          continue;
        }
        const evidenceIds = newIds(before.evidence, after.evidence);
        const progressed = newIds(before.observations, after.observations).length > 0
          || evidenceIds.length > 0
          || newIds(before.facts, after.facts).length > 0
          || newIds(before.hypotheses, after.hypotheses).length > 0;
        await this.settleIntentAfterTurn(options.runId, intentScheduler, activeIntent, before, after);
        await coordinator.settle(options.runId, activeWorkItemId, progressed, evidenceIds, []);
        activeWorkItemId = undefined;
        if (mode() === "assist") {
          await this.services.control.dispatch(options.runId, { type: "pause", reason: "Assist turn completed without a completion proposal." });
          break;
        }
        if (agentOutcome.usage.input >= Math.floor(this.config.modelProfiles.executor.contextWindow * 0.78)) {
          await checkpoints.create(options.runId, "context-budget-threshold");
          try {
            await lane.compact("Preserve the task, ledger ids, rejected hypotheses, open effects, leases, and latest complete tool exchange.");
          } catch {
            // The checkpoint is sufficient for deterministic recovery.
          }
        }
        if (Date.now() - Date.parse(before.startedAt ?? new Date().toISOString()) >= before.task.constraints.deadline_ms) {
          await this.exhaust(options.runId, "Run deadline exhausted.");
          break;
        }
      }
    } catch (error) {
      await coordinator.fail(options.runId, activeWorkItemId, "Coding lane failed before returning a turn outcome.").catch(() => undefined);
      const paused = await this.services.control.snapshot(options.runId);
      if (paused.status === "PAUSED") {
        snapshot = paused;
        return outcome(snapshot, mode, turns, verification);
      }
      if (!isTerminal(paused.status)) {
        // A caller-owned terminalization policy describes an AbortSignal
        // deadline, not every exception from the coding lane.  Applying it to
        // ordinary provider/tool errors misclassified those failures as
        // budget exhaustion in evaluation reports.
        const terminalization = options.signal?.aborted ? options.terminalizeAbort : undefined;
        await this.services.control.dispatch(options.runId, {
          type: "fail",
          reason: terminalization?.reason ?? "Coding lane failed before returning a turn outcome.",
          category: terminalization?.category ?? "effect_outcome_unknown",
          lane: "executor",
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      removeAbortListener?.();
      const results: Array<{ resource: string; result: PromiseSettledResult<void> }> = [];
      if (abortPromise) results.push({ resource: "coding_lane_abort", result: await settleWithTimeout(abortPromise, "coding lane abort") });
      if (lane) results.push({ resource: "coding_lane_close", result: await settleWithTimeout(Promise.resolve().then(() => lane!.close()), "coding lane close") });
      results.push({ resource: "tool_runtime_close", result: await settleWithTimeout(Promise.resolve().then(() => runtime.close()), "tool runtime close") });
      const timedOutResources = results.flatMap(({ resource, result }) => result.status === "rejected" && isCleanupTimeout(result.reason) ? [resource] : []);
      if (timedOutResources.length > 0) {
        await this.services.control.append(options.runId, [{
          schemaVersion: 1,
          lane: "executor",
          actor: "orchestrator",
          correlationId: `${options.runId}:resource-cleanup`,
          type: "resource_cleanup_recovery_required",
          payload: {
            status: "UNKNOWN",
            recoveryRequired: true,
            resources: timedOutResources,
            reason: "Cleanup did not settle before the run deadline; reconcile resources before reuse.",
          },
        }]);
      }
      const failures = results.flatMap(({ result }) => result.status === "rejected" && !isCleanupTimeout(result.reason) ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, "Failed to close one or more run resources");
    }
    snapshot = await this.services.control.snapshot(options.runId);
    if (mode() === "auto" && snapshot.status !== "PAUSED" && !isTerminal(snapshot.status) && turns >= maxTurns) {
      try {
        await coordinator.fail(options.runId, activeWorkItemId, `No verified completion after ${maxTurns} model turns.`);
        await this.services.control.dispatch(options.runId, { type: "exhaust", reason: `No verified completion after ${maxTurns} model turns.` });
      } catch (error) {
        const current = await this.services.control.snapshot(options.runId);
        if (current.status !== "PAUSED") throw error;
      }
      snapshot = await this.services.control.snapshot(options.runId);
    }
    return outcome(snapshot, mode, turns, verification);
  }

  private async verifyAndFinalize(runId: string, fixture: Awaited<ReturnType<AppServices["sandbox"]["build"]>>, coordinator: RunCoordinator, completionId: string, scheduler: IntentScheduler, workItemId: string | undefined, signal?: AbortSignal): Promise<VerificationOutcome> {
    throwIfAborted(signal);
    const snapshot = await this.services.control.snapshot(runId);
    if (Object.keys(snapshot.hypotheses).length === 0) {
      const completion = snapshot.completions[completionId]!;
      await this.services.control.dispatch(runId, {
        type: "hypothesis",
        hypothesis: { id: id("H"), statement: `The target candidate with sha256=${completion.candidateHash} satisfies the task.`, status: "OPEN", evidenceIds: Object.keys(snapshot.evidence) },
        lane: "executor",
      });
    }
    throwIfAborted(signal);
    throwIfAborted(signal);
    const verified = await coordinator.verifyCompletion(runId, fixture, completionId, signal);
    await this.ensureVerifierActive(runId, signal);
    if (!verified.accepted) {
      await this.failClaimedIntents(runId, scheduler, `Verifier rejected completion ${completionId}`);
      await coordinator.fail(runId, workItemId, `Verifier rejected completion ${completionId}`);
      return verified;
    }
    await this.ensureVerifierActive(runId, signal);
    await coordinator.moveToPhase(runId, "report");
    await this.ensureVerifierActive(runId, signal);
    const verifiedSnapshot = await this.services.control.snapshot(runId);
    const acceptedCompletion = verifiedSnapshot.completions[verified.completionId];
    if (!acceptedCompletion || acceptedCompletion.status !== "ACCEPTED") throw new Error(`Verified completion is not accepted: ${verified.completionId}`);
    const report = [
      "# ProofBlade verification report",
      "",
      `Run: ${runId}`,
      `Completion: ${verified.completionId}`,
      `Candidate: ${verified.candidate}`,
      `Candidate SHA-256: ${acceptedCompletion.candidateHash}`,
      `Evidence: ${acceptedCompletion.evidenceIds.join(", ")}`,
      `Fact: ${verified.factId ?? "none"}`,
      `Fixture generation: ${(await this.services.control.snapshot(runId)).generation}`,
    ].join("\n");
    await this.services.artifacts.putText(runId, report, { filename: "report.md", mime: "text/markdown", sensitivity: "flag_candidate" });
    const current = await this.services.control.snapshot(runId);
    for (const intent of this.claimedSchedulerIntents(current)) {
      await scheduler.completeIntent(runId, intent.id, {
        producedObservations: Object.keys(current.observations),
        producedEvidence: verified.evidenceIds,
        producedFacts: Object.keys(current.facts),
      });
    }
    await this.ensureVerifierActive(runId, signal);
    await coordinator.finishAccepted(runId, workItemId, acceptedCompletion.id, "Hidden scorer reproduced the candidate.");
    return verified;
  }

  /**
   * A task-owned reproduction is already verified by CodingClaimVerifier's
   * verifier journal before the loop observes the turn. Do not send it through
   * the hidden-scorer verifier (which would be a different authority); finish
   * the same durable report/submit edge from the accepted Completion instead.
   */
  private async finalizeAcceptedVerification(
    runId: string,
    coordinator: RunCoordinator,
    scheduler: IntentScheduler,
    completionId: string,
    workItemId: string | undefined,
    signal?: AbortSignal,
  ): Promise<VerificationOutcome> {
    throwIfAborted(signal);
    const snapshot = await this.services.control.snapshot(runId);
    const completion = snapshot.completions[completionId];
    if (!completion || completion.status !== "ACCEPTED") throw new Error(`Task verification completion is not accepted: ${completionId}`);
    const artifact = snapshot.artifacts[completion.artifactId];
    if (!artifact) throw new Error(`Task verification result artifact is missing: ${completion.artifactId}`);
    const candidate = (await this.services.artifacts.readText(runId, artifact)).trim();
    const evidenceIds = [...completion.evidenceIds];
    if (evidenceIds.length === 0) throw new Error(`Task verification completion has no Evidence: ${completionId}`);
    if (snapshot.domainPhase !== "REPORT" && snapshot.domainPhase !== "SUBMIT") {
      await coordinator.setDomainPhase(runId, "REPRODUCE");
      await coordinator.moveToPhase(runId, "verification");
      await coordinator.moveToPhase(runId, "report");
      await coordinator.setDomainPhase(runId, "REPORT");
    }
    const fact = Object.values(snapshot.facts).find((item) => item.status === "CONFIRMED" && item.evidenceIds.some((evidenceId) => evidenceIds.includes(evidenceId)));
    const report = [
      "# ProofBlade verification report",
      "",
      `Run: ${runId}`,
      `Completion: ${completion.id}`,
      `Candidate: ${candidate}`,
      `Candidate SHA-256: ${completion.candidateHash}`,
      `Evidence: ${evidenceIds.join(", ")}`,
      `Fact: ${fact?.id ?? "none"}`,
      `Fixture generation: ${(await this.services.control.snapshot(runId)).generation}`,
      "Verification authority: task-owned deterministic verifier.",
    ].join("\n");
    await this.services.artifacts.putText(runId, report, { filename: "report.md", mime: "text/markdown", sensitivity: "flag_candidate" });
    const current = await this.services.control.snapshot(runId);
    for (const intent of this.claimedSchedulerIntents(current)) {
      await scheduler.completeIntent(runId, intent.id, {
        producedObservations: Object.keys(current.observations),
        producedEvidence: evidenceIds,
        producedFacts: Object.keys(current.facts),
      });
    }
    throwIfAborted(signal);
    await coordinator.finishAccepted(runId, workItemId, completion.id, "Task-owned deterministic verifier accepted the result.");
    return { completionId: completion.id, accepted: true, candidate, candidateHash: completion.candidateHash, evidenceIds, ...(fact ? { factId: fact.id } : {}) };
  }

  private async ensureVerifierActive(runId: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if ((await this.services.control.snapshot(runId)).status === "PAUSED") throw new Error("Run paused during verification");
  }

  private async claimIntent(runId: string, scheduler: IntentScheduler): Promise<SchedulerIntent | undefined> {
    const snapshot = await this.services.control.snapshot(runId);
    const claimed = this.claimedSchedulerIntents(snapshot)[0];
    if (claimed) return claimed;
    return await scheduler.schedule(buildSchedulingContext(snapshot)) ?? undefined;
  }

  private async settleIntentAfterTurn(runId: string, scheduler: IntentScheduler, intent: SchedulerIntent | undefined, before: RunSnapshot, after: RunSnapshot): Promise<void> {
    if (!intent) return;
    const progressed = newIds(before.observations, after.observations).length > 0
      || newIds(before.evidence, after.evidence).length > 0
      || newIds(before.facts, after.facts).length > 0
      || newIds(before.hypotheses, after.hypotheses).length > 0;
    if (progressed) {
      await scheduler.completeIntent(runId, intent.id, {
        producedObservations: newIds(before.observations, after.observations),
        producedEvidence: newIds(before.evidence, after.evidence),
        producedFacts: newIds(before.facts, after.facts),
      });
    } else {
      await scheduler.failIntent(runId, intent.id, "Coding turn produced no durable progress");
    }
  }

  private async failClaimedIntents(runId: string, scheduler: IntentScheduler, reason: string): Promise<void> {
    const snapshot = await this.services.control.snapshot(runId);
    for (const intent of this.claimedSchedulerIntents(snapshot)) await scheduler.failIntent(runId, intent.id, reason);
  }

  private claimedSchedulerIntents(snapshot: RunSnapshot): SchedulerIntent[] {
    return Object.values(snapshot.schedulerIntents ?? {})
      .filter((intent) => intent.status === "CLAIMED" && intent.fixtureGeneration === snapshot.generation);
  }

  private async exhaust(runId: string, reason: string): Promise<void> {
    try {
      await this.services.control.dispatch(runId, { type: "exhaust", reason });
    } catch (error) {
      if ((await this.services.control.snapshot(runId)).status !== "PAUSED") throw error;
    }
  }
}

/**
 * Historical export retained for replay and downstream compatibility. New
 * callers must use the domain-neutral SingleAgentLoop implementation above.
 */
export const SingleAgentCtfLoop = SingleAgentLoop;

function isContextOverflow(stopReason: string, errorMessage?: string): boolean {
  return stopReason === "length" || (stopReason === "error" && /context|token|length|maximum/i.test(errorMessage ?? ""));
}

async function defaultLaneFactory(input: AgentLaneCreateInput): Promise<AgentLanePort> {
  const fixture = input.fixture;
  return await PiCodingLane.create({
    projectRoot: fixture.path,
    installRoot: input.projectRoot,
    runId: input.runId,
    runDir: input.runDir,
    controlStore: input.services.control,
    artifactStore: input.services.artifacts,
    journal: input.services.journal,
    claimVerifier: input.claimVerifier,
    config: input.config,
    ...(input.browserVerifierFactory ? { browserVerifierFactory: input.browserVerifierFactory } : {}),
    externalResources: input.externalResources,
    ...(input.services.sessionRuntimeBrokers ? { sessionRuntimeBrokers: input.services.sessionRuntimeBrokers } : {}),
    ...(input.services.sessionRuntimeRequired === undefined ? {} : { sessionRuntimeRequired: input.services.sessionRuntimeRequired }),
    ...(input.services.browserRuntimeRequired === undefined ? {} : { browserRuntimeRequired: input.services.browserRuntimeRequired }),
    sessionHandoffs: input.sessionHandoffs,
    browserHandoffs: input.browserHandoffs,
    ...(input.ablationPolicy ? { ablationPolicy: input.ablationPolicy } : {}),
    deferClaimAcceptance: true,
    sessionId: `${input.runId}-coding`,
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
  });
}

function latestPending(snapshot: RunSnapshot) {
  return Object.values(snapshot.completions).filter((item) => item.status === "PROPOSED").sort((a, b) => b.createdSeq - a.createdSeq)[0];
}

function latestAcceptedVerification(snapshot: RunSnapshot, task: TaskContract) {
  if (task.verification.kind !== "reproduction") return undefined;
  return Object.values(snapshot.completions)
    .filter((item) => item.status === "ACCEPTED"
      && (item.purpose === "claim_reproduction" || item.purpose === "harness_verification")
      && item.generation === snapshot.generation)
    .sort((a, b) => b.createdSeq - a.createdSeq)[0];
}

function turnPrompt(snapshot: RunSnapshot, turn: number, intent?: SchedulerIntent, userPrompt?: string): string {
  const remainingDeadline = remainingRunDeadlineMs(snapshot.startedAt, snapshot.task.constraints.deadline_ms);
  return [
    `Solve run ${snapshot.runId}. This is executor turn ${turn}.`,
    `Durable phase: ${snapshot.domainPhase}; generic phase: ${snapshot.phase}. This is status context, not a required route.`,
    `Remaining deadline: ${Math.ceil(remainingDeadline / 1000)} seconds. Choose the next bounded action that best serves the task objective.`,
    `Remaining effect budget: ${Math.max(0, snapshot.task.constraints.max_tool_calls - Object.keys(snapshot.effects).length)} of ${snapshot.task.constraints.max_tool_calls}.`,
    ...(intent ? [`Current Intent ${intent.id}: ${intent.objective}`, `Suggested tools: ${intent.suggestedTools.join(", ") || "none"}.`] : []),
    ...(userPrompt?.trim() ? ["User's latest instruction:", userPrompt.trim()] : []),
    `Task inputs (read-only, relative to the current workspace): ${snapshot.task.inputs.map((input) => input.path).join(", ") || "none listed; inspect the workspace manifest only"}.`,
    "Stay within the task workspace and use the enabled tools according to their stated safety boundaries.",
    "Inspect relevant inputs before making claims; preserve useful Artifact/Evidence ids and use them to support your reasoning.",
    "When the task has a verifier, use the available verification capability before marking a result as verified; otherwise report uncertainty clearly.",
  ].join("\n");
}

function newIds(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys(after).filter((key) => !(key in before));
}

function outcome(snapshot: RunSnapshot, mode: ExecutionMode | (() => ExecutionMode), turns: number, verification?: VerificationOutcome): SingleAgentRunOutcome {
  const resolvedMode = typeof mode === "function" ? mode() : mode;
  const finalResult = snapshot.finalResult;
  const completion = finalResult
    ? snapshot.completions[finalResult.completionId]
    : verification
      ? snapshot.completions[verification.completionId]
      : Object.values(snapshot.completions)
        .filter((item) => item.runId === snapshot.runId && item.generation === snapshot.generation)
        .sort((a, b) => b.createdSeq - a.createdSeq)[0];
  return {
    runId: snapshot.runId,
    mode: resolvedMode,
    status: snapshot.status,
    phase: snapshot.phase,
    turns,
    completionId: finalResult?.completionId ?? completion?.id,
    evidenceIds: finalResult ? [...finalResult.evidenceIds] : completion?.evidenceIds ?? [],
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Run aborted");
}

/** Cleanup must not extend a caller-owned deadline indefinitely. The original
 * operation remains observed so a late rejection cannot become unhandled. */
async function settleWithTimeout<T>(operation: Promise<T>, label: string, timeoutMs = 2_000): Promise<PromiseSettledResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observed = operation.then(
    (value) => ({ status: "fulfilled", value } as PromiseFulfilledResult<T>),
    (reason) => ({ status: "rejected", reason } as PromiseRejectedResult),
  );
  const timeout = new Promise<PromiseRejectedResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: "rejected", reason: Object.assign(new Error(`${label} timed out after ${timeoutMs}ms`), { cleanupTimeout: true }) }), timeoutMs);
  });
  const result = await Promise.race([observed, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

function isCleanupTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { cleanupTimeout?: unknown }).cleanupTimeout === true;
}

/**
 * Make caller-owned cancellation observable even when a Lane never settles its
 * prompt promise after `abort()`. The original promise has rejection handling
 * through this wrapper, so a late Provider/tool failure cannot become an
 * unhandled rejection after the Run has already reached its terminal state.
 */
function awaitWithAbort<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Run aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Run aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
