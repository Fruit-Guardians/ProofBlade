import { join } from "node:path";
import type { ProofBladeConfig } from "../config.js";
import type { AppServices } from "../app/demo.js";
import type { ExecutionMode, RunSnapshot, TargetKind, TaskContract } from "../domain/types.js";
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
  let forceReplan = false;
  let replanReason: string | undefined;
  let guardReplans = 0;

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
      const preTurnSnapshot = await services.control.snapshot(options.runId);
      const submissionsSoFar = countSubmissions(preTurnSnapshot);
      const prompt = turnPrompt(options.task, turns, options.workspaceRootForPrompt ?? options.workspaceRoot, {
        submissionsSoFar,
        forceReplan,
        previousTermination: replanReason,
      });
      forceReplan = false;
      replanReason = undefined;
      const outcome = await activeLane.prompt(prompt);
      lastText = outcome.text || lastText;
      termination = outcome.termination ?? termination;
      const snapshot = await services.control.snapshot(options.runId);
      if (accepted(snapshot)) {
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
        if (isRecoverableTurnGuard(outcome.termination) && guardReplans < MAX_GUARD_REPLANS) {
          // A guard only stopped the current provider turn. Keep the same lane
          // and durable session, but make the next prompt an explicit evidence-
          // summary/replan instead of the generic "continue" nudge.
          guardReplans += 1;
          forceReplan = true;
          replanReason = outcome.termination;
          continue;
        }
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

function countSubmissions(snapshot: RunSnapshot): number {
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
export function turnPrompt(task: TaskContract, turn: number, workspaceRoot: string, progress: { submissionsSoFar: number; forceReplan?: boolean; previousTermination?: string } = { submissionsSoFar: 0 }): string {
  if (turn > 1) {
    if (progress.forceReplan || (progress.submissionsSoFar === 0 && turn > REPLAN_NUDGE_AFTER_TURNS)) {
      return replanNudge(task.target_kind, turn, progress.previousTermination);
    }
    return "Continue from where you left off. Do not restart the analysis or re-read what you already have; take the next concrete step, and call submit_flag once you have derived the flag.";
  }
  const lines = [task.objective.trim()];
  if (task.target.startsWith("REMOTE:")) {
    lines.push(`\nLive target: ${task.target.slice("REMOTE:".length)} (also in connection-info.txt).`);
  }
  lines.push(`\nChallenge files are in ${workspaceRoot.replace(/\\/g, "/")}. Solve it and submit the flag with submit_flag.`);
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

function isRecoverableTurnGuard(reason: string): boolean {
  return reason === "experiment_budget" || reason === "no_progress" || reason === "repeated_tool_failure" || reason === "tool_failure_storm";
}
