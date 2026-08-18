import { join } from "node:path";
import type { ProofBladeConfig } from "../config.js";
import { createServices } from "../app/demo.js";
import type { ExecutionMode } from "../domain/types.js";
import type { CompetitionApi } from "./api.js";
import { competitionTask } from "./task.js";
import { CompetitionSandbox } from "./sandbox.js";
import { runCompetitionLoop, type CompetitionLaneFactory } from "./loop.js";
import type { ChallengeSolveRequest, ChallengeSolveResult, ChallengeSolver } from "./fleet.js";

export interface CompetitionChallengeSolverInit {
  root: string;
  config: ProofBladeConfig;
  api: CompetitionApi;
  /** Execution mode for the inner loop. Defaults to "auto" for autonomous play. */
  mode?: ExecutionMode;
  maxTurns?: number;
  /** Lane factory override, used by tests to inject a deterministic lane. */
  createLane?: CompetitionLaneFactory;
  /** Prefix for generated run ids. */
  runIdPrefix?: string;
}

/**
 * The real ChallengeSolver: turns one competition challenge into a full harness
 * run. Fetches detail + attachments, provisions the environment, and either
 * submits a platform-provided dynamic flag directly or drives the CODING lane
 * over a CompetitionSandbox. The provisioned environment is always released.
 */
export class CompetitionChallengeSolver implements ChallengeSolver {
  public constructor(private readonly init: CompetitionChallengeSolverInit) {}

  public async solve(request: ChallengeSolveRequest): Promise<ChallengeSolveResult> {
    const challengeId = request.challenge.challengeId;
    const detail = await this.init.api.getChallenge(challengeId);
    const environment = await this.init.api.startEnvironment(challengeId);

    // Dynamic-flag challenges hand us the flag at provisioning time — submit it
    // directly rather than spending a whole model run to rediscover it.
    if (environment.teamFlag && environment.teamFlag.trim()) {
      const flag = environment.teamFlag.trim();
      try {
        const verdict = await this.init.api.submitFlag(challengeId, flag);
        return {
          solved: verdict.correct,
          flag: verdict.correct ? flag : undefined,
          status: verdict.correct ? "SOLVED_DYNAMIC" : "DYNAMIC_REJECTED",
          submissions: 1,
          reason: verdict.message,
        };
      } finally {
        await this.stop(challengeId, environment.instanceId);
      }
    }

    const runId = `${this.init.runIdPrefix ?? "CH"}-${challengeId}-${Date.now()}`;
    const sandbox = new CompetitionSandbox({
      api: this.init.api,
      challengeId,
      // Keep the target workspace separate from the control-store run dir, the
      // same way LocalFixtureSandbox uses fixturesDir — otherwise inspect_target
      // would see task.json/events.jsonl alongside the attachments.
      workspaceRoot: join(this.init.root, this.init.config.storage.fixturesDir),
      attachments: detail.attachments,
      environment,
    });
    const services = createServices(this.init.root, this.init.config, { sandbox });
    const task = competitionTask(runId, request.challenge, environment, this.init.root, this.init.config);

    try {
      await services.control.createRun(runId, task);
      // Unpack attachments + connection info before the loop, and use the
      // returned fixture path as the lane's working directory so bash, reads, and
      // relative paths all land on the challenge files.
      const fixture = await sandbox.build(task);
      const outcome = await runCompetitionLoop(this.init.root, this.init.config, services, {
        runId,
        task,
        workspaceRoot: fixture.path,
        installRoot: this.init.root,
        // A live per-challenge mode getter (from the fleet control plane) wins;
        // otherwise the solver's configured mode, defaulting to autonomous play.
        mode: request.mode ?? this.init.mode ?? "auto",
        ...(this.init.maxTurns === undefined ? {} : { maxTurns: this.init.maxTurns }),
        ...(request.signal ? { signal: request.signal } : {}),
      }, this.init.createLane);
      return {
        solved: outcome.solved,
        status: competitionStatus(outcome.stopReason, outcome.solved),
        submissions: outcome.submissions,
        ...(outcome.solved ? {} : { reason: outcome.termination ?? outcome.stopReason }),
      };
    } finally {
      await this.stop(challengeId, environment.instanceId);
    }
  }

  private async stop(challengeId: string, instanceId?: string): Promise<void> {
    try {
      await this.init.api.stopEnvironment(challengeId, instanceId);
    } catch {
      // Best-effort teardown; the platform reclaims environments on expiry.
    }
  }
}

/** Map a loop stop reason onto the fleet's status string. */
function competitionStatus(stopReason: string, solved: boolean): string {
  if (solved) return "SOLVED";
  switch (stopReason) {
    case "held_for_approval":
      return "AWAITING_APPROVAL";
    case "aborted":
      return "CANCELLED";
    case "deadline":
      return "DEADLINE";
    case "provider_error":
      return "PROVIDER_ERROR";
    case "terminated":
      return "TERMINATED";
    default:
      return "UNSOLVED";
  }
}
