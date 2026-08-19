import { join } from "node:path";
import { resolveExecutionConfig, type ProofBladeConfig } from "../config.js";
import { createServices } from "../app/demo.js";
import type { ExecutionMode } from "../domain/types.js";
import { CompetitionChallengeError, CompetitionContainerError, type CompetitionApi } from "./api.js";
import { competitionTask, parseCompetitionTargets } from "./task.js";
import { CompetitionSandbox } from "./sandbox.js";
import { runCompetitionLoop, type CompetitionLaneFactory } from "./loop.js";
import type { ChallengeSolveRequest, ChallengeSolveResult, ChallengeSolver } from "./fleet.js";
import { DockerContainerRuntime } from "../container/docker.js";
import type { ContainerRef, ContainerRuntimePort } from "../container/contracts.js";

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
  /** Injectable container runtime; production defaults to Docker when enabled. */
  containerRuntime?: ContainerRuntimePort;
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
    let detail: Awaited<ReturnType<CompetitionApi["getChallenge"]>>;
    try {
      detail = await this.init.api.getChallenge(challengeId);
    } catch (error) {
      this.throwIfAborted(request.signal, error);
      return competitionFailure("fetch challenge", error);
    }

    const execution = resolveExecutionConfig(this.init.config);
    const profile = profileForCategory(request.challenge.normalizedCategory);
    const needsContainer = execution.backend === "docker" && profile !== undefined && execution.requireFor?.includes(request.challenge.normalizedCategory as never);
    const containerRuntime = needsContainer ? (this.init.containerRuntime ?? new DockerContainerRuntime(execution)) : undefined;
    if (containerRuntime) {
      try {
        await containerRuntime.prewarm([profile!]);
        const doctor = await containerRuntime.doctor(profile!);
        if (!doctor.daemon || doctor.image?.available === false) throw new Error(doctor.reason ?? `Docker image unavailable: ${doctor.image?.name ?? "unknown"}`);
      } catch (error) {
        this.throwIfAborted(request.signal, error);
        return competitionFailure("prepare Docker execution", new CompetitionContainerError(error instanceof Error ? error.message : String(error), error));
      }
    }

    let environment: Awaited<ReturnType<CompetitionApi["startEnvironment"]>>;
    try {
      environment = await this.init.api.startEnvironment(challengeId);
    } catch (error) {
      // startEnvironment can fail after the build POST has already succeeded
      // (for example while polling or parsing readiness). We may not have an
      // instance handle yet, so use the challenge id for a best-effort,
      // idempotent cleanup instead of leaking the provisioned environment.
      await this.stop(challengeId);
      this.throwIfAborted(request.signal, error);
      return competitionFailure("provision environment", error);
    }

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
      } catch (error) {
        this.throwIfAborted(request.signal, error);
        return competitionFailure("submit dynamic flag", error);
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

    try {
      let task: ReturnType<typeof competitionTask>;
      try {
        task = competitionTask(runId, request.challenge, environment, this.init.root, this.init.config);
      } catch (error) {
        this.throwIfAborted(request.signal, error);
        return competitionFailure("parse challenge targets", error);
      }
      await services.control.createRun(runId, task);
      // Unpack attachments + connection info before the loop, and use the
      // returned fixture path as the lane's working directory so bash, reads, and
      // relative paths all land on the challenge files.
      const fixture = await sandbox.build(task);
      let container;
      try {
        container = containerRuntime ? await containerRuntime.create({
          runId,
          generation: 1,
          profile: profile!,
          image: execution.images[profile!],
          workspaceHostPath: fixture.path,
          skillLibraryHostPath: join(this.init.root, "skills-library", "ctf-skills"),
          targets: parseCompetitionTargets(environment.connectionInfo),
          networkPolicy: execution.networkPolicy,
          gatewayImage: execution.images.gateway,
        }) : undefined;
      } catch (error) {
        this.throwIfAborted(request.signal, error);
        return competitionFailure("create Docker execution", error instanceof CompetitionChallengeError
          ? error
          : new CompetitionContainerError(error instanceof Error ? error.message : String(error), error));
      }
      try {
        const outcome = await runCompetitionLoop(this.init.root, this.init.config, services, {
          runId,
          task,
          workspaceRoot: fixture.path,
          installRoot: this.init.root,
          ...(container && containerRuntime ? {
            executionEnv: containerRuntime.executionEnv(container),
            workspaceRootForPrompt: "/workspace",
            skillsLibraryPathForPrompt: "/opt/proofblade/skills",
            executionPlatform: "linux",
            hostWorkspaceRootForMcp: fixture.path,
          } : {}),
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
        if (container && containerRuntime) await containerRuntime.destroy(container);
      }
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

  private throwIfAborted(signal: AbortSignal, error: unknown): void {
    if (!signal.aborted) return;
    throw signal.reason instanceof Error ? signal.reason : error;
  }
}

function profileForCategory(category: string): ContainerRef["profile"] | undefined {
  if (category === "web") return "web";
  if (category === "pwn") return "pwn";
  return undefined;
}

function competitionFailure(operation: string, error: unknown): ChallengeSolveResult {
  const cause = error instanceof Error ? error.message : String(error);
  if (error instanceof CompetitionChallengeError) {
    return { solved: false, status: "CHALLENGE_ERROR", reason: `Challenge ${operation} failed: ${cause}` };
  }
  if (error instanceof CompetitionContainerError) {
    return { solved: false, status: "CONTAINER_ERROR", reason: `Container ${operation} failed: ${cause}` };
  }
  return { solved: false, status: "PLATFORM_ERROR", reason: `Platform ${operation} failed: ${cause}` };
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
