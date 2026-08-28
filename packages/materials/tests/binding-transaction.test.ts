import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { sha256 } from "../src/domain/utils.js";
import { classifyExternalBinding } from "../src/recovery/binding-transaction.js";
import { externalResourceBindingTransactionId, type ExternalResourceRecord } from "../src/recovery/external-resource-registry.js";
import { BindingTransactionCoordinator, bindingTransactionIdentityHash } from "../src/recovery/binding-transaction-coordinator.js";
import { createServices, demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { ExternalResourceRegistry } from "../src/recovery/external-resource-registry.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POLICY_HASH = sha256("binding-policy");
const RECIPE_HASH = sha256("binding-recipe");
const SCOPE_HASH = sha256("binding-scope");

function resource(overrides: Partial<ExternalResourceRecord> = {}): ExternalResourceRecord {
  return {
    schemaVersion: 1,
    id: "session:SES-1",
    kind: "pwn-session",
    runId: "RUN-1",
    generation: 2,
    ownerLane: "executor",
    state: "STARTED",
    externalId: "tube-1",
    bindingTxnId: sha256("binding-txn"),
    effectId: "EFF-1",
    requestKey: "REQ-1",
    policyHash: POLICY_HASH,
    recipeHash: RECIPE_HASH,
    scopeHash: SCOPE_HASH,
    controlSessionId: "SES-1",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    inspectCount: 0,
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "SES-1",
    runId: "RUN-1",
    kind: "pwn-local" as const,
    ownerLane: "executor" as const,
    generation: 2,
    status: "OPEN" as const,
    externalId: "tube-1",
    bindingTxnId: sha256("binding-txn"),
    ...overrides,
  };
}

test("binding transaction id is stable and excludes the opaque external handle", () => {
  const base = resource();
  const first = externalResourceBindingTransactionId(base);
  const second = externalResourceBindingTransactionId({ ...base, externalId: "a-different-handle" });
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, externalResourceBindingTransactionId({ ...base, generation: 3 }));
});

test("exact OPEN session with a durable marker is adoptable", () => {
  assert.deepEqual(classifyExternalBinding({ resource: resource(), controlSession: session() }), {
    phase: "CONTROL_BOUND",
    action: "ADOPT",
    reason: "the exact Control Store owner marker is durable",
    bindingTxnId: sha256("binding-txn"),
  });
});

test("exact OPEN session without a marker requires reconciliation before adoption", () => {
  assert.deepEqual(classifyExternalBinding({ resource: resource({ controlSessionId: undefined }), controlSession: session() }), {
    phase: "STARTED",
    action: "RECONCILE",
    reason: "the exact Control Store owner exists but the binding marker is not durable yet",
    bindingTxnId: sha256("binding-txn"),
  });
});

test("missing or closed owners are release-only and never adoptable", () => {
  assert.equal(classifyExternalBinding({ resource: resource({ controlSessionId: undefined }), controlSession: undefined }).action, "RELEASE");
  assert.equal(classifyExternalBinding({ resource: resource({ controlSessionId: undefined }), controlSession: session({ status: "CLOSED" }) }).action, "RELEASE");
});

test("binding mismatches become manual recovery", () => {
  const decision = classifyExternalBinding({ resource: resource(), controlSession: session({ externalId: "foreign-tube" }) });
  assert.deepEqual(decision, {
    phase: "AMBIGUOUS",
    action: "MANUAL",
    reason: "Control Store session does not match the immutable external resource binding",
    bindingTxnId: sha256("binding-txn"),
  });
});

test("an OPEN owner backed by a proposal requires backend reconciliation", () => {
  assert.deepEqual(classifyExternalBinding({ resource: resource({ state: "PROPOSED", externalId: undefined, controlSessionId: undefined }), controlSession: session() }), {
    phase: "PROPOSED",
    action: "RECONCILE",
    reason: "an OPEN Control Store session may have crossed the external side-effect boundary before STARTED was recorded",
    bindingTxnId: sha256("binding-txn"),
  });
});

const config = { schemaVersion: 1, runtime: { piVersion: "0.83.0" }, storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" }, modelProfiles: { executor: { thinkingLevel: "off" } } } as unknown as ProofBladeConfig;

const bindingWorkerSource = `
  const [{ createServices }, { BindingTransactionCoordinator }] = await Promise.all([
    import('./packages/materials/src/app/demo.ts'),
    import('./packages/materials/src/recovery/binding-transaction-coordinator.ts'),
  ]);
  const [root, runId, authoritySecret, bindingTxnId] = process.argv.slice(1);
  const config = { schemaVersion: 1, runtime: { piVersion: '0.83.0' }, storage: { runsDir: 'runs', fixturesDir: 'fixtures/runtime' }, modelProfiles: { executor: { thinkingLevel: 'off' } } };
  const services = createServices(root, config, { authoritySecret });
  const coordinator = new BindingTransactionCoordinator(services.control, services.externalResources);
  const intent = await coordinator.get(bindingTxnId);
  if (!intent) throw new Error('binding worker could not read the prepared intent');
  const session = {
    id: intent.sessionId,
    runId: intent.runId,
    kind: intent.kind === 'pwn-session' ? 'pwn-local' : 'http',
    ownerLane: intent.ownerLane,
    generation: intent.generation,
    externalId: intent.externalId,
    ...(intent.requestKey ? { requestKey: intent.requestKey } : {}),
  };
  const committed = await coordinator.commitControl(intent, session);
  await coordinator.finalize(committed);
`;

test("binding transaction coordinator commits, finalizes, and recovers idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-binding-coordinator-"));
  try {
    const services = createServices(root, config);
    const runId = "BINDING-COORDINATOR";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const registry = new ExternalResourceRegistry(join(root, ".proofblade", "external-resources.json"));
    const coordinator = new BindingTransactionCoordinator(services.control, registry);
    const input = {
      sessionId: "HTTP-TXN-1",
      resource: {
        id: "session:HTTP-TXN-1",
        kind: "http-session" as const,
        runId,
        generation: 0,
        ownerLane: "verifier" as const,
        externalId: "opaque-http-txn-1",
        requestKey: "request-http-txn-1",
      },
    };
    const prepared = await coordinator.prepare(input);
    assert.equal(prepared.state, "PREPARED");
    assert.equal(prepared.identityHash, bindingTransactionIdentityHash(await registry.get(input.resource.id), input.sessionId));
    const sessionInput = {
      id: input.sessionId,
      runId,
      kind: "http" as const,
      ownerLane: "verifier" as const,
      generation: 0,
      externalId: input.resource.externalId,
      requestKey: input.resource.requestKey,
    };
    const committed = await coordinator.commitControl(prepared, sessionInput);
    assert.equal(committed.state, "CONTROL_COMMITTED");
    const finalized = await coordinator.finalize(committed);
    assert.equal(finalized.state, "BOUND");
    assert.equal((await registry.get(input.resource.id))?.controlSessionId, input.sessionId);
    assert.equal((await coordinator.finalize(finalized)).state, "BOUND");
    assert.equal((await coordinator.commitControl(finalized, sessionInput)).state, "BOUND");

    const restarted = new BindingTransactionCoordinator(services.control, registry);
    const report = await restarted.recover(runId, 0);
    assert.deepEqual(report, { repaired: [], bound: [], releaseCandidates: [], manual: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binding finalization cannot promote a session closed between the external marker and Control fence", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-binding-finalize-race-"));
  try {
    const services = createServices(root, config);
    const runId = "BINDING-FINALIZE-RACE";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const registry = new ExternalResourceRegistry(join(root, ".proofblade", "external-resources.json"));
    const coordinator = new BindingTransactionCoordinator(services.control, registry);
    const input = {
      sessionId: "HTTP-TXN-FINALIZE-RACE",
      resource: {
        id: "session:HTTP-TXN-FINALIZE-RACE",
        kind: "http-session" as const,
        runId,
        generation: 0,
        ownerLane: "verifier" as const,
        externalId: "opaque-http-finalize-race",
      },
    };
    const prepared = await coordinator.prepare(input);
    const sessionInput = {
      id: input.sessionId,
      runId,
      kind: "http" as const,
      ownerLane: "verifier" as const,
      generation: 0,
      externalId: input.resource.externalId,
    };
    const committed = await coordinator.commitControl(prepared, sessionInput);
    assert.equal((await services.control.snapshot(runId)).sessions[input.sessionId]?.bindingState, "FINALIZING");
    await assert.rejects(() => services.control.dispatch(runId, {
      type: "session_binding_completed",
      sessionId: input.sessionId,
      bindingTxnId: prepared.bindingTxnId,
      bindingIdentityHash: prepared.identityHash,
      lane: "verifier",
    }), /requires binding authority/);

    const markControlBound = registry.markControlBound.bind(registry);
    registry.markControlBound = async (...args: Parameters<ExternalResourceRegistry["markControlBound"]>) => {
      const result = await markControlBound(...args);
      await services.control.dispatch(runId, { type: "session_closed", sessionId: input.sessionId, reason: "race injected", lane: "verifier" });
      return result;
    };

    await assert.rejects(() => coordinator.finalize(committed), /owner is CLOSED/);
    const closed = (await services.control.snapshot(runId)).sessions[input.sessionId];
    assert.equal(closed?.status, "CLOSED");
    assert.equal(closed?.bindingState, "FINALIZING");
    assert.equal((await registry.get(input.resource.id))?.controlSessionId, input.sessionId);
    assert.equal((await coordinator.get(prepared.bindingTxnId))?.state, "CONTROL_COMMITTED");

    const recovery = await new BindingTransactionCoordinator(services.control, registry).recover(runId, 0);
    assert.deepEqual(recovery, { repaired: [], bound: [], releaseCandidates: [prepared.bindingTxnId], manual: [] });
    assert.notEqual((await coordinator.get(prepared.bindingTxnId))?.state, "BOUND");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binding transaction recovery repairs a crash after Control Store commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-binding-recovery-"));
  try {
    const services = createServices(root, config);
    const runId = "BINDING-RECOVERY";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const registry = new ExternalResourceRegistry(join(root, ".proofblade", "external-resources.json"));
    const coordinator = new BindingTransactionCoordinator(services.control, registry);
    const input = {
      sessionId: "HTTP-TXN-RECOVERY",
      resource: {
        id: "session:HTTP-TXN-RECOVERY",
        kind: "http-session" as const,
        runId,
        generation: 0,
        ownerLane: "verifier" as const,
        externalId: "opaque-http-txn-recovery",
      },
    };
    const prepared = await coordinator.prepare(input);
    const resourceRecord = await registry.get(input.resource.id);
    await registry.markConfirmed(input.resource.id, "external host was inspected before binding recovery");
    const sessionInput = {
      id: input.sessionId,
      runId,
      kind: "http" as const,
      ownerLane: "verifier" as const,
      generation: 0,
      externalId: input.resource.externalId,
      bindingTxnId: resourceRecord!.bindingTxnId,
      bindingIdentityHash: prepared.identityHash,
    };
    await services.control.dispatch(runId, { type: "session_opened", session: sessionInput, lane: "verifier" });
    const report = await coordinator.recover(runId, 0);
    assert.deepEqual(report.repaired, [prepared.bindingTxnId]);
    assert.equal((await registry.get(input.resource.id))?.controlSessionId, input.sessionId);
    assert.equal((await coordinator.get(prepared.bindingTxnId))?.state, "BOUND");
    const second = await coordinator.recover(runId, 0);
    assert.deepEqual(second, { repaired: [], bound: [], releaseCandidates: [], manual: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binding transaction records external confirmation before control-marker repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-binding-external-confirmed-"));
  try {
    const services = createServices(root, config);
    const runId = "BINDING-EXTERNAL-CONFIRMED";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const registry = new ExternalResourceRegistry(join(root, ".proofblade", "external-resources.json"));
    const coordinator = new BindingTransactionCoordinator(services.control, registry);
    const input = {
      sessionId: "HTTP-TXN-CONFIRMED",
      resource: {
        id: "session:HTTP-TXN-CONFIRMED",
        kind: "http-session" as const,
        runId,
        generation: 0,
        ownerLane: "verifier" as const,
        externalId: "opaque-http-confirmed",
      },
    };
    const prepared = await coordinator.prepare(input);
    await assert.rejects(coordinator.markExternalConfirmed(prepared), /requires a confirmed external resource/);
    await registry.markConfirmed(input.resource.id, "exact host inspect/adopt succeeded");
    const confirmed = await coordinator.markExternalConfirmed(prepared);
    assert.equal(confirmed.state, "EXTERNAL_CONFIRMED");
    assert.equal((await coordinator.markExternalConfirmed(confirmed)).state, "EXTERNAL_CONFIRMED");
    const sessionInput = {
      id: input.sessionId,
      runId,
      kind: "http" as const,
      ownerLane: "verifier" as const,
      generation: 0,
      externalId: input.resource.externalId,
      bindingTxnId: prepared.bindingTxnId,
      bindingIdentityHash: prepared.identityHash,
    };
    const committed = await coordinator.commitControl(confirmed, sessionInput);
    assert.equal(committed.state, "CONTROL_COMMITTED");
    assert.equal((await coordinator.finalize(committed)).state, "BOUND");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binding transaction recovery refuses to promote an unknown external handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-binding-unknown-"));
  try {
    const services = createServices(root, config);
    const runId = "BINDING-UNKNOWN-EXTERNAL";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const registry = new ExternalResourceRegistry(join(root, ".proofblade", "external-resources.json"));
    const coordinator = new BindingTransactionCoordinator(services.control, registry);
    const input = {
      sessionId: "HTTP-TXN-UNKNOWN",
      resource: {
        id: "session:HTTP-TXN-UNKNOWN",
        kind: "http-session" as const,
        runId,
        generation: 0,
        ownerLane: "verifier" as const,
        externalId: "opaque-http-unknown",
      },
    };
    const prepared = await coordinator.prepare(input);
    await services.control.dispatch(runId, {
      type: "session_opened",
      session: {
        id: input.sessionId,
        runId,
        kind: "http" as const,
        ownerLane: "verifier" as const,
        generation: 0,
        externalId: input.resource.externalId,
        bindingTxnId: prepared.bindingTxnId,
        bindingIdentityHash: prepared.identityHash,
      },
      lane: "verifier",
    });
    await registry.markUnknown(input.resource.id, "host inspection timed out");

    const report = await coordinator.recover(runId, 0);
    assert.deepEqual(report, { repaired: [], bound: [], releaseCandidates: [], manual: [prepared.bindingTxnId] });
    assert.equal((await coordinator.get(prepared.bindingTxnId))?.state, "PREPARED");
    assert.equal((await registry.get(input.resource.id))?.controlSessionId, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binding transaction fault points converge without duplicate sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-binding-faults-"));
  try {
    const services = createServices(root, config);
    const registry = new ExternalResourceRegistry(join(root, ".proofblade", "external-resources.json"));

    const afterExternalStartedRun = "BINDING-FAULT-EXTERNAL";
    await services.control.createRun(afterExternalStartedRun, demoTask(afterExternalStartedRun, root, config));
    const afterExternalStarted = new BindingTransactionCoordinator(services.control, registry, { fault: (point) => point === "after_external_started" ? (() => { throw new Error("crash after external start"); })() : undefined });
    await assert.rejects(() => afterExternalStarted.prepare({
      sessionId: "HTTP-FAULT-EXTERNAL",
      resource: { id: "session:HTTP-FAULT-EXTERNAL", kind: "http-session", runId: afterExternalStartedRun, generation: 0, ownerLane: "verifier", externalId: "opaque-fault-external" },
    }), /crash after external start/);
    assert.equal((await new BindingTransactionCoordinator(services.control, registry).intents(afterExternalStartedRun)).length, 0);
    assert.equal((await registry.get("session:HTTP-FAULT-EXTERNAL"))?.state, "STARTED");
    await registry.markReleased("session:HTTP-FAULT-EXTERNAL", "test cleanup");

    const afterIntentRun = "BINDING-FAULT-INTENT";
    await services.control.createRun(afterIntentRun, demoTask(afterIntentRun, root, config));
    const afterIntent = new BindingTransactionCoordinator(services.control, registry, { fault: (point) => point === "after_intent" ? (() => { throw new Error("crash after intent"); })() : undefined });
    await assert.rejects(() => afterIntent.prepare({
      sessionId: "HTTP-FAULT-INTENT",
      resource: { id: "session:HTTP-FAULT-INTENT", kind: "http-session", runId: afterIntentRun, generation: 0, ownerLane: "verifier", externalId: "opaque-fault-intent" },
    }), /crash after intent/);
    const intentRecovery = await new BindingTransactionCoordinator(services.control, registry).recover(afterIntentRun, 0);
    assert.equal(intentRecovery.releaseCandidates.length, 1);
    await registry.markReleased("session:HTTP-FAULT-INTENT", "test cleanup");
    const releasedIntent = (await new BindingTransactionCoordinator(services.control, registry).intents(afterIntentRun))[0];
    assert.ok(releasedIntent);
    await new BindingTransactionCoordinator(services.control, registry).markReleased(releasedIntent.bindingTxnId);
    assert.deepEqual(await new BindingTransactionCoordinator(services.control, registry).recover(afterIntentRun, 0), { repaired: [], bound: [], releaseCandidates: [], manual: [] });

    const afterExternalConfirmedRun = "BINDING-FAULT-CONFIRMED";
    await services.control.createRun(afterExternalConfirmedRun, demoTask(afterExternalConfirmedRun, root, config));
    const confirmedInput = { sessionId: "HTTP-FAULT-CONFIRMED", resource: { id: "session:HTTP-FAULT-CONFIRMED", kind: "http-session" as const, runId: afterExternalConfirmedRun, generation: 0, ownerLane: "verifier" as const, externalId: "opaque-fault-confirmed" } };
    const confirmedIntent = await new BindingTransactionCoordinator(services.control, registry).prepare(confirmedInput);
    await registry.markConfirmed(confirmedInput.resource.id, "test host confirmation");
    const afterExternalConfirmed = new BindingTransactionCoordinator(services.control, registry, { fault: (point) => point === "after_external_confirmed" ? (() => { throw new Error("crash after external confirmation"); })() : undefined });
    await assert.rejects(() => afterExternalConfirmed.markExternalConfirmed(confirmedIntent), /crash after external confirmation/);
    assert.equal((await new BindingTransactionCoordinator(services.control, registry).get(confirmedIntent.bindingTxnId))?.state, "EXTERNAL_CONFIRMED");
    await registry.markReleased(confirmedInput.resource.id, "test cleanup");
    await new BindingTransactionCoordinator(services.control, registry).markReleased(confirmedIntent.bindingTxnId);

    const afterControlRun = "BINDING-FAULT-CONTROL";
    await services.control.createRun(afterControlRun, demoTask(afterControlRun, root, config));
    const afterControl = new BindingTransactionCoordinator(services.control, registry, { fault: (point) => point === "after_control_commit" ? (() => { throw new Error("crash after Control commit"); })() : undefined });
    const controlInput = { sessionId: "HTTP-FAULT-CONTROL", resource: { id: "session:HTTP-FAULT-CONTROL", kind: "http-session" as const, runId: afterControlRun, generation: 0, ownerLane: "verifier" as const, externalId: "opaque-fault-control" } };
    const controlIntent = await afterControl.prepare(controlInput);
    const controlSession = { id: controlInput.sessionId, runId: afterControlRun, kind: "http" as const, ownerLane: "verifier" as const, generation: 0, externalId: controlInput.resource.externalId };
    await assert.rejects(() => afterControl.commitControl(controlIntent, controlSession), /crash after Control commit/);
    await registry.markConfirmed(controlInput.resource.id, "external host was inspected before binding recovery");
    const controlRecovery = await new BindingTransactionCoordinator(services.control, registry).recover(afterControlRun, 0);
    assert.deepEqual(controlRecovery.repaired, [controlIntent.bindingTxnId]);

    const afterFinalizeRun = "BINDING-FAULT-FINALIZE";
    await services.control.createRun(afterFinalizeRun, demoTask(afterFinalizeRun, root, config));
    const afterFinalize = new BindingTransactionCoordinator(services.control, registry, { fault: (point) => point === "after_finalize" ? (() => { throw new Error("crash after finalize"); })() : undefined });
    const finalizeInput = { sessionId: "HTTP-FAULT-FINALIZE", resource: { id: "session:HTTP-FAULT-FINALIZE", kind: "http-session" as const, runId: afterFinalizeRun, generation: 0, ownerLane: "verifier" as const, externalId: "opaque-fault-finalize" } };
    const finalizeIntent = await afterFinalize.prepare(finalizeInput);
    const finalizeSession = { id: finalizeInput.sessionId, runId: afterFinalizeRun, kind: "http" as const, ownerLane: "verifier" as const, generation: 0, externalId: finalizeInput.resource.externalId };
    const finalizeCommitted = await afterFinalize.commitControl(finalizeIntent, finalizeSession);
    await assert.rejects(() => afterFinalize.finalize(finalizeCommitted), /crash after finalize/);
    const finalizeRecovery = await new BindingTransactionCoordinator(services.control, registry).recover(afterFinalizeRun, 0);
    assert.deepEqual(finalizeRecovery.bound, [finalizeIntent.bindingTxnId]);

    const concurrentRun = "BINDING-CONCURRENT";
    await services.control.createRun(concurrentRun, demoTask(concurrentRun, root, config));
    const concurrent = new BindingTransactionCoordinator(services.control, registry);
    const concurrentInput = { sessionId: "HTTP-CONCURRENT", resource: { id: "session:HTTP-CONCURRENT", kind: "http-session" as const, runId: concurrentRun, generation: 0, ownerLane: "verifier" as const, externalId: "opaque-concurrent" } };
    const prepared = await Promise.all([concurrent.prepare(concurrentInput), concurrent.prepare(concurrentInput)]);
    assert.equal(new Set(prepared.map((intent) => intent.bindingTxnId)).size, 1);
    const concurrentSession = { id: concurrentInput.sessionId, runId: concurrentRun, kind: "http" as const, ownerLane: "verifier" as const, generation: 0, externalId: concurrentInput.resource.externalId };
    await Promise.all(prepared.map((intent) => concurrent.commitControl(intent, concurrentSession)));
    await Promise.all(prepared.map((intent) => concurrent.finalize(intent)));
    assert.equal(Object.values((await services.control.snapshot(concurrentRun)).sessions).length, 1);
    assert.equal((await concurrent.intents(concurrentRun)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binding transaction coordinator serializes owner commit across processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-binding-cross-process-"));
  const authoritySecret = "binding-cross-process-authority-secret-0123456789";
  try {
    const services = createServices(root, config, { authoritySecret });
    const runId = "BINDING-CROSS-PROCESS";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const registry = new ExternalResourceRegistry(join(root, ".proofblade", "external-resources.json"));
    const coordinator = new BindingTransactionCoordinator(services.control, registry);
    const prepared = await coordinator.prepare({
      sessionId: "HTTP-CROSS-PROCESS",
      resource: {
        id: "session:HTTP-CROSS-PROCESS",
        kind: "http-session",
        runId,
        generation: 0,
        ownerLane: "verifier",
        externalId: "opaque-cross-process",
        requestKey: "request-cross-process",
      },
    });
    await Promise.all([
      runBindingWorker(root, runId, authoritySecret, prepared.bindingTxnId),
      runBindingWorker(root, runId, authoritySecret, prepared.bindingTxnId),
    ]);
    const events = await services.control.events(runId);
    assert.equal(events.filter((event) => event.type === "session_opened").length, 1);
    assert.equal(Object.keys((await services.control.snapshot(runId)).sessions).length, 1);
    assert.equal((await coordinator.get(prepared.bindingTxnId))?.state, "BOUND");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runBindingWorker(root: string, runId: string, authoritySecret: string, bindingTxnId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", bindingWorkerSource, root, runId, authoritySecret, bindingTxnId], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`binding worker exited with ${String(code)} ${String(signal)}: ${stderr}`));
    });
  });
}
