import { join } from "node:path";
import type { TaskContract } from "../domain/types.js";
import { id, sha256 } from "../domain/utils.js";
import { JsonlControlStore } from "../storage/jsonl-store.js";
import { ControlStore } from "../control/control-store.js";
import { ArtifactStore } from "../effects/artifact-store.js";
import { EffectJournal } from "../effects/effect-journal.js";
import { LocalFixtureSandbox } from "../sandbox/fixture.js";
import type { ProofBladeConfig } from "../config.js";

export interface AppServices {
  control: ControlStore;
  artifacts: ArtifactStore;
  journal: EffectJournal;
  sandbox: LocalFixtureSandbox;
  runsRoot: string;
}

export function createServices(root: string, config: ProofBladeConfig): AppServices {
  const runsRoot = join(root, config.storage.runsDir);
  const control = new ControlStore(new JsonlControlStore(runsRoot));
  const artifacts = new ArtifactStore(runsRoot, control);
  const sandbox = new LocalFixtureSandbox(join(root, config.storage.fixturesDir));
  const journal = new EffectJournal(control, artifacts, sandbox);
  return { control, artifacts, journal, sandbox, runsRoot };
}

export function demoTask(runId: string, root: string, config: ProofBladeConfig): TaskContract {
  return {
    schema_version: 1,
    task_id: runId,
    mode: "ctf_solve",
    target_kind: "misc",
    target: "LOCAL_FIXTURE",
    objective: "Locate the synthetic flag, preserve the observation, and verify it twice.",
    inputs: [],
    success_criteria: [
      "The candidate is supported by an immutable artifact.",
      "Two reproduction observations agree.",
      "The final report references evidence ids.",
    ],
    verification: { kind: "reproduction", required_reproductions: 2 },
    scope: { allowed_hosts: ["LOCAL_FIXTURE"], allowed_ports: [], external_network: false, allowed_workspace: join(root, config.storage.runsDir, runId) },
    pause_policy: ["scope_change", "credential_required", "irreversible_external_effect"],
    constraints: { deadline_ms: 300_000, max_cost_usd: 0, max_tool_calls: 20, max_submissions: 2 },
  };
}

export async function runDemo(root: string, runId: string, config: ProofBladeConfig): Promise<{ runId: string; flag: string }> {
  const services = createServices(root, config);
  const task = demoTask(runId, root, config);
  await services.control.createRun(runId, task);
  await services.control.dispatch(runId, { type: "start_phase", phase: "reconnaissance" });
  await services.control.dispatch(runId, {
    type: "intent",
    intent: { id: "I-001", title: "Inspect fixture", description: "Read the local target and preserve its output.", phase: "reconnaissance", status: "CLAIMED", priority: 10, ownerLane: "executor" },
    lane: "executor",
  });
  const fixture = await services.sandbox.build(task);
  const generation = await services.sandbox.reset(fixture);
  await services.control.dispatch(runId, { type: "fixture_reset", generation });
  const readCommand = process.platform === "win32" ? "type challenge.txt" : "cat challenge.txt";
  const first = await services.journal.execute(runId, { tool: "fixture_read", args: { path: "challenge.txt", generation, attempt: 1 }, replayPolicy: "pure", command: readCommand, cwd: fixture.path });
  const flag = first.result.stdout.match(/PB\{[^}\r\n]+\}/)?.[0];
  if (!flag) throw new Error("Demo fixture produced no flag candidate");
  const evidenceOne = id("EV");
  await services.control.dispatch(runId, {
    type: "evidence",
    evidence: { id: evidenceOne, kind: "observation", summary: "The fixture contains a ProofBlade flag candidate.", source: { tool: "fixture_read", effectId: first.effectId, artifactId: first.artifactId, generation }, confidence: 0.95, supports: ["H-001"], refutes: [] },
    lane: "executor",
  });
  await services.control.dispatch(runId, {
    type: "hypothesis",
    hypothesis: { id: "H-001", statement: "The candidate in challenge.txt is the fixture solution.", status: "OPEN", evidenceIds: [evidenceOne] },
    lane: "executor",
  });
  await services.control.dispatch(runId, { type: "start_phase", phase: "verification", lane: "verifier" });
  const verifyCommand = process.platform === "win32" ? "findstr /C:\"PB{\" challenge.txt" : "grep -F 'PB{' challenge.txt";
  const second = await services.journal.execute(runId, { tool: "fixture_verify", args: { path: "challenge.txt", generation, attempt: 2 }, replayPolicy: "pure", command: verifyCommand, cwd: fixture.path });
  const evidenceTwo = id("EV");
  await services.control.dispatch(runId, {
    type: "evidence",
    evidence: { id: evidenceTwo, kind: "reproduction", summary: "An independent match reproduced the same candidate.", source: { tool: "fixture_verify", effectId: second.effectId, artifactId: second.artifactId, generation }, confidence: 1, supports: ["H-001", "F-001"], refutes: [] },
    lane: "verifier",
  });
  await services.control.dispatch(runId, {
    type: "hypothesis",
    hypothesis: { id: "H-001", statement: "The candidate in challenge.txt is the fixture solution.", status: "CONFIRMED", evidenceIds: [evidenceOne, evidenceTwo] },
    lane: "verifier",
  });
  await services.control.dispatch(runId, {
    type: "fact",
    fact: { id: "F-001", statement: `Verified candidate hash: ${sha256(flag)}`, status: "CONFIRMED", evidenceIds: [evidenceOne, evidenceTwo] },
    lane: "verifier",
  });
  await services.control.dispatch(runId, {
    type: "intent",
    intent: { id: "I-001", title: "Inspect fixture", description: "Read the local target and preserve its output.", phase: "reconnaissance", status: "DONE", priority: 10, ownerLane: "executor" },
    lane: "executor",
  });
  await services.control.dispatch(runId, { type: "start_phase", phase: "report" });
  await services.artifacts.putText(runId, [
    "# ProofBlade demo report",
    "",
    `Candidate: ${flag}`,
    `Evidence: ${evidenceOne}, ${evidenceTwo}`,
    `Fixture generation: ${generation}`,
  ].join("\n"), { filename: "report.md", mime: "text/markdown", sensitivity: "flag_candidate" });
  await services.control.dispatch(runId, { type: "finish", verified: true, evidenceIds: [evidenceOne, evidenceTwo], reason: "Two local reproductions agree.", lane: "verifier" });
  return { runId, flag };
}
