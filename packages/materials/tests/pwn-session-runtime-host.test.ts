import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../src/control/control-store.js";
import { demoTask } from "../src/app/demo.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";
import type { ProofBladeConfig } from "../src/config.js";
import { PwnSessionRuntimeHost, type PwnSessionSupervisor } from "../src/recovery/pwn-session-runtime-host.js";
import { DurablePwnSessionSupervisor } from "../src/recovery/pwn-session-supervisor.js";
import { DurableSessionRuntimeService } from "../src/recovery/session-runtime-service.js";
import { sessionRuntimeWireResource, type SessionRuntimeCreateRequest } from "../src/recovery/session-runtime-wire.js";
import { BindingTransactionCoordinator } from "../src/recovery/binding-transaction-coordinator.js";
import { ExternalResourceRegistry, type ExternalResourceRecord } from "../src/recovery/external-resource-registry.js";

const HASH = "a".repeat(64);

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: { executor: { thinkingLevel: "off" } },
};

async function makeControl(root: string, runId: string): Promise<ControlStore> {
  const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
  await control.createRun(runId, demoTask(runId, root, config));
  return control;
}

function request(): SessionRuntimeCreateRequest {
  return {
    kind: "pwn-session",
    runId: "PWN-HOST-CONTRACT",
    generation: 3,
    ownerLane: "executor",
    requestKey: HASH,
    pwn: {
      mode: "remote",
      command: ["python3", "exploit.py"],
      endpoint: "127.0.0.1:31337",
      cwd: "/workspace",
      waitTimeoutMs: 2_000,
      idleSilenceMs: 250,
    },
  };
}

function resource(externalId = "pwn-supervisor-1"): ExternalResourceRecord {
  return {
    schemaVersion: 1,
    id: "session:PWN-HOST-SESSION",
    kind: "pwn-session",
    runId: "PWN-HOST-CONTRACT",
    generation: 3,
    ownerLane: "executor",
    state: "STARTED",
    externalId,
    requestKey: HASH,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    inspectCount: 0,
  };
}

function supervisor(state = new Map<string, { sessionId: string; externalId: string; stateHash: string }>()): PwnSessionSupervisor {
  return {
    actions: {
      async pwnWrite() { return { delta: "ack", waitReason: "idle", exited: false, truncated: false }; },
      async pwnRead() { return { delta: "reply", waitReason: "data", exited: false, truncated: false }; },
      async pwnSignal() { return true; },
      async pwnClose() { return { exitCode: 0 }; },
    },
    async create(_request, idempotencyKey) {
      const existing = state.get(idempotencyKey);
      if (existing) return existing;
      const created = { sessionId: "PWN-HOST-SESSION", externalId: "pwn-supervisor-1", stateHash: HASH };
      state.set(idempotencyKey, created);
      return created;
    },
    async inspect(externalId) {
      return [...state.values()].some((record) => record.externalId === externalId) ? { status: "PRESENT", externalId } : { status: "ABSENT", externalId };
    },
    async adopt(externalId) { return [...state.values()].some((record) => record.externalId === externalId); },
    async release(externalId) { return [...state.values()].some((record) => record.externalId === externalId); },
    async inspectByIdempotency(_request, idempotencyKey) {
      const created = state.get(idempotencyKey);
      return created ? { status: "PRESENT", created } : { status: "ABSENT" };
    },
    async heartbeat() {},
    async health() { return { status: "READY", capabilities: { kinds: ["pwn-session"], maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576, stableAcrossRestart: true }, summary: "fixture supervisor" }; },
  };
}

test("Pwn session runtime host delegates only validated Pwn requests and actions", async () => {
  const host = new PwnSessionRuntimeHost(supervisor());
  assert.deepEqual(await host.create(request(), HASH), { sessionId: "PWN-HOST-SESSION", externalId: "pwn-supervisor-1", stateHash: HASH });
  assert.deepEqual(await host.inspect("pwn-supervisor-1", request()), { status: "PRESENT", externalId: "pwn-supervisor-1" });
  assert.equal(await host.adopt("pwn-supervisor-1", request()), true);
  assert.equal(await host.release("pwn-supervisor-1", request(), "test cleanup"), true);
  assert.deepEqual(await host.inspectByIdempotency!(request(), HASH), { status: "PRESENT", created: { sessionId: "PWN-HOST-SESSION", externalId: "pwn-supervisor-1", stateHash: HASH } });
  assert.deepEqual(await host.actions.pwnWrite({ ...resource(), schemaVersion: 1 }, "payload"), { delta: "ack", waitReason: "idle", exited: false, truncated: false });
  assert.deepEqual(await host.actions.pwnRead({ ...resource(), schemaVersion: 1 }), { delta: "reply", waitReason: "data", exited: false, truncated: false });
  assert.equal(await host.actions.pwnSignal({ ...resource(), schemaVersion: 1 }, "SIGINT"), true);
  assert.deepEqual(await host.actions.pwnClose({ ...resource(), schemaVersion: 1 }), { exitCode: 0 });
  assert.deepEqual(await host.health(), { status: "READY", capabilities: { kinds: ["pwn-session"], maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576, stableAcrossRestart: true }, summary: "fixture supervisor" });
  await assert.rejects(host.actions.httpRequest({ ...resource(), schemaVersion: 1 }, { method: "GET", url: "http://target.test", headers: {} }), /does not expose HTTP actions/);
  await assert.rejects(host.create({ ...request(), kind: "http-session", pwn: undefined, http: { baseUrl: "http://target.test", allowedHosts: ["target.test"], allowedPorts: [80] } }, HASH), /only supports complete pwn-session/);
});

test("Pwn session runtime host downgrades mixed supervisor capabilities", async () => {
  const mixed = supervisor();
  mixed.health = async () => ({ status: "READY", capabilities: { kinds: ["pwn-session", "http-session"], maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576, stableAcrossRestart: true }, summary: "misconfigured" });
  const health = await new PwnSessionRuntimeHost(mixed).health!();
  assert.equal(health.status, "DEGRADED");
  assert.equal(health.capabilities.stableAcrossRestart, false);
  assert.deepEqual(health.capabilities.kinds, ["pwn-session"]);
});

test("Pwn session runtime host reports degraded without supervisor health", async () => {
  const candidate = supervisor();
  delete candidate.health;
  const health = await new PwnSessionRuntimeHost(candidate).health!();
  assert.equal(health.status, "DEGRADED");
  assert.equal(health.capabilities.stableAcrossRestart, false);
});

test("Pwn supervisor host composes with the durable service across a host restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-host-service-"));
  const state = new Map<string, { sessionId: string; externalId: string; stateHash: string }>();
  try {
    const requestValue = request();
    const first = new DurableSessionRuntimeService(join(root, "service.json"), new PwnSessionRuntimeHost(supervisor(state)));
    const created = await first.create(requestValue, HASH);
    assert.equal(created.state, "CREATED");
    const record: ExternalResourceRecord = {
      schemaVersion: 1,
      id: `session:${created.sessionId}`,
      kind: "pwn-session",
      runId: requestValue.runId,
      generation: requestValue.generation,
      ownerLane: requestValue.ownerLane,
      state: "CONFIRMED",
      externalId: created.externalId,
      requestKey: requestValue.requestKey,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      inspectCount: 0,
    };
    const restarted = new DurableSessionRuntimeService(join(root, "service.json"), new PwnSessionRuntimeHost(supervisor(state)));
    assert.equal((await restarted.health()).status, "READY");
    assert.deepEqual(await restarted.inspect(sessionRuntimeWireResource(record)), { status: "PRESENT", binding: "MATCH", externalId: created.externalId });
    assert.deepEqual(await restarted.adopt(sessionRuntimeWireResource(record)), { state: "CONFIRMED", externalId: created.externalId });
    assert.deepEqual(await restarted.actionService.pwnWrite(sessionRuntimeWireResource(record), "payload"), { delta: "ack", waitReason: "idle", exited: false, truncated: false });
    assert.equal((await restarted.create(requestValue, HASH)).state, "EXISTING");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pwn supervisor contract never creates a duplicate tube across concurrent service instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-host-race-"));
  const state = new Map<string, { sessionId: string; externalId: string; stateHash: string }>();
  let createCalls = 0;
  const base = supervisor(state);
  const delayed: PwnSessionSupervisor = {
    ...base,
    async create(requestValue, idempotencyKey, signal) {
      createCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return await base.create(requestValue, idempotencyKey, signal);
    },
  };
  try {
    const requestValue = request();
    const first = new DurableSessionRuntimeService(join(root, "service.json"), new PwnSessionRuntimeHost(delayed));
    const second = new DurableSessionRuntimeService(join(root, "service.json"), new PwnSessionRuntimeHost(delayed));
    const outcomes = await Promise.all([first.create(requestValue, HASH), second.create(requestValue, HASH)]);
    assert.equal(createCalls, 1);
    assert.equal(state.size, 1);
    assert.ok(outcomes.some((outcome) => outcome.state === "CREATED"));
    assert.ok(outcomes.every((outcome) => outcome.state === "CREATED" || outcome.state === "EXISTING" || outcome.state === "UNKNOWN"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pwn supervisor contract never replaces an interrupted STARTING reservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-host-starting-"));
  const ledgerPath = join(root, "service.json");
  const requestValue = request();
  await writeFile(ledgerPath, `${JSON.stringify({
    schemaVersion: 1,
    records: [{
      schemaVersion: 1,
      idempotencyKey: HASH,
      request: requestValue,
      state: "STARTING",
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      leaseExpiresAt: "2026-08-27T00:10:00.000Z",
    }],
  })}\n`, "utf8");
  let createCalls = 0;
  const base = supervisor();
  const guarded: PwnSessionSupervisor = {
    ...base,
    async create(...args) {
      createCalls += 1;
      return await base.create(...args);
    },
  };
  try {
    const service = new DurableSessionRuntimeService(ledgerPath, new PwnSessionRuntimeHost(guarded));
    assert.deepEqual(await service.reconcile(), { recovered: [], unknown: [HASH], pending: [] });
    assert.deepEqual(await service.create(requestValue, HASH), { state: "UNKNOWN", summary: "Session create is awaiting exact host reconciliation" });
    assert.equal(createCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pwn supervisor release failures remain retryable without changing the tube identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-host-release-"));
  const state = new Map<string, { sessionId: string; externalId: string; stateHash: string }>();
  let releaseCalls = 0;
  const base = supervisor(state);
  const retryable: PwnSessionSupervisor = {
    ...base,
    async release(externalId, requestValue, reason, signal) {
      releaseCalls += 1;
      if (releaseCalls === 1) return false;
      return await base.release(externalId, requestValue, reason, signal);
    },
  };
  try {
    const service = new DurableSessionRuntimeService(join(root, "service.json"), new PwnSessionRuntimeHost(retryable));
    const requestValue = request();
    const created = await service.create(requestValue, HASH);
    const record: ExternalResourceRecord = {
      ...resource(created.externalId),
      id: `session:${created.sessionId}`,
      externalId: created.externalId,
      state: "CONFIRMED",
    };
    const wire = sessionRuntimeWireResource(record);
    assert.deepEqual(await service.release(wire, "first attempt"), { released: false, summary: "Session host did not confirm release" });
    assert.deepEqual(await service.release(wire, "retry"), { released: true, summary: "Session released: retry" });
    assert.equal(releaseCalls, 2);
    assert.equal(state.size, 1, "release retry must not create or replace the tube");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real detached Pwn backend converges after a Control Store fault", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-real-handoff-"));
  const runId = "PWN-REAL-HANDOFF";
  const requestKey = "e".repeat(64);
  const requestValue: SessionRuntimeCreateRequest = {
    kind: "pwn-session",
    runId,
    generation: 0,
    ownerLane: "executor",
    requestKey,
    pwn: {
      mode: "local",
      command: [process.execPath, "-e", "process.stdin.on('data', chunk => process.stdout.write('echo:' + chunk.toString()))"],
      cwd: process.cwd(),
      waitTimeoutMs: 5_000,
      idleSilenceMs: 100,
    },
  };
  const statePath = join(root, "pwn-supervisor.json");
  const workerScript = join(process.cwd(), "scripts", "pwn-session-worker.mjs");
    // Match the production default: staged CI runs many process-heavy tests in
    // parallel, so a five-second detached-worker window is an avoidable flake.
    const supervisorOptions = { statePath, workerScript, timeoutMs: 15_000, allowLocalCommands: true } as const;
  let created: { sessionId: string; externalId: string; stateHash: string } | undefined;
  try {
    const control = await makeControl(root, runId);
    const externalResources = new ExternalResourceRegistry(join(root, "external-resources.json"));
    const supervisor = new DurablePwnSessionSupervisor(supervisorOptions);
    created = await supervisor.create(requestValue, requestKey);
    const resourceInput = {
      id: `session:${created.sessionId}`,
      kind: "pwn-session" as const,
      runId,
      generation: 0,
      ownerLane: "executor" as const,
      externalId: created.externalId,
      requestKey,
    };
    const prepared = await new BindingTransactionCoordinator(control, externalResources).prepare({ sessionId: created.sessionId, resource: resourceInput });
    const sessionInput = {
      id: created.sessionId,
      runId,
      kind: "pwn-local" as const,
      ownerLane: "executor" as const,
      generation: 0,
      externalId: created.externalId,
      requestKey,
    };
    const faulting = new BindingTransactionCoordinator(control, externalResources, {
      fault: (point) => point === "after_control_commit" ? (() => { throw new Error("injected Control Store boundary"); })() : undefined,
    });
    await assert.rejects(() => faulting.commitControl(prepared, sessionInput), /injected Control Store boundary/);
    assert.equal((await control.events(runId)).filter((event) => event.type === "session_opened").length, 1);
    assert.equal((await externalResources.get(resourceInput.id))?.state, "STARTED");
    assert.equal((await new BindingTransactionCoordinator(control, externalResources).get(prepared.bindingTxnId))?.state, "PREPARED");

    const restartedSupervisor = new DurablePwnSessionSupervisor(supervisorOptions);
    assert.deepEqual(await restartedSupervisor.inspect(created.externalId, requestValue), { status: "PRESENT", externalId: created.externalId });
    assert.equal(await restartedSupervisor.adopt(created.externalId, requestValue), true);
    await externalResources.markConfirmed(resourceInput.id, "exact detached worker inspect/adopt");
    const recovery = await new BindingTransactionCoordinator(control, externalResources).recover(runId, 0);
    assert.deepEqual(recovery, { repaired: [prepared.bindingTxnId], bound: [], releaseCandidates: [], manual: [] });
    const bound = await externalResources.get(resourceInput.id);
    assert.equal(bound?.controlSessionId, created.sessionId);
    assert.deepEqual(await restartedSupervisor.actions.pwnWrite(sessionRuntimeWireResource(bound!), "after-recovery\n"), {
      delta: "echo:after-recovery\n",
      waitReason: "data",
      exited: false,
      truncated: false,
    });
  } finally {
    if (created) await new DurablePwnSessionSupervisor(supervisorOptions).release(created.externalId, requestValue, "real handoff test cleanup").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("real remote TCP Pwn backend converges after Control Store commit and keeps the same tube", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-remote-handoff-"));
  const fixture = createServer((socket) => {
    socket.write("remote-ready\n");
    socket.on("data", (chunk) => socket.write(`remote-echo:${chunk.toString()}`));
  });
  await new Promise<void>((resolveListen, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  const runId = "PWN-REMOTE-HANDOFF";
  const requestKey = "f".repeat(64);
  const endpoint = `127.0.0.1:${address.port}`;
  const requestValue: SessionRuntimeCreateRequest = {
    kind: "pwn-session",
    runId,
    generation: 0,
    ownerLane: "executor",
    requestKey,
    pwn: {
      mode: "remote",
      command: ["immutable", "deployment-hint"],
      endpoint,
      waitTimeoutMs: 5_000,
      idleSilenceMs: 100,
    },
  };
  const statePath = join(root, "pwn-supervisor.json");
  const workerScript = join(process.cwd(), "scripts", "pwn-session-worker.mjs");
  const supervisorOptions = {
    statePath,
    workerScript,
    timeoutMs: 5_000,
    remoteScope: { allowedHosts: ["127.0.0.1"], allowedPorts: [address.port] },
  } as const;
  let created: { sessionId: string; externalId: string; stateHash: string } | undefined;
  try {
    const control = await makeControl(root, runId);
    const externalResources = new ExternalResourceRegistry(join(root, "external-resources.json"));
    const supervisor = new DurablePwnSessionSupervisor(supervisorOptions);
    created = await supervisor.create(requestValue, requestKey);
    const resourceInput = {
      id: `session:${created.sessionId}`,
      kind: "pwn-session" as const,
      runId,
      generation: 0,
      ownerLane: "executor" as const,
      externalId: created.externalId,
      requestKey,
    };
    const prepared = await new BindingTransactionCoordinator(control, externalResources).prepare({ sessionId: created.sessionId, resource: resourceInput });
    const sessionInput = {
      id: created.sessionId,
      runId,
      kind: "pwn-remote" as const,
      ownerLane: "executor" as const,
      generation: 0,
      externalId: created.externalId,
      requestKey,
    };
    const faulting = new BindingTransactionCoordinator(control, externalResources, {
      fault: (point) => point === "after_control_commit" ? (() => { throw new Error("injected remote Control Store boundary"); })() : undefined,
    });
    await assert.rejects(() => faulting.commitControl(prepared, sessionInput), /injected remote Control Store boundary/);
    assert.equal((await control.events(runId)).filter((event) => event.type === "session_opened").length, 1);
    assert.equal((await externalResources.get(resourceInput.id))?.state, "STARTED");

    const restartedSupervisor = new DurablePwnSessionSupervisor(supervisorOptions);
    assert.deepEqual(await restartedSupervisor.inspect(created.externalId, requestValue), { status: "PRESENT", externalId: created.externalId });
    assert.equal(await restartedSupervisor.adopt(created.externalId, requestValue), true);
    const wire = sessionRuntimeWireResource({
      schemaVersion: 1,
      ...resourceInput,
      state: "CONFIRMED",
      bindingTxnId: prepared.bindingTxnId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      inspectCount: 0,
    });
    await externalResources.markConfirmed(resourceInput.id, "exact remote worker inspect/adopt");
    const recovery = await new BindingTransactionCoordinator(control, externalResources).recover(runId, 0);
    assert.deepEqual(recovery, { repaired: [prepared.bindingTxnId], bound: [], releaseCandidates: [], manual: [] });
    assert.deepEqual(await restartedSupervisor.actions.pwnRead(wire, { waitTimeoutMs: 5_000, idleSilenceMs: 100 }), {
      delta: "remote-ready\n",
      waitReason: "data",
      exited: false,
      truncated: false,
    });
    assert.deepEqual(await restartedSupervisor.actions.pwnWrite(wire, "after-remote-recovery\n", { waitTimeoutMs: 5_000, idleSilenceMs: 100 }), {
      delta: "remote-echo:after-remote-recovery\n",
      waitReason: "data",
      exited: false,
      truncated: false,
    });
    assert.equal(await restartedSupervisor.release(created.externalId, requestValue, "remote handoff test cleanup"), true);
    created = undefined;
  } finally {
    if (created) await new DurablePwnSessionSupervisor(supervisorOptions).release(created.externalId, requestValue, "remote handoff test cleanup").catch(() => undefined);
    await new Promise<void>((resolveClose, reject) => fixture.close((error) => error ? reject(error) : resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
});

test("real remote TCP Pwn backend fault matrix never creates a replacement tube", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-pwn-remote-fault-matrix-"));
  const fixture = createServer((socket) => {
    socket.write("matrix-ready\n");
    socket.on("data", (chunk) => socket.write(`matrix-echo:${chunk.toString()}`));
  });
  await new Promise<void>((resolveListen, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  const faultPoints = ["after_external_started", "after_intent", "after_external_confirmed", "after_control_commit", "after_finalize"] as const;
  try {
    for (const [index, faultPoint] of faultPoints.entries()) {
      const runId = `PWN-REMOTE-FAULT-${index}`;
      const requestKey = `${"f".repeat(63)}${index.toString(16)}`;
      const endpoint = `127.0.0.1:${address.port}`;
      const requestValue: SessionRuntimeCreateRequest = {
        kind: "pwn-session",
        runId,
        generation: 0,
        ownerLane: "executor",
        requestKey,
        pwn: {
          mode: "remote",
          command: ["immutable", "deployment-hint"],
          endpoint,
          waitTimeoutMs: 5_000,
          idleSilenceMs: 100,
        },
      };
      const statePath = join(root, `pwn-supervisor-${index}.json`);
      const workerScript = join(process.cwd(), "scripts", "pwn-session-worker.mjs");
      const supervisorOptions = {
        statePath,
        workerScript,
        timeoutMs: 5_000,
        remoteScope: { allowedHosts: ["127.0.0.1"], allowedPorts: [address.port] },
      } as const;
      let created: { sessionId: string; externalId: string; stateHash: string } | undefined;
      try {
        const control = await makeControl(root, runId);
        const externalResources = new ExternalResourceRegistry(join(root, `external-resources-${index}.json`));
        const supervisor = new DurablePwnSessionSupervisor(supervisorOptions);
        created = await supervisor.create(requestValue, requestKey);
        const resourceInput = {
          id: `session:${created.sessionId}`,
          kind: "pwn-session" as const,
          runId,
          generation: 0,
          ownerLane: "executor" as const,
          externalId: created.externalId,
          requestKey,
        };
        const coordinator = new BindingTransactionCoordinator(control, externalResources);
        const faulting = new BindingTransactionCoordinator(control, externalResources, {
          fault: (point) => point === faultPoint ? (() => { throw new Error(`injected remote fault: ${faultPoint}`); })() : undefined,
        });

        if (faultPoint === "after_external_started") {
          await assert.rejects(() => faulting.prepare({ sessionId: created!.sessionId, resource: resourceInput }), /injected remote fault: after_external_started/);
          assert.deepEqual(await coordinator.intents(runId), []);
          assert.equal(await supervisor.release(created.externalId, requestValue, "remote matrix cleanup"), true);
          created = undefined;
          continue;
        }

        let intent = await coordinator.prepare({ sessionId: created.sessionId, resource: resourceInput });
        if (faultPoint === "after_intent") {
          await assert.rejects(() => faulting.prepare({ sessionId: created.sessionId, resource: resourceInput }), /injected remote fault: after_intent/);
          assert.equal((await coordinator.intents(runId)).length, 1);
          assert.deepEqual(await coordinator.recover(runId, 0), { repaired: [], bound: [], releaseCandidates: [intent.bindingTxnId], manual: [] });
          assert.equal(await supervisor.release(created.externalId, requestValue, "remote matrix cleanup"), true);
          created = undefined;
          continue;
        }

        await externalResources.markConfirmed(resourceInput.id, "remote matrix host confirmation");
        if (faultPoint === "after_external_confirmed") {
          await assert.rejects(() => faulting.markExternalConfirmed(intent), /injected remote fault: after_external_confirmed/);
          intent = await coordinator.get(intent.bindingTxnId) as typeof intent;
          assert.equal(intent.state, "EXTERNAL_CONFIRMED");
          assert.deepEqual(await coordinator.recover(runId, 0), { repaired: [], bound: [], releaseCandidates: [intent.bindingTxnId], manual: [] });
          assert.equal(await supervisor.release(created.externalId, requestValue, "remote matrix cleanup"), true);
          created = undefined;
          continue;
        }

        const sessionInput = {
          id: created.sessionId,
          runId,
          kind: "pwn-remote" as const,
          ownerLane: "executor" as const,
          generation: 0,
          externalId: created.externalId,
          requestKey,
        };
        if (faultPoint === "after_control_commit") {
          await assert.rejects(() => faulting.commitControl(intent, sessionInput), /injected remote fault: after_control_commit/);
          const restarted = new DurablePwnSessionSupervisor(supervisorOptions);
          assert.equal(await restarted.adopt(created.externalId, requestValue), true);
          const recovery = await coordinator.recover(runId, 0);
          assert.deepEqual(recovery, { repaired: [intent.bindingTxnId], bound: [], releaseCandidates: [], manual: [] });
          const bound = await externalResources.get(resourceInput.id);
          assert.deepEqual(await restarted.actions.pwnRead(sessionRuntimeWireResource(bound!), { waitTimeoutMs: 5_000, idleSilenceMs: 100 }), {
            delta: "matrix-ready\n",
            waitReason: "data",
            exited: false,
            truncated: false,
          });
          assert.deepEqual(await restarted.actions.pwnWrite(sessionRuntimeWireResource(bound!), "matrix-control\n", { waitTimeoutMs: 5_000, idleSilenceMs: 100 }), {
            delta: "matrix-echo:matrix-control\n",
            waitReason: "data",
            exited: false,
            truncated: false,
          });
          assert.equal(await restarted.release(created.externalId, requestValue, "remote matrix cleanup"), true);
          created = undefined;
          continue;
        }

        const committed = await coordinator.commitControl(intent, sessionInput);
        await assert.rejects(() => faulting.finalize(committed), /injected remote fault: after_finalize/);
        const finalized = await coordinator.recover(runId, 0);
        assert.deepEqual(finalized, { repaired: [], bound: [intent.bindingTxnId], releaseCandidates: [], manual: [] });
        const restarted = new DurablePwnSessionSupervisor(supervisorOptions);
        assert.equal(await restarted.adopt(created.externalId, requestValue), true);
        const bound = await externalResources.get(resourceInput.id);
        assert.equal(bound?.controlSessionId, created.sessionId);
        assert.deepEqual(await restarted.actions.pwnRead(sessionRuntimeWireResource(bound!), { waitTimeoutMs: 5_000, idleSilenceMs: 100 }), {
          delta: "matrix-ready\n",
          waitReason: "data",
          exited: false,
          truncated: false,
        });
        assert.deepEqual(await restarted.actions.pwnWrite(sessionRuntimeWireResource(bound!), "matrix-finalize\n", { waitTimeoutMs: 5_000, idleSilenceMs: 100 }), {
          delta: "matrix-echo:matrix-finalize\n",
          waitReason: "data",
          exited: false,
          truncated: false,
        });
        assert.equal(await restarted.release(created.externalId, requestValue, "remote matrix cleanup"), true);
        created = undefined;
      } finally {
        if (created) await new DurablePwnSessionSupervisor(supervisorOptions).release(created.externalId, requestValue, "remote matrix cleanup").catch(() => undefined);
      }
    }
  } finally {
    await new Promise<void>((resolveClose, reject) => fixture.close((error) => error ? reject(error) : resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
});
