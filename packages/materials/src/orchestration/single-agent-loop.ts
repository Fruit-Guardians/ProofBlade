import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ProofBladeConfig } from "../config.js";
import type { AgentLanePort } from "../runtime/pi-adapter.js";
import { PiSolverLane } from "../runtime/solver-lane.js";
import type { AppServices } from "../app/demo.js";
import type { ExecutionMode, RunSnapshot, TaskContract } from "../domain/types.js";
import { id, isTerminal } from "../domain/utils.js";
import { pathToPhase } from "../control/phase-machine.js";
import { ProofBladeToolRuntime } from "../tools/runtime.js";
import { IndependentVerifier, type VerificationOutcome } from "../verification/verifier.js";
import { CheckpointService } from "../context/checkpoint.js";
import { PlannerCoordinator } from "./planner.js";
import { RunRecoveryService } from "../recovery/run-recovery.js";

export interface SolverLaneCreateInput {
  projectRoot: string;
  runId: string;
  runDir: string;
  runtime: ProofBladeToolRuntime;
  services: AppServices;
  config: ProofBladeConfig;
}

export type SolverLaneFactory = (input: SolverLaneCreateInput) => Promise<AgentLanePort>;

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
    private readonly createLane: SolverLaneFactory = defaultLaneFactory,
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
    const recovery = await new RunRecoveryService(this.services.control, this.services.journal, this.services.sandbox)
      .recover(options.runId, snapshot.task);
    throwIfAborted(options.signal);
    const fixture = recovery.fixture;
    snapshot = await this.services.control.snapshot(options.runId);
    throwIfAborted(options.signal);
    if (snapshot.phase === "intake") await this.services.control.dispatch(options.runId, { type: "start_phase", phase: "reconnaissance" });
    await this.ensureIntent(options.runId);
    const verifier = new IndependentVerifier(this.services.control, this.services.artifacts, this.services.journal, this.services.runsRoot);
    const checkpoints = new CheckpointService(this.services.control, this.services.artifacts);
    const planner = new PlannerCoordinator(this.services.control);
    const pendingAtStart = latestPending(await this.services.control.snapshot(options.runId));
    if (pendingAtStart) {
      throwIfAborted(options.signal);
      let verified: VerificationOutcome;
      try {
        verified = await this.verifyAndFinalize(options.runId, fixture, verifier, pendingAtStart.id, options.signal);
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
    try {
      throwIfAborted(options.signal);
      lane = await this.createLane({ projectRoot: this.root, runId: options.runId, runDir, runtime, services: this.services, config: this.config });
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
        const before = await this.services.control.snapshot(options.runId);
        if (isTerminal(before.status) || before.status === "PAUSED") break;
        await planner.prepare(options.runId);
        throwIfAborted(options.signal);
        turns += 1;
        const agentOutcome = await lane.prompt(turnPrompt(before, turns));
        throwIfAborted(options.signal);
        if (agentOutcome.termination === "budget_exhausted" || agentOutcome.termination === "deadline_exhausted") {
          await this.exhaust(options.runId, agentOutcome.termination === "deadline_exhausted" ? "Run deadline exhausted during a Provider request." : "Run provider cost budget exhausted.");
          break;
        }
        if (isContextOverflow(agentOutcome.stopReason, agentOutcome.errorMessage)) {
          const failed = await this.services.control.snapshot(options.runId);
          if (failed.contextOverflowRecoveries >= 1) {
            await this.services.control.dispatch(options.runId, { type: "fail", reason: "context_overflow: recovery already used for this run.", category: "context_overflow" });
            break;
          }
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
            await this.services.control.dispatch(options.runId, { type: "pause", reason: `Completion ${pending.id} is waiting for verifier approval.` });
            break;
          }
          throwIfAborted(options.signal);
          verification = await this.verifyAndFinalize(options.runId, fixture, verifier, pending.id, options.signal);
          if (verification.accepted) break;
          await this.moveTo(options.runId, "experiment");
          continue;
        }
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
      const paused = await this.services.control.snapshot(options.runId);
      if (paused.status === "PAUSED") {
        snapshot = paused;
        return outcome(snapshot, mode, turns, verification);
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
        await this.services.control.dispatch(options.runId, { type: "exhaust", reason: `No verified completion after ${maxTurns} model turns.` });
      } catch (error) {
        const current = await this.services.control.snapshot(options.runId);
        if (current.status !== "PAUSED") throw error;
      }
      snapshot = await this.services.control.snapshot(options.runId);
    }
    return outcome(snapshot, mode, turns, verification);
  }

  private async ensureIntent(runId: string): Promise<void> {
    const snapshot = await this.services.control.snapshot(runId);
    if (Object.keys(snapshot.intents).length > 0) return;
    await this.services.control.dispatch(runId, {
      type: "intent",
      intent: { id: id("I"), title: "Inspect target and propose an evidenced candidate", description: "Use the stable target tools, preserve observations, then submit one candidate for independent verification.", phase: "reconnaissance", status: "CLAIMED", priority: 10, ownerLane: "executor" },
      lane: "executor",
    });
  }

  private async verifyAndFinalize(runId: string, fixture: Awaited<ReturnType<AppServices["sandbox"]["build"]>>, verifier: IndependentVerifier, completionId: string, signal?: AbortSignal): Promise<VerificationOutcome> {
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
    await this.moveTo(runId, "verification");
    throwIfAborted(signal);
    const verified = await verifier.verify(runId, fixture, completionId, signal);
    await this.ensureVerifierActive(runId, signal);
    if (!verified.accepted) return verified;
    await this.ensureVerifierActive(runId, signal);
    await this.moveTo(runId, "report");
    await this.ensureVerifierActive(runId, signal);
    const report = [
      "# ProofBlade verification report",
      "",
      `Run: ${runId}`,
      `Completion: ${verified.completionId}`,
      `Candidate: ${verified.candidate}`,
      `Candidate SHA-256: ${verified.candidateHash}`,
      `Evidence: ${verified.evidenceIds.join(", ")}`,
      `Fact: ${verified.factId ?? "none"}`,
      `Fixture generation: ${(await this.services.control.snapshot(runId)).generation}`,
    ].join("\n");
    await this.services.artifacts.putText(runId, report, { filename: "report.md", mime: "text/markdown", sensitivity: "flag_candidate" });
    const current = await this.services.control.snapshot(runId);
    for (const intent of Object.values(current.intents).filter((item) => item.status === "OPEN" || item.status === "CLAIMED")) {
      await this.services.control.dispatch(runId, { type: "intent", intent: { ...intent, status: "DONE" }, lane: "executor" });
    }
    await this.ensureVerifierActive(runId, signal);
    await this.services.control.dispatch(runId, { type: "finish", verified: true, evidenceIds: verified.evidenceIds, reason: "Hidden scorer reproduced the candidate.", lane: "verifier" });
    return verified;
  }

  private async ensureVerifierActive(runId: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if ((await this.services.control.snapshot(runId)).status === "PAUSED") throw new Error("Run paused during verification");
  }

  private async moveTo(runId: string, phase: RunSnapshot["phase"]): Promise<void> {
    const snapshot = await this.services.control.snapshot(runId);
    for (const next of pathToPhase(snapshot.phase, phase)) await this.services.control.dispatch(runId, { type: "start_phase", phase: next });
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

async function defaultLaneFactory(input: SolverLaneCreateInput): Promise<AgentLanePort> {
  return await PiSolverLane.create({ projectRoot: input.projectRoot, runId: input.runId, runDir: input.runDir, controlStore: input.services.control, artifactStore: input.services.artifacts, config: input.config, runtime: input.runtime });
}

function latestPending(snapshot: RunSnapshot) {
  return Object.values(snapshot.completions).filter((item) => item.status === "PROPOSED").sort((a, b) => b.createdSeq - a.createdSeq)[0];
}

function turnPrompt(snapshot: RunSnapshot, turn: number): string {
  return [
    `Solve run ${snapshot.runId}. This is executor turn ${turn}.`,
    "Call inspect_target with an empty object {} to inspect every visible synthetic target file.",
    "Preserve the returned evidence id in any hypothesis or fact proposal.",
    "Copy one complete PB{...} value exactly from inspect_target output, then call submit_candidate with that exact value.",
    "Do not stop at a prose answer; the completion proposal tool is required.",
  ].join("\n");
}

function outcome(snapshot: RunSnapshot, mode: ExecutionMode | (() => ExecutionMode), turns: number, verification?: VerificationOutcome): SingleAgentRunOutcome {
  const resolvedMode = typeof mode === "function" ? mode() : mode;
  const completion = verification ? snapshot.completions[verification.completionId] : Object.values(snapshot.completions).sort((a, b) => b.createdSeq - a.createdSeq)[0];
  return { runId: snapshot.runId, mode: resolvedMode, status: snapshot.status, phase: snapshot.phase, turns, completionId: completion?.id, evidenceIds: completion?.evidenceIds ?? [] };
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
