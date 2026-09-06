import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentHarness, JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { captureProviderPrefixShape } from "@proofblade/molecules";
import type { ProofBladeConfig } from "../src/config.js";
import { createServices, demoTask } from "../src/app/demo.js";
import { fixtureTask } from "../src/app/fixture-task.js";
import { ContextCompiler, contextText } from "../src/context/compiler.js";
import { createInitialSnapshot } from "../src/control/reducer.js";
import { estimateTokens, sha256 } from "../src/domain/utils.js";
import { attachPiObservability, createProviderSchedulingTelemetry } from "../src/observability/pi-events.js";
import { RunTelemetry } from "../src/observability/run-telemetry.js";
import { CodingClaimVerifier } from "../src/verification/claim-verification.js";
import { MAX_PROJECT_PROMPT_TOKENS, PiCodingLane } from "../src/runtime/coding-lane.js";
import { createConfiguredModels, type ResolvedModelProfile } from "../src/runtime/lmstudio-provider.js";
import type { SessionRuntimeCreateBroker } from "../src/recovery/session-resource-adapter.js";

const apiKeyEnv = "PROOFBLADE_MOCK_PROVIDER_KEY";

test("default compiled system context stays below 10K after Provider serialization", async () => {
  let requestBody = "";
  const server = createServer(async (request, response) => {
    const chunks: string[] = [];
    request.setEncoding("utf8");
    for await (const chunk of request) chunks.push(String(chunk));
    requestBody = chunks.join("");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "context-cap", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(join(tmpdir(), "proofblade-provider-context-cap-"));
  const config: ProofBladeConfig = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: {
      executor: {
        provider: "mock-http",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "mock-model",
        modelDiscoveryPath: "/models",
        apiKeyEnv,
        contextWindow: 100_000,
        maxTokens: 256,
        requestTimeoutMs: 5_000,
        maxRetries: 0,
        input: ["text"],
      },
    },
  };
  let closeTransport: (() => Promise<void>) | undefined;
  try {
    const task = demoTask("PI-CONTEXT-CAP", root, config);
    const snapshot = createInitialSnapshot("PI-CONTEXT-CAP", task);
    snapshot.status = "RUNNING";
    snapshot.facts = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`F-${index}`, {
      id: `F-${index}`, runId: snapshot.runId, generation: snapshot.generation,
      statement: `large confirmed finding ${index} ${"x".repeat(300)}`, status: "CONFIRMED" as const, evidenceIds: [], createdSeq: index + 1,
    }]));
    const resources = {
      version: 1 as const,
      skillCatalogHash: "s".repeat(64),
      skills: Array.from({ length: 64 }, (_, index) => ({ name: `skill-${index}`, description: "skill description ".repeat(200), contentHash: "a".repeat(64) })),
      mcpCatalogHash: "m".repeat(64),
      mcpServers: [],
      toolCatalogHash: "t".repeat(64),
      toolCatalog: [],
    };
    const compiled = new ContextCompiler().build({ runId: snapshot.runId, lane: "main", phase: snapshot.phase, task, snapshot, contextWindow: 100_000, resources });
    const rawContext = compiled.messages.map((message) => `[${message.role}]\n${message.content}`).join("\n\n");
    assert.ok(estimateTokens(rawContext) > 10_000, "fixture must exercise the default cap");
    const systemPrompt = contextText(compiled);
    assert.ok(estimateTokens(systemPrompt) <= 10_000);

    process.env[apiKeyEnv] = "mock-key";
    const env = new NodeExecutionEnv({ cwd: root });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "pi-sessions") });
    const session = await repo.create({ id: "context-cap", cwd: root });
    const configured = createConfiguredModels({ ...config.modelProfiles.executor, modelId: "mock-model" }, undefined);
    closeTransport = configured.closeTransport;
    const harness = new AgentHarness({ session, models: configured.models, model: configured.model, systemPrompt });
    const response = await harness.prompt("Say ok.");
    assert.equal(response.stopReason, "stop");
    const payload = JSON.parse(requestBody) as { messages?: Array<{ role?: string; content?: unknown }> };
    const visibleSystem = (payload.messages ?? [])
      .filter((message) => message.role === "system" || message.role === "developer")
      .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""))
      .join("\n");
    assert.ok(estimateTokens(visibleSystem) <= 10_000, "serialized Provider system context must stay below the hard cap");
    await env.cleanup();
  } finally {
    await closeTransport?.();
    delete process.env[apiKeyEnv];
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("configured Pi AgentHarness records real HTTP provider traffic", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-smoke", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-smoke", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(join(tmpdir(), "proofblade-pi-http-smoke-"));
  const config: ProofBladeConfig = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: {
      executor: {
        provider: "mock-http",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "mock-model",
        modelDiscoveryPath: "/models",
        apiKeyEnv,
        contextWindow: 4_096,
        maxTokens: 256,
        requestTimeoutMs: 5_000,
        maxRetries: 0,
        input: ["text"],
      },
    },
  };

  let closeTransport: (() => Promise<void>) | undefined;
  try {
    const services = createServices(root, config);
    const runId = "PI-HTTP-SMOKE";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const env = new NodeExecutionEnv({ cwd: root });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "pi-sessions") });
    const session = await repo.create({ id: "pi-http-smoke", cwd: root, metadata: { runId, lane: "main" } });
    const scheduling = createProviderSchedulingTelemetry({ runId, lane: "main", controlStore: services.control });
    const profile: ResolvedModelProfile = { ...config.modelProfiles.executor, modelId: "mock-model" };
    const configured = createConfiguredModels(profile, undefined, { observer: scheduling.observer });
    closeTransport = configured.closeTransport;
    const harness = new AgentHarness({ session, models: configured.models, model: configured.model, systemPrompt: "Reply with one short word." });
    const detach = attachPiObservability(harness, {
      runId,
      lane: "main",
      controlStore: services.control,
      scheduling,
      getContextSnapshot: async () => ({
        omittedItems: [{
          itemId: "pruned:tool_exchange:123",
          role: "unknown",
          source: "context" as const,
          sourceIds: ["call-123"],
          contentHash: "a".repeat(64),
          visibleChars: 0,
          estimatedTokens: 0,
          included: false,
          artifactRefs: [],
          evidenceRefs: [],
        }],
      }),
    });
    try {
      const response = await harness.prompt("Say ok.");
      assert.equal(response.stopReason, "stop");
      assert.equal(response.content.find((item) => item.type === "text")?.text, "ok");
    } finally {
      detach();
    }

    // Pi delivers subscriber callbacks asynchronously after the assistant turn
    // resolves; wait for the durable terminal event instead of relying on a
    // timing guess when the full suite is under load.
    const telemetryDeadline = Date.now() + 2_000;
    while (!(await services.control.events(runId)).some((event) => event.type === "model_usage") && Date.now() < telemetryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const telemetry = await new RunTelemetry(services.control).report(runId);
    assert.equal(requests, 1);
    assert.equal(telemetry.provider.requestCount, 1);
    assert.equal(telemetry.provider.responseCount, 1);
    assert.equal(telemetry.provider.byModel[0]?.provider, "mock-http");
    assert.equal(telemetry.provider.byModel[0]?.model, "mock-model");
    assert.equal(telemetry.provider.tokens.total, 4);
    const frameEvents = (await services.control.events(runId)).filter((event) => event.type === "model_context_frame_recorded");
    assert.equal(frameEvents.length, 1);
    const frame = (frameEvents[0]?.payload as { frame?: { messageCount?: number; frameHash?: string; omittedItems?: Array<{ itemId?: string; included?: boolean }> } }).frame;
    assert.ok((frame?.messageCount ?? 0) > 0);
    assert.equal(frame?.frameHash?.length, 64);
    assert.equal(frame?.omittedItems?.[0]?.itemId, "pruned:tool_exchange:123");
    assert.equal(frame?.omittedItems?.[0]?.included, false);
    assert.doesNotMatch(JSON.stringify(frameEvents[0]?.payload), /Say ok\.|Reply with one short word/);
  } finally {
    await closeTransport?.();
    delete process.env[apiKeyEnv];
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("PiCodingLane exposes generic external_submit only for a declared target with a trusted adapter", async () => {
  let requestBody = "";
  const server = createServer(async (request, response) => {
    const chunks: string[] = [];
    request.setEncoding("utf8");
    for await (const chunk of request) chunks.push(String(chunk));
    requestBody = chunks.join("");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "generic-external-submit", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: { role: "assistant", content: "ready" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "generic-external-submit", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(join(tmpdir(), "proofblade-generic-external-submit-"));
  const config: ProofBladeConfig = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: {
      executor: {
        provider: "mock-http",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "mock-model",
        modelDiscoveryPath: "/models",
        apiKeyEnv,
        contextWindow: 4_096,
        maxTokens: 256,
        requestTimeoutMs: 5_000,
        maxRetries: 0,
        input: ["text"],
      },
    },
  };
  let lane: PiCodingLane | undefined;
  try {
    process.env[apiKeyEnv] = "mock-key";
    const services = createServices(root, config);
    const runId = "PI-GENERIC-EXTERNAL-SUBMIT";
    const task = demoTask(runId, root, config);
    task.external_submission = { targets: ["review"] };
    await services.control.createRun(runId, task);
    const claimVerifier = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
    lane = await PiCodingLane.create({
      runId,
      projectRoot: root,
      installRoot: root,
      runDir: join(services.runsRoot, runId),
      controlStore: services.control,
      artifactStore: services.artifacts,
      journal: services.journal,
      claimVerifier,
      config,
      externalSubmission: async (submission) => ({
        accepted: true,
        completionId: "C-REVIEW",
        candidateHash: sha256(submission.payload),
        replayed: false,
        submissionsUsed: 1,
        submissionsRemaining: 1,
        target: submission.target,
      }),
    });
    const outcome = await lane.prompt("Prepare a review submission.");
    assert.equal(outcome.stopReason, "stop", outcome.errorMessage ?? "Provider returned a non-stop response");
    const providerTools = JSON.stringify((JSON.parse(requestBody) as { tools?: unknown[] }).tools ?? []);
    assert.match(providerTools, /external_submit/);
    assert.doesNotMatch(providerTools, /submit_flag/);
  } finally {
    await lane?.close();
    delete process.env[apiKeyEnv];
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("PiCodingLane persists tool preparation before the first Provider request and reuses it", async () => {
  let services: ReturnType<typeof createServices> | undefined;
  let firstRequestEventTypes: string[] | undefined;
  let firstRequestBody = "";
  const requestBodies: string[] = [];
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests += 1;
    const chunks: string[] = [];
    request.setEncoding("utf8");
    await new Promise<void>((resolve, reject) => {
      request.on("data", (chunk: string) => chunks.push(chunk));
      request.on("end", resolve);
      request.on("error", reject);
    });
    const requestBody = chunks.join("");
    requestBodies.push(requestBody);
    if (requests === 1) firstRequestBody = requestBody;
    if (services) firstRequestEventTypes = (await services.control.events("PI-HTTP-PREFLIGHT")).map((event) => event.type);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-preflight", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: { role: "assistant", content: "ready" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-preflight", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(join(tmpdir(), "proofblade-pi-preflight-"));
  const config: ProofBladeConfig = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: {
      executor: {
        provider: "mock-http",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "mock-model",
        modelDiscoveryPath: "/models",
        apiKeyEnv,
        contextWindow: 4_096,
        maxTokens: 256,
        requestTimeoutMs: 5_000,
        maxRetries: 0,
        input: ["text"],
      },
    },
  };
  let lane: PiCodingLane | undefined;
  let resumedLane: PiCodingLane | undefined;
  let browserLane: PiCodingLane | undefined;
  let pwnHealthCalls = 0;
  let httpHealthCalls = 0;
  const pwnBroker = {
    name: "unrelated-pwn",
    kind: "pwn-session",
    health: async () => {
      pwnHealthCalls += 1;
      throw new Error("a Web task must not probe the unrelated Pwn broker");
    },
    inspect: async () => ({ status: "UNKNOWN" as const, binding: "UNKNOWN" as const }),
    adopt: async () => ({ state: "UNKNOWN" as const }),
    release: async () => ({ released: false }),
    create: async () => ({ schemaVersion: 1 as const, operation: "create" as const, state: "UNKNOWN" as const }),
    createBinding: async () => { throw new Error("not used by this smoke test"); },
  } satisfies SessionRuntimeCreateBroker;
  const httpBroker = {
    name: "preflight-http",
    kind: "http-session",
    health: async () => {
      httpHealthCalls += 1;
      return {
        status: "READY" as const,
        capabilities: { kinds: ["http-session"] as const, maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576, stableAcrossRestart: true },
      };
    },
    inspect: async () => ({ status: "UNKNOWN" as const, binding: "UNKNOWN" as const }),
    adopt: async () => ({ state: "UNKNOWN" as const }),
    release: async () => ({ released: false }),
    create: async () => ({ schemaVersion: 1 as const, operation: "create" as const, state: "UNKNOWN" as const }),
    createBinding: async () => { throw new Error("not used by this smoke test"); },
  } satisfies SessionRuntimeCreateBroker;
  try {
    services = createServices(root, config);
    const runId = "PI-HTTP-PREFLIGHT";
    const task = fixtureTask(runId, "web-source-1", root, config);
    task.target = `REMOTE:http://127.0.0.1:${address.port}`;
    task.verification.web = { flag_pattern: "^flag\\{" };
    await services.control.createRun(runId, task);
    const claimVerifier = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
    const laneOptions = {
      runId,
      projectRoot: root,
      installRoot: root,
      runDir: join(services.runsRoot, runId),
      controlStore: services.control,
      artifactStore: services.artifacts,
      journal: services.journal,
      claimVerifier,
      config,
      sessionRuntimeBrokers: [pwnBroker, httpBroker],
      projectPrompt: `PROJECT_PROMPT_HEAD ${"中".repeat(2_000)} ${"x".repeat(8_000)} PROJECT_PROMPT_TAIL`,
    };
    lane = await PiCodingLane.create(laneOptions);
    const promptSnapshot = JSON.parse(await readFile(join(services.runsRoot, runId, "prompt-snapshot.json"), "utf8")) as {
      schemaVersion: number;
      projectPrompt: string;
      projectPromptOriginalChars: number;
      projectPromptOmittedChars: number;
      projectPromptTruncated: boolean;
    };
    assert.equal(promptSnapshot.schemaVersion, 2);
    assert.ok(Buffer.byteLength(promptSnapshot.projectPrompt, "utf8") <= MAX_PROJECT_PROMPT_TOKENS);
    assert.ok(promptSnapshot.projectPrompt.includes("PROJECT_PROMPT_HEAD"));
    assert.ok(promptSnapshot.projectPrompt.includes("PROJECT_PROMPT_TAIL"));
    assert.equal(promptSnapshot.projectPromptTruncated, true);
    assert.ok(promptSnapshot.projectPromptOriginalChars > promptSnapshot.projectPrompt.length);
    assert.ok(promptSnapshot.projectPromptOmittedChars > 0);
    const afterCreate = await services.control.snapshot(runId);
    assert.equal(afterCreate.toolPreparation?.profileId, "web");
    assert.equal(afterCreate.toolPreparation?.runtime, "host");
    assert.equal((await services.control.events(runId)).filter((event) => event.type === "tool_preparation_recorded").length, 1);
    assert.equal(pwnHealthCalls, 0, "a Web task must not probe the unrelated Pwn broker");
    assert.equal(httpHealthCalls, 1, "the Web task should probe its required HTTP broker once");

    const firstPrompt = "Inspect the prepared challenge and report readiness.";
    const outcome = await lane.prompt(firstPrompt);
    assert.equal(outcome.stopReason, "stop", outcome.errorMessage ?? "Provider returned a non-stop response");
    assert.equal(requests, 1);
    assert.doesNotMatch(firstRequestBody, /CTF solving workflow \(prepared direction\)/);
    assert.doesNotMatch(firstRequestBody, /\[ProofBlade prepared CTF path\]/);
    assert.match(firstRequestBody, /proofblade-context/);
    assert.match(firstRequestBody, /<task-contract>/);
    assert.match(firstRequestBody, /<durable-ledger>/);
    const firstRequest = JSON.parse(firstRequestBody) as { messages?: Array<{ role?: string; content?: unknown }> };
    const firstRequestMessages = JSON.stringify(firstRequest.messages ?? []);
    assert.match(firstRequestMessages, /manifest-hash=\\"[a-f0-9]{64}\\"/);
    const messageText = (message: { content?: unknown }): string => {
      if (typeof message.content === "string") return message.content;
      if (Array.isArray(message.content)) return message.content.map((item) => {
        if (item && typeof item === "object" && "text" in item && typeof item.text === "string") return item.text;
        return JSON.stringify(item);
      }).join("");
      return JSON.stringify(message.content ?? "");
    };
    const instructionText = (firstRequest.messages ?? []).filter((message) => message.role === "system" || message.role === "developer").map(messageText).join("\n");
    assert.ok(instructionText.includes(promptSnapshot.projectPrompt), "Provider must receive the exact bounded project prompt recorded in the snapshot");
    assert.doesNotMatch(instructionText, /ProofBlade prepared CTF path|Prepared challenge tool profile|CTF solving workflow \(prepared direction\)/);
    assert.ok((firstRequest.messages ?? []).some((message) => message.role === "user" && messageText(message) === firstPrompt));
    assert.ok(!(firstRequest.messages ?? []).some((message) => messageText(message).includes(firstPrompt) && messageText(message).includes("[ProofBlade prepared CTF path]")));
    assert.doesNotMatch(messageText((firstRequest.messages ?? []).at(-1) ?? {}), /<proofblade-turn-guidance>[\s\S]*\[ProofBlade prepared CTF path\]/);
    const projectionText = messageText((firstRequest.messages ?? []).at(-1) ?? {});
    const projectionMatch = projectionText.match(/<proofblade-context[^>]*dynamic-hash="([a-f0-9]{64})">\n([\s\S]*)\n<\/proofblade-context>/);
    assert.ok(projectionMatch, "the serialized context projection must expose its visible suffix hash");
    assert.equal(projectionMatch?.[1], sha256(projectionMatch?.[2] ?? ""), "dynamicSuffixHash must hash the bounded text sent to the Provider");
    assert.doesNotMatch(firstRequestBody, /Categorize: pick the dominant category/);
    assert.doesNotMatch(firstRequestBody, /Load the playbook:/);
    assert.ok(firstRequestEventTypes?.includes("tool_preparation_recorded"));
    const requestEpoch = (await services.control.events(runId)).find((event) => event.type === "request_epoch_started")?.payload?.epoch as { contextManifestHash?: unknown; manifestSummary?: { layerTokens?: Record<string, unknown>; maintenance?: unknown } } | undefined;
    assert.equal(typeof requestEpoch?.contextManifestHash, "string");
    assert.equal(typeof requestEpoch?.manifestSummary?.layerTokens?.L3A, "number");
    assert.equal(typeof requestEpoch?.manifestSummary?.layerTokens?.L3B, "number");
    assert.ok(requestEpoch?.manifestSummary?.maintenance);
    const requestEpochContext = (await services.control.events(runId)).find((event) => event.type === "request_epoch_context")?.payload as { fields?: { dynamicSuffixHash?: unknown } } | undefined;
    assert.equal(typeof requestEpochContext?.fields?.dynamicSuffixHash, "string");

    await lane.close();
    lane = undefined;
    resumedLane = await PiCodingLane.create({
      ...laneOptions,
      sessionRuntimePreflight: { brokers: [httpBroker], unavailableKinds: [] },
    });
    assert.equal((await services.control.events(runId)).filter((event) => event.type === "tool_preparation_recorded").length, 1);
    assert.equal(pwnHealthCalls, 0, "session resume must still avoid the unrelated Pwn broker");
    assert.equal(httpHealthCalls, 1, "session resume must reuse the caller-owned preflight too");
    await resumedLane.prompt("Continue from the durable prepared observation.");
    assert.equal(requestBodies.length, 2);
    assert.equal(captureProviderPrefixShape(JSON.parse(requestBodies[0]!)).prefixHash, captureProviderPrefixShape(JSON.parse(requestBodies[1]!)).prefixHash);

    const browserRunId = "PI-BROWSER-PREFLIGHT";
    const browserTask = fixtureTask(browserRunId, "web-source-1", root, config);
    browserTask.target = `REMOTE:http://127.0.0.1:${address.port}`;
    browserTask.verification.web = { flag_pattern: "^flag\\{", transport: "browser" };
    await services.control.createRun(browserRunId, browserTask);
    const browserClaims = new CodingClaimVerifier(browserRunId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
    browserLane = await PiCodingLane.create({
      ...laneOptions,
      runId: browserRunId,
      runDir: join(services.runsRoot, browserRunId),
      claimVerifier: browserClaims,
    });
    assert.equal(pwnHealthCalls, 0, "a Browser task must not probe the unrelated Pwn broker");
    assert.equal(httpHealthCalls, 1, "a Browser task must not require an HTTP session broker");
  } finally {
    await browserLane?.close();
    await resumedLane?.close();
    await lane?.close();
    await services?.sandbox.close();
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
