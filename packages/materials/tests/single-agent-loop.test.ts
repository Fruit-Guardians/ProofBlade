import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "../src/config.js";
import { createServices, demoTask } from "../src/app/demo.js";
import { sha256 } from "../src/domain/utils.js";
import { fixtureTask } from "../src/app/fixture-task.js";
import { listFixtureProfiles } from "../src/sandbox/fixture-catalog.js";
import { SingleAgentCtfLoop, type AgentLaneFactory } from "../src/orchestration/single-agent-loop.js";
import { IndependentVerifier } from "../src/verification/verifier.js";

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

const deterministicLane: AgentLaneFactory = async ({ runtime }) => ({
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
    const finalSnapshot = await services.control.snapshot(runId);
    assert.equal(Object.values(finalSnapshot.completions)[0]?.status, "ACCEPTED");
    assert.ok(Object.values(finalSnapshot.workItems).some((item) => item.status === "SUCCEEDED"), "approval resume must settle the blocked work item");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto mode preserves a pause raised during a turn instead of exhausting the run", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pause-during-turn-"));
  try {
    const services = createServices(root, config);
    const runId = "PAUSE-TURN-web-source-1";
    const task = fixtureTask(runId, "web-source-1", root, config);
    const pausingLane: AgentLaneFactory = async ({ services: laneServices }) => ({
      async prompt() {
        await laneServices.control.dispatch(runId, { type: "pause", reason: "test pause", lane: "executor" });
        return {
          text: "paused",
          stopReason: "aborted",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 } },
        };
      },
      async compact() {},
      async abort() {},
      async isIdle() { return true; },
      async close() {},
    });
    const result = await new SingleAgentCtfLoop(root, config, services, pausingLane).run({ runId, task, mode: "auto", maxTurns: 1 });
    assert.equal(result.status, "PAUSED");
    assert.equal(result.turns, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:provider-budget-exhaustion] a Provider budget termination ends the Run before another model turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-provider-budget-exhaustion-"));
  try {
    const services = createServices(root, config);
    let prompts = 0;
    const budgetLane: AgentLaneFactory = async () => ({
      async prompt() {
        prompts += 1;
        return { text: "", stopReason: "error", errorMessage: "Provider cost budget exhausted", termination: "budget_exhausted", usage: zeroUsage() };
      },
      async compact() {},
      async abort() {},
      async isIdle() { return true; },
      async close() {},
    });
    const runId = "PROVIDER-BUDGET-web-source-1";
    const result = await new SingleAgentCtfLoop(root, config, services, budgetLane).run({
      runId,
      task: fixtureTask(runId, "web-source-1", root, config),
      mode: "auto",
      maxTurns: 3,
    });
    assert.equal(prompts, 1);
    assert.equal(result.status, "EXHAUSTED");
    assert.match((await services.control.snapshot(runId)).terminalReason ?? "", /cost budget/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:abort-after-planner-before-prompt] [contract:sandbox-close-after-run-failure] aborting in Planner prevents a new model request and permits Sandbox cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-abort-after-planner-"));
  const services = createServices(root, config);
  const controller = new AbortController();
  let prompts = 0;
  let aborts = 0;
  const originalDispatch = services.control.dispatch.bind(services.control);
  services.control.dispatch = async (runId, command) => {
    const events = await originalDispatch(runId, command);
    if (command.type === "handoff_accepted") controller.abort();
    return events;
  };
  const lane: AgentLaneFactory = async () => ({
    async prompt() { prompts += 1; return { text: "unexpected", stopReason: "stop", usage: zeroUsage() }; },
    async compact() {},
    async abort() { aborts += 1; },
    async isIdle() { return true; },
    async close() {},
  });
  try {
    const runId = "ABORT-PLANNER-web-source-1";
    const task = fixtureTask(runId, "web-source-1", root, config);
    await assert.rejects(
      new SingleAgentCtfLoop(root, config, services, lane).run({ runId, task, mode: "auto", maxTurns: 1, signal: controller.signal }),
      /aborted/i,
    );
    assert.equal(prompts, 0);
    assert.equal(aborts, 1);
    assert.notEqual((await services.control.snapshot(runId)).status, "EXHAUSTED");
  } finally {
    await services.sandbox.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:abort-before-verification] aborting after Prompt leaves the candidate unverified", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-abort-before-verification-"));
  const services = createServices(root, config);
  const controller = new AbortController();
  let prompts = 0;
  const lane: AgentLaneFactory = async ({ runtime }) => ({
    async prompt() {
      prompts += 1;
      const inspected = await runtime.inspectTarget();
      const candidate = inspected.output.match(/PB\{[^}\r\n]+\}/)?.[0];
      assert.ok(candidate);
      await runtime.submitCandidate(candidate);
      controller.abort();
      return { text: "candidate proposed", stopReason: "stop", usage: zeroUsage() };
    },
    async compact() {},
    async abort() {},
    async isIdle() { return true; },
    async close() {},
  });
  try {
    const runId = "ABORT-VERIFY-web-source-1";
    const task = fixtureTask(runId, "web-source-1", root, config);
    await assert.rejects(
      new SingleAgentCtfLoop(root, config, services, lane).run({ runId, task, mode: "auto", maxTurns: 1, signal: controller.signal }),
      /aborted/i,
    );
    const snapshot = await services.control.snapshot(runId);
    assert.equal(prompts, 1);
    assert.equal(Object.values(snapshot.completions)[0]?.status, "PROPOSED");
    assert.equal(Object.values(snapshot.evidence).filter((item) => item.kind === "reproduction").length, 0);
    assert.notEqual(snapshot.status, "EXHAUSTED");
  } finally {
    await services.sandbox.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:pause-during-verifier] pause during verifier remains PAUSED instead of completing successfully", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pause-during-verifier-"));
  const services = createServices(root, config);
  const originalExecute = services.sandbox.execute.bind(services.sandbox);
  let pauseDuringScore = true;
  services.sandbox.execute = async (input, signal) => {
    const result = await originalExecute(input, signal);
    if (pauseDuringScore && input.operation === "fixture_score") {
      pauseDuringScore = false;
      await services.control.dispatch(String(input.args.runId), { type: "pause", reason: "paused during verifier", lane: "verifier" });
    }
    return result;
  };
  const lane: AgentLaneFactory = async ({ runtime }) => ({
    async prompt() {
      const inspected = await runtime.inspectTarget();
      const candidate = inspected.output.match(/PB\{[^}\r\n]+\}/)?.[0];
      assert.ok(candidate);
      await runtime.submitCandidate(candidate);
      return { text: "candidate proposed", stopReason: "stop", usage: zeroUsage() };
    },
    async compact() {},
    async abort() {},
    async isIdle() { return true; },
    async close() {},
  });
  try {
    const runId = "PAUSE-VERIFIER-web-source-1";
    const result = await new SingleAgentCtfLoop(root, config, services, lane).run({ runId, task: fixtureTask(runId, "web-source-1", root, config), mode: "auto", maxTurns: 1 });
    assert.equal(result.status, "PAUSED");
    assert.equal((await services.control.snapshot(runId)).status, "PAUSED");
  } finally {
    await services.sandbox.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:pause-before-finish] an atomically persisted pause wins the race with successful finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pause-before-finish-"));
  const services = createServices(root, config);
  const originalVerifier = services.verifier;
  let finishAttempts = 0;
  services.verifier = {
    ...originalVerifier,
    async finish(runId, input) {
      finishAttempts += 1;
      await services.control.dispatch(runId, { type: "pause", reason: "pause won finish race", lane: "main" });
      return await originalVerifier.finish(runId, input);
    },
  };
  try {
    const runId = "PAUSE-FINISH-web-source-1";
    const result = await new SingleAgentCtfLoop(root, config, services, deterministicLane).run({
      runId,
      task: fixtureTask(runId, "web-source-1", root, config),
      mode: "auto",
      maxTurns: 1,
    });
    const snapshot = await services.control.snapshot(runId);
    assert.equal(finishAttempts, 1);
    assert.equal(result.status, "PAUSED");
    assert.equal(snapshot.status, "PAUSED");
    assert.equal(Object.values(snapshot.completions)[0]?.status, "ACCEPTED");
  } finally {
    await services.sandbox.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:pause-before-exhaust] an atomically persisted pause wins the race with budget exhaustion", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pause-before-exhaust-"));
  const services = createServices(root, config);
  const originalDispatch = services.control.dispatch.bind(services.control);
  let exhaustAttempts = 0;
  services.control.dispatch = async (runId, command) => {
    if (command.type === "exhaust") {
      exhaustAttempts += 1;
      await originalDispatch(runId, { type: "pause", reason: "pause won exhaust race", lane: "main" });
    }
    return await originalDispatch(runId, command);
  };
  const idleLane: AgentLaneFactory = async () => ({
    async prompt() { return { text: "no candidate", stopReason: "stop", usage: zeroUsage() }; },
    async compact() {},
    async abort() {},
    async isIdle() { return true; },
    async close() {},
  });
  try {
    const runId = "PAUSE-EXHAUST-web-source-1";
    const result = await new SingleAgentCtfLoop(root, config, services, idleLane).run({
      runId,
      task: fixtureTask(runId, "web-source-1", root, config),
      mode: "auto",
      maxTurns: 1,
    });
    assert.equal(exhaustAttempts, 1);
    assert.equal(result.status, "PAUSED");
    assert.equal((await services.control.snapshot(runId)).status, "PAUSED");
  } finally {
    await services.sandbox.close();
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
    await services.fixtureControl.reset(runId, generation);
    const { ProofBladeToolRuntime } = await import("../src/tools/runtime.js");
    const runtime = new ProofBladeToolRuntime(runId, fixture, services.runsRoot, services.control, services.artifacts, services.journal);
    await runtime.inspectTarget();
    await assert.rejects(runtime.submitCandidate("PB{fabricated_value}"), /does not occur in a successful target observation/);
    assert.equal(Object.keys((await services.control.snapshot(runId)).completions).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal reopen projects the exact finalResult completion instead of a newer unrelated proposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-final-result-reopen-"));
  const services = createServices(root, config);
  try {
    const runId = "FINAL-RESULT-REOPEN";
    const task = demoTask(runId, root, config);
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    await services.fixtureControl.assertResetAllowed(runId);
    const generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);

    const acceptedArtifact = await services.artifacts.putText(runId, "PB{evidence_first}", { filename: "accepted.txt", sensitivity: "flag_candidate" });
    await services.control.dispatch(runId, {
      type: "completion_proposed",
      completion: { id: "C-FINAL", purpose: "harness_verification", candidateHash: sha256("PB{evidence_first}"), artifactId: acceptedArtifact.id },
    });
    const unrelatedArtifact = await services.artifacts.putText(runId, "PB{unrelated_newer}", { filename: "unrelated.txt", sensitivity: "flag_candidate" });
    await services.control.dispatch(runId, {
      type: "completion_proposed",
      completion: { id: "C-NEWER", purpose: "harness_verification", candidateHash: sha256("PB{unrelated_newer}"), artifactId: unrelatedArtifact.id },
    });

    const verified = await new IndependentVerifier(services.control, services.artifacts, services.verifierJournal, services.runsRoot, services.verifier)
      .verify(runId, { ...fixture, generation }, "C-FINAL");
    assert.equal(verified.accepted, true);
    await services.verifier.finish(runId, { completionId: "C-FINAL", reason: "terminal reopen projection regression" });

    const neverCreateLane: AgentLaneFactory = async () => { throw new Error("terminal reopen must not create a lane"); };
    const reopened = await new SingleAgentCtfLoop(root, config, services, neverCreateLane).run({ runId, task, mode: "auto" });
    const snapshot = await services.control.snapshot(runId);
    assert.equal(reopened.status, "SUCCEEDED");
    assert.equal(reopened.completionId, "C-FINAL");
    assert.deepEqual(reopened.evidenceIds, snapshot.finalResult?.evidenceIds);
    assert.equal(snapshot.completions["C-NEWER"]?.status, "PROPOSED");
  } finally {
    await services.sandbox.close();
    await rm(root, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
