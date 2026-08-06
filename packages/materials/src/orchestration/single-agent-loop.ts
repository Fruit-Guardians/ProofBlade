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
import { handoffKnowledgeVersion } from "../domain/handoff.js";

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
  mode?: ExecutionMode;
  maxTurns?: number;
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
    const mode = options.mode ?? "assist";
    const maxTurns = options.maxTurns ?? 3;
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
    const fixture = recovery.fixture;
    snapshot = await this.services.control.snapshot(options.runId);
    if (snapshot.phase === "intake") await this.services.control.dispatch(options.runId, { type: "start_phase", phase: "reconnaissance" });
    await this.ensureIntent(options.runId);
    const runtime = new ProofBladeToolRuntime(options.runId, fixture, this.services.runsRoot, this.services.control, this.services.artifacts, this.services.journal, this.root);
    await runtime.recoverJobs();
    const verifier = new IndependentVerifier(this.services.control, this.services.artifacts, this.services.journal, this.services.runsRoot);
    const checkpoints = new CheckpointService(this.services.control, this.services.artifacts);
    const planner = new PlannerCoordinator(this.services.control);
    const pendingAtStart = latestPending(await this.services.control.snapshot(options.runId));
    if (pendingAtStart) {
      const verified = await this.verifyAndFinalize(options.runId, fixture, verifier, pendingAtStart.id);
      return outcome(await this.services.control.snapshot(options.runId), mode, 0, verified);
    }
    const lane = await this.createLane({ projectRoot: this.root, runId: options.runId, runDir, runtime, services: this.services, config: this.config });
    let turns = 0;
    let verification: VerificationOutcome | undefined;
    let previousTurnAdvanced: boolean | undefined;
    try {
      while (turns < maxTurns) {
        const before = await this.services.control.snapshot(options.runId);
        if (isTerminal(before.status)) break;
        const beforeKnowledgeVersion = handoffKnowledgeVersion(before);
        await planner.prepare(options.runId);
        turns += 1;
        const agentOutcome = await lane.prompt(turnPrompt(before, turns, previousTurnAdvanced));
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
        previousTurnAdvanced = handoffKnowledgeVersion(after) !== beforeKnowledgeVersion;
        const pending = latestPending(after);
        if (pending) {
          if (mode === "assist") {
            await this.services.control.dispatch(options.runId, { type: "pause", reason: `Completion ${pending.id} is waiting for verifier approval.` });
            break;
          }
          verification = await this.verifyAndFinalize(options.runId, fixture, verifier, pending.id);
          if (verification.accepted) break;
          await this.moveTo(options.runId, "experiment");
          continue;
        }
        if (mode === "assist") {
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
          await this.services.control.dispatch(options.runId, { type: "exhaust", reason: "Run deadline exhausted." });
          break;
        }
      }
    } finally {
      await lane.close();
      await runtime.close();
    }
    snapshot = await this.services.control.snapshot(options.runId);
    if (mode === "auto" && !isTerminal(snapshot.status) && turns >= maxTurns) {
      await this.services.control.dispatch(options.runId, { type: "exhaust", reason: `No verified completion after ${maxTurns} model turns.` });
      snapshot = await this.services.control.snapshot(options.runId);
    }
    return outcome(snapshot, mode, turns, verification);
  }

  private async ensureIntent(runId: string): Promise<void> {
    const snapshot = await this.services.control.snapshot(runId);
    if (Object.keys(snapshot.intents).length > 0) return;
    await this.services.control.dispatch(runId, {
      type: "intent",
      intent: { id: id("I"), title: "Solve the challenge through an evidenced route", description: "Choose the highest-value authorized analysis route, preserve durable observations, and propose a grounded candidate for independent verification.", phase: "reconnaissance", status: "CLAIMED", priority: 10, ownerLane: "executor" },
      lane: "executor",
    });
  }

  private async verifyAndFinalize(runId: string, fixture: Awaited<ReturnType<AppServices["sandbox"]["build"]>>, verifier: IndependentVerifier, completionId: string): Promise<VerificationOutcome> {
    const snapshot = await this.services.control.snapshot(runId);
    if (Object.keys(snapshot.hypotheses).length === 0) {
      const completion = snapshot.completions[completionId]!;
      await this.services.control.dispatch(runId, {
        type: "hypothesis",
        hypothesis: { id: id("H"), statement: `The target candidate with sha256=${completion.candidateHash} satisfies the task.`, status: "OPEN", evidenceIds: Object.keys(snapshot.evidence) },
        lane: "executor",
      });
    }
    await this.moveTo(runId, "verification");
    const verified = await verifier.verify(runId, fixture, completionId);
    if (!verified.accepted) return verified;
    await this.moveTo(runId, "report");
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
    await this.services.control.dispatch(runId, { type: "finish", verified: true, evidenceIds: verified.evidenceIds, reason: "Hidden scorer reproduced the candidate.", lane: "verifier" });
    return verified;
  }

  private async moveTo(runId: string, phase: RunSnapshot["phase"]): Promise<void> {
    const snapshot = await this.services.control.snapshot(runId);
    for (const next of pathToPhase(snapshot.phase, phase)) await this.services.control.dispatch(runId, { type: "start_phase", phase: next });
  }
}

function isContextOverflow(stopReason: string, errorMessage?: string): boolean {
  return stopReason === "error" && /context|token|length|maximum/i.test(errorMessage ?? "");
}

async function defaultLaneFactory(input: SolverLaneCreateInput): Promise<AgentLanePort> {
  return await PiSolverLane.create({ projectRoot: input.projectRoot, runId: input.runId, runDir: input.runDir, controlStore: input.services.control, artifactStore: input.services.artifacts, config: input.config, runtime: input.runtime });
}

function latestPending(snapshot: RunSnapshot) {
  return Object.values(snapshot.completions).filter((item) => item.status === "PROPOSED").sort((a, b) => b.createdSeq - a.createdSeq)[0];
}

function turnPrompt(snapshot: RunSnapshot, turn: number, previousTurnAdvanced?: boolean): string {
  const progress = previousTurnAdvanced === false
    ? "The previous turn made no durable progress. Choose a materially different route; do not repeat the same no-result action."
    : previousTurnAdvanced === true
      ? "The previous turn advanced durable state. Reassess the new evidence before choosing the next action."
      : "Select the highest-value first action from the task, active handoff, and available resources.";
  return [
    `Continue run ${snapshot.runId}; executor turn ${turn}; phase=${snapshot.phase}; target_kind=${snapshot.task.target_kind}.`,
    `Objective: ${snapshot.task.objective}`,
    progress,
    "Choose your own analysis method and authorized tool sequence. Skills, capabilities, MCP-backed operations, and direct reasoning are optional resources, not a mandatory recipe.",
    "Make concrete progress toward durable evidence or a grounded candidate. Do not stop with an unsupported prose answer.",
  ].join("\n");
}

function outcome(snapshot: RunSnapshot, mode: ExecutionMode, turns: number, verification?: VerificationOutcome): SingleAgentRunOutcome {
  const completion = verification ? snapshot.completions[verification.completionId] : Object.values(snapshot.completions).sort((a, b) => b.createdSeq - a.createdSeq)[0];
  return { runId: snapshot.runId, mode, status: snapshot.status, phase: snapshot.phase, turns, completionId: completion?.id, evidenceIds: completion?.evidenceIds ?? [] };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
