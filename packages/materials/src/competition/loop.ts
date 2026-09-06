import { join } from "node:path";
import type { ProofBladeConfig } from "../config.js";
import type { AppServices } from "../app/demo.js";
import type { ActionBundle, ExecutionMode, RunSnapshot, TargetKind, TaskContract } from "../domain/types.js";
import { PiCodingLane } from "../runtime/coding-lane.js";
import type { AgentLanePort } from "../runtime/pi-adapter.js";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { isTerminal } from "../domain/utils.js";
import { CodingClaimVerifier } from "../verification/claim-verification.js";
import { IndependentVerifier } from "../verification/verifier.js";
import type { ApprovalPolicy } from "../security/approval-policy.js";
import { RunCoordinator } from "../orchestration/run-coordinator.js";
import { shouldReplanAfterTurnGuard, turnGuardFailureCategory } from "../domain/failure-policy.js";
import { remainingRunDeadlineMs } from "../domain/utils.js";
import { RunRecoveryService } from "../recovery/run-recovery.js";
import type { VerificationRecoveryAdapterSource } from "../recovery/verification-recovery.js";
import type { ExternalResourceAdapterSource } from "../recovery/external-resource-registry.js";
import { withSessionResourceAdapters } from "../recovery/session-resource-adapter.js";
import type { SessionRuntimePreflight } from "../recovery/session-runtime-composition.js";
import { withBrowserResourceAdapter } from "../web/browser-resource-adapter.js";
import type { BrowserVerifierFactory } from "../web/browser-session.js";

/** Factory override so tests can inject a deterministic lane. */
export type CompetitionLaneFactory = (options: Parameters<typeof PiCodingLane.create>[0]) => Promise<AgentLanePort>;

export interface CompetitionLoopOptions {
  runId: string;
  task: TaskContract;
  /** The unpacked challenge workspace — where bash runs and attachments live. */
  workspaceRoot: string;
  /** ProofBlade install root, where skills/ and .mcp.json live. */
  installRoot: string;
  mode?: ExecutionMode | (() => ExecutionMode);
  maxTurns?: number;
  /** Ceiling in seconds on any single blocking `bash` call. Defaults to 180. */
  bashTimeoutSecondsMax?: number;
  /** Optional Docker-backed process environment for Web/Pwn runs. */
  executionEnv?: ExecutionEnv;
  /** Workspace path visible to the execution backend, e.g. /workspace. */
  workspaceRootForPrompt?: string;
  /** Skill library path visible to the execution backend, e.g. /opt/proofblade/skills. */
  skillsLibraryPathForPrompt?: string;
  /** Platform syntax visible to the execution backend (Docker Web/Pwn is Linux even on Windows hosts). */
  executionPlatform?: NodeJS.Platform;
  /** Host path for host-side MCP tools such as IDA; only use it in MCP arguments. */
  hostWorkspaceRootForMcp?: string;
  signal?: AbortSignal;
  /** Optional durable approval gate for platform effects. */
  approvalPolicy?: ApprovalPolicy;
  /** Backend adapters used when this loop is resumed after a process restart. */
  verificationRecoveryAdapters?: VerificationRecoveryAdapterSource;
  /** Adapters used to inspect/adopt/release external resources during recovery. */
  externalResourceAdapters?: ExternalResourceAdapterSource;
  /** Verifier-owned Browser runtime for browser transport tasks. */
  browserVerifierFactory?: BrowserVerifierFactory;
  /** Session broker health already checked before the lane is created. */
  sessionRuntimePreflight?: SessionRuntimePreflight;
}

export interface CompetitionLoopOutcome {
  runId: string;
  turns: number;
  solved: boolean;
  /** Set when a flag is recorded but awaiting operator approval (assist mode). */
  heldForApproval: boolean;
  submissions: number;
  stopReason: "solved" | "held_for_approval" | "max_turns" | "deadline" | "aborted" | "provider_error" | "terminated";
  lastText?: string;
  termination?: string;
}

/**
 * Drive one competition challenge on the CODING lane.
 *
 * This loop is the platform-facing wrapper around the same PiCodingLane used
 * by Fixture execution. Competition adds the platform submission path and
 * scoped execution environment; it does not maintain a second solver lane.
 *
 * Kept from the old loop: bounded turns, deadline enforcement, abort wiring, and
 * assist-mode stop-before-submitting. Phase movement and verifier-first
 * finalization are delegated to RunCoordinator so Competition and Fixture/GUI
 * runs replay through the same durable state machine.
 */
export async function runCompetitionLoop(
  root: string,
  config: ProofBladeConfig,
  services: AppServices,
  options: CompetitionLoopOptions,
  createLane: CompetitionLaneFactory = (laneOptions) => PiCodingLane.create(laneOptions),
): Promise<CompetitionLoopOutcome> {
  const modeSource = options.mode ?? "auto";
  const mode = (): ExecutionMode => (typeof modeSource === "function" ? modeSource() : modeSource);
  const maxTurns = options.maxTurns ?? 24;
  const runDir = join(services.runsRoot, options.runId);
  const startedAt = Date.now();
  const deadlineMs = options.task.constraints.deadline_ms;

  let lane: AgentLanePort | undefined;
  let removeAbortListener: (() => void) | undefined;
  let turns = 0;
  let lastText: string | undefined;
  let termination: string | undefined;
  let stopReason: CompetitionLoopOutcome["stopReason"] = "max_turns";
  let forceReplan = false;
  let replanReason: string | undefined;
  let guardReplans = 0;
  let workItemId: string | undefined;
  let deadlineReached = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let approvalRequiredId: string | undefined;

  try {
    const recovery = await new RunRecoveryService(
      services.control,
      services.journal,
      services.sandbox,
      services.fixtureControl,
      undefined,
      services.verificationRecovery,
      options.verificationRecoveryAdapters ?? services.verificationRecoveryAdapters,
      services.externalResources,
      withSessionResourceAdapters(
        withBrowserResourceAdapter(options.externalResourceAdapters ?? services.externalResourceAdapters, options.browserVerifierFactory),
        services.sessionRuntimeBrokers ?? [],
      ),
    ).recover(options.runId, options.task);
    const claimVerifier = new CodingClaimVerifier(options.runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
    const platformVerifier = new IndependentVerifier(services.control, services.artifacts, services.verifierJournal, services.runsRoot, services.verifier);
    const coordinator = new RunCoordinator(services.control, services.verifier, { verifier: platformVerifier });
    lane = await createLane({
      runId: options.runId,
      projectRoot: options.workspaceRoot,
      installRoot: options.installRoot,
      runDir,
      controlStore: services.control,
      artifactStore: services.artifacts,
      journal: services.journal,
      claimVerifier,
      platformVerifier,
      config,
      // The fleet's per-challenge toggle is read on every submission, so flipping
      // auto/assist mid-run takes effect without rebuilding the lane.
      mode: () => (mode() === "assist" ? "assist" : "auto"),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      onApprovalRequired: (approvalId) => { approvalRequiredId = approvalId; },
      // Bound a single blocking command. A real run hung one bash call for 30+
      // minutes, which in a fleet idles a worker slot for the whole time; long work
      // belongs in shell_background instead.
      bashTimeoutSecondsMax: options.bashTimeoutSecondsMax ?? 180,
      // Competition replay still speaks the historical verify_claim protocol;
      // generic security tasks leave this compatibility alias disabled.
      legacyClaimVerification: true,
      ...(options.executionEnv ? { executionEnv: options.executionEnv } : {}),
      ...(options.workspaceRootForPrompt ? { workspaceRootForPrompt: options.workspaceRootForPrompt } : {}),
      ...(options.skillsLibraryPathForPrompt ? { skillsLibraryPathForPrompt: options.skillsLibraryPathForPrompt } : {}),
      ...(options.executionPlatform ? { executionPlatform: options.executionPlatform } : {}),
      ...(options.hostWorkspaceRootForMcp ? { hostWorkspaceRootForMcp: options.hostWorkspaceRootForMcp } : {}),
      externalResources: services.externalResources,
      ...(services.sessionRuntimeBrokers ? { sessionRuntimeBrokers: services.sessionRuntimeBrokers } : {}),
      ...(options.sessionRuntimePreflight ? { sessionRuntimePreflight: options.sessionRuntimePreflight } : {}),
      ...(services.sessionRuntimeRequired === undefined ? {} : { sessionRuntimeRequired: services.sessionRuntimeRequired }),
      ...(services.browserRuntimeRequired === undefined ? {} : { browserRuntimeRequired: services.browserRuntimeRequired }),
      ...(options.browserVerifierFactory ? { browserVerifierFactory: options.browserVerifierFactory } : {}),
      sessionHandoffs: recovery.sessionHandoffs,
    });
    const activeLane = lane;
    const remainingDeadlineMs = Math.max(0, deadlineMs - (Date.now() - startedAt));
    deadlineTimer = setTimeout(() => {
      deadlineReached = true;
      void activeLane.abort("Challenge deadline exceeded").catch(() => undefined);
    }, remainingDeadlineMs);
    if (options.signal) {
      const onAbort = () => void activeLane.abort(options.signal?.reason ?? "Challenge cancelled");
      options.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      if (options.signal.aborted) onAbort();
    }

    while (turns < maxTurns) {
      if (options.signal?.aborted) {
        stopReason = "aborted";
        break;
      }
      if (deadlineReached || Date.now() - startedAt >= deadlineMs) {
        stopReason = "deadline";
        break;
      }
      turns += 1;
      await coordinator.setDomainPhase(options.runId, coordinator.domainPhaseForTurn(turns));
      workItemId = (await coordinator.claim(options.runId, options.task, turns)).id;
      const preTurnSnapshot = await services.control.snapshot(options.runId);
      const submissionsSoFar = countSubmissions(preTurnSnapshot);
      const prompt = turnPrompt(options.task, turns, options.workspaceRootForPrompt ?? options.workspaceRoot, {
        submissionsSoFar,
        domainPhase: preTurnSnapshot.domainPhase,
        remainingToolCalls: options.task.constraints.max_tool_calls - Object.keys(preTurnSnapshot.effects).length,
        remainingDeadlineMs: remainingRunDeadlineMs(new Date(startedAt).toISOString(), deadlineMs),
        actionBundle: preTurnSnapshot.toolPreparation?.actionBundles?.find((bundle) => bundle.domainPhase === preTurnSnapshot.domainPhase),
        forceReplan,
        previousTermination: replanReason,
      });
      forceReplan = false;
      replanReason = undefined;
      let outcome: Awaited<ReturnType<AgentLanePort["prompt"]>>;
      try {
        outcome = await activeLane.prompt(prompt);
      } catch (error) {
        await failCompetitionWorkItem(services.control, options.runId, workItemId, "Coding lane threw before returning a turn outcome.");
        throw error;
      }
      lastText = outcome.text || lastText;
      const snapshot = await services.control.snapshot(options.runId);
      const acceptedCompletion = acceptedPlatformCompletion(snapshot);
      if (approvalRequiredId) {
        stopReason = "held_for_approval";
        termination = `approval_required:${approvalRequiredId}`;
        await blockCompetitionWorkItem(services.control, options.runId, workItemId, "Completion is waiting for operator approval.");
        break;
      }
      if (deadlineReached || Date.now() - startedAt >= deadlineMs) {
        termination = "deadline_exhausted";
        stopReason = "deadline";
        await failCompetitionWorkItem(services.control, options.runId, workItemId, termination);
        break;
      }
      if (acceptedCompletion) {
        // Close the active work item and advance the domain projection before
        // finish makes the Run terminal; terminal Runs deliberately reject
        // further work-graph mutation.
        await coordinator.finishAccepted(options.runId, workItemId, acceptedCompletion.id, "The platform scorer accepted this exact submission Completion.");
        // A prior recoverable guard may have caused a replan, but the run is
        // solved now; do not report that intermediate guard as the final stop.
        termination = undefined;
        stopReason = "solved";
        break;
      }
      // AgentHarness already applies the configured Provider retry policy inside
      // one prompt. A terminal Provider error (for example 402 balance exhausted
      // or 401 invalid credentials) therefore cannot make progress on a later
      // competition turn. Retrying it up to maxTurns previously produced 24
      // identical paid/failed requests per challenge.
      if (outcome.stopReason === "error") {
        termination = outcome.errorMessage?.trim() || "Provider request failed";
        stopReason = "provider_error";
        await failCompetitionWorkItem(services.control, options.runId, workItemId, "Provider request failed");
        break;
      }
      if (mode() === "assist" && Object.values(snapshot.completions).some((completion) => completion.purpose === "submission"
        && completion.runId === snapshot.runId && completion.generation === snapshot.generation)) {
        await coordinator.setDomainPhase(options.runId, "REPRODUCE");
        stopReason = "held_for_approval";
        await blockCompetitionWorkItem(services.control, options.runId, workItemId, "Completion is waiting for operator approval.");
        break;
      }
      if (outcome.termination === "budget_exhausted" || outcome.termination === "deadline_exhausted") {
        termination = outcome.termination;
        stopReason = "deadline";
        await failCompetitionWorkItem(services.control, options.runId, workItemId, outcome.termination);
        break;
      }
      if (outcome.termination) {
        if (shouldReplanAfterTurnGuard(outcome.termination) && guardReplans < MAX_GUARD_REPLANS) {
          // A guard only stopped the current provider turn. Keep the same lane
          // and durable session, but make the next prompt an explicit evidence-
          // summary/replan instead of the generic "continue" nudge.
          guardReplans += 1;
          forceReplan = true;
          replanReason = outcome.termination;
          await blockAndQueueCompetitionWorkItem(services.control, options.runId, options.task, workItemId, outcome.termination, turns);
          workItemId = undefined;
          continue;
        }
        termination = outcome.termination;
        stopReason = "terminated";
        await failCompetitionWorkItem(services.control, options.runId, workItemId, outcome.termination);
        break;
      }
    }
    if (stopReason === "max_turns" && workItemId) {
      await failCompetitionWorkItem(services.control, options.runId, workItemId, `No verified completion after ${maxTurns} model turns.`);
    }
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    removeAbortListener?.();
    if (lane) {
      try {
        await lane.close();
      } catch {
        // Lane teardown is best-effort; the environment is released by the caller.
      }
    }
  }

  const finalSnapshot = await services.control.snapshot(options.runId);
  return {
    runId: options.runId,
    turns,
    solved: hasAcceptedPlatformSubmission(finalSnapshot),
    heldForApproval: stopReason === "held_for_approval",
    // Count real platform submissions, not every completion: `verify_claim` also
    // proposes completions and never contacts the platform, so counting those
    // would inflate the wrong-submission number the rules use as a tiebreaker.
    submissions: Object.values(finalSnapshot.effects).filter((effect) => effect.operation === "fixture_score").length,
    stopReason,
    ...(lastText ? { lastText } : {}),
    ...(termination ? { termination } : {}),
  };
}

/**
 * Claim a durable executor work item before each provider turn.  A lease that
 * survived a process restart can be reclaimed after expiry; an active lease
 * owned by this lane is reused so a normal multi-turn conversation does not
 * create duplicate work nodes.
 */
export async function claimCompetitionWorkItem(control: AppServices["control"], runId: string, task: TaskContract, turn: number): Promise<string> {
  return (await new RunCoordinator(control).claim(runId, task, turn)).id;
}

export async function commitCompetitionSuccess(control: AppServices["control"], verifier: AppServices["verifier"], runId: string, workItemId: string | undefined, snapshot: RunSnapshot): Promise<void> {
  const completion = Object.values(snapshot.completions).find((item) => item.status === "ACCEPTED");
  if (!completion) throw new Error("Cannot commit competition success without an accepted completion");
  if (isTerminal(snapshot.status)) return;
  await new RunCoordinator(control, verifier).finishAccepted(runId, workItemId, completion.id, "Platform accepted the candidate and verifier evidence covers the completion.");
}

async function failCompetitionWorkItem(control: AppServices["control"], runId: string, workItemId: string | undefined, reason: string): Promise<void> {
  await new RunCoordinator(control).fail(runId, workItemId, reason);
}
async function blockCompetitionWorkItem(control: AppServices["control"], runId: string, workItemId: string | undefined, reason: string): Promise<void> {
  await new RunCoordinator(control).block(runId, workItemId, reason);
}

async function blockAndQueueCompetitionWorkItem(control: AppServices["control"], runId: string, task: TaskContract, workItemId: string | undefined, reason: string, turn: number): Promise<void> {
  await new RunCoordinator(control).blockAndQueue(runId, task, workItemId, reason, turnGuardFailureCategory(reason) ?? "wrong_hypothesis");
  void turn;
}

/**
 * Solved means the PLATFORM accepted, so an accepted completion is not enough on
 * its own: require a real `fixture_score` effect too. `verify_claim` also
 * produces completions, and before this check a local reproduction could report a
 * challenge as solved with the platform never contacted.
 */
export function hasAcceptedPlatformSubmission(snapshot: RunSnapshot): boolean {
  return acceptedPlatformCompletion(snapshot) !== undefined;
}

function acceptedPlatformCompletion(snapshot: RunSnapshot): RunSnapshot["completions"][string] | undefined {
  if (["FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"].includes(snapshot.status)) return undefined;
  return Object.values(snapshot.completions).find((completion) => {
    if (completion.purpose !== "submission" || completion.status !== "ACCEPTED"
      || completion.runId !== snapshot.runId || completion.generation !== snapshot.generation
      || completion.evidenceIds.length === 0) return false;
    return completion.evidenceIds.every((evidenceId) => {
      const evidence = snapshot.evidence[evidenceId];
      const effect = evidence?.provenance.effect ? snapshot.effects[evidence.provenance.effect.id] : undefined;
      const verdict = effect?.verification;
      return evidence?.kind === "reproduction"
        && evidence.provenance.recordedBy === "verifier"
        && evidence.supports.includes(completion.id)
        && effect?.operation === "fixture_score"
        && verdict?.valid === true
        && verdict.accepted === true
        && verdict.completionId === completion.id
        && verdict.candidateHash === completion.candidateHash
        && verdict.candidateArtifactId === completion.artifactId
        && verdict.generation === completion.generation;
    });
  });
}

export function countSubmissions(snapshot: RunSnapshot): number {
  return Object.values(snapshot.effects).filter((effect) => effect.operation === "fixture_score").length;
}

/**
 * Number of turns without a single submission after which the loop injects a
 * hard replan directive. In the failed CH-10662 run the model spent dozens of
 * tool calls inside one provider turn rewriting the same broken parser without
 * ever calling submit_flag or reconsidering its hypothesis. A single mid-run
 * kick that the model cannot miss is much cheaper than waiting for every outer
 * turn-level stall breaker.
 */
const REPLAN_NUDGE_AFTER_TURNS = 12;
const MAX_GUARD_REPLANS = 2;

/**
 * The turn prompt. Turn 1 states the challenge; later turns are a short nudge,
 * because the lane keeps the full conversation and restating the task every turn
 * would both waste the cached prefix and invite the model to restart its
 * analysis from scratch.
 *
 * After REPLAN_NUDGE_AFTER_TURNS turns without any submission attempt, the
 * regular continue-nudge is replaced by an explicit stop-and-replan directive.
 * That is the ONE place we override the caching-friendly short nudge, because
 * a model that has run twelve turns of the same failing approach won't
 * self-correct from a generic "continue".
 */
export function turnPrompt(task: TaskContract, turn: number, workspaceRoot: string, progress: { submissionsSoFar: number; forceReplan?: boolean; previousTermination?: string; domainPhase?: string; remainingToolCalls?: number; remainingDeadlineMs?: number; actionBundle?: ActionBundle } = { submissionsSoFar: 0 }): string {
  const phaseLine = progress.domainPhase
    ? `Durable phase: ${progress.domainPhase}. Treat this as a bounded phase step; do not restart the entire analysis.`
    : "Treat this as one bounded phase step; do not restart the entire analysis.";
  const budgetLine = progress.remainingToolCalls === undefined
    ? "Every tool call must produce a new fact, evidence item, or candidate check."
    : `Remaining effect budget: ${Math.max(0, progress.remainingToolCalls)}. Every tool call must produce a new fact, evidence item, or candidate check.`;
  const deadlineLine = progress.remainingDeadlineMs === undefined
    ? undefined
    : `Remaining deadline: ${Math.ceil(Math.max(0, progress.remainingDeadlineMs) / 1000)} seconds. Prioritize one concrete observation, evidence item, or verifier-ready candidate before broadening the search.`;
  const actionBundleLine = progress.actionBundle
    ? `Action bundle ${progress.actionBundle.id}: ${progress.actionBundle.objective} Tools: ${progress.actionBundle.toolNames.join(", ")}. Preconditions: ${progress.actionBundle.preconditions.join("; ")}. Success: ${progress.actionBundle.successCriteria.join("; ")}. Failure: ${progress.actionBundle.failureCriteria.join("; ")}. Max calls: ${progress.actionBundle.maxCalls}.`
    : undefined;
  if (turn > 1) {
    if (progress.forceReplan || (progress.submissionsSoFar === 0 && turn > REPLAN_NUDGE_AFTER_TURNS)) {
      return [phaseLine, actionBundleLine, deadlineLine, budgetLine, replanNudge(task.target_kind, turn, progress.previousTermination)].filter((line): line is string => Boolean(line)).join("\n");
    }
    return [phaseLine, actionBundleLine, deadlineLine, budgetLine, "Continue from where you left off. Do not restart the analysis or re-read what you already have; take the next concrete step, and call submit_flag once you have derived the flag."].filter((line): line is string => Boolean(line)).join("\n");
  }
  const lines = [phaseLine, actionBundleLine, deadlineLine, budgetLine, task.objective.trim()].filter((line): line is string => Boolean(line));
  if (task.target.startsWith("REMOTE:")) {
    lines.push(`\nLive target: ${task.target.slice("REMOTE:".length)} (also in connection-info.txt).`);
  }
  lines.push(`\nChallenge files are in ${workspaceRoot.replace(/\\/g, "/")}. Solve it and submit the flag with submit_flag.`);
  lines.push(`Task inputs (read-only, relative to this challenge workspace): ${task.inputs.map((input) => input.path).join(", ") || "none listed; inspect only the current workspace"}.`);
  lines.push("Do not search the ProofBlade install root, skills library, runs/, or parent directories for challenge answers; those are framework resources, not target data.");
  return lines.join("\n");
}
function replanNudge(kind: TargetKind, turn: number, previousTermination?: string): string {
  const lines = [
    `[ProofBlade replan checkpoint — turn ${turn}${previousTermination ? ` after ${previousTermination}` : " without a submit_flag call"}]`,
    "The current strategy has consumed many turns without producing a flag. Stop iterating on the same exploit or parser: it is either wrong or blocked on a hypothesis you have not questioned.",
    "In THIS turn:",
    "1. Write ONE short paragraph naming the strongest evidence you have and the assumption your current approach depends on.",
    "2. State the alternative hypothesis you have been avoiding.",
    "3. Take a single concrete action against that alternative (a new probe, a new decode, a different tool) — do not resume the previous strategy.",
    "Rules of thumb:",
    "- If a parser has silently produced empty results twice, distrust the string constants first, not the transport. Save raw recv bytes to a file and `xxd` them before writing another regex.",
    "- Chinese/CJK banners on the wire are usually GBK, not UTF-8. Reconstruct anchors from actual bytes, not from how the tool echo looks in your view.",
    "- If external network probes keep failing but the target host works, that is the egress gateway enforcing target-only policy, not a broken tool.",
    "- Have you been re-deriving facts you already proved? That means you did not persist them. Write confirmed findings to a notes file (`/workspace/NOTES.md`) and read it back instead of re-probing; for a durable searchable record use `evidence record` on an `A-*` anchor.",
  ];
  if (kind === "pwn") {
    lines.push("- For pwn: re-run `checksec`, `file`, and (if remote-only) capture 4KB of the banner into a file before touching the exploit script again.");
  } else if (kind === "web") {
    lines.push("- For web: re-issue `curl -sSikL` against the root and check Server/X-Powered-By/Set-Cookie headers before adding another payload variant.");
  } else if (kind === "reverse") {
    lines.push("- For reverse: open the target in the decompiler MCP if you have not, and work from pseudocode instead of another objdump pass.");
  }
  return lines.join("\n");
}
// Failure recovery policy is centralized in domain/failure-policy.ts.
