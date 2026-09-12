import assert from "node:assert/strict";
import test from "node:test";
import { generalTaskFromLegacy, createCognitiveSnapshot, createSafetySnapshot, assertGeneralTaskContract, type GeneralTaskContract, type LegacyTaskContract } from "../src/domain/general-task-contract.js";
import type { TaskContract } from "../src/domain/types.js";
import { createInitialSnapshot } from "../src/control/reducer.js";

function task(overrides: Partial<GeneralTaskContract> = {}): GeneralTaskContract {
  return {
    schemaVersion: 1,
    taskId: "GENERAL-001",
    title: "Inspect the project",
    kind: "coding",
    domainTags: ["documentation"],
    target: "LOCAL_WORKSPACE:D:/work/project",
    objective: "Read the project and summarize the configuration.",
    inputs: [],
    successCriteria: ["The summary names the relevant configuration."],
    scope: { allowedHosts: [], allowedPorts: [], externalNetwork: false, allowedWorkspace: "D:/work/project" },
    pausePolicy: ["credential_required"],
    constraints: { deadlineMs: 60_000, maxCostUsd: 1, maxToolCalls: 20 },
    verification: { kind: "none", required: false },
    enabledCapabilities: { enabled: ["filesystem.read", "process.exec"] },
    contextPolicy: { scope: "run", recallMode: "summary_first" },
    cognitivePolicy: "advisory",
    ...overrides,
  };
}

const legacy: LegacyTaskContract = {
  schema_version: 1,
  task_id: "LEGACY-001",
  mode: "ctf_solve",
  target_kind: "web",
  target: "FIXTURE:web",
  objective: "Inspect the fixture.",
  inputs: [],
  success_criteria: ["An independent verifier accepts the result."],
  verification: { kind: "hidden_scorer", required_reproductions: 2 },
  scope: { allowed_hosts: ["LOCAL_FIXTURE"], allowed_ports: [], external_network: false, allowed_workspace: "runs/LEGACY-001" },
  pause_policy: ["scope_change"],
  constraints: { deadline_ms: 300_000, max_cost_usd: 0, max_tool_calls: 20, max_submissions: 3 },
};

test("a generic task without a verifier is valid and has independent plane snapshots", () => {
  const general = task();
  assert.doesNotThrow(() => assertGeneralTaskContract(general));
  assert.equal(general.verification.required, false);

  const safety = createSafetySnapshot(general);
  const cognitive = createCognitiveSnapshot(general);
  assert.equal(safety.fingerprint.length, 64);
  assert.equal(cognitive.fingerprint.length, 64);
});

test("domain tags cannot change a task safety or cognitive snapshot", () => {
  const baseline = task({ domainTags: ["documentation"] });
  const tagged = task({ domainTags: ["pwn"] });
  assert.equal(createSafetySnapshot(baseline).fingerprint, createSafetySnapshot(tagged).fingerprint);
  assert.equal(createCognitiveSnapshot(baseline).fingerprint, createCognitiveSnapshot(tagged).fingerprint);

  const changedScope = task({ scope: { ...baseline.scope, externalNetwork: true } });
  assert.notEqual(createSafetySnapshot(baseline).fingerprint, createSafetySnapshot(changedScope).fingerprint);
});

test("legacy CTF tasks project to a generic contract without preserving a CTF mode", () => {
  const projected = generalTaskFromLegacy(legacy);
  assert.equal(projected.kind, "evaluation");
  assert.deepEqual(projected.domainTags, ["web"]);
  assert.equal(projected.target, legacy.target);
  assert.deepEqual(projected.verification, { kind: "rubric", required: true, successCriteria: legacy.success_criteria });
  assert.equal("mode" in projected, false);
  assert.doesNotThrow(() => assertGeneralTaskContract(projected));
});

test("new Run snapshots persist the generic task and independent policy planes", () => {
  const snapshot = createInitialSnapshot(legacy.task_id, legacy as TaskContract);
  const projected = generalTaskFromLegacy(legacy);
  assert.deepEqual(snapshot.generalTask, projected);
  assert.deepEqual(snapshot.safetySnapshot, createSafetySnapshot(projected));
  assert.deepEqual(snapshot.cognitiveSnapshot, createCognitiveSnapshot(projected));

  const retagged = createInitialSnapshot("LEGACY-002", { ...legacy, task_id: "LEGACY-002", target_kind: "pwn" } as TaskContract);
  assert.notDeepEqual(retagged.generalTask?.domainTags, snapshot.generalTask?.domainTags);
  assert.equal(retagged.safetySnapshot?.fingerprint, snapshot.safetySnapshot?.fingerprint);
  assert.equal(retagged.cognitiveSnapshot?.fingerprint, snapshot.cognitiveSnapshot?.fingerprint);
});

test("generic contracts reject domain-dependent safety and invalid verification", () => {
  assert.throws(() => assertGeneralTaskContract(task({ domainTags: ["ctf" as never] })), /domain tags/);
  assert.throws(() => assertGeneralTaskContract(task({ target: "" })), /target/);
  assert.throws(() => assertGeneralTaskContract(task({ verification: { kind: "none", required: true } })), /cannot be required/);
  assert.throws(() => assertGeneralTaskContract(task({ enabledCapabilities: { enabled: ["filesystem.read"], disabled: ["filesystem.read"] } })), /both enabled and disabled/);
});
