import { join } from "node:path";
import type { ProofBladeConfig } from "../config.js";
import type { TaskContract } from "../domain/types.js";
import { getFixtureProfile } from "../sandbox/fixture-catalog.js";

export function fixtureTask(runId: string, profileId: string, root: string, config: ProofBladeConfig): TaskContract {
  const profile = getFixtureProfile(profileId);
  return {
    schema_version: 1,
    task_id: runId,
    mode: "ctf_solve",
    target_kind: profile.targetKind,
    target: `FIXTURE:${profile.id}`,
    objective: profile.description,
    inputs: [],
    success_criteria: [
      "The candidate is supported by an immutable target observation.",
      "The hidden scorer accepts two independent reproduction attempts.",
      "The report references the accepted completion and evidence ids.",
    ],
    verification: { kind: "hidden_scorer", required_reproductions: 2 },
    scope: {
      allowed_hosts: ["LOCAL_FIXTURE"],
      allowed_ports: [],
      external_network: false,
      allowed_workspace: join(root, config.storage.runsDir, runId),
    },
    pause_policy: ["scope_change", "credential_required", "irreversible_external_effect"],
    constraints: { deadline_ms: 300_000, max_cost_usd: 0, max_tool_calls: 20, max_submissions: 3 },
  };
}
