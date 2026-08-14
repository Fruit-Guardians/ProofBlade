import { join } from "node:path";
import type { ProofBladeConfig } from "../config.js";
import type { TargetKind, TaskContract } from "../domain/types.js";
import type { CompetitionChallengeSummary, CompetitionEnvironment } from "./api.js";

/** Map a normalized competition category onto the harness TargetKind. */
function targetKindForCategory(summary: CompetitionChallengeSummary): TargetKind {
  switch (summary.normalizedCategory) {
    case "web":
      return "web";
    case "reverse":
      return "reverse";
    case "pwn":
      return "pwn";
    case "crypto":
      return "crypto";
    default:
      return "misc";
  }
}

/**
 * Build a TaskContract for a live competition challenge.
 *
 * Differs from `fixtureTask` in three deliberate ways, all driven by the fact
 * that the platform — not a local scorer — is the judge:
 *  - verification.kind = "platform_submission" (the dormant enum), so scoring is
 *    a single real API submission rather than local reproduction.
 *  - required_reproductions = 1, so a correct flag is never submitted twice
 *    (which would inflate the wrong-submission tiebreaker or hit "already solved").
 *  - external_network = true and the live connection host is in scope.
 */
export function competitionTask(
  runId: string,
  summary: CompetitionChallengeSummary,
  env: CompetitionEnvironment,
  root: string,
  config: ProofBladeConfig,
): TaskContract {
  const workspace = join(root, config.storage.runsDir, runId);
  const objectiveParts = [summary.title, summary.description].filter((part): part is string => Boolean(part && part.trim()));
  const objective = objectiveParts.join("\n\n") || `Solve competition challenge ${summary.challengeId}.`;
  const connection = env.connectionInfo?.trim();

  return {
    schema_version: 1,
    task_id: runId,
    mode: "ctf_solve",
    target_kind: targetKindForCategory(summary),
    target: connection ? `REMOTE:${connection}` : `CHALLENGE:${summary.challengeId}`,
    objective,
    inputs: [],
    success_criteria: [
      "Submit a flag the platform accepts.",
      "The submitted flag is anchored by a recorded observation or a platform-provided value.",
    ],
    verification: { kind: "platform_submission", required_reproductions: 1 },
    scope: {
      allowed_hosts: connection ? [connection] : [`CHALLENGE:${summary.challengeId}`],
      allowed_ports: [],
      external_network: true,
      allowed_workspace: workspace,
    },
    pause_policy: ["scope_change", "credential_required", "irreversible_external_effect"],
    constraints: {
      deadline_ms: deadlineFromExpiry(env.expiresAt),
      max_cost_usd: 0,
      // Journaled effects only — coding-lane bash/read/edit/write and first-class
      // MCP calls do not pass through the journal, so this bounds capability
      // invocations, artifact reads, and fixture_score. Real runs have exceeded 130
      // tool calls, so a 40-effect ceiling risked failing a solve on bookkeeping.
      max_tool_calls: 200,
      max_submissions: 5,
    },
  };
}

/** Derive a run deadline from the environment expiry, with a sane default. */
function deadlineFromExpiry(expiresAt: number | undefined): number {
  const fallback = 600_000;
  if (!expiresAt || !Number.isFinite(expiresAt)) return fallback;
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return fallback;
  return Math.min(remaining, 3_600_000);
}
