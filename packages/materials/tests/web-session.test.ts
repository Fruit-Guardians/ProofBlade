import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices, demoTask } from "../src/app/demo.js";
import { fixtureTask } from "../src/app/fixture-task.js";
import type { ProofBladeConfig } from "../src/config.js";
import { RunRecoveryService } from "../src/recovery/run-recovery.js";
import { HttpSessionBackend } from "../src/web/http-session.js";
import { BrowserContextBackend, openVerifierBrowserSession, type BrowserContextPort, type BrowserVerifierFactory } from "../src/web/browser-session.js";
import { createPlaywrightBrowserVerifierFactory, tryCreatePlaywrightBrowserVerifierFactory, type PlaywrightChromiumPort, type PlaywrightPagePort } from "../src/web/playwright-browser-verifier.js";
import { WebReproducer, type WebVerifierPort } from "../src/verification/web-reproducer.js";
import { BrowserReproducer } from "../src/verification/browser-reproducer.js";
import { beginVerificationRequest } from "../src/verification/verification-key.js";
import { createWebSessionTools } from "../src/runtime/web-coding-tools.js";
import type { CodingResourceContext } from "../src/runtime/coding-resources.js";
import { WebToolHandler } from "../src/web/web-tools.js";
import { CodingClaimVerifier } from "../src/verification/claim-verification.js";
import type { Evidence } from "../src/domain/types.js";
import { canonicalJson, sha256 } from "../src/domain/utils.js";
import { ExternalResourceRegistry, type ExternalResourceInspection, type ExternalResourceRecord } from "../src/recovery/external-resource-registry.js";
import { SessionResourceAdapter, type SessionRuntimeBroker } from "../src/recovery/session-resource-adapter.js";
import { BindingTransactionCoordinator } from "../src/recovery/binding-transaction-coordinator.js";

const config = { schemaVersion: 1, runtime: { piVersion: "0.83.0" }, storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" }, modelProfiles: { executor: { thinkingLevel: "off" } } } as unknown as ProofBladeConfig;

function webVerifier(services: ReturnType<typeof createServices>, runId: string): WebVerifierPort {
  const claims = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
  return {
    prepareReplay: (input) => claims.prepareReplay(input),
    startReplay: (effectId, sessionId, externalId) => claims.startReplay(effectId, sessionId, externalId),
    finishReplay: (effectId, result) => claims.finishReplay(effectId, result),
    executeEffect: (input: Parameters<CodingClaimVerifier["executeWebReproductionEffect"]>[0], signal?: AbortSignal) => claims.executeWebReproductionEffect(input, signal),
    recordEvidence: (id: string, evidence: Omit<Evidence, "createdSeq" | "provenance">) => services.verifier.dispatch(id, { type: "evidence", evidence }),
    recordDomainRecords: (id: string, records) => claims.recordVerifierDomainRecords(records),
    finalize: (_id: string, completionId: string, accepted: boolean, evidenceIds: string[]) => claims.finalizeWebReproduction(completionId, accepted, evidenceIds),
  };
}

function browserVerifier(services: ReturnType<typeof createServices>, runId: string): WebVerifierPort {
  const claims = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
  return {
    prepareReplay: (input) => claims.prepareReplay(input),
    startReplay: (effectId, sessionId, externalId) => claims.startReplay(effectId, sessionId, externalId),
    finishReplay: (effectId, result) => claims.finishReplay(effectId, result),
    executeEffect: (input: Parameters<CodingClaimVerifier["executeBrowserReproductionEffect"]>[0], signal?: AbortSignal) => claims.executeBrowserReproductionEffect(input, signal),
    recordEvidence: (id: string, evidence: Omit<Evidence, "createdSeq" | "provenance">) => services.verifier.dispatch(id, { type: "evidence", evidence }),
    recordDomainRecords: (id: string, records) => claims.recordVerifierDomainRecords(records),
    finalize: (_id: string, completionId: string, accepted: boolean, evidenceIds: string[]) => claims.finalizeBrowserReproduction(completionId, accepted, evidenceIds),
  };
}

test("HTTP session reuses Cookie/CSRF within one run and WebReproducer uses a clean session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-http-session-"));
  const server = createServer((request, response) => {
    if (request.url === "/login") {
      response.setHeader("set-cookie", "sid=abc; HttpOnly; Path=/");
      response.end('<meta name="csrf-token" content="token-123">logged in');
      return;
    }
    const authenticated = request.headers.cookie === "sid=abc" && request.headers["x-csrf-token"] === "token-123";
    response.statusCode = authenticated ? 200 : 403;
    response.end(authenticated ? "flag{web-clean}" : "forbidden");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const services = createServices(root, config);
    const runId = "WEB-SESSION";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    task.verification.web = { flag_pattern: "flag\\{[^}]+\\}" };
    await services.control.createRun(runId, task);
    const session = await HttpSessionBackend.open({ runId, baseUrl, ownerLane: "executor", controlStore: services.control, artifactStore: services.artifacts, allowedHosts: ["127.0.0.1"] });
    await session.request("/login");
    const flag = await session.request("/flag");
    assert.equal(flag.status, 200);
    assert.match(flag.body, /flag\{web-clean\}/);
    await session.close();

    const otherRun = "WEB-OTHER";
    await services.control.createRun(otherRun, demoTask(otherRun, root, config));
    const isolated = await HttpSessionBackend.open({ runId: otherRun, baseUrl, ownerLane: "executor", controlStore: services.control, artifactStore: services.artifacts });
    assert.equal((await isolated.request("/flag")).status, 403, "cookies must not cross runs");
    await isolated.close();

    const reproducer = new WebReproducer(services.control, services.artifacts, webVerifier(services, runId));
    const result = await reproducer.reproduce(runId, { steps: [{ path: "/login", expectStatus: 200 }, { path: "/flag", expectStatus: 200 }] }, async () => await HttpSessionBackend.open({ runId, baseUrl, ownerLane: "verifier", controlStore: services.control, artifactStore: services.artifacts }));
    assert.equal(result.reproduced, true);
    assert.equal(result.flag, "flag{web-clean}");
    const snapshot = await services.control.replay(runId);
    const replayEffects = Object.values(snapshot.effects).filter((effect) => effect.operation === "verification_replay");
    assert.equal(replayEffects.length, 2);
    assert.ok(replayEffects.every((effect) => effect.status === "FINISHED" && effect.verification === undefined));
    assert.equal(snapshot.evidence[result.evidenceId]?.kind, "reproduction");
    assert.equal(snapshot.evidence[result.evidenceId]?.source.artifactIds?.length, 3, "clean replay evidence must cover the verifier result and every response artifact in the first attempt");
    const exchangeArtifact = snapshot.artifacts[result.artifactId!];
    assert.ok(exchangeArtifact);
    const exchange = JSON.parse(await services.artifacts.readText(runId, exchangeArtifact!)) as { kind: string; request: { method: string; headers: Record<string, string> }; response: { body: string } };
    assert.equal(exchange.kind, "http_exchange");
    assert.equal(exchange.request.method, "GET");
    assert.equal(exchange.request.headers.cookie, "[REDACTED]");
    assert.match(exchange.response.body, /flag\{web-clean\}/);
    assert.ok(Object.values(snapshot.observations).filter((item) => item.source.operation.startsWith("http:")).length >= 4, "HTTP responses must be observed automatically");
    assert.ok(Object.values(snapshot.sessions).some((item) => item.kind === "http" && item.stateHash));
    const reproducedChain = Object.values(snapshot.domainRecords).find((item) => item.kind === "web_exploit_chain" && item.status === "reproduced");
    assert.ok(reproducedChain, "trusted replay must emit a reproduced exploit-chain record");
    assert.equal(reproducedChain?.stepRecordIds.length, 2);
    assert.ok(reproducedChain?.stepRecordIds.every((recordId) => snapshot.domainRecords[recordId]?.kind === "web_request"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("coding web session tools keep exploratory state lane-owned and journal the response", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-web-tools-"));
  const server = createServer((request, response) => {
    if (request.url === "/login") {
      response.setHeader("set-cookie", "sid=tool-cookie; Path=/");
      response.end('<meta name="csrf-token" content="tool-csrf">login');
      return;
    }
    const authenticated = request.headers.cookie === "sid=tool-cookie" && request.headers["x-csrf-token"] === "tool-csrf";
    response.statusCode = authenticated ? 200 : 403;
    response.end(authenticated ? "flag{tool-session}" : "forbidden");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const services = createServices(root, config);
    const runId = "WEB-TOOLS";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const handler = new WebToolHandler({
      runId,
      controlStore: services.control,
      artifactStore: services.artifacts,
      ownerLane: "main",
      scope: { allowedHosts: ["127.0.0.1"], allowedPorts: [address.port] },
    });
    const context = { webSession: handler } as unknown as CodingResourceContext;
    const tools = createWebSessionTools();
    const execute = async (name: string, params: Record<string, unknown>) => {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw new Error(`missing tool ${name}`);
      return await tool.execute(`web-tool-${name}`, params, new AbortController().signal, undefined, context);
    };
    try {
      const opened = await execute("web_open", { baseUrl: `http://127.0.0.1:${address.port}/` });
      const sessionId = String((opened.details as { sessionId: string }).sessionId);
      await execute("web_request", { sessionId, path: "/login" });
      const flag = await execute("web_request", { sessionId, path: "/" });
      assert.match(String((flag.details as { bodyViewport: string }).bodyViewport), /flag\{tool-session\}/);
      assert.equal(handler.list().length, 1);
      await execute("web_close", { sessionId });
      assert.equal(handler.list().length, 0);
      await execute("web_close", { sessionId });
      const snapshot = await services.control.snapshot(runId);
      assert.equal(snapshot.sessions[sessionId]?.status, "CLOSED");
      assert.ok(Object.values(snapshot.observations).filter((item) => item.source.operation.startsWith("http:")).length >= 2);
    } finally {
      await handler.disposeAll();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP response bodies are streamed and cancelled at the one MiB bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-http-stream-bound-"));
  try {
    const services = createServices(root, config);
    const runId = "WEB-STREAM-BOUND";
    await services.control.createRun(runId, demoTask(runId, root, config));
    let pulls = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode("A".repeat(64 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const session = await HttpSessionBackend.open({
      runId,
      baseUrl: "http://target.test/",
      ownerLane: "executor",
      controlStore: services.control,
      artifactStore: services.artifacts,
      fetchImpl: async () => new Response(stream, { status: 200 }),
    });
    const response = await session.request("/");
    assert.equal(response.body.length, 1_048_576);
    assert.ok(pulls <= 17, `reader should stop after the bounded chunks, got ${pulls}`);
    assert.equal(cancelled, true);
    await session.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WebReproducer rejects reusing an existing HTTP session as a clean session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-web-clean-session-"));
  try {
    const services = createServices(root, config);
    const runId = "WEB-CLEAN-IDENTITY";
    const task = demoTask(runId, root, config);
    task.verification.web = { flag_pattern: "flag\\{[^}]+\\}" };
    await services.control.createRun(runId, task);
    const session = await HttpSessionBackend.open({ runId, baseUrl: "http://target.test/", ownerLane: "verifier", controlStore: services.control, artifactStore: services.artifacts, fetchImpl: async () => new Response("flag{should-not-run}") });
    const reproducer = new WebReproducer(services.control, services.artifacts, webVerifier(services, runId));
    await assert.rejects(() => reproducer.reproduce(runId, { steps: [{ path: "/" }] }, async () => session), /new pristine verifier HTTP session/);
    assert.equal((await services.control.snapshot(runId)).sessions[session.sessionId]?.status, "CLOSED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WebReproducer rejects a flag literal reflected from the recipe input", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-web-reflection-"));
  try {
    const services = createServices(root, config);
    const runId = "WEB-REFLECTION";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    task.verification.web = { flag_pattern: "flag\\{[^}]+\\}" };
    await services.control.createRun(runId, task);
    const reproducer = new WebReproducer(services.control, services.artifacts, webVerifier(services, runId));
    const result = await reproducer.reproduce(runId, { steps: [{ path: "/", method: "POST", body: "flag{reflected}" }] }, async () => await HttpSessionBackend.open({
      runId,
      baseUrl: "http://target.test/",
      ownerLane: "verifier",
      controlStore: services.control,
      artifactStore: services.artifacts,
      fetchImpl: async (_url, init) => new Response(String(init?.body ?? "")),
    }));
    assert.equal(result.reproduced, false);
    assert.equal(result.flag, undefined);
    const snapshot = await services.control.snapshot(runId);
    assert.equal(snapshot.evidence[result.evidenceId]?.kind, "negative");
    assert.ok(Object.values(snapshot.domainRecords).some((item) => item.kind === "web_exploit_chain" && item.status === "observed"), "failed trusted replay must remain observational");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run recovery supersedes an orphaned HTTP session when no live registry exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-web-recovery-"));
  try {
    const services = createServices(root, config);
    const runId = "WEB-RECOVERY";
    const task = fixtureTask(runId, "web-source-1", root, config);
    await services.control.createRun(runId, task);
    const session = await HttpSessionBackend.open({ runId, baseUrl: "http://target.test/", ownerLane: "executor", controlStore: services.control, artifactStore: services.artifacts });
    const recovery = new RunRecoveryService(services.control, services.journal, services.sandbox);
    const result = await recovery.recover(runId, task);
    assert.equal(result.supersededSessions, 1);
    assert.equal((await services.control.snapshot(runId)).sessions[session.sessionId]?.status, "SUPERSEDED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP session persists a broker-owned opaque external id", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-http-opaque-id-"));
  try {
    const services = createServices(root, config);
    const runId = "WEB-OPAQUE-ID";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const ledger = new ExternalResourceRegistry(join(root, "external-resources.json"));
    const session = await HttpSessionBackend.open({
      runId,
      baseUrl: "http://target.test/",
      ownerLane: "executor",
      controlStore: services.control,
      artifactStore: services.artifacts,
      externalResources: ledger,
      externalId: "opaque-http-service-1",
    });
    assert.equal((await ledger.get(`session:${session.sessionId}`))?.externalId, "opaque-http-service-1");
    assert.equal((await ledger.get(`session:${session.sessionId}`))?.controlSessionId, session.sessionId);
    assert.equal((await services.control.snapshot(runId)).sessions[session.sessionId]?.externalId, "opaque-http-service-1");
    await session.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP session releases a broker handle when the Control Store owner write fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-http-owner-write-failure-"));
  try {
    const services = createServices(root, config);
    const runId = "WEB-OWNER-WRITE-FAILURE";
    await services.control.createRun(runId, demoTask(runId, root, config));
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
    const ledger = new ExternalResourceRegistry(join(root, "external-resources.json"));
    let releaseCount = 0;
    await assert.rejects(() => HttpSessionBackend.open({
      runId,
      baseUrl: "http://target.test/",
      ownerLane: "verifier",
      controlStore: control,
      artifactStore: services.artifacts,
      externalResources: ledger,
      externalId: "opaque-http-owner-write-failure",
      externalRelease: async (externalId, reason) => {
        releaseCount += 1;
        assert.equal(externalId, "opaque-http-owner-write-failure");
        assert.equal(reason, "HTTP session owner commit failed");
        return { released: true, summary: "broker released after owner write failure" };
      },
    }), /simulated Control Store owner write failure/);
    assert.equal(releaseCount, 1);
    const resources = await ledger.records(runId);
    assert.equal(resources.length, 1);
    assert.equal(resources[0]?.state, "RELEASED");
    assert.equal(Object.values((await services.control.snapshot(runId)).sessions).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP session keeps a broker handle adoptable when the Control binding marker fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-http-binding-marker-failure-"));
  try {
    const services = createServices(root, config);
    const runId = "WEB-BINDING-MARKER-FAILURE";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const ledger = new ExternalResourceRegistry(join(root, "external-resources.json"));
    const failingLedger = new Proxy(ledger, {
      get(target, property, receiver) {
        if (property === "markControlBound") return async () => { throw new Error("simulated binding marker failure"); };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ExternalResourceRegistry;
    let releaseCount = 0;
    await assert.rejects(() => HttpSessionBackend.open({
      runId,
      baseUrl: "http://target.test/",
      ownerLane: "verifier",
      controlStore: services.control,
      artifactStore: services.artifacts,
      externalResources: failingLedger,
      externalId: "opaque-http-binding-marker-failure",
      externalRelease: async () => {
        releaseCount += 1;
        return { released: true };
      },
    }), /simulated binding marker failure/);
    assert.equal(releaseCount, 0, "a durable Control Store owner must remain adoptable");
    assert.equal(Object.values((await services.control.snapshot(runId)).sessions).length, 1);
    const resources = await ledger.records(runId);
    assert.equal(resources[0]?.state, "UNKNOWN");

    const broker: SessionRuntimeBroker = {
      name: "recovery-marker-broker",
      kind: "http-session",
      async inspect(record) {
        return { status: "PRESENT", binding: "MATCH", externalId: record.externalId };
      },
      async adopt(record) {
        return {
          state: "CONFIRMED",
          binding: { kind: "http-session", externalId: record.externalId!, fetchImpl: async () => new Response("ok") },
        };
      },
      async release() {
        return { released: true };
      },
    };
    const recovery = await new RunRecoveryService(
      services.control,
      services.journal,
      services.sandbox,
      undefined,
      undefined,
      undefined,
      undefined,
      ledger,
      [new SessionResourceAdapter(broker)],
    ).recover(runId);
    assert.equal(recovery.sessionHandoffs.length, 1, "recovery should adopt the exact broker handle after repairing its marker");
    assert.equal(recovery.bindingTransactions?.repaired.length, 1, "coordinator recovery should record the marker repair");
    const recoveredResource = await ledger.get(resources[0]!.id);
    assert.equal(recoveredResource?.state, "CONFIRMED");
    assert.equal(recoveredResource?.controlSessionId, Object.values((await services.control.snapshot(runId)).sessions)[0]?.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run recovery does not repair a legacy binding marker while external state is unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-http-legacy-binding-unknown-"));
  try {
    const services = createServices(root, config);
    const runId = "WEB-LEGACY-BINDING-UNKNOWN";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const ledger = new ExternalResourceRegistry(join(root, "external-resources.json"));
    const sessionId = "HTTP-LEGACY-UNKNOWN";
    const resourceId = `session:${sessionId}`;
    await ledger.registerStarted({
      id: resourceId,
      kind: "http-session",
      runId,
      generation: 0,
      ownerLane: "verifier",
      externalId: "opaque-legacy-unknown",
    });
    await services.control.dispatch(runId, {
      type: "session_opened",
      session: {
        id: sessionId,
        runId,
        kind: "http" as const,
        ownerLane: "verifier" as const,
        generation: 0,
        externalId: "opaque-legacy-unknown",
      },
      lane: "verifier",
    });
    await ledger.markUnknown(resourceId, "legacy host inspection timed out");

    const recovery = await new RunRecoveryService(
      services.control,
      services.journal,
      services.sandbox,
      services.fixtureControl,
      undefined,
      services.verificationRecovery,
      services.verificationRecoveryAdapters,
      ledger,
      [],
    ).recover(runId);

    assert.equal(recovery.sessionHandoffs.length, 0);
    assert.equal((await ledger.get(resourceId))?.state, "UNKNOWN");
    assert.equal((await ledger.get(resourceId))?.controlSessionId, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP session keeps an unresolved broker handle retryable when release fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-http-owner-release-unknown-"));
  try {
    const services = createServices(root, config);
    const runId = "WEB-OWNER-RELEASE-UNKNOWN";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const control = new Proxy(services.control, {
      get(target, property, receiver) {
        if (property === "dispatchBindingTransaction") {
          return async (...args: Parameters<typeof services.control.dispatchBindingTransaction>) => {
            return await services.control.dispatchBindingTransaction(args[0], (snapshot) => {
              const transaction = args[1](snapshot);
              if (transaction.commands.some((command) => command.type === "session_opened")) throw new Error("simulated owner write failure");
              return transaction;
            });
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof services.control;
    const ledger = new ExternalResourceRegistry(join(root, "external-resources.json"));
    await assert.rejects(() => HttpSessionBackend.open({
      runId,
      baseUrl: "http://target.test/",
      ownerLane: "verifier",
      controlStore: control,
      artifactStore: services.artifacts,
      externalResources: ledger,
      externalId: "opaque-http-release-unknown",
      externalRelease: async () => ({ released: false, summary: "broker release timed out" }),
    }), /simulated owner write failure/);
    const resources = await ledger.records(runId);
    assert.equal(resources[0]?.state, "UNKNOWN");
    assert.equal(resources[0]?.lastSummary, "broker release timed out");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP session close releases the exact broker handle before finalizing the registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-http-close-broker-release-"));
  try {
    const services = createServices(root, config);
    const runId = "WEB-CLOSE-BROKER-RELEASE";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const ledger = new ExternalResourceRegistry(join(root, "external-resources.json"));
    let releaseCount = 0;
    const session = await HttpSessionBackend.open({
      runId,
      baseUrl: "http://target.test/",
      ownerLane: "main",
      controlStore: services.control,
      artifactStore: services.artifacts,
      externalResources: ledger,
      externalId: "opaque-http-close-release",
      externalRelease: async (externalId, reason) => {
        releaseCount += 1;
        assert.equal(externalId, "opaque-http-close-release");
        assert.equal(reason, "operator cleanup");
        return { released: true, summary: "broker closed" };
      },
    });
    await session.close("operator cleanup");
    assert.equal(releaseCount, 1);
    assert.equal((await ledger.get(`session:${session.sessionId}`))?.state, "RELEASED");
    await session.close("operator cleanup retry");
    assert.equal(releaseCount, 1, "close is idempotent after the first release attempt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP session adoption reuses the durable session id and broker transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-http-adopt-"));
  try {
    const services = createServices(root, config);
    const runId = "WEB-ADOPT";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const ledger = new ExternalResourceRegistry(join(root, "external-resources.json"));
    const externalId = "opaque-http-adopt-1";
    const original = await HttpSessionBackend.open({
      runId,
      baseUrl: "http://target.test/",
      ownerLane: "main",
      controlStore: services.control,
      artifactStore: services.artifacts,
      externalResources: ledger,
      externalId,
      fetchImpl: async () => new Response("original"),
    });
    const before = await services.control.snapshot(runId);
    await rm(join(root, "external-resources.json"), { force: true });
    const recoveredLedger = new ExternalResourceRegistry(join(root, "external-resources.json"));
    const adopted = await HttpSessionBackend.adopt({
      runId,
      baseUrl: "http://target.test/",
      ownerLane: "main",
      controlStore: services.control,
      artifactStore: services.artifacts,
      externalResources: recoveredLedger,
      externalId,
      fetchImpl: async () => new Response("broker-response", { status: 200 }),
    }, original.sessionId, sha256("broker-state"));
    assert.equal(adopted.sessionId, original.sessionId);
    assert.equal((await recoveredLedger.get(`session:${original.sessionId}`))?.controlSessionId, original.sessionId);
    assert.equal(Object.keys((await services.control.snapshot(runId)).sessions).length, Object.keys(before.sessions).length, "adoption must not append another session");
    await assert.rejects(
      HttpSessionBackend.adopt({
        runId,
        baseUrl: "http://target.test/",
        ownerLane: "main",
        controlStore: services.control,
        artifactStore: services.artifacts,
        externalId: "foreign-http-handle",
        fetchImpl: async () => new Response("foreign"),
      }, original.sessionId),
      /opaque handle mismatch/,
    );
    const response = await adopted.request("/continuation");
    assert.equal(response.body, "broker-response");
    assert.equal((await services.control.snapshot(runId)).sessions[original.sessionId]?.status, "OPEN");
    await adopted.close("adopted cleanup");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run recovery adopts an HTTP runtime before superseding local orphans", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-http-recovery-handoff-"));
  try {
    const services = createServices(root, config);
    const runId = "WEB-RECOVERY-HANDOFF";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    await services.control.createRun(runId, task);
    // Establish the post-fixture generation before creating the durable
    // session; a real lane opens resources only after this recovery boundary.
    await new RunRecoveryService(services.control, services.journal, services.sandbox, services.fixtureControl).recover(runId, task);
    const ledger = new ExternalResourceRegistry(join(root, "external-resources.json"));
    const externalId = "opaque-http-recovery-1";
    const session = await HttpSessionBackend.open({ runId, baseUrl: "http://target.test/", ownerLane: "main", controlStore: services.control, artifactStore: services.artifacts, externalResources: ledger, externalId, fetchImpl: async () => new Response("before-restart") });
    const broker: SessionRuntimeBroker = {
      name: "test-http-broker",
      kind: "http-session",
      async inspect(record: ExternalResourceRecord): Promise<ExternalResourceInspection> {
        return { status: "PRESENT", binding: "MATCH", externalId: record.externalId, summary: "broker session is still active" };
      },
      async adopt(record) {
        return { state: "CONFIRMED", binding: { kind: "http-session", externalId: record.externalId!, fetchImpl: async () => new Response("after-restart"), stateHash: sha256("broker-state") } };
      },
      async release() { return { released: true }; },
    };
    const result = await new RunRecoveryService(
      services.control,
      services.journal,
      services.sandbox,
      services.fixtureControl,
      undefined,
      services.verificationRecovery,
      services.verificationRecoveryAdapters,
      ledger,
      [new SessionResourceAdapter(broker)],
    ).recover(runId, task);
    assert.equal(result.supersededSessions, 0);
    assert.deepEqual(result.externalResources?.adopted, [`session:${session.sessionId}`]);
    assert.equal(result.sessionHandoffs.length, 1);
    assert.equal((await services.control.snapshot(runId)).sessions[session.sessionId]?.status, "OPEN");
    assert.equal(result.sessionHandoffs[0]?.binding.kind, "http-session");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run recovery finalizes a broker-confirmed handoff through the binding transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-http-recovery-confirmed-"));
  try {
    const services = createServices(root, config);
    const runId = "WEB-RECOVERY-CONFIRMED";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    await services.control.createRun(runId, task);
    await new RunRecoveryService(services.control, services.journal, services.sandbox, services.fixtureControl).recover(runId, task);
    const generation = (await services.control.snapshot(runId)).generation;
    const ledger = new ExternalResourceRegistry(join(root, "external-resources.json"));
    const coordinator = new BindingTransactionCoordinator(services.control, ledger);
    const prepared = await coordinator.prepare({
      sessionId: "HTTP-RECOVERY-CONFIRMED",
      resource: {
        id: "session:HTTP-RECOVERY-CONFIRMED",
        kind: "http-session",
        runId,
        generation,
        ownerLane: "verifier",
        externalId: "opaque-http-recovery-confirmed",
      },
    });
    await services.control.dispatch(runId, {
      type: "session_opened",
      session: {
        id: prepared.sessionId,
        runId,
        kind: "http",
        ownerLane: "verifier",
        generation,
        endpoint: "http://target.test",
        externalId: prepared.externalId,
        bindingTxnId: prepared.bindingTxnId,
        bindingIdentityHash: prepared.identityHash,
      },
      lane: "verifier",
    });
    const broker: SessionRuntimeBroker = {
      name: "recovery-confirmed-broker",
      kind: "http-session",
      async inspect(record) {
        return { status: "PRESENT", binding: "MATCH", externalId: record.externalId };
      },
      async adopt(record) {
        return { state: "CONFIRMED", binding: { kind: "http-session", externalId: record.externalId!, fetchImpl: async () => new Response("continued") } };
      },
      async release() {
        return { released: true };
      },
    };
    const result = await new RunRecoveryService(
      services.control,
      services.journal,
      services.sandbox,
      services.fixtureControl,
      undefined,
      services.verificationRecovery,
      services.verificationRecoveryAdapters,
      ledger,
      [new SessionResourceAdapter(broker)],
    ).recover(runId, task);
    assert.deepEqual(result.externalResources?.adopted, ["session:HTTP-RECOVERY-CONFIRMED"]);
    assert.deepEqual(result.bindingTransactions?.repaired, [prepared.bindingTxnId]);
    assert.equal((await coordinator.get(prepared.bindingTxnId))?.state, "BOUND");
    assert.equal((await ledger.get("session:HTTP-RECOVERY-CONFIRMED"))?.controlSessionId, prepared.sessionId);
    assert.equal(result.sessionHandoffs.length, 1);
    assert.equal(result.sessionHandoffs[0]?.binding.kind, "http-session");
    assert.equal(Object.values((await services.control.snapshot(runId)).sessions).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WebReproducer replays a terminal VerificationRequest without opening another clean session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-web-verification-key-"));
  try {
    const services = createServices(root, config);
    const runId = "WEB-VERIFICATION-KEY";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    task.verification.web = { flag_pattern: "flag\\{[^}]+\\}" };
    await services.control.createRun(runId, task);
    let opened = 0;
    const create = async () => {
      opened += 1;
      return await HttpSessionBackend.open({
        runId,
        baseUrl: "http://target.test/",
        ownerLane: "verifier",
        controlStore: services.control,
        artifactStore: services.artifacts,
        fetchImpl: async () => new Response("flag{stable-replay}"),
      });
    };
    const reproducer = new WebReproducer(services.control, services.artifacts, webVerifier(services, runId));
    const first = await reproducer.reproduce(runId, { steps: [{ path: "/" }] }, create);
    const second = await reproducer.reproduce(runId, { steps: [{ path: "/" }] }, async () => { throw new Error("must not open a second clean session"); });
    assert.equal(first.reproduced, true);
    assert.equal(second.reproduced, true);
    assert.equal(second.flag, first.flag);
    assert.equal(opened, task.verification.required_reproductions);
    const snapshot = await services.control.snapshot(runId);
    assert.equal(Object.keys(snapshot.verificationRequests).length, 1);
    assert.equal(Object.values(snapshot.completions).length, 1);
    const completion = Object.values(snapshot.completions)[0]!;
    assert.equal(completion.verificationKey, Object.values(snapshot.verificationRequests)[0]!.key);
    assert.equal(Object.values(snapshot.verificationRequests)[0]!.status, "BOUND");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a pending VerificationRequest fails closed instead of rerunning an external verifier", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-web-verification-pending-"));
  try {
    const services = createServices(root, config);
    const runId = "WEB-VERIFICATION-PENDING";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    task.verification.web = { flag_pattern: "flag\\{[^}]+\\}" };
    await services.control.createRun(runId, task);
    await beginVerificationRequest(services.control, runId, {
      kind: "web",
      policyHash: sha256(canonicalJson(task.verification.web)),
      recipeHash: sha256(canonicalJson({ steps: [{ path: "/" }] })),
    });
    let opened = false;
    const reproducer = new WebReproducer(services.control, services.artifacts, webVerifier(services, runId));
    await assert.rejects(
      reproducer.reproduce(runId, { steps: [{ path: "/" }] }, async () => {
        opened = true;
        throw new Error("unexpected external verifier");
      }),
      /requires durable recovery/,
    );
    assert.equal(opened, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run recovery supersedes an orphaned Browser session when no live runtime exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-browser-recovery-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-RECOVERY";
    const task = fixtureTask(runId, "web-source-1", root, config);
    await services.control.createRun(runId, task);
    const driver: BrowserContextPort = {
      async goto() { return { status: 200, content: "page" }; },
      async currentUrl() { return "https://target.test/"; },
      async storageState() { return { cookies: [], origins: [] }; },
      async close() {},
    };
    const session = new BrowserContextBackend(runId, "verifier", "https://target.test/", driver, services.control, services.artifacts, undefined, ["target.test"]);
    await session.open();
    const recovery = new RunRecoveryService(services.control, services.journal, services.sandbox);
    const result = await recovery.recover(runId, task);
    assert.equal(result.supersededSessions, 1);
    assert.equal((await services.control.snapshot(runId)).sessions[session.sessionId]?.status, "SUPERSEDED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP session refuses requests after the run generation changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-web-generation-"));
  try {
    const services = createServices(root, config);
    const runId = "WEB-GENERATION";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const session = await HttpSessionBackend.open({ runId, baseUrl: "http://target.test/", ownerLane: "executor", controlStore: services.control, artifactStore: services.artifacts, fetchImpl: async () => new Response("ok") });
    await services.fixtureControl.reset(runId, 1);
    await assert.rejects(() => session.request("/"), /generation drift/);
    await session.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("web reproducer rejects caller-supplied wildcard policy and ordinary pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-web-policy-"));
  const server = createServer((_request, response) => response.end("ordinary page"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const services = createServices(root, config);
    const runId = "WEB-POLICY";
    const task = demoTask(runId, root, config);
    task.verification.web = { flag_pattern: ".*" };
    await services.control.createRun(runId, task);
    const reproducer = new WebReproducer(services.control, services.artifacts, webVerifier(services, runId));
    await assert.rejects(() => reproducer.reproduce(runId, { steps: [{ path: "/" }] }, async () => await HttpSessionBackend.open({ runId, baseUrl: `http://127.0.0.1:${address.port}`, ownerLane: "verifier", controlStore: services.control, artifactStore: services.artifacts })), /Unsafe web flag pattern/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP WebReproducer refuses a browser transport policy before proposing a Completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-web-browser-policy-"));
  try {
    const services = createServices(root, config);
    const runId = "WEB-BROWSER-POLICY";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    task.target = "https://target.test/";
    task.verification.web = { flag_pattern: "flag\\{[^}]+\\}", transport: "browser" };
    await services.control.createRun(runId, task);
    const reproducer = new WebReproducer(services.control, services.artifacts, webVerifier(services, runId));
    await assert.rejects(() => reproducer.reproduce(runId, { steps: [{ path: "/" }] }, async () => {
      throw new Error("HTTP factory must not be called");
    }), /HTTP reproduction cannot run under a browser Web verification policy/);
    assert.equal(Object.keys((await services.control.replay(runId)).completions).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser context records storage state and response artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-browser-session-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-SESSION";
    await services.control.createRun(runId, demoTask(runId, root, config));
    let closed = false;
    const driver: BrowserContextPort = {
      async goto() { return { status: 200, content: "<html>dashboard</html>" }; },
      async currentUrl() { return "https://target.test/dashboard"; },
      async storageState() { return { cookies: [{ name: "sid", value: "abc" }] }; },
      async close() { closed = true; },
    };
    const browser = new BrowserContextBackend(runId, "executor", "https://target.test/", driver, services.control, services.artifacts, undefined, ["target.test"]);
    await browser.open();
    const page = await browser.navigate("https://target.test/dashboard");
    assert.match(page.content, /dashboard/);
    assert.ok(page.stateHash);
    await assert.rejects(() => browser.navigate("https://evil.test/"), /crosses origin/);
    await browser.close();
    assert.equal(closed, true);
    const snapshot = await services.control.snapshot(runId);
    assert.equal(snapshot.sessions[browser.sessionId]?.status, "CLOSED");
    const artifact = snapshot.artifacts[page.artifactId];
    assert.ok(artifact);
    const exchange = JSON.parse(await services.artifacts.readText(runId, artifact!)) as { kind: string; stateHash: string; response: { content: string } };
    assert.equal(exchange.kind, "browser_exchange");
    assert.equal(exchange.stateHash, page.stateHash);
    assert.match(exchange.response.content, /dashboard/);
    assert.equal(Object.values(snapshot.observations).filter((item) => item.source.operation === "browser_navigate").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser context persists the runtime binding marker before becoming usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-browser-binding-marker-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-BINDING-MARKER";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const ledger = new ExternalResourceRegistry(join(root, "external-resources.json"));
    const bindings: Array<{ bindingTxnId: string; controlSessionId: string }> = [];
    const driver: BrowserContextPort = {
      async goto() { return { status: 200, content: "page" }; },
      async currentUrl() { return "https://target.test/"; },
      async storageState() { return { cookies: [], origins: [] }; },
      async bind(binding) { bindings.push(binding); },
      async close() {},
    };
    const browser = new BrowserContextBackend(runId, "verifier", "https://target.test/", driver, services.control, services.artifacts, undefined, ["target.test"], undefined, 1_048_576, ledger);
    await browser.open();
    assert.deepEqual(bindings, [{ bindingTxnId: (await ledger.get(`session:${browser.sessionId}`))!.bindingTxnId!, controlSessionId: browser.sessionId }]);
    const resource = await ledger.get(`session:${browser.sessionId}`);
    assert.equal(resource?.controlSessionId, browser.sessionId);
    assert.equal((await services.control.snapshot(runId)).sessions[browser.sessionId]?.bindingState, "BOUND");
    await browser.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("BrowserReproducer uses independent empty contexts and emits a trusted reproduced chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-browser-reproducer-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-REPRODUCER";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    task.target = "https://target.test/";
    task.scope.allowed_hosts = ["target.test"];
    task.verification.required_reproductions = 2;
    task.verification.web = { flag_pattern: "flag\\{[^}]+\\}", transport: "browser" };
    await services.control.createRun(runId, task);
    let factoryCalls = 0;
    const factoryRequests: Array<{ runId: string; generation: number; target: string; policyHash: string; maxResponseBytes: number }> = [];
    const factory: BrowserVerifierFactory = {
      name: "test-browser-runtime",
      async createContext(request) {
        factoryRequests.push({ runId: request.runId, generation: request.generation, target: request.target, policyHash: request.policyHash, maxResponseBytes: request.maxResponseBytes });
        return {
          async goto() { return { status: 200, content: "dashboard flag{browser-clean}" }; },
          async currentUrl() { return "https://target.test/dashboard"; },
          async storageState() { return { cookies: [], origins: [] }; },
          async close() {},
        };
      },
    };
    const reproducer = new BrowserReproducer(services.control, services.artifacts, browserVerifier(services, runId));
    const result = await reproducer.reproduce(runId, { transport: "browser", steps: [{ path: "/dashboard", expectStatus: 200 }] }, async (request, signal) => {
      factoryCalls += 1;
      return await openVerifierBrowserSession(factory, request, services.control, services.artifacts, signal);
    });
    assert.equal(result.reproduced, true);
    assert.equal(result.flag, "flag{browser-clean}");
    assert.equal(factoryCalls, 2);
    assert.equal(factoryRequests.length, 2);
    assert.ok(factoryRequests.every((request) => request.runId === runId && request.generation === 0 && request.target === "https://target.test/" && request.policyHash.length === 64 && request.maxResponseBytes === 1_048_576));
    const snapshot = await services.control.replay(runId);
    const replayEffects = Object.values(snapshot.effects).filter((effect) => effect.operation === "verification_replay");
    assert.equal(replayEffects.length, 2);
    assert.ok(replayEffects.every((effect) => effect.status === "FINISHED" && effect.verification === undefined));
    assert.equal(Object.values(snapshot.effects).filter((effect) => effect.operation === "browser_reproduce").length, 2);
    assert.equal(snapshot.evidence[result.evidenceId]?.kind, "reproduction");
    const chain = Object.values(snapshot.domainRecords).find((record) => record.kind === "web_exploit_chain" && record.status === "reproduced");
    assert.ok(chain);
    assert.equal(chain?.stepRecordIds.length, 1);
    assert.ok(Object.values(snapshot.sessions).every((session) => session.kind !== "browser" || session.status === "CLOSED"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Browser verifier policy bounds replay steps before creating a trusted context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-browser-policy-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-POLICY";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    task.target = "https://target.test/";
    task.scope.allowed_hosts = ["target.test"];
    task.verification.web = { flag_pattern: "flag\\{[^}]+\\}", transport: "browser", browser: { allowed_actions: ["navigate"], max_steps: 1 } };
    await services.control.createRun(runId, task);
    const reproducer = new BrowserReproducer(services.control, services.artifacts, browserVerifier(services, runId));
    let factoryCalls = 0;
    await assert.rejects(() => reproducer.reproduce(runId, { transport: "browser", steps: [{ path: "/one" }, { path: "/two" }] }, async () => {
      factoryCalls += 1;
      throw new Error("factory must not be called for an over-budget recipe");
    }), /requires 1-1 browser steps/);
    assert.equal(factoryCalls, 0);
    await assert.rejects(() => reproducer.reproduce(runId, { transport: "browser", steps: [{ action: "click", selector: { kind: "test_id", value: "submit" } }] }, async () => {
      factoryCalls += 1;
      throw new Error("factory must not be called for a disallowed action");
    }), /action click is not allowed/);
    assert.equal(Object.keys((await services.control.replay(runId)).completions).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Browser verifier executes only policy-allowed form actions and records each action", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-browser-actions-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-ACTIONS";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    task.target = "https://target.test/";
    task.scope.allowed_hosts = ["target.test"];
    task.verification.required_reproductions = 1;
    task.verification.web = {
      flag_pattern: "flag\\{[^}]+\\}",
      transport: "browser",
      browser: { allowed_actions: ["navigate", "fill", "click", "submit"], max_steps: 4 },
    };
    await services.control.createRun(runId, task);
    const actionLog: string[] = [];
    const factory: BrowserVerifierFactory = {
      name: "action-browser-runtime",
      async createContext() {
        return {
          async goto() { actionLog.push("navigate"); return { status: 200, content: "form" }; },
          async fill(_selector, value) { actionLog.push(`fill:${value}`); return { status: 200, content: "filled" }; },
          async click() { actionLog.push("click"); return { status: 200, content: "clicked" }; },
          async submit() { actionLog.push("submit"); return { status: 200, content: "flag{browser-actions}" }; },
          async currentUrl() { return "https://target.test/"; },
          async storageState() { return { cookies: [], origins: [] }; },
          async close() {},
        };
      },
    };
    const reproducer = new BrowserReproducer(services.control, services.artifacts, browserVerifier(services, runId));
    const selector = { kind: "test_id" as const, value: "username" };
    const result = await reproducer.reproduce(runId, {
      transport: "browser",
      steps: [
        { action: "navigate", path: "/" },
        { action: "fill", selector, value: "payload" },
        { action: "click", selector },
        { action: "submit", selector },
      ],
    }, async (request, signal) => await openVerifierBrowserSession(factory, request, services.control, services.artifacts, signal));
    assert.equal(result.reproduced, true);
    assert.equal(result.flag, "flag{browser-actions}");
    assert.deepEqual(actionLog, ["navigate", "fill:payload", "click", "submit"]);
    const snapshot = await services.control.replay(runId);
    assert.ok(Object.values(snapshot.observations).some((item) => item.source.operation === "browser_fill"));
    assert.ok(Object.values(snapshot.observations).some((item) => item.source.operation === "browser_click"));
    assert.ok(Object.values(snapshot.observations).some((item) => item.source.operation === "browser_submit"));
    const chain = Object.values(snapshot.domainRecords).find((record) => record.kind === "web_exploit_chain" && record.status === "reproduced");
    assert.ok(chain);
    assert.equal(chain?.stepRecordIds.length, 4);
    assert.deepEqual(chain?.stepRecordIds.map((id) => snapshot.domainRecords[id]?.kind), ["web_request", "web_request", "web_request", "web_request"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Browser replay driver errors become negative verifier evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-browser-driver-error-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-DRIVER-ERROR";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    task.target = "https://target.test/";
    task.scope.allowed_hosts = ["target.test"];
    task.verification.required_reproductions = 1;
    task.verification.web = { flag_pattern: "flag\\{[^}]+\\}", transport: "browser" };
    await services.control.createRun(runId, task);
    const factory: BrowserVerifierFactory = {
      name: "failing-browser-runtime",
      async createContext() {
        return {
          async goto() { throw new Error("driver timeout"); },
          async currentUrl() { return "https://target.test/"; },
          async storageState() { return { cookies: [], origins: [] }; },
          async close() {},
        };
      },
    };
    const reproducer = new BrowserReproducer(services.control, services.artifacts, browserVerifier(services, runId));
    const result = await reproducer.reproduce(runId, { transport: "browser", steps: [{ path: "/flag" }] }, async (request, signal) => await openVerifierBrowserSession(factory, request, services.control, services.artifacts, signal));
    assert.equal(result.reproduced, false);
    const snapshot = await services.control.replay(runId);
    assert.equal(snapshot.evidence[result.evidenceId]?.kind, "negative");
    assert.ok(Object.values(snapshot.effects).some((effect) => effect.operation === "browser_reproduce" && effect.outcome === "success"));
    assert.ok(Object.values(snapshot.domainRecords).some((record) => record.kind === "web_exploit_chain" && record.status === "observed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("BrowserReproducer keeps a failed clean context observational and rejects stale generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-browser-reproducer-negative-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-REPRODUCER-NEGATIVE";
    const task = demoTask(runId, root, config);
    task.target_kind = "web";
    task.target = "https://target.test/";
    task.verification.web = { flag_pattern: "flag\\{[^}]+\\}", transport: "browser" };
    await services.control.createRun(runId, task);
    const reproducer = new BrowserReproducer(services.control, services.artifacts, browserVerifier(services, runId));
    const result = await reproducer.reproduce(runId, { transport: "browser", steps: [{ path: "/ordinary", expectStatus: 200 }] }, async () => {
      const driver = {
        async goto() { return { status: 200, content: "ordinary page" }; },
        async currentUrl() { return "https://target.test/ordinary"; },
        async storageState() { return { cookies: [], origins: [] }; },
        async close() {},
      };
      return new BrowserContextBackend(runId, "verifier", "https://target.test/", driver, services.control, services.artifacts, undefined, ["target.test"]);
    });
    assert.equal(result.reproduced, false);
    assert.equal(result.flag, undefined);
    const failedSnapshot = await services.control.replay(runId);
    assert.equal(failedSnapshot.evidence[result.evidenceId]?.kind, "negative");
    assert.ok(Object.values(failedSnapshot.domainRecords).some((record) => record.kind === "web_exploit_chain" && record.status === "observed"));

    const staleRunId = "BROWSER-REPRODUCER-STALE";
    const staleTask = demoTask(staleRunId, root, config);
    staleTask.target_kind = "web";
    staleTask.target = "https://target.test/";
    staleTask.verification.web = { flag_pattern: "flag\\{[^}]+\\}", transport: "browser" };
    await services.control.createRun(staleRunId, staleTask);
    const staleReproducer = new BrowserReproducer(services.control, services.artifacts, browserVerifier(services, staleRunId));
    await assert.rejects(() => staleReproducer.reproduce(staleRunId, { transport: "browser", steps: [{ path: "/" }] }, async () => {
      await services.fixtureControl.reset(staleRunId, 1);
      const driver = {
        async goto() { return { status: 200, content: "flag{stale}" }; },
        async currentUrl() { return "https://target.test/"; },
        async storageState() { return { cookies: [], origins: [] }; },
        async close() {},
      };
      return new BrowserContextBackend(staleRunId, "verifier", "https://target.test/", driver, services.control, services.artifacts, undefined, ["target.test"]);
    }), /new pristine verifier browser session/);
    assert.equal(Object.values(await services.control.replay(staleRunId).then((snapshot) => snapshot.completions)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional Playwright adapter binds empty contexts, semantic selectors, scope, and idempotent close", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-playwright-adapter-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-PLAYWRIGHT-ADAPTER";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const calls: string[] = [];
    let pageUrl = "https://target.test/";
    let contextCloseCount = 0;
    let browserCloseCount = 0;
    let contextOptions: Record<string, unknown> | undefined;
    const locator = (label: string) => ({
      async click() { calls.push(`click:${label}`); },
      async fill(value: string) { calls.push(`fill:${label}:${value}`); },
    });
    const page: PlaywrightPagePort = {
      async goto(url) { calls.push(`goto:${url}`); pageUrl = url; return { status: () => 200 }; },
      async content() { return "dashboard".repeat(1_000); },
      url() { return pageUrl; },
      locator(selector) { calls.push(`css:${selector}`); return locator(`css:${selector}`); },
      getByRole(role, options) { calls.push(`role:${role}:${options?.name ?? ""}`); return locator(`role:${role}`); },
      getByLabel(label) { calls.push(`label:${label}`); return locator(`label:${label}`); },
      getByTestId(testId) { calls.push(`test_id:${testId}`); return locator(`test_id:${testId}`); },
      async waitForTimeout(milliseconds) { calls.push(`wait:${milliseconds}`); },
    };
    const chromium: PlaywrightChromiumPort = {
      async launch(options) {
        assert.equal(options?.headless, true);
        return {
          async newContext(options) {
            contextOptions = options;
            return {
              async newPage() { return page; },
              async storageState() { return { cookies: [], origins: [] }; },
              async close() { contextCloseCount += 1; },
            };
          },
          async close() { browserCloseCount += 1; },
        };
      },
    };
    const factory = createPlaywrightBrowserVerifierFactory({ loadChromium: () => chromium });
    const session = await openVerifierBrowserSession(factory, {
      runId,
      generation: 0,
      target: "https://target.test/",
      policyHash: "a".repeat(64),
      allowedHosts: ["target.test"],
      allowedPorts: [],
      maxResponseBytes: 1_024,
    }, services.control, services.artifacts);
    await session.open();
    assert.deepEqual(contextOptions?.storageState, { cookies: [], origins: [] });
    const navigation = await session.navigate("https://target.test/login");
    assert.equal(navigation.content.length, 1_024);
    await session.click({ kind: "role", value: "button", name: "Login" });
    await session.fill({ kind: "label", value: "Username" }, "guest");
    await session.submit({ kind: "test_id", value: "submit" });
    await session.wait(5);
    assert.deepEqual(calls, [
      "goto:https://target.test/login",
      "role:button:Login",
      "click:role:button",
      "label:Username",
      "fill:label:Username:guest",
      "test_id:submit",
      "click:test_id:submit",
      "wait:5",
    ]);
    await session.close();
    await session.close();
    assert.equal(contextCloseCount, 1);
    assert.equal(browserCloseCount, 1);
    assert.equal(tryCreatePlaywrightBrowserVerifierFactory({ loadChromium: () => { throw new Error("module missing"); } }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional Playwright adapter rejects an action that navigates outside task scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-playwright-scope-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-PLAYWRIGHT-SCOPE";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const page: PlaywrightPagePort = {
      async goto() { return { status: () => 200 }; },
      async content() { return "ordinary"; },
      url() { return "https://evil.test/"; },
      getByRole() { return { async click() {} }; },
      async waitForTimeout() {},
    };
    const chromium: PlaywrightChromiumPort = {
      async launch() {
        return {
          async newContext() { return { async newPage() { return page; }, async storageState() { return { cookies: [], origins: [] }; }, async close() {} }; },
          async close() {},
        };
      },
    };
    const factory = createPlaywrightBrowserVerifierFactory({ loadChromium: () => chromium });
    const session = await openVerifierBrowserSession(factory, {
      runId,
      generation: 0,
      target: "https://target.test/",
      policyHash: "b".repeat(64),
      allowedHosts: ["target.test"],
      allowedPorts: [],
      maxResponseBytes: 1_024,
    }, services.control, services.artifacts);
    await session.open();
    await assert.rejects(() => session.click({ kind: "role", value: "button" }), /crossed origin/);
    await session.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
