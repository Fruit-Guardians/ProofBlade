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
import { BrowserContextBackend, type BrowserContextPort } from "../src/web/browser-session.js";
import { WebReproducer, type WebVerifierPort } from "../src/verification/web-reproducer.js";
import { createWebSessionTools } from "../src/runtime/web-coding-tools.js";
import type { CodingResourceContext } from "../src/runtime/coding-resources.js";
import { WebToolHandler } from "../src/web/web-tools.js";
import { CodingClaimVerifier } from "../src/verification/claim-verification.js";
import type { Evidence } from "../src/domain/types.js";

const config = { schemaVersion: 1, runtime: { piVersion: "0.83.0" }, storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" }, modelProfiles: { executor: { thinkingLevel: "off" } } } as unknown as ProofBladeConfig;

function webVerifier(services: ReturnType<typeof createServices>, runId: string): WebVerifierPort {
  const claims = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
  return {
    executeEffect: (input: Parameters<CodingClaimVerifier["executeWebReproductionEffect"]>[0], signal?: AbortSignal) => claims.executeWebReproductionEffect(input, signal),
    recordEvidence: (id: string, evidence: Omit<Evidence, "createdSeq" | "provenance">) => services.verifier.dispatch(id, { type: "evidence", evidence }),
    finalize: (_id: string, completionId: string, accepted: boolean, evidenceIds: string[]) => claims.finalizeWebReproduction(completionId, accepted, evidenceIds),
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
    assert.equal((await services.control.snapshot(runId)).evidence[result.evidenceId]?.kind, "negative");
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

test("browser context records storage state and response artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-browser-session-"));
  try {
    const services = createServices(root, config);
    const runId = "BROWSER-SESSION";
    await services.control.createRun(runId, demoTask(runId, root, config));
    let closed = false;
    const driver: BrowserContextPort = {
      async goto() { return { status: 200, content: "<html>dashboard</html>" }; },
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
