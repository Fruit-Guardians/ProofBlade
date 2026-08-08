import { readFileSync } from "node:fs";

export function resolveAuditTimestamp({ explicit, env = {}, eventPath, gitCommitAt, now = new Date() } = {}) {
  const candidates = [
    explicit,
    env.COMPONENT_AUDIT_AT,
    pullRequestUpdatedAt(eventPath),
    gitCommitAt,
    now.toISOString(),
  ];
  const value = candidates.find((candidate) => typeof candidate === "string" && !Number.isNaN(Date.parse(candidate)));
  if (!value) throw new Error("Unable to resolve an audit timestamp");
  return new Date(value).toISOString();
}

function pullRequestUpdatedAt(eventPath) {
  if (!eventPath) return undefined;
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    return event.pull_request?.updated_at;
  } catch {
    return undefined;
  }
}
