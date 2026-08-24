import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ProofBladeConfig } from "../config.js";
import type { AgentLanePort } from "../runtime/pi-adapter.js";
import { PiCodingLane } from "../runtime/coding-lane.js";
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

export interface AgentLaneCreateInput {
  projectRoot: string;
  runId: string;
  runDir: string;
  /** The recovered fixture workspace shared by the loop and its lane. */
  fixture: Awaited<ReturnType<AppServices["sandbox"]["build"]>>;
  runtime: ProofBladeToolRuntime;
  /** Deliberately excludes verifier and fixture lifecycle capabilities. */
  services: Pick<AppServices, "control" | "artifacts" | "journal">;
  /** Safe claim service; the lane never receives verifier control directly. */
  claimVerifier: CodingClaimVerifier;
  config: ProofBladeConfig;
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

export class SingleAgentCtfLoop {
  public constructor(
    private readonly root: string,
    private readonly config: ProofBladeConfig,
    private readonly services: AppServices,
    private readonly createLane: AgentLaneFactory = defaultLaneFactory,
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
    const recovery = await new RunRecoveryService(
      this.services.control,
      this.services.journal,
      this.services.sandbox,
      this.services.fixtureControl,
      SessionRegistry.forRecovery(options.runId, this.services.control),
    ).recover(options.runId, snapshot.task);
    throwIfAborted(options.signal);
    const fixture = recovery.fixture;
    snapshot = await this.services.control.snapshot(options.runId);
    throwIfAborted(options.signal);
    const intentScheduler = new IntentScheduler(this.services.control, new LeaseManager(this.services.control), this.config.intentScheduler);
    const verifier = new IndependentVerifier(this.services.control, this.services.artifacts, this.services.verifierJournal, this.services.runsRoot, this.services.verifier);
    const coordinator = new RunCoordinator(this.services.control, this.services.verifier, { verifier });
    // Keep the initial generic projection and the CTF projection in one
    // transaction.  A direct `start_phase` here used to leave a fresh local
    // Run at `domainPhase=INTAKE, phase=reconnaissance` until the first model
    // turn, which made GUI/Fixture replay diverge from Competition replay.
    if (snapshot.phase === "intake") await coordinator.setDomainPhase(options.runId, "RECON");
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
        services: Object.freeze({ control: this.services.control, artifacts: this.services.artifacts, journal: this.services.journal }),
        claimVerifier,
        config: this.config,
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
        await coordinator.setDomainPhase(options.runId, coordinator.domainPhaseForTurn(turns + 1));
        const turnContext = await this.services.control.snapshot(options.runId);
        await planner.prepare(options.runId);
        activeWorkItemId = (await coordinator.claim(options.runId, options.task, turns + 1, activeIntent)).id;
        throwIfAborted(options.signal);
        turns += 1;
        const agentOutcome = await lane.prompt(turnPrompt(turnContext, turns, activeIntent));
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
          await coordinator.blockAndQueue(options.runId, options.task, activeWorkItemId, "context-overflow recovery");
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
      const results: PromiseSettledResult<void>[] = [];
      if (abortPromise) results.push(...await Promise.allSettled([abortPromise]));
      if (lane) results.push(...await Promise.allSettled([lane.close()]));
      results.push(...await Promise.allSettled([runtime.close()]));
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
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
    deferClaimAcceptance: true,
    sessionId: `${input.runId}-coding`,
  });
}

function latestPending(snapshot: RunSnapshot) {
  return Object.values(snapshot.completions).filter((item) => item.status === "PROPOSED").sort((a, b) => b.createdSeq - a.createdSeq)[0];
}

function turnPrompt(snapshot: RunSnapshot, turn: number, intent?: SchedulerIntent): string {
  const remainingDeadline = remainingRunDeadlineMs(snapshot.startedAt, snapshot.task.constraints.deadline_ms);
  return [
    `Solve run ${snapshot.runId}. This is executor turn ${turn}.`,
    `Durable phase: ${snapshot.domainPhase}; generic phase: ${snapshot.phase}. Treat this phase as a bounded step, not an invitation to restart the whole analysis.`,
    `Remaining deadline: ${Math.ceil(remainingDeadline / 1000)} seconds. Prioritize one concrete observation, evidence item, or verifier-ready candidate before broadening the search.`,
    `Remaining effect budget: ${Math.max(0, snapshot.task.constraints.max_tool_calls - Object.keys(snapshot.effects).length)} of ${snapshot.task.constraints.max_tool_calls}. Every call must produce a new fact, evidence item, or candidate check.`,
    ...(intent ? [`Current Intent ${intent.id}: ${intent.objective}`, `Suggested tools: ${intent.suggestedTools.join(", ") || "none"}.`] : []),
    "Inspect every visible target file with read or a bounded bash command; do not guess from the task description.",
    "Preserve useful Artifact/Evidence ids and use them to support your reasoning.",
    "When a candidate is ready, call verify_claim with the exact candidate and a deterministic command that derives it from workspace inputs without embedding the candidate literal.",
    "Do not stop at a prose answer; the verify_claim tool is required.",
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
