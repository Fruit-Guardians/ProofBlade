import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ProofBladeConfig } from "../src/config.js";
import { createServices } from "../src/app/demo.js";
import { fixtureTask } from "../src/app/fixture-task.js";
import { CheckpointService } from "../src/context/checkpoint.js";
import { DurableCompactionCoordinator } from "../src/context/durable-compaction.js";
import { latestExternalUserMessage } from "../src/context/user-task-anchor.js";
import { AUTOMATIC_CONTEXT_RECOVERY_MARKER } from "../src/runtime/context-length-recovery.js";
import { AUTOMATIC_CONTEXT_RECOVERY_PROMPT } from "../src/context/user-task-anchor.js";
import { repairAgentMessages, toolPairViolations } from "../src/context/agent-pruner.js";
import { LeaseManager } from "../src/control/lease-manager.js";
import { RunRecoveryService } from "../src/recovery/run-recovery.js";
import { SessionRegistry } from "../src/container/session-registry.js";
import { createEffectInput } from "../src/control/control-store.js";

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

test("interruption 1: effect_started before launch reruns once under the original effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-interrupt-start-"));
  try {
    let fired = false;
    const services = createServices(root, config, (point) => {
      if (!fired && point === "after_started") {
        fired = true;
        throw new Error("interrupt-before-launch");
      }
    });
    const runId = "INTERRUPT-EFFECT-START";
    const task = fixtureTask(runId, "reverse-strings-1", root, config);
    await services.control.createRun(runId, task);
    const recovered = await new RunRecoveryService(services.control, services.journal, services.sandbox, services.fixtureControl).recover(runId);
    await assert.rejects(services.journal.execute(runId, {
      operation: "fixture_read",
      args: { path: "strings.txt", generation: recovered.fixture.generation },
      replayPolicy: "pure",
      cwd: recovered.fixture.path,
    }), /interrupt-before-launch/);
    const interrupted = await services.control.snapshot(runId);
    const effect = Object.values(interrupted.effects)[0]!;
    assert.equal(effect.status, "STARTED");
    assert.equal(Object.values(interrupted.artifacts).filter((item) => item.sourceEffectId === effect.id).length, 0);

    assert.deepEqual(await services.journal.reconcile(runId), [effect.id]);
    const finished = await services.control.snapshot(runId);
    assert.equal(finished.effects[effect.id]?.status, "FINISHED");
    assert.equal(Object.values(finished.artifacts).filter((item) => item.sourceEffectId === effect.id).length, 1);
    const stableHash = finished.projectionHash;
    assert.deepEqual(await services.journal.reconcile(runId), []);
    assert.equal((await services.control.snapshot(runId)).projectionHash, stableHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interruption 2: persisted artifact is adopted before effect_finished without rerun", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-interrupt-artifact-"));
  try {
    let fired = false;
    const services = createServices(root, config, (point) => {
      if (!fired && point === "after_artifact") {
        fired = true;
        throw new Error("interrupt-after-artifact");
      }
    });
    const runId = "INTERRUPT-EFFECT-ARTIFACT";
    const task = fixtureTask(runId, "web-source-1", root, config);
    await services.control.createRun(runId, task);
    const recovered = await new RunRecoveryService(services.control, services.journal, services.sandbox, services.fixtureControl).recover(runId);
    await assert.rejects(services.journal.execute(runId, {
      operation: "fixture_inspect",
      args: { generation: recovered.fixture.generation },
      replayPolicy: "pure",
      cwd: recovered.fixture.path,
    }), /interrupt-after-artifact/);
    const interrupted = await services.control.snapshot(runId);
    const effect = Object.values(interrupted.effects)[0]!;
    const artifact = Object.values(interrupted.artifacts).find((item) => item.sourceEffectId === effect.id);
    assert.ok(artifact);
    assert.equal(effect.status, "STARTED");

    await services.journal.reconcile(runId);
    const finished = await services.control.snapshot(runId);
    assert.equal(finished.effects[effect.id]?.artifactId, artifact.id);
    assert.equal(Object.values(finished.artifacts).filter((item) => item.sourceEffectId === effect.id).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interruption 3: assistant tool call persisted before preflight receives an error pair", () => {
  const repaired = repairAgentMessages([toolAssistant([
    { id: "call-before-preflight", name: "inspect_target" },
  ])]);
  assert.deepEqual(toolPairViolations(repaired.messages), []);
  const result = repaired.messages[1];
  assert.equal(result?.role, "toolResult");
  if (result?.role === "toolResult") {
    assert.equal(result.toolCallId, "call-before-preflight");
    assert.equal(result.toolName, "inspect_target");
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /missing \(interrupted\)/);
  }
});

test("interruption 4: partial parallel batch is rebuilt in original call order", () => {
  const messages = [
    toolAssistant([
      { id: "call-a", name: "read_a" },
      { id: "call-b", name: "read_b" },
      { id: "call-c", name: "read_c" },
    ]),
    toolResult("call-c", "read_c", "C"),
    toolResult("call-a", "read_a", "A"),
  ] as AgentMessage[];
  assert.ok(toolPairViolations(messages).some((item) => item.kind === "misordered-result"));
  const repaired = repairAgentMessages(messages);
  assert.deepEqual(toolPairViolations(repaired.messages), []);
  assert.deepEqual(repaired.messages.slice(1).map((message) => message.role === "toolResult" ? message.toolCallId : ""), ["call-a", "call-b", "call-c"]);
  const missing = repaired.messages[2];
  assert.equal(missing?.role, "toolResult");
  if (missing?.role === "toolResult") assert.equal(missing.isError, true);
});

test("interruption 5: mechanical summary survives before Pi Session append and retries cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-interrupt-compact-"));
  try {
    const services = createServices(root, config);
    const runId = "INTERRUPT-COMPACTION";
    await services.control.createRun(runId, fixtureTask(runId, "web-route-2", root, config));
    await services.verifier.dispatch(runId, {
      type: "fact",
      fact: { id: "F-DURABLE", statement: "confirmed state survives compaction interruption", status: "CONFIRMED", evidenceIds: [] },
    });
    const env = new NodeExecutionEnv({ cwd: root });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "pi-sessions") });
    const session = await repo.create({ id: "PI-COMPACTION", cwd: root, metadata: { runId } });
    const firstKeptEntryId = await session.appendMessage({ role: "user", content: "retained turn", timestamp: 1 });
    await session.appendMessage(textAssistant("history to compact"));
    const checkpointService = new CheckpointService(services.control, services.artifacts);
    let fired = false;
    const interrupted = new DurableCompactionCoordinator(checkpointService, (point) => {
      if (!fired && point === "after_checkpoint") {
        fired = true;
        throw new Error("interrupt-before-session-append");
      }
    });
    const preparation = { firstKeptEntryId, tokensBefore: 2048, retainedTail: [] };
    await assert.rejects(interrupted.provide(runId, preparation), /interrupt-before-session-append/);
    assert.equal((await session.getBranch()).filter((entry) => entry.type === "compaction").length, 0);
    const afterFault = await services.control.snapshot(runId);
    const checkpoint = Object.values(afterFault.checkpoints)[0]!;
    assert.equal(Object.keys(afterFault.checkpoints).length, 1);
    assert.equal(afterFault.facts["F-DURABLE"]?.status, "CONFIRMED");

    const compaction = await new DurableCompactionCoordinator(checkpointService).provide(runId, preparation);
    assert.equal(compaction.details.checkpointId, checkpoint.id);
    assert.equal(compaction.details.artifactId, checkpoint.artifactId);
    assert.equal(Object.keys((await services.control.snapshot(runId)).checkpoints).length, 1);
    await session.appendCompaction(compaction.summary, compaction.firstKeptEntryId, compaction.tokensBefore, compaction.details, true, undefined, compaction.retainedTail);
    const reopened = await repo.open(await session.getMetadata());
    const entries = await reopened.getBranch();
    const compacted = entries.filter((entry) => entry.type === "compaction");
    assert.equal(compacted.length, 1);
    assert.equal(compacted[0]?.type === "compaction" ? (compacted[0].details as { checkpointId?: string }).checkpointId : undefined, checkpoint.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:bounded-compaction-tail] mechanical compaction bounds a single oversized tool turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-bounded-compact-"));
  try {
    const services = createServices(root, config);
    const runId = "BOUNDED-COMPACTION";
    await services.control.createRun(runId, fixtureTask(runId, "reverse-branch-2", root, config));
    const checkpointService = new CheckpointService(services.control, services.artifacts);
    const retainedTail = Array.from({ length: 12 }, (_, index) => [
      { role: "assistant", content: [{ type: "toolCall", id: `call-${index}`, name: "inspect_target", arguments: {} }], api: "openai-completions", provider: "test", model: "test", usage: zeroUsage(), stopReason: "toolUse", timestamp: index * 2 },
      { role: "toolResult", toolCallId: `call-${index}`, toolName: "inspect_target", content: [{ type: "text", text: `A-${index} ` + "x".repeat(4_000) }], isError: false, timestamp: index * 2 + 1 },
    ]).flat() as AgentMessage[];
    const compaction = await new DurableCompactionCoordinator(checkpointService).provide(runId, {
      firstKeptEntryId: "entry-1",
      tokensBefore: 20_000,
      retainedTail,
    }, undefined, { maxContextTokens: 4_096 });
    assert.ok(compaction.details.retainedTailTokensAfter < compaction.details.retainedTailTokensBefore);
    assert.ok(compaction.details.retainedTailTokensAfter <= 2_048);
    assert.ok(compaction.details.droppedEntries > 0);
    assert.deepEqual(toolPairViolations(compaction.retainedTail), []);
    assert.match(JSON.stringify(compaction.retainedTail), /call-11/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:compaction-task-anchor] mechanical compaction restores a user request omitted from Pi's retained tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-task-anchor-compact-"));
  try {
    const services = createServices(root, config);
    const runId = "TASK-ANCHOR-COMPACTION";
    await services.control.createRun(runId, fixtureTask(runId, "reverse-branch-2", root, config));
    const checkpointService = new CheckpointService(services.control, services.artifacts);
    const taskAnchor = { role: "user" as const, content: "继续完成逆向并求出 flag", timestamp: 10 };
    const retainedTail = Array.from({ length: 8 }, (_, index) => [
      { role: "assistant", content: [{ type: "toolCall", id: `anchor-call-${index}`, name: "evidence", arguments: {} }], api: "openai-completions", provider: "test", model: "test", usage: zeroUsage(), stopReason: "toolUse", timestamp: index * 2 + 11 },
      { role: "toolResult", toolCallId: `anchor-call-${index}`, toolName: "evidence", content: [{ type: "text", text: `artifact-${index} ` + "x".repeat(2_000) }], isError: false, timestamp: index * 2 + 12 },
    ]).flat() as AgentMessage[];
    const compaction = await new DurableCompactionCoordinator(checkpointService).provide(runId, {
      firstKeptEntryId: "assistant-after-user",
      tokensBefore: 20_000,
      retainedTail,
    }, undefined, { maxContextTokens: 4_096, taskAnchor });
    assert.match(compaction.summary, /## Active user request\n继续完成逆向并求出 flag/);
    assert.equal(compaction.retainedTail.filter((message) => message.role === "user").length, 1);
    assert.match(JSON.stringify(compaction.retainedTail), /继续完成逆向并求出 flag/);
    assert.deepEqual(toolPairViolations(compaction.retainedTail), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:repeated-length-task-anchor] consecutive context recovery keeps the external task anchor", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-repeated-length-anchor-"));
  try {
    const services = createServices(root, config);
    const runId = "REPEATED-LENGTH-ANCHOR";
    await services.control.createRun(runId, fixtureTask(runId, "reverse-branch-2", root, config));
    const checkpointService = new CheckpointService(services.control, services.artifacts);
    const realTask = { role: "user" as const, content: "继续完成固件逆向并求出 flag", timestamp: 10 };
    const recoveryPrompt = { role: "user" as const, content: AUTOMATIC_CONTEXT_RECOVERY_PROMPT, timestamp: 20 };
    const makeTail = (prefix: AgentMessage[]): AgentMessage[] => [...prefix, ...Array.from({ length: 8 }, (_, index) => [
      { role: "assistant", content: [{ type: "toolCall", id: `repeat-call-${index}`, name: "evidence", arguments: {} }], api: "openai-completions", provider: "test", model: "test", usage: zeroUsage(), stopReason: "toolUse", timestamp: index * 2 + 30 },
      { role: "toolResult", toolCallId: `repeat-call-${index}`, toolName: "evidence", content: [{ type: "text", text: `repeat-artifact-${index} ` + "x".repeat(2_000) }], isError: false, timestamp: index * 2 + 31 },
    ]).flat() as AgentMessage[]];
    const first = await new DurableCompactionCoordinator(checkpointService).provide(runId, {
      firstKeptEntryId: "first-overflow",
      tokensBefore: 20_000,
      retainedTail: makeTail([realTask]),
    }, undefined, { maxContextTokens: 4_096, taskAnchor: realTask });
    const secondTail = makeTail([...first.retainedTail, recoveryPrompt]);
    const anchor = latestExternalUserMessage(secondTail);
    assert.equal(anchor?.content, realTask.content);
    const second = await new DurableCompactionCoordinator(checkpointService).provide(runId, {
      firstKeptEntryId: "second-overflow",
      tokensBefore: 30_000,
      retainedTail: secondTail,
    }, undefined, { maxContextTokens: 4_096, taskAnchor: anchor });
    assert.match(second.summary, /## Active user request\n继续完成固件逆向并求出 flag/);
    const retained = JSON.stringify(second.retainedTail);
    assert.match(retained, /继续完成固件逆向并求出 flag/);
    assert.doesNotMatch(second.summary, new RegExp(AUTOMATIC_CONTEXT_RECOVERY_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(retained, new RegExp(AUTOMATIC_CONTEXT_RECOVERY_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interruption 6: expired heartbeat and missing target reset lifecycle state", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-interrupt-lifecycle-"));
  try {
    const services = createServices(root, config);
    const runId = "INTERRUPT-LIFECYCLE";
    const task = fixtureTask(runId, "reverse-branch-2", root, config);
    await services.control.createRun(runId, task);
    const recovery = new RunRecoveryService(services.control, services.journal, services.sandbox, services.fixtureControl);
    const initial = await recovery.recover(runId);
    const generation = initial.fixture.generation;
    const leases = new LeaseManager(services.control);
    const lease = await leases.acquire(runId, `target:${runId}`, "executor", 30_000);
    const staleEffectArgs = { path: "strings.txt", generation };
    await services.control.dispatch(runId, {
      type: "effect_proposed",
      effect: { id: "EF-STALE", idempotencyKey: createEffectInput(runId, "fixture_read", staleEffectArgs, "pure", generation).idempotencyKey, replayPolicy: "pure", operation: "fixture_read", args: staleEffectArgs, cwd: initial.fixture.path, status: "PROPOSED" },
      lane: "executor",
    });
    await services.control.dispatch(runId, { type: "effect_started", effectId: "EF-STALE", lane: "executor" });
    await services.control.dispatch(runId, {
      type: "job_queued_legacy",
      job: { id: "J-STALE", capabilityId: "proofblade.target", operation: "inspect", args: {}, replayPolicy: "pure", status: "QUEUED", lane: "executor", generation },
      lane: "executor",
    });
    await services.control.dispatch(runId, { type: "job_started", jobId: "J-STALE", lane: "executor" });
    await rm(initial.fixture.path, { recursive: true, force: true });

    const reconciled = await recovery.recover(runId, task, Date.parse(lease.expiresAt) + 1);
    assert.equal(reconciled.fixtureHealth.status, "missing");
    assert.equal(reconciled.fixtureAction, "reset");
    assert.deepEqual(reconciled.expiredLeases.map((item) => item.resourceKey), [`target:${runId}`]);
    assert.deepEqual(reconciled.reconciledEffects, ["EF-STALE"]);
    assert.deepEqual(reconciled.reconciledJobs, ["J-STALE"]);
    const snapshot = await services.control.snapshot(runId);
    assert.equal(snapshot.generation, generation + 1);
    assert.equal(snapshot.effects["EF-STALE"]?.status, "UNKNOWN");
    assert.equal(snapshot.jobs["J-STALE"]?.status, "UNKNOWN");
    assert.equal(Object.keys(snapshot.leases).length, 0);
    await assert.rejects(leases.heartbeat(runId, lease, 30_000), /ownership mismatch/);

    const stableHash = snapshot.projectionHash;
    const second = await recovery.recover(runId, task);
    assert.equal(second.fixtureAction, "none");
    assert.deepEqual(second.reconciledEffects, []);
    assert.deepEqual(second.reconciledJobs, []);
    assert.equal((await services.control.snapshot(runId)).projectionHash, stableHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interruption 7: RunRecoveryService supersedes an orphaned OPEN session on restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-interrupt-session-"));
  try {
    const services = createServices(root, config);
    const runId = "INTERRUPT-SESSION";
    const task = fixtureTask(runId, "reverse-branch-2", root, config);
    await services.control.createRun(runId, task);
    // Simulate a prior process that opened a durable session and then died: emit
    // session_opened directly, leaving it OPEN with no live host process.
    await services.control.dispatch(runId, {
      type: "session_opened",
      session: { id: "SES-ORPH", runId, kind: "pwn-remote", ownerLane: "main", generation: 0, externalId: "dxs-dead" },
      lane: "main",
    });
    assert.equal((await services.control.snapshot(runId)).sessions["SES-ORPH"]?.status, "OPEN");

    // Production recovery path: a fresh registry (empty live map) is passed in, so
    // the durably-OPEN session is recognized as an orphan and superseded.
    const recovery = new RunRecoveryService(
      services.control, services.journal, services.sandbox,
      services.fixtureControl,
      SessionRegistry.forRecovery(runId, services.control),
    );
    const result = await recovery.recover(runId, task);
    assert.equal(result.supersededSessions, 1);
    assert.equal((await services.control.snapshot(runId)).sessions["SES-ORPH"]?.status, "SUPERSEDED");

    // Idempotent: a second recovery finds no orphan and supersedes nothing.
    const again = await recovery.recover(runId, task);
    assert.equal(again.supersededSessions, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture recovery preflight does not mutate the sandbox or generation for a terminal run", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-terminal-reset-preflight-"));
  try {
    const services = createServices(root, config);
    const runId = "TERMINAL-RESET-PREFLIGHT";
    const task = fixtureTask(runId, "reverse-branch-2", root, config);
    await services.control.createRun(runId, task);
    await services.control.dispatch(runId, {
      type: "fail",
      reason: "terminal reset preflight regression",
      category: "verification_missing",
    });
    const before = await services.control.snapshot(runId);
    const reset = services.sandbox.reset.bind(services.sandbox);
    let resetCalls = 0;
    services.sandbox.reset = async (fixture) => {
      resetCalls += 1;
      return await reset(fixture);
    };

    await assert.rejects(
      new RunRecoveryService(services.control, services.journal, services.sandbox, services.fixtureControl).recover(runId, task),
      /Cannot reset fixture for terminal run FAILED/,
    );

    const after = await services.control.snapshot(runId);
    assert.equal(resetCalls, 0, "terminal preflight must reject before Sandbox.reset");
    assert.equal(after.generation, before.generation);
    assert.equal(after.status, "FAILED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture recovery preflight does not mutate the sandbox or generation under the wrong authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-authority-reset-preflight-"));
  const owner = createServices(root, config);
  const attacker = createServices(root, config, { authoritySecret: "attacker-authority-secret-that-is-deliberately-different" });
  try {
    const runId = "AUTHORITY-RESET-PREFLIGHT";
    const task = fixtureTask(runId, "reverse-branch-2", root, config);
    await owner.control.createRun(runId, task);
    const before = await owner.control.snapshot(runId);
    const reset = attacker.sandbox.reset.bind(attacker.sandbox);
    let resetCalls = 0;
    attacker.sandbox.reset = async (fixture) => {
      resetCalls += 1;
      return await reset(fixture);
    };

    await assert.rejects(
      new RunRecoveryService(attacker.control, attacker.journal, attacker.sandbox, attacker.fixtureControl).recover(runId, task),
      /authority does not match the immutable Run anchor/,
    );

    const after = await owner.control.snapshot(runId);
    assert.equal(resetCalls, 0, "unanchored preflight must reject before Sandbox.reset");
    assert.equal(after.generation, before.generation);
    assert.equal(after.status, "READY");
  } finally {
    await Promise.allSettled([owner.sandbox.close(), attacker.sandbox.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

function toolAssistant(calls: Array<{ id: string; name: string }>): AgentMessage {
  return {
    role: "assistant",
    content: calls.map((call) => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: {} })),
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: zeroUsage(),
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function toolResult(toolCallId: string, toolName: string, text: string): AgentMessage {
  return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: 2 };
}

function textAssistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: 2,
  };
}

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
