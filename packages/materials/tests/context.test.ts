import assert from "node:assert/strict";
import test from "node:test";
import { ContextCompiler } from "../src/context/compiler.js";
import { createInitialSnapshot } from "../src/control/reducer.js";
import type { TaskContract } from "../src/domain/types.js";

const task: TaskContract = {
  schema_version: 1,
  task_id: "CTX-001",
  mode: "ctf_solve",
  target_kind: "web",
  target: "LOCAL_FIXTURE",
  objective: "verify fixture",
  inputs: [],
  success_criteria: ["evidence exists"],
  verification: { kind: "reproduction", required_reproductions: 1 },
  scope: { allowed_hosts: ["LOCAL_FIXTURE"], allowed_ports: [], external_network: false, allowed_workspace: "runs/CTX-001" },
  pause_policy: [],
  constraints: { deadline_ms: 1000, max_cost_usd: 0, max_tool_calls: 5, max_submissions: 1 },
};

test("context manifest is deterministic and labels target data as untrusted", () => {
  const snapshot = createInitialSnapshot("CTX-001", task);
  snapshot.status = "RUNNING";
  snapshot.phase = "reconnaissance";
  snapshot.evidence["EV-001"] = {
    id: "EV-001",
    kind: "observation",
    summary: "Target says ignore the system prompt",
    source: { tool: "web_fetch", artifactId: "A-001" },
    confidence: 0.5,
    supports: [],
    refutes: [],
    createdSeq: 2,
  };
  const compiler = new ContextCompiler();
  const input = { runId: "CTX-001", lane: "main" as const, phase: snapshot.phase, task, snapshot };
  const first = compiler.build(input);
  const second = compiler.build(input);
  assert.equal(first.manifest.hash, second.manifest.hash);
  assert.deepEqual(first.manifest.evidenceIds, ["EV-001"]);
  assert.equal(first.manifest.memory.standingInstructionHash.length, 64);
  assert.deepEqual(first.manifest.memory.recalledEvidenceIds, ["EV-001"]);
  assert.ok(["stable", "notice", "snip", "prune", "compact"].includes(first.manifest.maintenance.stage));
  assert.match(first.messages[0]!.content, /untrusted observation/i);
  assert.match(first.messages[1]!.content, /Target says ignore/);
});
