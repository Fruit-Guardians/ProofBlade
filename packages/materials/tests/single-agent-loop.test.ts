import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "../src/config.js";
import { createServices } from "../src/app/demo.js";
import { fixtureTask } from "../src/app/fixture-task.js";
import { listFixtureProfiles } from "../src/sandbox/fixture-catalog.js";
import { SingleAgentCtfLoop, type SolverLaneFactory } from "../src/orchestration/single-agent-loop.js";
import { SOLVER_PROTOCOL_INSTRUCTIONS } from "../src/runtime/version.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "TEST_API_KEY",
      contextWindow: 4096,
      maxTokens: 512,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      input: ["text"],
    },
  },
};

const deterministicLane: SolverLaneFactory = async ({ runtime }) => ({
  async prompt() {
    const inspected = await runtime.inspectTarget();
    const candidate = inspected.output.match(/PB\{[^}\r\n]+\}/)?.[0];
    if (!candidate) throw new Error("Fixture contains no candidate");
    await runtime.proposeHypothesis({ statement: "The observed candidate satisfies the fixture.", evidenceIds: [inspected.evidenceId] });
    await runtime.submitCandidate(candidate);
    return {
      text: "candidate proposed",
      stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
  },
  async compact() {},
  async abort() {},
  async isIdle() { return true; },
  async close() {},
});

test("auto mode solves all three web and three reverse fixtures through the verifier gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-fixtures-"));
  try {
    const services = createServices(root, config);
    for (const profile of listFixtureProfiles()) {
      const runId = `AUTO-${profile.id}`;
      const loop = new SingleAgentCtfLoop(root, config, services, deterministicLane);
      const result = await loop.run({ runId, task: fixtureTask(runId, profile.id, root, config), mode: "auto", maxTurns: 1 });
      assert.equal(result.status, "SUCCEEDED", profile.id);
      assert.equal(result.phase, "report", profile.id);
      const snapshot = await services.control.snapshot(runId);
      assert.equal(Object.keys(snapshot.observations).length, 1, profile.id);
      assert.equal(Object.values(snapshot.evidence).filter((item) => item.kind === "reproduction").length, 2, profile.id);
      assert.equal(Object.values(snapshot.completions)[0]?.status, "ACCEPTED", profile.id);
      assert.ok(Object.values(snapshot.artifacts).some((item) => item.path.endsWith("report.md")), profile.id);
      const events = await readFile(join(root, "runs", runId, "events.jsonl"), "utf8");
      assert.doesNotMatch(events, new RegExp(escapeRegExp(profile.expected)), `${profile.id} leaked its candidate into the event log`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assist mode pauses before verification and resumes from the durable proposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-assist-"));
  try {
    const services = createServices(root, config);
    const runId = "ASSIST-web-source-1";
    const loop = new SingleAgentCtfLoop(root, config, services, deterministicLane);
    const task = fixtureTask(runId, "web-source-1", root, config);
    const first = await loop.run({ runId, task, mode: "assist", maxTurns: 1 });
    assert.equal(first.status, "PAUSED");
    assert.equal(Object.values((await services.control.snapshot(runId)).completions)[0]?.status, "PROPOSED");
    const resumed = await loop.run({ runId, task, mode: "assist", maxTurns: 1 });
    assert.equal(resumed.status, "SUCCEEDED");
    assert.equal(resumed.turns, 0);
    assert.equal(Object.values((await services.control.snapshot(runId)).completions)[0]?.status, "ACCEPTED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completion proposals must be grounded in a successful current-generation observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-grounding-"));
  try {
    const services = createServices(root, config);
    const runId = "GROUND-web-source-1";
    const task = fixtureTask(runId, "web-source-1", root, config);
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.control.dispatch(runId, { type: "fixture_reset", generation });
    const { ProofBladeToolRuntime } = await import("../src/tools/runtime.js");
    const runtime = new ProofBladeToolRuntime(runId, fixture, services.runsRoot, services.control, services.artifacts, services.journal);
    await runtime.inspectTarget();
    await assert.rejects(runtime.submitCandidate("PB{fabricated_value}"), /does not occur in a successful target observation/);
    assert.equal(Object.keys((await services.control.snapshot(runId)).completions).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate grounding accepts challenge-specific answer formats", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-generic-candidate-"));
  try {
    const services = createServices(root, config);
    const runId = "GENERIC-web-source-1";
    const task = fixtureTask(runId, "web-source-1", root, config);
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.control.dispatch(runId, { type: "fixture_reset", generation });
    await writeFile(join(fixture.path, "generic-answer.txt"), "answer-42\n", "utf8");
    const { ProofBladeToolRuntime } = await import("../src/tools/runtime.js");
    const runtime = new ProofBladeToolRuntime(runId, fixture, services.runsRoot, services.control, services.artifacts, services.journal);
    try {
      await runtime.inspectTarget();
      const proposed = await runtime.submitCandidate("answer-42");
      assert.match(proposed.candidateHash, /^[a-f0-9]{64}$/);
      assert.equal((await services.control.snapshot(runId)).completions[proposed.completionId]?.status, "PROPOSED");
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto mode preserves route freedom and redirects a stalled turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-autonomy-"));
  try {
    const prompts: string[] = [];
    const idleLane: SolverLaneFactory = async () => ({
      async prompt(prompt) {
        prompts.push(prompt);
        return {
          text: "No action taken.",
          stopReason: "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
      },
      async compact() {},
      async abort() {},
      async isIdle() { return true; },
      async close() {},
    });
    const services = createServices(root, config);
    const runId = "AUTONOMY-web-source-1";
    const loop = new SingleAgentCtfLoop(root, config, services, idleLane);
    const result = await loop.run({ runId, task: fixtureTask(runId, "web-source-1", root, config), mode: "auto", maxTurns: 2 });

    assert.equal(result.status, "EXHAUSTED");
    assert.equal(prompts.length, 2);
    assert.match(prompts[0]!, /choose your own analysis method/i);
    assert.match(prompts[1]!, /previous turn made no durable progress/i);
    assert.match(prompts[1]!, /materially different route/i);
    assert.doesNotMatch(prompts.join("\n"), /inspect_target|PB\{/);
    const protocol = SOLVER_PROTOCOL_INSTRUCTIONS.join("\n");
    assert.match(protocol, /no fixed tool sequence is required/i);
    assert.doesNotMatch(protocol, /Call inspect_target|PB\{/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
