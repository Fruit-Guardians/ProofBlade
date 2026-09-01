import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProofBladeConfig } from "../src/config.js";
import { createServices, demoTask } from "../src/app/demo.js";
import { sha256 } from "../src/domain/utils.js";
import { fixtureTask } from "../src/app/fixture-task.js";
import { projectionHash } from "../src/control/reducer.js";
import { listFixtureProfiles } from "../src/sandbox/fixture-catalog.js";
import { SingleAgentCtfLoop, type AgentLaneFactory } from "../src/orchestration/single-agent-loop.js";
import { RunCoordinator } from "../src/orchestration/run-coordinator.js";
import { IndependentVerifier } from "../src/verification/verifier.js";
import { CodingClaimVerifier } from "../src/verification/claim-verification.js";
import { PiCodingLane } from "../src/runtime/coding-lane.js";
import type { SessionRuntimeCreateBroker } from "../src/recovery/session-resource-adapter.js";

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

test("local Run prompt carries the remaining deadline into the single coding lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-deadline-prompt-"));
  let promptText = "";
  const services = createServices(root, config);
  let phaseAtLaneCreation: { domainPhase: string; phase: string } | undefined;
  const lane: AgentLaneFactory = async ({ services: laneServices, runId }) => {
    const snapshot = await laneServices.control.snapshot(runId);
    phaseAtLaneCreation = { domainPhase: snapshot.domainPhase, phase: snapshot.phase };
    return {
      async prompt(text) {
        promptText = text;
        return { text: "no candidate yet", stopReason: "stop", usage: zeroUsage() };
      },
      async compact() {},
      async abort() {},
      async isIdle() { return true; },
      async close() {},
    };
  };
  try {
    const runId = "DEADLINE-PROMPT-web-source-1";
    const result = await new SingleAgentCtfLoop(root, config, services, lane).run({
      runId,
      task: fixtureTask(runId, "web-source-1", root, config),
      mode: "auto",
      maxTurns: 1,
    });
    assert.equal(result.status, "EXHAUSTED");
    assert.deepEqual(phaseAtLaneCreation, { domainPhase: "RECON", phase: "reconnaissance" });
    assert.match(promptText, /Remaining deadline: \d+ seconds/);
    assert.match(promptText, /Task inputs \(read-only, relative to the current challenge workspace\):/);
    assert.match(promptText, /Do not search the ProofBlade install root/);
  } finally {
    await services.sandbox.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("single-agent CTF loop forwards configured session runtime brokers to its lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-loop-session-runtime-"));
  const services = createServices(root, config, { sessionRuntimeBrokers: [sessionRuntimeBroker()], sessionRuntimeRequired: true, browserRuntimeRequired: true });
  let received: unknown;
  const lane: AgentLaneFactory = async ({ services: laneServices }) => {
    received = laneServices;
    return {
      async prompt() { return { text: "bounded turn", stopReason: "stop", usage: zeroUsage() }; },
      async compact() {},
      async abort() {},
      async isIdle() { return true; },
      async close() {},
    };
  };
  try {
    const runId = "SESSION-RUNTIME-FORWARD-web-source-1";
    await new SingleAgentCtfLoop(root, config, services, lane).run({
      runId,
      task: fixtureTask(runId, "web-source-1", root, config),
      mode: "auto",
      maxTurns: 1,
    });
    assert.equal(received && "sessionRuntimeRequired" in received, true);
    assert.equal((received as { sessionRuntimeRequired: boolean }).sessionRuntimeRequired, true);
    assert.equal((received as { browserRuntimeRequired: boolean }).browserRuntimeRequired, true);
    assert.equal((received as { sessionRuntimeBrokers: readonly SessionRuntimeCreateBroker[] }).sessionRuntimeBrokers[0]?.name, "test-runtime");
  } finally {
    await services.sandbox.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("required Browser runtime fails closed before creating a browser task lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-loop-browser-runtime-required-"));
  const services = createServices(root, config, { browserRuntimeRequired: true });
  const runId = "BROWSER-RUNTIME-REQUIRED-web-source-1";
  const baseTask = fixtureTask(runId, "web-source-1", root, config);
  const task = {
    ...baseTask,
    verification: {
      ...baseTask.verification,
      web: { flag_pattern: "PB\\{[^}]+\\}", transport: "browser" as const },
    },
  };
  try {
    await services.control.createRun(runId, task);
    const claimVerifier = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
    await assert.rejects(() => PiCodingLane.create({
      runId,
      projectRoot: root,
      installRoot: root,
      runDir: join(services.runsRoot, runId),
      controlStore: services.control,
      artifactStore: services.artifacts,
      journal: services.journal,
      claimVerifier,
      config,
      browserRuntimeRequired: true,
    }), /Browser runtime broker is configured but unavailable/);
  } finally {
    await services.sandbox.close();
    await rm(root, { recursive: true, force: true });
  }
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
      const replayed = await services.control.replay(runId);
      assert.equal(projectionHash(snapshot), projectionHash(replayed), `${profile.id} replay projection must match the live snapshot`);
      const events = await readFile(join(root, "runs", runId, "events.jsonl"), "utf8");
      const domainPhases = events.trim().split(/\r?\n/)
        .map((line) => JSON.parse(line) as { type: string; payload?: { domainPhase?: string } })
        .filter((event) => event.type === "domain_phase_changed")
        .map((event) => event.payload?.domainPhase);
      assert.deepEqual(domainPhases, ["RECON", "REPRODUCE", "REPORT", "SUBMIT"], profile.id);
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

test("[contract:deadline-cleanup] a stuck lane close cannot extend run completion indefinitely", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-stuck-lane-close-"));
  const services = createServices(root, config);
  const lane: AgentLaneFactory = async () => ({
    async prompt() { return { text: "bounded turn", stopReason: "stop", usage: zeroUsage() }; },
    async compact() {},
    async abort() {},
    async isIdle() { return false; },
    async close() { await new Promise<void>(() => undefined); },
  });
  try {
    const started = Date.now();
    const result = await new SingleAgentCtfLoop(root, config, services, lane).run({
      runId: "STUCK-CLOSE-web-source-1",
      task: fixtureTask("STUCK-CLOSE-web-source-1", "web-source-1", root, config),
      mode: "auto",
      maxTurns: 1,
    });
    assert.ok(Date.now() - started < 5_000);
    assert.equal(result.status, "EXHAUSTED");
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

test("attachment-backed reproduction completion finishes through RunCoordinator without fixture_score", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-workspace-reproduction-"));
  const workspace = join(root, ".proofblade-workspaces", "WORKSPACE-REPRO");
  const command = process.platform === "win32" ? "type attachments\\answer.txt" : "cat attachments/answer.txt";
  const candidate = "PB{workspace_reproduction}";
  await mkdir(join(workspace, "attachments"), { recursive: true });
  await writeFile(join(workspace, "attachments", "answer.txt"), `${candidate}\n`, "utf8");
  await writeFile(join(workspace, "challenge.md"), "workspace reproduction\n", "utf8");
  const task = {
    schema_version: 1 as const,
    task_id: "WORKSPACE-REPRO",
    mode: "ctf_solve" as const,
    target_kind: "misc" as const,
    target: "LOCAL_WORKSPACE:misc",
    objective: "Derive the candidate from the attachment.",
    inputs: [{ path: "attachments/answer.txt", sha256: sha256(candidate + "\n"), read_only: true }],
    success_criteria: ["Task-owned command derives the candidate."],
    verification: { kind: "reproduction" as const, command, required_reproductions: 1 },
    scope: { allowed_hosts: [], allowed_ports: [], external_network: false, allowed_workspace: workspace },
    pause_policy: [],
    constraints: { deadline_ms: 300_000, max_cost_usd: 0, max_tool_calls: 40, max_submissions: 0 },
  };
  try {
    const services = createServices(root, config);
    const lane: AgentLaneFactory = async ({ claimVerifier, fixture, runId }) => ({
      async prompt() {
        await claimVerifier.record({ candidate, command, cwd: fixture.path, toolCallId: `${runId}-verify` });
        return { text: `verified ${candidate}`, stopReason: "stop", usage: zeroUsage() };
      },
      async compact() {},
      async abort() {},
      async isIdle() { return true; },
      async close() {},
    });
    const result = await new SingleAgentCtfLoop(root, config, services, lane).run({ runId: task.task_id, task, mode: "auto", maxTurns: 1 });
    const snapshot = await services.control.snapshot(task.task_id);
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(snapshot.domainPhase, "SUBMIT");
    assert.equal(snapshot.finalResult?.completionId, result.completionId);
    assert.ok(Object.values(snapshot.effects).some((effect) => effect.operation === "claim_reproduction" && effect.producerLane === "verifier"));
    assert.equal(Object.values(snapshot.effects).some((effect) => effect.operation === "fixture_score"), false);
    assert.ok(Object.values(snapshot.artifacts).some((artifact) => artifact.path.endsWith("report.md")));
    assert.ok(Object.values(snapshot.evidence).every((evidence) => evidence.provenance.generation === snapshot.generation));
    await services.sandbox.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unexpected coding lane failure terminalizes the Run for replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-lane-failure-terminal-"));
  const services = createServices(root, config);
  const failingLane: AgentLaneFactory = async () => ({
    async prompt() { throw new Error("provider stream failed"); },
    async compact() {},
    async abort() {},
    async isIdle() { return true; },
    async close() {},
  });
  try {
    const runId = "LANE-FAILURE-web-source-1";
    await assert.rejects(
      new SingleAgentCtfLoop(root, config, services, failingLane).run({
        runId,
        task: fixtureTask(runId, "web-source-1", root, config),
        mode: "auto",
        maxTurns: 1,
      }),
      /provider stream failed/,
    );
    const snapshot = await services.control.snapshot(runId);
    assert.equal(snapshot.status, "FAILED");
    assert.equal(snapshot.failureCategory, "effect_outcome_unknown");
    assert.match(snapshot.terminalReason ?? "", /Coding lane failed/);
  } finally {
    await services.sandbox.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a terminal Provider error stops after one turn and keeps its provider classification", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-provider-error-terminal-"));
  const services = createServices(root, config);
  let prompts = 0;
  const failingProviderLane: AgentLaneFactory = async () => ({
    async prompt() {
      prompts += 1;
      return { text: "", stopReason: "error", errorMessage: "Connection error.", usage: zeroUsage() };
    },
    async compact() {},
    async abort() {},
    async isIdle() { return true; },
    async close() {},
  });
  try {
    const runId = "PROVIDER-ERROR-web-source-1";
    const result = await new SingleAgentCtfLoop(root, config, services, failingProviderLane).run({
      runId,
      task: fixtureTask(runId, "web-source-1", root, config),
      mode: "auto",
      maxTurns: 3,
    });
    const snapshot = await services.control.snapshot(runId);
    assert.equal(prompts, 1);
    assert.equal(result.status, "FAILED");
    assert.equal(snapshot.failureCategory, "provider_error");
    assert.equal(snapshot.terminalReason, "Connection error.");
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
    const coordinator = new RunCoordinator(services.control, services.verifier);
    const workItem = await coordinator.claim(runId, task, 1);
    await coordinator.settle(runId, workItem.id, true, verified.evidenceIds, [acceptedArtifact.id]);
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

function sessionRuntimeBroker(): SessionRuntimeCreateBroker {
  return {
    name: "test-runtime",
    kind: "pwn-session",
    inspect: async () => ({ status: "UNKNOWN", binding: "UNKNOWN" }),
    adopt: async () => ({ state: "UNKNOWN" }),
    release: async () => ({ released: false }),
    health: async () => ({
      status: "READY",
      capabilities: { kinds: ["pwn-session"], maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576, stableAcrossRestart: true },
    }),
    create: async () => ({ schemaVersion: 1, operation: "create", state: "UNKNOWN", summary: "test broker" }),
    createBinding: async () => { throw new Error("test broker does not create bindings"); },
  };
}
