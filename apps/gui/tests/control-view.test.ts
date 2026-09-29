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

test("the GUI does not show recovery debt a rule-less task can never pay", () => {
  // The request keeps RECOVERY_REQUIRED from before the contract was understood to
  // bind no verification rule, and the panel used to list it as outstanding work
  // forever (reconcile clears the durable state, but a read-only view must not depend
  // on someone having run it).
  const ruleLess: TaskContract = { ...task, task_id: "GUI-CONTROL-NO-RULE", verification: { kind: "reproduction", required_reproductions: 0 } };
  const snapshot = createInitialSnapshot(ruleLess.task_id, ruleLess);
  snapshot.verificationRequests["VR-1"] = {
    id: "VR-1",
    runId: snapshot.runId,
    generation: 0,
    kind: "claim",
    key: "k",
    createdSeq: 1,
    recoveryState: "RECOVERY_REQUIRED",
    recoveryReason: "Completion is proposed but no verifier Effect is durable yet.",
  } as never;
  assert.deepEqual(buildRunControlView(snapshot).recovery, { required: 0, items: [] });

  // With a rule-bound task the same persisted state is real work and stays visible.
  const boundSnapshot = createInitialSnapshot(task.task_id, task);
  boundSnapshot.verificationRequests["VR-1"] = { ...snapshot.verificationRequests["VR-1"]!, runId: boundSnapshot.runId } as never;
  const bound = buildRunControlView(boundSnapshot).recovery;
  assert.equal(bound.required, 1);
  assert.equal(bound.items.length, 1);
});

test("GUI control projection is read-only and exposes blocked gate plus budgets", () => {
  const snapshot = createInitialSnapshot(task.task_id, task);
  const view = buildRunControlView(snapshot);
  assert.equal(view.domainPhase, "INTAKE");
  assert.equal(view.gate.status, "blocked");
  assert.deepEqual(view.gate.missing, ["current-generation-tool-preparation"]);
  assert.equal(view.budget.journaledEffectsRemaining, 5, "the cap counts Effect Journal entries, not tool calls");
  assert.equal(view.budget.submissionsRemaining, 1);
  assert.equal(view.budget.replansUsed, 0);
  assert.equal(view.budget.replanLimit, 2);
  assert.equal(view.nextAction, undefined);
  assert.deepEqual(view.recovery, { required: 0, items: [] });
});
