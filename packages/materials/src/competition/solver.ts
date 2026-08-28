import { join } from "node:path";
import { resolveExecutionConfig, type ProofBladeConfig } from "../config.js";
import { createServices } from "../app/demo.js";
import type { ExecutionMode, TaskContract } from "../domain/types.js";
import { id, isTerminal, sha256 } from "../domain/utils.js";
import { CompetitionChallengeError, CompetitionContainerError, CompetitionHttpError, type CompetitionApi, type CompetitionAttachment, type CompetitionEnvironment } from "./api.js";
import { competitionTask, parseCompetitionTargets } from "./task.js";
import { CompetitionSandbox } from "./sandbox.js";
import { countSubmissions, runCompetitionLoop, type CompetitionLaneFactory } from "./loop.js";
import type { ChallengeSolveRequest, ChallengeSolveResult, ChallengeSolver } from "./fleet.js";
import { DockerContainerRuntime } from "../container/docker.js";
import type { ContainerRef, ContainerRuntimePort } from "../container/contracts.js";
import { SessionRegistry } from "../container/session-registry.js";
import { CompetitionEnvironmentJanitor, CompetitionEnvironmentResourceAdapter, type CompetitionEnvironmentReservation, type ManagedCompetitionEnvironment } from "./environment-janitor.js";
import { ExternalResourceRegistry } from "../recovery/external-resource-registry.js";
import { IndependentVerifier } from "../verification/verifier.js";
import { beginSubmissionVerificationRequest } from "../verification/verification-key.js";
import { PwnReplayRecoveryAdapter } from "../verification/pwn-replay-recovery.js";
import type { PwnVerifierPolicy } from "../verification/pwn-reproduction-verifier.js";
import { RunCoordinator } from "../orchestration/run-coordinator.js";
import type { ApprovalPolicy } from "../security/approval-policy.js";
import { preflightSessionRuntimeBrokers, tryCreateConfiguredSessionRuntimeBrokers, type SessionRuntimePreflight } from "../recovery/session-runtime-composition.js";
import type { BrowserVerifierFactory } from "../web/browser-session.js";

type RequiredRuntimeKind = "http-session" | "pwn-session";

/**
 * Competition tasks currently expose HTTP as the default Web verifier
 * transport. Only the runtime needed by the immutable task direction may
 * block the solve; an unrelated configured broker must not turn a healthy
 * challenge into a platform error.
 */
function requiredRuntimeKinds(targetKind: string): ReadonlySet<RequiredRuntimeKind> {
  if (targetKind === "pwn") return new Set(["pwn-session"]);
  if (targetKind === "web") return new Set(["http-session"]);
  return new Set();
}

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
  /** Optional durable environment capacity/expiry guard shared by the Fleet. */
  environmentJanitor?: CompetitionEnvironmentJanitor;
  /** Optional common resource ledger shared by environment and Run recovery. */
  externalResources?: ExternalResourceRegistry;
  /** Optional durable approval gate for platform submission effects. */
  approvalPolicy?: ApprovalPolicy;
  /** Optional verifier-owned Browser runtime used by browser transport tasks. */
  browserVerifierFactory?: BrowserVerifierFactory;
}

function pwnVerifierPolicyFor(contract: TaskContract["verification"]["pwn"]): PwnVerifierPolicy | undefined {
  if (!contract || contract.target.command.length === 0 || !contract.flag_path || !contract.flag_pattern) return undefined;
  const target = contract.target.kind === "remote"
    ? contract.target.endpoint
      ? { kind: "remote" as const, command: [...contract.target.command], endpoint: contract.target.endpoint }
      : undefined
    : { kind: "local" as const, command: [...contract.target.command] };
  if (!target) return undefined;
  return { target, flagPath: contract.flag_path, flagPattern: contract.flag_pattern };
}

/**
 * The real ChallengeSolver: turns one competition challenge into a full harness
 * run. Fetches detail + attachments, provisions the environment, and either
 * takes a journaled no-model dynamic-flag path or drives the CODING lane over
 * a CompetitionSandbox. The provisioned environment is always released.
 */
export class CompetitionChallengeSolver implements ChallengeSolver {
  private readonly environmentJanitor: CompetitionEnvironmentJanitor;
  private readonly externalResources: ExternalResourceRegistry;

  public constructor(private readonly init: CompetitionChallengeSolverInit) {
    this.externalResources = init.externalResources ?? new ExternalResourceRegistry(join(init.root, ".proofblade", "external-resources.json"));
    if (init.containerRuntime instanceof DockerContainerRuntime) init.containerRuntime.bindExternalResourceRegistry(this.externalResources);
    this.environmentJanitor = init.environmentJanitor ?? new CompetitionEnvironmentJanitor({
      api: init.api,
      // Keep the lifecycle ledger beside other private runtime state rather
      // than under `runs/`, whose children are individual Run directories.
      ledgerPath: join(init.root, ".proofblade", "competition-environments.json"),
      requireRemoteInspectionForSweep: true,
      externalResources: this.externalResources,
    });
  }

  /** Reconcile expired environments before the Fleet claims new challenges. */
  public async reconcile(): Promise<void> {
    await this.environmentJanitor.sweepExpired();
  }

  public async solve(request: ChallengeSolveRequest): Promise<ChallengeSolveResult> {
    const challengeId = request.challenge.challengeId;
    const runId = `${this.init.runIdPrefix ?? "CH"}-${challengeId}-${Date.now()}`;
    let detail: Awaited<ReturnType<CompetitionApi["getChallenge"]>>;
    try {
      detail = await this.init.api.getChallenge(challengeId);
    } catch (error) {
      this.throwIfAborted(request.signal, error);
      return competitionFailure("fetch challenge", classifyChallengeFetchError(error));
    }

    const execution = resolveExecutionConfig(this.init.config);
    const profile = profileForCategory(request.challenge.normalizedCategory);
    const needsContainer = execution.backend === "docker" && profile !== undefined && execution.requireFor?.includes(request.challenge.normalizedCategory as never);

    let environment: Awaited<ReturnType<CompetitionApi["startEnvironment"]>> | undefined;
    let reservation: CompetitionEnvironmentReservation | undefined;
    let managedEnvironment: ManagedCompetitionEnvironment | undefined;
    try {
      reservation = await this.environmentJanitor.acquireForChallenge(runId, challengeId, request.signal);
      await this.environmentJanitor.markStarting(reservation);
      environment = await this.init.api.startEnvironment(challengeId, { idempotencyKey: reservation.idempotencyKey });
      managedEnvironment = await this.environmentJanitor.register(reservation, challengeId, environment);
      reservation = undefined;
    } catch (error) {
      // startEnvironment can fail after the build POST has already succeeded
      // (for example while polling or parsing readiness). We may not have an
      // instance handle yet, so use the challenge id for a best-effort,
      // idempotent cleanup instead of leaking the provisioned environment.
      if (environment) await this.stop(challengeId, environment.instanceId, managedEnvironment);
      else await this.stop(challengeId);
      if (reservation) await this.environmentJanitor.releaseReservation(reservation);
      this.throwIfAborted(request.signal, error);
      return competitionFailure("provision environment", error);
    }
    if (!environment) throw new Error("Competition environment provisioning returned no environment");

    // Dynamic-flag challenges hand us the flag at provisioning time — submit it
    // without spending a model turn to rediscover it. It still goes through a
    // durable Run, Artifact, independent verifier, and journaled fixture_score
    // so the fast path cannot bypass the single terminal state machine.
    if (environment.teamFlag && environment.teamFlag.trim()) {
      const flag = environment.teamFlag.trim();
      try {
        return await this.solveDynamicFlag(runId, request, challengeId, detail.attachments, environment, flag);
      } catch (error) {
        this.throwIfAborted(request.signal, error);
        return competitionFailure("submit dynamic flag", error);
      } finally {
        await this.stop(challengeId, environment.instanceId, managedEnvironment);
      }
    }

    // Do not create a Coding lane until every session broker required by this
    // task direction has proved that it can serve restart-stable capabilities.
    // An explicitly injected Browser factory remains an application-owned
    // test/development seam; Browser transport is not part of the current
    // competition task contract. The check
    // intentionally sits after the dynamic-flag path: the platform only tells
    // us whether a challenge is dynamic after environment provisioning, and
    // that path never creates a Coding lane or touches a session runtime.
    const runtimeKinds = requiredRuntimeKinds(request.challenge.normalizedCategory);
    const sessionRuntime = tryCreateConfiguredSessionRuntimeBrokers(this.init.config);
    const requiredSessionKinds = [...runtimeKinds];
    const hasConfiguredRuntime = requiredSessionKinds.length > 0 && sessionRuntime.configured;
    const requiredSessionBrokers = sessionRuntime.brokers.filter((broker) => requiredSessionKinds.includes(broker.kind));
    let sessionRuntimePreflight: SessionRuntimePreflight = { brokers: [], unavailableKinds: [] };
    if (hasConfiguredRuntime) {
      if (sessionRuntime.tokenAvailable) sessionRuntimePreflight = await preflightSessionRuntimeBrokers(requiredSessionBrokers, request.signal);
      const unavailable = sessionRuntime.tokenAvailable
        ? sessionRuntimePreflight.unavailableKinds.filter((kind) => requiredSessionKinds.includes(kind)).map((kind) => `${kind}: broker is not READY with restart-stable capabilities`)
        : requiredSessionKinds.map((kind) => `${kind}: missing session runtime credentials`);
      if (unavailable.length > 0) {
        await this.stop(challengeId, environment.instanceId, managedEnvironment);
        return competitionFailure("runtime preflight", new Error(unavailable.join("; ")));
      }
    }

    // Dynamic-flag challenges never execute code in a local container. Delay
    // Docker preflight until after startEnvironment has told us that this run
    // actually has a model-solvable target; otherwise a local Docker outage
    // would incorrectly block a platform-only flag submission.
    const containerRuntime = needsContainer ? (this.init.containerRuntime ?? new DockerContainerRuntime(execution, undefined, undefined, this.externalResources)) : undefined;
    if (containerRuntime) {
      try {
        await containerRuntime.prewarm([profile!]);
        const doctor = await containerRuntime.doctor(profile!);
        if (!doctor.daemon || doctor.image?.available === false) throw new Error(doctor.reason ?? `Docker image unavailable: ${doctor.image?.name ?? "unknown"}`);
      } catch (error) {
        await this.stop(challengeId, environment.instanceId, managedEnvironment);
        this.throwIfAborted(request.signal, error);
        return competitionFailure("prepare Docker execution", new CompetitionContainerError(error instanceof Error ? error.message : String(error), error));
      }
    }

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
    const services = createServices(this.init.root, this.init.config, {
      sandbox,
      externalResources: this.externalResources,
      externalResourceAdapters: [new CompetitionEnvironmentResourceAdapter(this.environmentJanitor)],
      ...(requiredSessionBrokers.length > 0 ? { sessionRuntimeBrokers: requiredSessionBrokers } : {}),
      ...(hasConfiguredRuntime && !sessionRuntime.tokenAvailable ? { sessionRuntimeRequired: true } : {}),
      ...(this.init.config.runtime.browserBroker ? { browserRuntimeRequired: true } : {}),
    });

    try {
      let task: ReturnType<typeof competitionTask>;
      try {
        task = competitionTask(runId, request.challenge, environment, this.init.root, this.init.config, detail.attachments);
      } catch (error) {
        this.throwIfAborted(request.signal, error);
        return competitionFailure("parse challenge targets", error);
      }
      await services.control.createRun(runId, task);
      // Unpack attachments + connection info before the loop, and use the
      // returned fixture path as the lane's working directory so bash, reads, and
      // relative paths all land on the challenge files.
      const fixture = await sandbox.build(task);
      let container: ContainerRef | undefined;
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
        const pwnPolicy = pwnVerifierPolicyFor(task.verification.pwn);
        const verificationRecoveryAdapters = container && containerRuntime && pwnPolicy
          ? [new PwnReplayRecoveryAdapter({
            runId,
            controlStore: services.control,
            registry: new SessionRegistry(runId, containerRuntime, services.control, services.externalResources),
            refProvider: () => container!,
            policy: pwnPolicy,
            readRecipe: async (effectId) => await services.journal.readVerifierReplayInput(runId, effectId),
          })]
          : undefined;
        const externalResourceAdapters = [
          new CompetitionEnvironmentResourceAdapter(this.environmentJanitor),
          ...(containerRuntime instanceof DockerContainerRuntime ? [containerRuntime.externalResourceAdapter()] : []),
        ];
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
          sessionRuntimePreflight,
          ...(this.init.approvalPolicy ? { approvalPolicy: this.init.approvalPolicy } : {}),
          ...(this.init.browserVerifierFactory ? { browserVerifierFactory: this.init.browserVerifierFactory } : {}),
          ...(verificationRecoveryAdapters ? { verificationRecoveryAdapters } : {}),
          externalResourceAdapters,
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
      await this.stop(challengeId, environment.instanceId, managedEnvironment);
    }
  }

  private async stop(challengeId: string, instanceId?: string, managedEnvironment?: ManagedCompetitionEnvironment): Promise<void> {
    if (managedEnvironment) {
      await this.environmentJanitor.release(managedEnvironment.leaseId, "challenge solver finished").catch(() => false);
      return;
    }
    try {
      await this.init.api.stopEnvironment(challengeId, instanceId);
    } catch {
      // Best-effort teardown; the platform reclaims environments on expiry.
    }
  }

  private async solveDynamicFlag(
    runId: string,
    request: ChallengeSolveRequest,
    challengeId: string,
    attachments: CompetitionAttachment[],
    environment: CompetitionEnvironment,
    flag: string,
  ): Promise<ChallengeSolveResult> {
    const task = competitionTask(runId, request.challenge, environment, this.init.root, this.init.config, attachments);
    const sandbox = new CompetitionSandbox({
      api: this.init.api,
      challengeId,
      workspaceRoot: join(this.init.root, this.init.config.storage.fixturesDir),
      attachments,
      environment,
    });
    const sessionRuntime = tryCreateConfiguredSessionRuntimeBrokers(this.init.config);
    const services = createServices(this.init.root, this.init.config, {
      sandbox,
      externalResources: this.externalResources,
      externalResourceAdapters: [new CompetitionEnvironmentResourceAdapter(this.environmentJanitor)],
      ...(sessionRuntime.brokers.length > 0 ? { sessionRuntimeBrokers: sessionRuntime.brokers } : {}),
      ...(sessionRuntime.configured ? { sessionRuntimeRequired: !sessionRuntime.tokenAvailable } : {}),
      ...(this.init.config.runtime.browserBroker ? { browserRuntimeRequired: true } : {}),
    });
    let created = false;
    try {
      await services.control.createRun(runId, task);
      created = true;
      const fixture = await sandbox.build(task);
      const candidateArtifact = await services.artifacts.putText(runId, flag, {
        filename: "dynamic-flag.txt",
        sensitivity: "flag_candidate",
      });
      const completionId = id("C");
      const verificationRequest = await beginSubmissionVerificationRequest(services.control, runId, { candidateHash: sha256(flag), candidateArtifactId: candidateArtifact.id });
      const verifier = new IndependentVerifier(services.control, services.artifacts, services.verifierJournal, join(this.init.root, this.init.config.storage.runsDir), services.verifier);
      const coordinator = new RunCoordinator(services.control, services.verifier, { verifier });
      await coordinator.setDomainPhase(runId, "RECON");
      const workItemId = (await coordinator.claim(runId, task, 0)).id;
      await services.control.dispatch(runId, {
        type: "completion_proposed",
        completion: { id: completionId, purpose: "submission", candidateHash: sha256(flag), artifactId: candidateArtifact.id, verificationKey: verificationRequest.request.key },
        lane: "executor",
      });
      if ((request.mode?.() ?? this.init.mode ?? "auto") === "assist") {
        await coordinator.block(runId, workItemId, "Completion is waiting for operator approval.");
        return { solved: false, status: "AWAITING_APPROVAL", submissions: 0, reason: "Completion is waiting for operator approval." };
      }
      if (this.init.approvalPolicy) {
        const approval = await this.init.approvalPolicy.check({
          runId,
          operation: "platform.submit",
          resource: flag,
          reason: "A platform-provided dynamic flag is ready for submission.",
        });
        if (!approval.allowed) {
          await coordinator.block(runId, workItemId, "Completion is waiting for operator approval.");
          return { solved: false, status: "AWAITING_APPROVAL", submissions: 0, reason: `${approval.reason ?? "Completion is waiting for operator approval."}${approval.approvalId ? ` approvalId=${approval.approvalId}` : ""}` };
        }
      }
      const verified = await coordinator.verifyCompletion(runId, fixture, completionId, request.signal);
      const snapshot = await services.control.snapshot(runId);
      const submissions = countSubmissions(snapshot);
      if (!verified.accepted) {
        await coordinator.fail(runId, workItemId, "The platform rejected the dynamic flag.");
        await services.control.dispatch(runId, { type: "fail", reason: verified.evidenceIds.join(", ") || "The platform rejected the dynamic flag.", category: "verifier_disagreement", lane: "verifier" });
        return { solved: false, status: "DYNAMIC_REJECTED", submissions, reason: "The platform rejected the dynamic flag." };
      }
      await coordinator.finishAccepted(runId, workItemId, completionId, "Platform accepted the candidate and verifier evidence covers the completion.");
      return { solved: true, status: "SOLVED_DYNAMIC", flag, submissions };
    } catch (error) {
      if (created) {
        const current = await services.control.snapshot(runId);
        if (!isTerminal(current.status)) {
          await services.control.dispatch(runId, {
            type: "fail",
            reason: error instanceof Error ? error.message : String(error),
            category: "permission_or_environment",
            lane: "verifier",
          }).catch(() => undefined);
        }
      }
      throw error;
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

/**
 * Keep failures that identify one malformed/missing challenge local to that
 * challenge. Authentication, throttling, transport, and service failures must
 * remain PLATFORM_ERROR so the Fleet circuit still protects the platform.
 */
function classifyChallengeFetchError(error: unknown): unknown {
  if (error instanceof CompetitionChallengeError) return error;
  if (error instanceof CompetitionHttpError && error.method === "GET" && isExplicitChallengeHttpError(error)) {
    return new CompetitionChallengeError(`Challenge detail request was rejected: ${error.message}`, error);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(?:attachment|challenge|exercise|payload|parameter)\b.*\b(?:exceed\w*|too\s+large|invalid|malformed|unsafe|corrupt\w*|validation|missing)\b/i.test(message)
    || /\b(?:invalid|malformed|missing|unavailable|corrupt\w*)\b.*\b(?:challenge|exercise|attachment|payload|parameter)\b/i.test(message)) {
    return new CompetitionChallengeError(message, error);
  }
  return error;
}

function isExplicitChallengeHttpError(error: CompetitionHttpError): boolean {
  const body = error.responseBody;
  // A route-level 404 (for example "Cannot GET /api/challenges/...") or a
  // generic proxy error must remain PLATFORM_ERROR. Only an explicit business
  // response naming a missing/invalid challenge is safe to isolate.
  if (![400, 404, 410, 422].includes(error.status)) return false;
  return /\b(?:challenge|exercise|problem)\b.{0,100}\b(?:not\s+found|missing|does\s+not\s+exist|invalid|不存在|缺失)\b/i.test(body)
    || /\b(?:not\s+found|missing|does\s+not\s+exist|invalid|不存在|缺失)\b.{0,100}\b(?:challenge|exercise|problem)\b/i.test(body)
    || /\b(?:challenge|exercise|problem)[_.-](?:not[_.-]?found|missing|invalid)\b/i.test(body);
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
