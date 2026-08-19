import { join } from "node:path";
import { isIP } from "node:net";
import type { ProofBladeConfig } from "../config.js";
import type { TargetKind, TaskContract } from "../domain/types.js";
import { CompetitionChallengeError, type CompetitionChallengeSummary, type CompetitionEnvironment } from "./api.js";
import type { ContainerTarget, ContainerTargetProtocol } from "../container/contracts.js";

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
  const targets = parseCompetitionTargets(connection);

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
      allowed_hosts: targets.length > 0 ? targets.map((target) => target.host) : connection ? [] : [`CHALLENGE:${summary.challengeId}`],
      allowed_ports: [...new Set(targets.map((target) => target.port))],
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

/** Extract concrete remote endpoints from platform connection text. */
export function parseCompetitionTargets(connectionInfo: string | undefined): ContainerTarget[] {
  if (!connectionInfo?.trim()) return [];
  const found = new Map<string, ContainerTarget>();
  const add = (rawHost: string, rawPort: string | undefined, protocol: ContainerTargetProtocol, source: "explicit" | "generic" = "explicit"): void => {
    const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
    const port = rawPort ? Number(rawPort) : undefined;
    const ipVersion = isIP(host);
    if (ipVersion === 6) throw new CompetitionChallengeError(`IPv6 competition targets are not supported by the target-only Docker gateway: ${host}`);
    if (!host || (!ipVersion && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host))) return;
    if (!port || !Number.isInteger(port) || port < 1 || port > 65535) return;
    const key = `${protocol}:${host}:${port}`;
    if (source === "generic" && [...found.values()].some((item) => item.host === host && item.port === port)) return;
    if (!found.has(key)) found.set(key, { host, port, protocol });
  };
  for (const match of connectionInfo.matchAll(/\b(https?|tcp|udp):\/\/(\[[^\]]+\]|[^/\s:]+)(?::(\d{1,5}))?/gi)) {
    const protocol = match[1].toLowerCase() === "udp" ? "udp" : "tcp";
    const port = match[3] ?? (match[1].toLowerCase() === "https" ? "443" : match[1].toLowerCase() === "http" ? "80" : undefined);
    add(match[2], port, protocol);
  }
  for (const match of connectionInfo.matchAll(/\b(?:nc|ncat)\s+(?:(?:-[a-z]*u[a-z]*|--udp)\s+)+((?:\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\s+(\d{1,5})\b/gi)) add(match[1], match[2], "udp");
  for (const match of connectionInfo.matchAll(/\b(?:nc|ncat)\s+(?!-u\b|--udp\b)((?:\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\s+(\d{1,5})\b/gi)) add(match[1], match[2], "tcp");
  for (const match of connectionInfo.matchAll(/\b(?:socat)\s+(?:[^\s]+\s+)*(TCP|UDP):((?:\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):(\d{1,5})\b/gi)) add(match[2], match[3], match[1].toLowerCase() === "udp" ? "udp" : "tcp");
  for (const match of connectionInfo.matchAll(/\b(?:telnet|socat)\s+((?:\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\s+(\d{1,5})\b/gi)) add(match[1], match[2], "tcp");
  for (const match of connectionInfo.matchAll(/\b((?:\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):(\d{1,5})\b/gi)) {
    if (/^(?:tcp|udp)$/i.test(match[1])) continue;
    const prefix = connectionInfo.slice(0, match.index ?? 0);
    if (/(?:^|\s)(?:tcp|udp):[\d.]*$/i.test(prefix)) continue;
    add(match[1], match[2], "tcp", "generic");
  }
  return [...found.values()];
}

/** Derive a run deadline from the environment expiry, with a sane default. */
function deadlineFromExpiry(expiresAt: number | undefined): number {
  const fallback = 600_000;
  if (!expiresAt || !Number.isFinite(expiresAt)) return fallback;
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return fallback;
  return Math.min(remaining, 3_600_000);
}
