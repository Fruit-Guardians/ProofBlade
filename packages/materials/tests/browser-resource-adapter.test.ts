import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices, demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import {
  BrowserContextResourceAdapter,
  withBrowserResourceAdapter,
} from "../src/web/browser-resource-adapter.js";
import {
  BrowserContextBackend,
  adoptVerifierBrowserSession,
  openVerifierBrowserSession,
  type BrowserContextPort,
  type BrowserRuntimeBroker,
  type BrowserVerifierFactory,
} from "../src/web/browser-session.js";
import { BrowserReproducer } from "../src/verification/browser-reproducer.js";
import { CodingClaimVerifier } from "../src/verification/claim-verification.js";
import {
  ExternalResourceRegistry,
  type ExternalResourceInspection,
  type ExternalResourceRecord,
} from "../src/recovery/external-resource-registry.js";
import { RunRecoveryService } from "../src/recovery/run-recovery.js";
import { canonicalJson, sha256 } from "../src/domain/utils.js";
import { beginVerificationRequest } from "../src/verification/verification-key.js";
import { serializeVerifierOutcomeEnvelope } from "../src/verification/outcome-envelope.js";

const config = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures" },
  modelProfiles: { executor: { thinkingLevel: "off" } },
} as unknown as ProofBladeConfig;

test("browser broker persists an opaque handle and recovery adopts the exact context", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-resource-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-BROKER";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const broker = new FakeBrowserBroker("browser-handle-1", "BROWSER-BROKER");
    const factory: BrowserVerifierFactory = {
      name: "test-browser-broker",
      runtimeBroker: broker,
      async createContext(request) {
        return {
          context: browserContext(),
          externalId: "browser-handle-1",
        };
      },
    };
    const request = {
      runId,
      generation: 0,
      target: "https://target.test/",
      policyHash: sha256("policy"),
      recipeHash: sha256("recipe"),
      allowedHosts: ["target.test"],
      allowedPorts: [],
      maxResponseBytes: 1_024,
    };
    const session = await openVerifierBrowserSession(factory, request, services.control, services.artifacts, undefined, services.externalResources);
    await session.open();
    const record = await services.externalResources.get(`session:${session.sessionId}`);
    assert.equal(record?.externalId, "browser-handle-1");
    assert.equal(record?.controlSessionId, session.sessionId);
    assert.equal(record?.policyHash, request.policyHash);
    assert.equal(record?.recipeHash, request.recipeHash);
    assert.equal(record?.scopeHash, sha256(canonicalJson({ target: "https://target.test", allowedHosts: ["target.test"], allowedPorts: [] })));

    const restarted = new ExternalResourceRegistry(join(root, ".proofblade", "external-resources.json"));
    const adapter = new BrowserContextResourceAdapter(broker);
    const adopted = await restarted.reconcileRun(runId, 0, [adapter]);
    assert.deepEqual(adopted, { examined: 1, adopted: [`session:${session.sessionId}`], released: [], unknown: [], failed: [] });
    assert.equal((await restarted.get(`session:${session.sessionId}`))?.state, "CONFIRMED");
    assert.equal(broker.createCount, 1, "recovery must adopt the existing opaque handle, not create a new context");
    await session.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser broker refuses mismatched ownership and only releases an exact stale context", async () => {
  const broker = new FakeBrowserBroker("handle");
  const adapter = new BrowserContextResourceAdapter(broker);
  const matching = browserRecord({ runId: "RUN-1", generation: 1, externalId: "handle" });
  const inspection = await adapter.inspect(matching);
  assert.equal(inspection.binding, "MATCH");
  assert.equal((await adapter.adopt(matching, inspection)).state, "CONFIRMED");
  assert.equal(adapter.takeBinding(matching.id)?.externalId, "handle");
  assert.equal(adapter.takeBinding(matching.id), undefined, "an adopted browser binding is transferred exactly once");
  assert.equal((await adapter.release(matching, "stale generation")).released, true);
  assert.equal(broker.releaseCount, 1);

  const mismatch = browserRecord({ runId: "RUN-2", generation: 1, externalId: "handle" });
  const foreign = await adapter.inspect(mismatch);
  assert.equal(foreign.binding, "MISMATCH");
  assert.equal((await adapter.release(mismatch, "foreign")).released, false);
  assert.equal(broker.releaseCount, 1, "a foreign context must never be released");

  const echoingForeignBroker: BrowserRuntimeBroker = {
    name: "echoing-foreign-browser",
    async inspect() { return { status: "PRESENT", binding: "MATCH", externalId: "foreign-handle" }; },
    async adopt() { throw new Error("foreign browser must not be adopted"); },
    async release() { throw new Error("foreign browser must not be released"); },
  };
  const echoingForeignAdapter = new BrowserContextResourceAdapter(echoingForeignBroker);
  const echoed = await echoingForeignAdapter.inspect(matching);
  assert.deepEqual(echoed, { status: "PRESENT", binding: "MISMATCH", externalId: "foreign-handle", summary: "Browser broker returned a different opaque handle" });
  assert.equal((await echoingForeignAdapter.adopt(matching, echoed)).state, "UNKNOWN");
  assert.equal((await echoingForeignAdapter.release(matching, "foreign")).released, false);
});

test("run recovery retains an adopted browser binding and protects the session from orphan supersession", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-handoff-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-HANDOFF";
    const task = demoTask(runId, root, config);
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);
    const broker = new FakeBrowserBroker("browser-handoff", runId);
    const factory: BrowserVerifierFactory = {
      name: "handoff-browser",
      runtimeBroker: broker,
      async createContext() {
        return { context: browserContext(), externalId: "browser-handoff" };
      },
    };
    const session = await openVerifierBrowserSession(factory, {
      runId,
      generation,
      target: "https://target.test/",
      policyHash: sha256("policy"),
      allowedHosts: ["target.test"],
      allowedPorts: [],
      maxResponseBytes: 1_024,
    }, services.control, services.artifacts, undefined, services.externalResources);
    await session.open();

    const restarted = new ExternalResourceRegistry(join(root, ".proofblade", "external-resources.json"));
    const adapter = new BrowserContextResourceAdapter(broker);
    const recovery = await new RunRecoveryService(
      services.control,
      services.journal,
      services.sandbox,
      services.fixtureControl,
      undefined,
      services.verificationRecovery,
      services.verificationRecoveryAdapters,
      restarted,
      [adapter],
    ).recover(runId);

    assert.equal(recovery.browserHandoffs.length, 1);
    assert.equal(recovery.browserHandoffs[0]?.binding.externalId, "browser-handoff");
    assert.equal(recovery.sessionHandoffs.length, 0);
    assert.equal((await services.control.snapshot(runId)).sessions[session.sessionId]?.status, "OPEN");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run recovery releases a browser handle started before its Control Store session event", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-unbound-start-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-UNBOUND-START";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const broker = new FakeBrowserBroker("browser-unbound-start", runId);
    broker.failReleaseCount = 1;
    const resourceId = "session:BROWSER-UNBOUND-SESSION";
    await services.externalResources.registerStarted({
      id: resourceId,
      kind: "browser-context",
      runId,
      generation: 0,
      ownerLane: "verifier",
      externalId: "browser-unbound-start",
      policyHash: sha256("policy"),
    });

    const recoveryService = new RunRecoveryService(
      services.control,
      services.journal,
      services.sandbox,
      services.fixtureControl,
      undefined,
      services.verificationRecovery,
      services.verificationRecoveryAdapters,
      services.externalResources,
      [new BrowserContextResourceAdapter(broker)],
    );
    const failedRecovery = await recoveryService.recover(runId);

    assert.deepEqual(failedRecovery.externalResources?.released, []);
    assert.deepEqual(failedRecovery.externalResources?.failed, [resourceId]);
    assert.deepEqual(failedRecovery.externalResources?.adopted, []);
    assert.equal(broker.releaseCount, 0, "a failed release must not be reported as successful or adopted");
    assert.equal((await services.externalResources.get(resourceId))?.state, "UNKNOWN");

    const recovery = await recoveryService.recover(runId);
    assert.deepEqual(recovery.externalResources?.released, [resourceId]);
    assert.equal(broker.releaseCount, 1, "the next recovery must retry the exact unbound handle");
    assert.equal((await services.externalResources.get(resourceId))?.state, "RELEASED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run recovery adopts a browser whose Control Store event committed before the binding marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-binding-marker-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-BINDING-MARKER";
    const task = demoTask(runId, root, config);
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);
    const broker = new FakeBrowserBroker("browser-binding-marker", runId);
    const registry = new FailingControlBindingRegistry(join(root, "external-resources.json"));
    const factory: BrowserVerifierFactory = {
      name: "binding-marker-browser",
      runtimeBroker: broker,
      async createContext() { return { context: browserContext(), externalId: "browser-binding-marker" }; },
    };
    const session = await openVerifierBrowserSession(factory, {
      runId,
      generation,
      target: "https://target.test/",
      policyHash: sha256("policy"),
      allowedHosts: ["target.test"],
      allowedPorts: [],
      maxResponseBytes: 1_024,
    }, services.control, services.artifacts, undefined, registry);
    await assert.rejects(() => session.open(), /simulated binding marker failure/);
    assert.equal((await services.control.snapshot(runId)).sessions[session.sessionId]?.status, "OPEN");
    assert.equal((await registry.get(`session:${session.sessionId}`))?.state, "UNKNOWN");

    const recovery = await new RunRecoveryService(
      services.control,
      services.journal,
      services.sandbox,
      services.fixtureControl,
      undefined,
      services.verificationRecovery,
      services.verificationRecoveryAdapters,
      registry,
      [new BrowserContextResourceAdapter(broker)],
    ).recover(runId, task);

    assert.deepEqual(recovery.externalResources?.released, []);
    assert.equal(recovery.browserHandoffs.length, 1, "a committed Control Store session remains adoptable");
    assert.equal(broker.releaseCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run recovery releases a resource whose Control Store owner is already closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-closed-owner-"));
  try {
    const runId = "BROWSER-CLOSED-OWNER";
    const services = createServices(root, config);
    const task = demoTask(runId, root, config);
    await services.control.createRun(runId, task);
    const sessionId = "BROWSER-CLOSED-SESSION";
    const externalId = "browser-closed-handle";
    await services.control.dispatch(runId, {
      type: "session_opened",
      session: { id: sessionId, runId, kind: "browser", ownerLane: "verifier", generation: 0, endpoint: "https://target.test", externalId },
      lane: "verifier",
    });
    await services.control.dispatch(runId, { type: "session_closed", sessionId, reason: "test owner closed", lane: "verifier" });
    await services.externalResources.registerStarted({ id: `session:${sessionId}`, kind: "browser-context", runId, generation: 0, ownerLane: "verifier", externalId });
    await services.externalResources.markControlBound(`session:${sessionId}`, sessionId);
    const broker = new FakeBrowserBroker(runId, runId, externalId);
    const recovery = await new RunRecoveryService(
      services.control,
      services.journal,
      services.sandbox,
      services.fixtureControl,
      undefined,
      services.verificationRecovery,
      services.verificationRecoveryAdapters,
      services.externalResources,
      [new BrowserContextResourceAdapter(broker)],
    ).recover(runId, task);
    assert.equal(broker.releaseCount, 1);
    assert.equal((await services.externalResources.get(`session:${sessionId}`))?.state, "RELEASED");
    assert.ok(recovery.externalResources?.released.includes(`session:${sessionId}`));
    assert.deepEqual(recovery.browserHandoffs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser open closes the external driver when the Control Store owner write fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-owner-write-failure-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-OWNER-WRITE-FAILURE";
    const task = demoTask(runId, root, config);
    await services.control.createRun(runId, task);
    let closeCount = 0;
    const driver = { ...browserContext(), close: async () => { closeCount += 1; } } satisfies BrowserContextPort;
    const control = new Proxy(services.control, {
      get(target, property, receiver) {
        if (property === "dispatchBindingTransaction") {
          return async (...args: Parameters<typeof services.control.dispatchBindingTransaction>) => {
            return await services.control.dispatchBindingTransaction(args[0], (snapshot) => {
              const transaction = args[1](snapshot);
              if (transaction.commands.some((command) => command.type === "session_opened")) throw new Error("simulated Control Store owner write failure");
              return transaction;
            });
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof services.control;
    const session = new BrowserContextBackend(runId, "verifier", "https://target.test/", driver, control, services.artifacts, undefined, ["target.test"], [], 1_024, services.externalResources, { externalId: "browser-owner-write-failure" });
    await assert.rejects(() => session.open(), /simulated Control Store owner write failure/);
    assert.equal(closeCount, 1);
    assert.equal((await services.externalResources.get(`session:${session.sessionId}`))?.state, "RELEASED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run recovery releases a broker context whose replay result finished before session close", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-finished-cleanup-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-FINISHED-CLEANUP";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    task.target = "https://target.test/";
    task.scope.allowed_hosts = ["target.test"];
    task.verification.web = { flag_pattern: "flag\\{[^}]+\\}", transport: "browser" };
    task.verification.required_reproductions = 1;
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);
    const broker = new FakeBrowserBroker("browser-finished-cleanup", runId);
    broker.failReleaseCount = 1;
    const factory: BrowserVerifierFactory = {
      name: "finished-cleanup-browser",
      runtimeBroker: broker,
      async createContext() { return { context: browserContext("flag{finished}"), externalId: "browser-finished-cleanup" }; },
    };
    const claims = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
    const policyHash = sha256(canonicalJson(task.verification.web));
    const recipe = { transport: "browser" as const, steps: [{ path: "/flag" }] };
    const recipeHash = sha256(canonicalJson(recipe));
    const request = await beginVerificationRequest(services.control, runId, { kind: "browser", policyHash, recipeHash });
    const attemptId = sha256(`${runId}:${request.request.id}:browser:1`);
    const replay = await claims.prepareReplay({
      verificationRequestId: request.request.id,
      verificationKey: request.request.key,
      kind: "browser",
      policyHash,
      recipeHash,
      attemptId,
      cwd: task.scope.allowed_workspace,
      recoveryInput: { content: JSON.stringify({ schemaVersion: 1, kind: "browser", steps: recipe.steps }), filename: "browser-finished-cleanup.json", mime: "application/json", sensitivity: "secret" },
    });
    const session = await openVerifierBrowserSession(factory, {
      runId,
      generation,
      target: task.target,
      policyHash,
      recipeHash,
      verificationKey: request.request.key,
      allowedHosts: task.scope.allowed_hosts,
      allowedPorts: task.scope.allowed_ports,
      maxResponseBytes: 1_024,
    }, services.control, services.artifacts, undefined, services.externalResources);
    await session.open();
    await claims.startReplay(replay.effectId, session.sessionId, session.externalId);
    const response = await session.navigate("/flag");
    await claims.finishReplay(replay.effectId, {
      stdout: serializeVerifierOutcomeEnvelope({
        schemaVersion: 1,
        requestKey: request.request.key,
        runId,
        generation,
        kind: "browser",
        policyHash,
        recipeHash,
        externalId: session.sessionId,
        externalStatus: "CONFIRMED",
        attempts: [{ id: attemptId, phase: "browser_replay", status: "PASSED", externalId: session.sessionId, summary: "browser replay finished before process crash" }],
        transcriptArtifactIds: [response.artifactId],
        stageSummary: { reproduced: true, actionCount: 1, artifactCount: 1 },
        evidenceIds: [],
        terminal: false,
      }, { replay: true }),
      stderr: "",
      exitCode: 0,
      durationMs: 0,
      externalId: session.sessionId,
    });

    const restarted = new ExternalResourceRegistry(join(root, ".proofblade", "external-resources.json"));
    const adapter = new BrowserContextResourceAdapter(broker);
    const recoveryService = new RunRecoveryService(
      services.control,
      services.journal,
      services.sandbox,
      services.fixtureControl,
      undefined,
      services.verificationRecovery,
      services.verificationRecoveryAdapters,
      restarted,
      [adapter],
    );
    const failedRecovery = await recoveryService.recover(runId, task);

    assert.equal(failedRecovery.browserHandoffs.length, 1, "a failed broker release must retain the handoff for retry");
    assert.deepEqual(failedRecovery.externalResources?.released, []);
    assert.deepEqual(failedRecovery.externalResources?.failed, [`session:${session.sessionId}`]);
    assert.equal(broker.releaseCount, 0, "a rejected release must not be reported as successful");
    assert.equal((await restarted.get(`session:${session.sessionId}`))?.state, "UNKNOWN");
    assert.equal((await services.control.snapshot(runId)).sessions[session.sessionId]?.status, "OPEN");

    const recovery = await recoveryService.recover(runId, task);

    assert.deepEqual(recovery.browserHandoffs, [], "a finished replay must not hand a dead attempt back to the next lane");
    assert.deepEqual(recovery.externalResources?.released, [`session:${session.sessionId}`]);
    assert.equal(broker.releaseCount, 1, "the broker context is released exactly once");
    assert.equal((await services.control.snapshot(runId)).sessions[session.sessionId]?.status, "CLOSED");
    assert.equal((await restarted.get(`session:${session.sessionId}`))?.state, "RELEASED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("BrowserReproducer resumes an adopted in-flight context without creating a second browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-resume-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-RESUME";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    task.target = "https://target.test/";
    task.scope.allowed_hosts = ["target.test"];
    task.verification.required_reproductions = 1;
    task.verification.web = { flag_pattern: "flag\\{[^}]+\\}", transport: "browser" };
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);
    const broker = new FakeBrowserBroker("browser-resume", runId);
    const factory: BrowserVerifierFactory = {
      name: "resume-browser",
      runtimeBroker: broker,
      async createContext() {
        return { context: browserContext("partial"), externalId: "browser-resume" };
      },
    };
    const claims = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
    const policyHash = sha256(canonicalJson(task.verification.web));
    const recipe = { transport: "browser" as const, steps: [{ path: "/partial" }, { path: "/flag" }] };
    const recipeHash = sha256(canonicalJson(recipe));
    const request = await beginVerificationRequest(services.control, runId, { kind: "browser", policyHash, recipeHash });
    const replay = await claims.prepareReplay({
      verificationRequestId: request.request.id,
      verificationKey: request.request.key,
      kind: "browser",
      policyHash,
      recipeHash,
      attemptId: sha256(`${runId}:${request.request.id}:browser:1`),
      cwd: task.scope.allowed_workspace,
      recoveryInput: { content: JSON.stringify({ schemaVersion: 1, kind: "browser", steps: recipe.steps }), filename: "browser-resume.json", mime: "application/json", sensitivity: "secret" },
    });
    const session = await openVerifierBrowserSession(factory, {
      runId,
      generation,
      target: task.target,
      policyHash,
      recipeHash,
      verificationKey: request.request.key,
      allowedHosts: task.scope.allowed_hosts,
      allowedPorts: task.scope.allowed_ports,
      maxResponseBytes: 1_024,
    }, services.control, services.artifacts, undefined, services.externalResources);
    await session.open();
    await claims.startReplay(replay.effectId, session.sessionId, session.externalId);
    await session.navigate("/partial");

    const restarted = new ExternalResourceRegistry(join(root, ".proofblade", "external-resources.json"));
    const adapter = new BrowserContextResourceAdapter(broker);
    const recovery = await new RunRecoveryService(
      services.control,
      services.journal,
      services.sandbox,
      services.fixtureControl,
      undefined,
      services.verificationRecovery,
      services.verificationRecoveryAdapters,
      restarted,
      [adapter],
    ).recover(runId, task);
    assert.equal(recovery.browserHandoffs.length, 1);
    const reproducer = new BrowserReproducer(services.control, services.artifacts, {
      prepareReplay: (input) => claims.prepareReplay(input),
      startReplay: (effectId, sessionId, externalId) => claims.startReplay(effectId, sessionId, externalId),
      finishReplay: (effectId, result) => claims.finishReplay(effectId, result),
      executeEffect: async (input, signal) => await claims.executeBrowserReproductionEffect(input, signal),
      recordEvidence: async (_id, evidence) => await services.verifier.dispatch(runId, { type: "evidence", evidence }),
      recordDomainRecords: async (_id, records) => await claims.recordVerifierDomainRecords(records),
      finalize: async (_id, completionId, accepted, evidenceIds) => await claims.finalizeBrowserReproduction(completionId, accepted, evidenceIds),
    }, {
      handoffs: recovery.browserHandoffs,
      createRecoveredSession: async (handoff, requestInput) => await adoptVerifierBrowserSession(handoff.binding, requestInput, session.sessionId, services.control, services.artifacts, restarted),
    });
    const result = await reproducer.reproduce(runId, recipe, async () => {
      throw new Error("recovery must not create a clean browser");
    });
    assert.equal(result.reproduced, true);
    assert.equal(result.flag, "flag{recovered}");
    assert.equal(broker.createCount, 1, "the resumed replay must reuse the broker context");
    assert.equal((await services.control.snapshot(runId)).sessions[session.sessionId]?.status, "CLOSED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("BrowserReproducer resumes a later in-flight attempt and reuses earlier finished attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-multi-attempt-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-MULTI-ATTEMPT";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    task.target = "https://target.test/";
    task.scope.allowed_hosts = ["target.test"];
    task.verification.required_reproductions = 2;
    task.verification.web = { flag_pattern: "flag\\{[^}]+\\}", transport: "browser" };
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);
    const broker = new FakeBrowserBroker("browser-multi-attempt", runId);
    const factory: BrowserVerifierFactory = {
      name: "multi-attempt-browser",
      runtimeBroker: broker,
      async createContext(request) {
        return { context: browserContext("flag{recovered}"), externalId: "browser-multi-attempt" };
      },
    };
    const claims = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
    const policyHash = sha256(canonicalJson(task.verification.web));
    const recipe = { transport: "browser" as const, steps: [{ path: "/flag" }, { path: "/flag-again" }] };
    const recipeHash = sha256(canonicalJson(recipe));
    const request = await beginVerificationRequest(services.control, runId, { kind: "browser", policyHash, recipeHash });
    const firstAttemptId = sha256(`${runId}:${request.request.id}:browser:1`);
    const firstReplay = await claims.prepareReplay({
      verificationRequestId: request.request.id,
      verificationKey: request.request.key,
      kind: "browser",
      policyHash,
      recipeHash,
      attemptId: firstAttemptId,
      cwd: task.scope.allowed_workspace,
      recoveryInput: { content: JSON.stringify({ schemaVersion: 1, kind: "browser", steps: recipe.steps }), filename: "browser-multi-attempt.json", mime: "application/json", sensitivity: "secret" },
    });
    const firstSession = await openVerifierBrowserSession(factory, {
      runId,
      generation,
      target: task.target,
      policyHash,
      recipeHash,
      verificationKey: request.request.key,
      allowedHosts: task.scope.allowed_hosts,
      allowedPorts: task.scope.allowed_ports,
      maxResponseBytes: 1_024,
    }, services.control, services.artifacts, undefined, services.externalResources);
    await firstSession.open();
    await claims.startReplay(firstReplay.effectId, firstSession.sessionId, firstSession.externalId);
    const firstResponse = await firstSession.navigate("/flag");
    await claims.finishReplay(firstReplay.effectId, {
      stdout: serializeVerifierOutcomeEnvelope({
        schemaVersion: 1,
        requestKey: request.request.key,
        runId,
        generation,
        kind: "browser",
        policyHash,
        recipeHash,
        externalId: firstSession.sessionId,
        externalStatus: "CONFIRMED",
        attempts: [{ id: firstAttemptId, phase: "browser_replay", status: "PASSED", externalId: firstSession.sessionId, summary: "first browser attempt passed" }],
        transcriptArtifactIds: [firstResponse.artifactId],
        stageSummary: { reproduced: true, actionCount: 1, artifactCount: 1 },
        evidenceIds: [],
        terminal: false,
      }, { replay: true }),
      stderr: "",
      exitCode: 0,
      durationMs: 0,
      externalId: firstSession.sessionId,
    });
    await firstSession.close();

    const secondAttemptId = sha256(`${runId}:${request.request.id}:browser:2`);
    const secondReplay = await claims.prepareReplay({
      verificationRequestId: request.request.id,
      verificationKey: request.request.key,
      kind: "browser",
      policyHash,
      recipeHash,
      attemptId: secondAttemptId,
      cwd: task.scope.allowed_workspace,
      recoveryInput: { content: JSON.stringify({ schemaVersion: 1, kind: "browser", steps: recipe.steps }), filename: "browser-multi-attempt.json", mime: "application/json", sensitivity: "secret" },
    });
    const secondSession = await openVerifierBrowserSession(factory, {
      runId,
      generation,
      target: task.target,
      policyHash,
      recipeHash,
      verificationKey: request.request.key,
      allowedHosts: task.scope.allowed_hosts,
      allowedPorts: task.scope.allowed_ports,
      maxResponseBytes: 1_024,
    }, services.control, services.artifacts, undefined, services.externalResources);
    await secondSession.open();
    await claims.startReplay(secondReplay.effectId, secondSession.sessionId, secondSession.externalId);
    await secondSession.navigate("/flag");

    const restarted = new ExternalResourceRegistry(join(root, ".proofblade", "external-resources.json"));
    const adapter = new BrowserContextResourceAdapter(broker);
    const recovery = await new RunRecoveryService(
      services.control,
      services.journal,
      services.sandbox,
      services.fixtureControl,
      undefined,
      services.verificationRecovery,
      services.verificationRecoveryAdapters,
      restarted,
      [adapter],
    ).recover(runId, task);
    assert.equal(recovery.browserHandoffs.length, 1);
    assert.equal(recovery.browserHandoffs[0]?.resourceId, `session:${secondSession.sessionId}`);

    const reproducer = new BrowserReproducer(services.control, services.artifacts, {
      prepareReplay: (input) => claims.prepareReplay(input),
      startReplay: (effectId, sessionId, externalId) => claims.startReplay(effectId, sessionId, externalId),
      finishReplay: (effectId, result) => claims.finishReplay(effectId, result),
      executeEffect: async (input, signal) => await claims.executeBrowserReproductionEffect(input, signal),
      recordEvidence: async (_id, evidence) => await services.verifier.dispatch(runId, { type: "evidence", evidence }),
      recordDomainRecords: async (_id, records) => await claims.recordVerifierDomainRecords(records),
      finalize: async (_id, completionId, accepted, evidenceIds) => await claims.finalizeBrowserReproduction(completionId, accepted, evidenceIds),
    }, {
      handoffs: recovery.browserHandoffs,
      createRecoveredSession: async (handoff, requestInput) => await adoptVerifierBrowserSession(handoff.binding, requestInput, secondSession.sessionId, services.control, services.artifacts, restarted),
    });
    const result = await reproducer.reproduce(runId, recipe, async () => {
      throw new Error("multi-attempt recovery must not create a clean browser");
    });
    assert.equal(result.reproduced, true);
    assert.equal(result.flag, "flag{recovered}");
    assert.equal(broker.createCount, 1, "recovery must adopt the later attempt without creating another browser");
    assert.equal((await services.control.snapshot(runId)).sessions[secondSession.sessionId]?.status, "CLOSED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a factory without a broker remains fail-closed after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-no-broker-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-NO-BROKER";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const factory: BrowserVerifierFactory = { name: "in-process-only", async createContext() { return browserContext(); } };
    const session = await openVerifierBrowserSession(factory, {
      runId,
      generation: 0,
      target: "https://target.test/",
      policyHash: sha256("policy"),
      allowedHosts: ["target.test"],
      allowedPorts: [],
      maxResponseBytes: 1_024,
    }, services.control, services.artifacts, undefined, services.externalResources);
    await session.open();
    const restarted = new ExternalResourceRegistry(join(root, ".proofblade", "external-resources.json"));
    const result = await restarted.reconcileRun(runId, 0);
    assert.deepEqual(result, { examined: 1, adopted: [], released: [], unknown: [`session:${session.sessionId}`], failed: [] });
    assert.equal((await restarted.get(`session:${session.sessionId}`))?.state, "UNKNOWN");
    await session.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser recovery adapter composition preserves lazy existing adapters", async () => {
  const broker = new FakeBrowserBroker("handle");
  const factory: BrowserVerifierFactory = { name: "broker", runtimeBroker: broker, async createContext() { return browserContext(); } };
  const source = withBrowserResourceAdapter([{ kind: "container", inspect: async () => ({ status: "ABSENT", binding: "UNKNOWN" }), adopt: async () => ({ state: "UNKNOWN" }), release: async () => ({ released: true }) }], factory);
  const adapters = await (typeof source === "function" ? source({ runId: "RUN", generation: 0 }) : source);
  assert.deepEqual(adapters?.map((item) => item.kind), ["container", "browser-context"]);
});

test("browser broker inspection timeout remains UNKNOWN and retryable", async () => {
  const broker: BrowserRuntimeBroker = {
    name: "hanging-browser-broker",
    async inspect() { await new Promise<void>(() => undefined); return { status: "PRESENT", binding: "MATCH" }; },
    async adopt() { return { state: "UNKNOWN", summary: "not reached" }; },
    async release() { return { released: false, summary: "not reached" }; },
  };
  const adapter = new BrowserContextResourceAdapter(broker, { timeoutMs: 100 });
  await assert.rejects(() => adapter.inspect(browserRecord({ runId: "RUN-1", generation: 1, externalId: "handle" })), /timed out/);
});

test("BrowserReproducer fails closed when one request has two in-flight attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-browser-concurrent-inflight-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-CONCURRENT-INFLIGHT";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    task.target = "https://target.test/";
    task.scope.allowed_hosts = ["target.test"];
    task.verification.required_reproductions = 2;
    task.verification.web = { flag_pattern: "flag\\{[^}]+\\}", transport: "browser" };
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);

    const broker = new MultiHandleBrowserBroker(["browser-concurrent-1", "browser-concurrent-2"], runId);
    let createIndex = 0;
    const factory: BrowserVerifierFactory = {
      name: "concurrent-inflight-browser",
      runtimeBroker: broker,
      async createContext() {
        const externalId = ["browser-concurrent-1", "browser-concurrent-2"][createIndex++];
        if (!externalId) throw new Error("test browser factory created too many contexts");
        return { context: browserContext("partial"), externalId };
      },
    };
    const claims = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
    const policyHash = sha256(canonicalJson(task.verification.web));
    const recipe = { transport: "browser" as const, steps: [{ path: "/flag" }] };
    const recipeHash = sha256(canonicalJson(recipe));
    const request = await beginVerificationRequest(services.control, runId, { kind: "browser", policyHash, recipeHash });
    for (const [index, externalId] of ["browser-concurrent-1", "browser-concurrent-2"].entries()) {
      const attemptId = sha256(`${runId}:${request.request.id}:browser:${index + 1}`);
      const replay = await claims.prepareReplay({
        verificationRequestId: request.request.id,
        verificationKey: request.request.key,
        kind: "browser",
        policyHash,
        recipeHash,
        attemptId,
        cwd: task.scope.allowed_workspace,
        recoveryInput: { content: JSON.stringify({ schemaVersion: 1, kind: "browser", steps: recipe.steps }), filename: `browser-concurrent-${index + 1}.json`, mime: "application/json", sensitivity: "secret" },
      });
      const session = await openVerifierBrowserSession(factory, {
        runId,
        generation,
        target: task.target,
        policyHash,
        recipeHash,
        verificationKey: request.request.key,
        allowedHosts: task.scope.allowed_hosts,
        allowedPorts: task.scope.allowed_ports,
        maxResponseBytes: 1_024,
      }, services.control, services.artifacts, undefined, services.externalResources);
      await session.open();
      assert.equal(session.externalId, externalId);
      await claims.startReplay(replay.effectId, session.sessionId, session.externalId);
    }

    const restarted = new ExternalResourceRegistry(join(root, ".proofblade", "external-resources.json"));
    const recovery = await new RunRecoveryService(
      services.control,
      services.journal,
      services.sandbox,
      services.fixtureControl,
      undefined,
      services.verificationRecovery,
      services.verificationRecoveryAdapters,
      restarted,
      [new BrowserContextResourceAdapter(broker)],
    ).recover(runId, task);
    assert.equal(recovery.browserHandoffs.length, 2);

    const reproducer = new BrowserReproducer(services.control, services.artifacts, claims, {
      handoffs: recovery.browserHandoffs,
      createRecoveredSession: async () => {
        throw new Error("two in-flight attempts must be rejected before session adoption");
      },
    });
    await assert.rejects(
      () => reproducer.reproduce(runId, recipe, async () => { throw new Error("two in-flight attempts must not open a clean browser"); }),
      /multiple in-flight attempts/,
    );
    const snapshot = await services.control.snapshot(runId);
    assert.equal(Object.values(snapshot.sessions).filter((session) => session.status === "OPEN").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class FakeBrowserBroker implements BrowserRuntimeBroker {
  public createCount = 1;
  public releaseCount = 0;
  public failReleaseCount = 0;

  public constructor(public readonly name: string, private readonly expectedRunId = "RUN-1", private readonly handle = name) {}

  public async inspect(record: ExternalResourceRecord): Promise<ExternalResourceInspection> {
    if (record.externalId !== this.handle || record.runId !== this.expectedRunId) return { status: "PRESENT", binding: "MISMATCH", externalId: this.handle, summary: "foreign browser owner" };
    return { status: "PRESENT", binding: "MATCH", externalId: this.handle, summary: "broker owns browser context" };
  }

  public async adopt(_record: ExternalResourceRecord, inspection: ExternalResourceInspection): Promise<{ state: "CONFIRMED" | "UNKNOWN"; summary?: string; binding?: { kind: "browser-context"; externalId: string; context: BrowserContextPort } }> {
    return inspection.binding === "MATCH"
      ? { state: "CONFIRMED", summary: "adopted", binding: { kind: "browser-context", externalId: this.handle, context: browserContext(this.handle === "browser-resume" || this.handle === "browser-multi-attempt" ? "flag{recovered}" : undefined) } }
      : { state: "UNKNOWN", summary: "foreign" };
  }

  public async release(record: ExternalResourceRecord): Promise<{ released: boolean; summary?: string }> {
    if (record.runId !== this.expectedRunId || record.externalId !== this.handle) return { released: false, summary: "foreign" };
    if (this.failReleaseCount > 0) {
      this.failReleaseCount -= 1;
      return { released: false, summary: "broker release unavailable" };
    }
    this.releaseCount += 1;
    return { released: true, summary: "released" };
  }
}

class FailingControlBindingRegistry extends ExternalResourceRegistry {
  public override async markControlBound(): Promise<never> {
    throw new Error("simulated binding marker failure");
  }
}

class MultiHandleBrowserBroker implements BrowserRuntimeBroker {
  public readonly name = "multi-handle-browser-broker";

  public constructor(private readonly handles: readonly string[], private readonly expectedRunId: string) {}

  public async inspect(record: ExternalResourceRecord): Promise<ExternalResourceInspection> {
    return record.runId === this.expectedRunId && record.externalId !== undefined && this.handles.includes(record.externalId)
      ? { status: "PRESENT", binding: "MATCH", externalId: record.externalId, summary: "broker owns browser context" }
      : { status: "PRESENT", binding: "MISMATCH", summary: "foreign browser owner" };
  }

  public async adopt(_record: ExternalResourceRecord, inspection: ExternalResourceInspection): Promise<{ state: "CONFIRMED" | "UNKNOWN"; summary?: string; binding?: { kind: "browser-context"; externalId: string; context: BrowserContextPort } }> {
    return inspection.binding === "MATCH" && inspection.externalId
      ? { state: "CONFIRMED", summary: "adopted", binding: { kind: "browser-context", externalId: inspection.externalId, context: browserContext("flag{recovered}") } }
      : { state: "UNKNOWN", summary: "foreign" };
  }

  public async release(): Promise<{ released: boolean; summary?: string }> {
    return { released: true, summary: "released" };
  }
}

function browserContext(content = "browser"): BrowserContextPort {
  return {
    async goto() { return { status: 200, content }; },
    async currentUrl() { return "https://target.test/"; },
    async storageState() { return { cookies: [], origins: [] }; },
    async close() {},
  };
}

function browserRecord(input: Pick<ExternalResourceRecord, "runId" | "generation" | "externalId">): ExternalResourceRecord {
  return {
    schemaVersion: 1,
    id: "session:BROWSER",
    kind: "browser-context",
    ownerLane: "verifier",
    state: "STARTED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    inspectCount: 0,
    ...input,
  };
}
