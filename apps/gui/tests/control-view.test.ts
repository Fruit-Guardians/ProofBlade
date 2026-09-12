import assert from "node:assert/strict";
import test from "node:test";
import { createInitialSnapshot } from "@proofblade/materials";
import type { TaskContract } from "@proofblade/materials";
import { buildRunControlView } from "../src/control-view.js";

const task: TaskContract = {
  schema_version: 1,
  task_id: "GUI-CONTROL-001",
  mode: "vulnerability_discovery",
  target_kind: "web",
  target: "fixture",
  objective: "inspect",
  inputs: [],
  success_criteria: ["evidence"],
  verification: { kind: "reproduction", required_reproductions: 1 },
  scope: { allowed_hosts: ["fixture"], allowed_ports: [], external_network: false, allowed_workspace: "runs/GUI-CONTROL-001" },
  pause_policy: [],
  constraints: { deadline_ms: 1000, max_cost_usd: 0, max_tool_calls: 5, max_submissions: 1 },
};

test("GUI control projection is read-only and exposes blocked gate plus budgets", () => {
  const snapshot = createInitialSnapshot(task.task_id, task);
  const view = buildRunControlView(snapshot);
  assert.equal(view.domainPhase, "INTAKE");
  assert.equal(view.gate.status, "blocked");
  assert.deepEqual(view.gate.missing, ["current-generation-tool-preparation"]);
  assert.equal(view.budget.runToolCallsRemaining, 5);
  assert.equal(view.budget.submissionsRemaining, 1);
  assert.equal(view.budget.replansUsed, 0);
  assert.equal(view.budget.replanLimit, 2);
  assert.equal(view.nextAction, undefined);
  assert.deepEqual(view.recovery, { required: 0, items: [] });
});
