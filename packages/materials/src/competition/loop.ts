import { join } from "node:path";
import type { ProofBladeConfig } from "../config.js";
import type { AppServices } from "../app/demo.js";
import type { ExecutionMode, RunSnapshot, TaskContract } from "../domain/types.js";
import { PiCodingLane } from "../runtime/coding-lane.js";
import type { AgentLanePort } from "../runtime/pi-adapter.js";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";

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
 * This replaces SingleAgentCtfLoop for competition play. The reason is not
 * preference: the solver lane's tools are read-only proxies over a synthetic
 * fixture, so it cannot run a real exploit, script a solve, or drive a
 * decompiler MCP — which is what every real challenge needs. The coding lane has
 * real bash/read/edit/write plus first-class MCP tools and the on-disk skills
 * library, and (since submit_flag) a platform submission path.
 *
 * Kept from the old loop: bounded turns, deadline enforcement, abort wiring, and
 * assist-mode stop-before-submitting. Dropped: phase/planner choreography and
 * verifier orchestration, because submit_flag now performs the submission inline
 * and returns the verdict to the model in the same turn.
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

  try {
    lane = await createLane({
      runId: options.runId,
      projectRoot: options.workspaceRoot,
      installRoot: options.installRoot,
      runDir,
      controlStore: services.control,
      artifactStore: services.artifacts,
      journal: services.journal,
      config,
      // The fleet's per-challenge toggle is read on every submission, so flipping
      // auto/assist mid-run takes effect without rebuilding the lane.
      mode: () => (mode() === "assist" ? "assist" : "auto"),
      // Bound a single blocking command. A real run hung one bash call for 30+
      // minutes, which in a fleet idles a worker slot for the whole time; long work
      // belongs in shell_background instead.
      bashTimeoutSecondsMax: options.bashTimeoutSecondsMax ?? 180,
      ...(options.executionEnv ? { executionEnv: options.executionEnv } : {}),
      ...(options.workspaceRootForPrompt ? { workspaceRootForPrompt: options.workspaceRootForPrompt } : {}),
      ...(options.skillsLibraryPathForPrompt ? { skillsLibraryPathForPrompt: options.skillsLibraryPathForPrompt } : {}),
      ...(options.executionPlatform ? { executionPlatform: options.executionPlatform } : {}),
      ...(options.hostWorkspaceRootForMcp ? { hostWorkspaceRootForMcp: options.hostWorkspaceRootForMcp } : {}),
    });
    const activeLane = lane;
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
      if (Date.now() - startedAt >= deadlineMs) {
        stopReason = "deadline";
        break;
      }
      turns += 1;
      const outcome = await activeLane.prompt(turnPrompt(options.task, turns, options.workspaceRootForPrompt ?? options.workspaceRoot));
      lastText = outcome.text || lastText;
      termination = outcome.termination ?? termination;
      const snapshot = await services.control.snapshot(options.runId);
      if (accepted(snapshot)) {
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
        break;
      }
      if (mode() === "assist" && Object.keys(snapshot.completions).length > 0) {
        stopReason = "held_for_approval";
        break;
      }
      if (outcome.termination === "budget_exhausted" || outcome.termination === "deadline_exhausted") {
        stopReason = "deadline";
        break;
      }
      if (outcome.termination) {
        stopReason = "terminated";
        break;
      }
    }
  } finally {
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
    solved: accepted(finalSnapshot),
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
 * Solved means the PLATFORM accepted, so an accepted completion is not enough on
 * its own: require a real `fixture_score` effect too. `verify_claim` also
 * produces completions, and before this check a local reproduction could report a
 * challenge as solved with the platform never contacted.
 */
function accepted(snapshot: RunSnapshot): boolean {
  if (!Object.values(snapshot.completions).some((completion) => completion.status === "ACCEPTED")) return false;
  const submitted = Object.values(snapshot.effects).some((effect) => effect.operation === "fixture_score");
  return submitted;
}

/**
 * The turn prompt. Turn 1 states the challenge; later turns are a short nudge,
 * because the lane keeps the full conversation and restating the task every turn
 * would both waste the cached prefix and invite the model to restart its
 * analysis from scratch.
 */
function turnPrompt(task: TaskContract, turn: number, workspaceRoot: string): string {
  if (turn > 1) {
    return "Continue from where you left off. Do not restart the analysis or re-read what you already have; take the next concrete step, and call submit_flag once you have derived the flag.";
  }
  const lines = [task.objective.trim()];
  if (task.target.startsWith("REMOTE:")) {
    lines.push(`\nLive target: ${task.target.slice("REMOTE:".length)} (also in connection-info.txt).`);
  }
  lines.push(`\nChallenge files are in ${workspaceRoot.replace(/\\/g, "/")}. Solve it and submit the flag with submit_flag.`);
  return lines.join("\n");
}
