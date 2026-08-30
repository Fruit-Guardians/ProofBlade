import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices } from "../src/app/demo.js";
import { fixtureTask } from "../src/app/fixture-task.js";
import { ProofBladeToolRuntime } from "../src/tools/runtime.js";
import { createSolverTools, solverToolContractHash, solverToolContractSnapshot } from "../src/runtime/solver-tools.js";
import { bundledCapabilityCatalogHash } from "../src/capabilities/catalog.js";
import type { ProofBladeConfig } from "../src/config.js";
import { ProofBladeToolError } from "../src/tools/errors.js";
import type { ToolFailureAtom } from "@proofblade/atoms";

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

test("core solver tool contract has a stable ordered surface", () => {
  assert.deepEqual(solverToolContractSnapshot().map((tool) => tool.name), [
    "inspect_target",
    "list_capabilities",
    "discover_capabilities",
    "invoke_capability",
    "run_background",
    "read_job_output",
    "monitor_job",
    "stop_job",
    "load_skill",
    "propose_intent",
    "propose_hypothesis",
    "propose_fact",
    "submit_candidate",
    "read_artifact",
    "search_history",
    "report_status",
  ]);
  for (const contract of solverToolContractSnapshot()) {
    assert.equal(typeof contract.version, "string");
    assert.equal(typeof contract.readOnly, "boolean");
    assert.equal(typeof contract.timeoutMs, "number");
    assert.ok(Array.isArray(contract.resourceKeys));
    assert.match(String(contract.sensitivity), /^(public|target|secret)$/);
    assert.match(String(contract.replay), /^(pure|idempotent|resumable|reconcile|manual|forbidden-replay)$/);
  }
  assert.equal(solverToolContractHash(), "5e7564286643f24dec5ff30af45bb90878cf58bf5177d1cb3315f541a8e302c4");
  assert.equal(bundledCapabilityCatalogHash(), "a8f993b8344a62572a7a3e643e0506edc301f8750f69609353d081eaeb2f3e9e");
});

test("tool failures preserve structured errors and set the Pi error flag", async () => {
  const tool = createSolverTools().find((candidate) => candidate.name === "invoke_capability");
  assert.ok(tool);
  const partialArtifactRef = { id: "artifact-partial", path: "artifacts/partial.txt", sha256: "a".repeat(64), bytes: 7, mime: "text/plain" };
  const result = await tool.execute(
    "tool-call-1",
    { capabilityId: "fixture", operation: "timeout", input: {} },
    undefined,
    undefined,
    {
      runtime: {
        async invokeCapability() {
          throw new ProofBladeToolError({
            code: "TOOL_TIMEOUT",
            message: "operation timed out after reading PB{secret}",
            retryable: true,
            phase: "execute",
            partialArtifactRef,
            nextHint: "Read the partial artifact before retrying.",
          });
        },
      },
      skills: {},
    } as never,
  );
  const failure = result.details as ToolFailureAtom<typeof partialArtifactRef>;
  assert.equal(result.isError, true);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, "TOOL_TIMEOUT");
  assert.equal(failure.error.retryable, true);
  assert.equal(failure.error.phase, "execute");
  assert.equal(failure.error.partial_artifact_ref?.id, "artifact-partial");
  assert.equal(failure.error.next_hint, "Read the partial artifact before retrying.");
  assert.equal(failure.error.signature.length, 64);
  assert.doesNotMatch(JSON.stringify(result), /PB\{secret\}/);
});

test("capability catalog and router keep stable manifests and artifact anchors", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-capability-"));
  try {
    const services = createServices(root, config);
    const runId = "CAPABILITY-001";
    const task = fixtureTask(runId, "web-source-1", root, config);
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);
    const runtime = new ProofBladeToolRuntime(runId, fixture, services.runsRoot, services.control, services.artifacts, services.journal);
    const catalog = runtime.listCapabilities();
    assert.ok(catalog.catalogHash.length === 64);
    assert.deepEqual(catalog.capabilities.map((item) => item.id), ["proofblade.artifact", "proofblade.binary", "proofblade.firmware", "proofblade.target"]);
    const rizinStatus = catalog.backends.find((item) => item.id === "proofblade-rizin");
    assert.equal(rizinStatus?.kind, "local-process");
    assert.equal(catalog.backends.find((item) => item.id === "proofblade-binary")?.available, true);
    assert.equal(catalog.backends.find((item) => item.id === "proofblade-firmware")?.available, true);
    assert.equal(catalog.backends.find((item) => item.id === "proofblade-bundled")?.available, true);
    assert.equal(catalog.backends.find((item) => item.id === "proofblade-mcp")?.available, false);
    const search = runtime.discoverCapabilities({ query: "binary disassemble", maxResults: 10 });
    assert.equal(search.totalMatches, 1);
    assert.equal(search.results[0]?.capabilityId, "proofblade.binary");
    assert.equal(search.results[0]?.operation, "disassemble");
    assert.equal(search.results[0]?.parameters, undefined);
    assert.ok(search.results[0]?.backends.some((backend) => backend.id === "proofblade-rizin"));
    const described = runtime.discoverCapabilities({ capabilityId: "proofblade.binary", operation: "identify", includeSchemas: true, maxResults: 1 });
    assert.equal(described.totalMatches, 1);
    assert.equal((described.results[0]?.parameters as { type?: string }).type, "object");
    assert.equal(described.results[0]?.selectedBackend?.id, "proofblade-binary");
    const limited = runtime.discoverCapabilities({ query: "binary", maxResults: 2 });
    assert.equal(limited.results.length, 2);
    assert.equal(limited.truncated, true);
    assert.throws(() => runtime.discoverCapabilities({ operation: "identify" }), /requires capabilityId/);
    assert.throws(() => runtime.discoverCapabilities({ maxResults: 0 }), /between 1 and 100/);
    assert.equal(Object.keys((await services.control.snapshot(runId)).effects).length, 0, "discovery must not execute a capability");
    const inspected = await runtime.invokeCapability({ capabilityId: "proofblade.target", operation: "inspect", input: {} });
    assert.match(inspected.output, /^<untrusted-observation/);
    assert.equal(inspected.artifactId.length > 0, true);
    assert.equal(inspected.backendId, "proofblade-bundled");
    assert.equal(inspected.backendKind, "bundled");
    assert.equal(inspected.backendVersion, "1.0.0");
    const invokedSnapshot = await services.control.snapshot(runId);
    const expectedProvenance = {
      capabilityId: "proofblade.target",
      operation: "inspect",
      manifestHash: catalog.capabilities.find((item) => item.id === "proofblade.target")?.hash,
      backendId: "proofblade-bundled",
      backendKind: "bundled",
      backendVersion: "1.0.0",
    };
    assert.deepEqual(invokedSnapshot.effects[inspected.effectId]?.args.capability, expectedProvenance);
    const invocationArtifact = invokedSnapshot.artifacts[inspected.artifactId];
    assert.ok(invocationArtifact);
    const artifactPayload = JSON.parse(await services.artifacts.readText(runId, invocationArtifact)) as { args?: { capability?: unknown } };
    assert.deepEqual(artifactPayload.args?.capability, expectedProvenance);
    const archived = await runtime.invokeCapability({ capabilityId: "proofblade.artifact", operation: "read", input: { artifactId: inspected.artifactId, maxChars: 256 } });
    assert.equal(archived.truncated, true);
    const binary = Buffer.alloc(64);
    binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
    await writeFile(join(fixture.path, "sample.bin"), binary);
    const binaryIdentity = await runtime.invokeCapability({ capabilityId: "proofblade.binary", operation: "identify", input: { path: "sample.bin" } });
    assert.ok(binaryIdentity.observationId);
    assert.ok(binaryIdentity.evidenceId);
    await writeFile(join(fixture.path, "firmware.bin"), Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    const firmwareScan = await runtime.invokeCapability({ capabilityId: "proofblade.firmware", operation: "scan", input: { path: "firmware.bin" } });
    assert.equal(firmwareScan.backendId, "proofblade-firmware");
    assert.ok(firmwareScan.observationId);
    assert.ok(firmwareScan.evidenceId);
    await assert.rejects(() => runtime.invokeCapability({ capabilityId: "proofblade.target", operation: "inspect", input: { path: "../outside" } }));
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("background jobs complete, timeout, cancel, and recover through durable records", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-jobs-"));
  let runtime: ProofBladeToolRuntime | undefined;
  try {
    const services = createServices(root, config);
    const runId = "JOBS-001";
    const task = fixtureTask(runId, "reverse-strings-1", root, config);
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    let generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);
    runtime = new ProofBladeToolRuntime(runId, fixture, services.runsRoot, services.control, services.artifacts, services.journal);

    await assert.rejects(() => services.control.dispatch(runId, {
      type: "job_queued",
      job: { id: "J-MISSING-BACKEND", capabilityId: "proofblade.target", operation: "list", args: {}, replayPolicy: "pure", status: "QUEUED", lane: "executor", generation } as never,
      lane: "executor",
    }), /requires backendId and backendVersion/);

    const success = await runtime.runBackground({ capabilityId: "proofblade.target", operation: "list", input: {} });
    const completed = await runtime.waitJob(String(success.jobId));
    assert.equal(completed.status, "SUCCEEDED");
    assert.equal(completed.backendId, "proofblade-bundled");
    assert.equal(completed.backendVersion, "1.0.0");
    assert.match((await runtime.readJobOutput(completed.id)).output, /binary-info|strings/);
    const completedOutput = await runtime.readJobOutput(completed.id);
    const exitSignal = await runtime.monitorJob(completed.id, { sinceCursor: String(completedOutput.originalChars), triggers: ["exit"], waitMs: 100 });
    assert.equal(exitSignal.trigger, "exit");
    assert.equal(exitSignal.status, "SUCCEEDED");

    const heartbeatJob = await runtime.runBackground({ capabilityId: "proofblade.target", operation: "delay", input: { milliseconds: 500 }, timeoutMs: 5_000 });
    const heartbeat = await runtime.monitorJob(String(heartbeatJob.jobId), { triggers: ["heartbeat"], heartbeatMs: 50, waitMs: 500 });
    assert.equal(heartbeat.trigger, "heartbeat");
    await runtime.stopJob(String(heartbeatJob.jobId), "heartbeat test cleanup");

    const timeout = await runtime.runBackground({ capabilityId: "proofblade.target", operation: "delay", input: { milliseconds: 250 }, timeoutMs: 50 });
    const blockedUntil = Date.now() + 100;
    while (Date.now() < blockedUntil) {
      // Exercise the durable deadline path when the event loop delays the timer callback.
    }
    assert.equal((await runtime.waitJob(String(timeout.jobId), 2_000)).status, "TIMED_OUT");

    const cancel = await runtime.runBackground({ capabilityId: "proofblade.target", operation: "delay", input: { milliseconds: 1_000 }, timeoutMs: 5_000 });
    await runtime.stopJob(String(cancel.jobId), "test cancellation");
    assert.equal((await runtime.waitJob(String(cancel.jobId), 2_000)).status, "CANCELLED");

    await services.control.dispatch(runId, {
      type: "job_queued_legacy",
      job: { id: "J-RECOVER", capabilityId: "proofblade.target", operation: "list", args: {}, replayPolicy: "pure", status: "QUEUED", lane: "executor", generation },
      lane: "executor",
    });
    await runtime.recoverJobs();
    assert.equal((await runtime.waitJob("J-RECOVER")).status, "SUCCEEDED");
    const snapshot = await services.control.snapshot(runId);
    assert.equal(snapshot.jobs["J-RECOVER"]?.status, "SUCCEEDED");
    assert.equal((await services.control.replay(runId)).jobs["J-RECOVER"]?.status, "SUCCEEDED");

    await services.control.dispatch(runId, {
      type: "job_queued",
      job: { id: "J-STALE-RECOVER", capabilityId: "proofblade.target", operation: "list", backendId: "proofblade-bundled", backendVersion: "1.0.0", args: {}, replayPolicy: "pure", status: "QUEUED", lane: "executor", generation: snapshot.generation },
      lane: "executor",
    });
    const nextGeneration = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, nextGeneration);
    generation = nextGeneration;
    await runtime.recoverJobs();
    const staleRecovered = await runtime.jobStatus("J-STALE-RECOVER");
    assert.equal(staleRecovered.status, "UNKNOWN");
    assert.match(staleRecovered.error ?? "", /belongs to generation/);
    assert.equal((await services.control.events(runId)).filter((event) => event.type === "job_started" && event.payload.jobId === "J-STALE-RECOVER").length, 0);

    await services.control.dispatch(runId, {
      type: "job_queued",
      job: { id: "J-RECOVER-EXPIRED", capabilityId: "proofblade.target", operation: "delay", backendId: "proofblade-bundled", backendVersion: "1.0.0", args: { milliseconds: 500 }, replayPolicy: "idempotent", status: "QUEUED", lane: "executor", generation, timeoutMs: 50 },
      lane: "executor",
    });
    await services.control.dispatch(runId, { type: "job_started", jobId: "J-RECOVER-EXPIRED", startedAt: new Date(Date.now() - 1_000).toISOString(), lane: "executor" });
    await runtime.recoverJobs();
    const expired = await runtime.jobStatus("J-RECOVER-EXPIRED");
    assert.equal(expired.status, "TIMED_OUT");
    assert.match(expired.error ?? "", /deadline elapsed before recovery/);

    await services.control.dispatch(runId, {
      type: "job_queued",
      job: { id: "J-RECOVER-ACTIVE", capabilityId: "proofblade.target", operation: "delay", backendId: "proofblade-bundled", backendVersion: "1.0.0", args: { milliseconds: 100 }, replayPolicy: "idempotent", status: "QUEUED", lane: "executor", generation, timeoutMs: 2_000 },
      lane: "executor",
    });
    await services.control.dispatch(runId, { type: "job_started", jobId: "J-RECOVER-ACTIVE", startedAt: new Date().toISOString(), lane: "executor" });
    await runtime.recoverJobs();
    await runtime.recoverJobs();
    assert.equal((await runtime.waitJob("J-RECOVER-ACTIVE", 2_000)).status, "SUCCEEDED");
    const activeStarts = (await services.control.events(runId)).filter((event) => event.type === "job_started" && event.payload.jobId === "J-RECOVER-ACTIVE");
    assert.equal(activeStarts.length, 1);

    await services.control.dispatch(runId, {
      type: "job_queued",
      job: { id: "J-BACKEND-DRIFT", capabilityId: "proofblade.target", operation: "list", backendId: "proofblade-bundled", backendVersion: "0.9.0", args: {}, replayPolicy: "pure", status: "QUEUED", lane: "executor", generation },
      lane: "executor",
    });
    await runtime.recoverJobs();
    const drifted = await runtime.waitJob("J-BACKEND-DRIFT");
    assert.equal(drifted.status, "FAILED");
    assert.match(drifted.error ?? "", /backend version changed/);

    await services.control.dispatch(runId, {
      type: "job_queued_legacy",
      job: { id: "J-REDACTED", capabilityId: "proofblade.target", operation: "list", args: {}, argsRedacted: true, replayPolicy: "pure", status: "QUEUED", lane: "executor", generation },
      lane: "executor",
    });
    await runtime.recoverJobs();
    const redacted = await runtime.jobStatus("J-REDACTED");
    assert.equal(redacted.status, "UNKNOWN");
    assert.match(redacted.error ?? "", /arguments were redacted/);

    await services.control.dispatch(runId, {
      type: "job_queued_legacy",
      job: { id: "J-TERMINAL", capabilityId: "proofblade.target", operation: "list", args: {}, replayPolicy: "pure", status: "QUEUED", lane: "executor", generation },
      lane: "executor",
    });
    await services.control.dispatch(runId, { type: "fail", reason: "terminal recovery fixture" });
    await runtime.recoverJobs();
    assert.equal((await runtime.jobStatus("J-TERMINAL")).status, "UNKNOWN");
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("monitor_job resumes at UTF-8 byte cursors without splitting multibyte output", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-job-utf8-"));
  let runtime: ProofBladeToolRuntime | undefined;
  try {
    const services = createServices(root, config);
    const runId = "JOBS-UTF8-001";
    const task = fixtureTask(runId, "reverse-strings-1", root, config);
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.fixtureControl.reset(runId, generation);
    runtime = new ProofBladeToolRuntime(runId, fixture, services.runsRoot, services.control, services.artifacts, services.journal);
    const artifact = await services.artifacts.putText(runId, "前缀\n命中结果", { filename: "job-output.txt", sensitivity: "public" });
    await services.control.dispatch(runId, {
      type: "job_queued",
      job: {
        id: "J-UTF8",
        capabilityId: "proofblade.target",
        operation: "list",
        backendId: "proofblade-bundled",
        backendVersion: "1.0.0",
        args: {},
        replayPolicy: "pure",
        status: "QUEUED",
        lane: "executor",
        generation,
      },
      lane: "executor",
    });
    await services.control.dispatch(runId, { type: "job_started", jobId: "J-UTF8", lane: "executor" });
    await services.control.dispatch(runId, { type: "job_finished", jobId: "J-UTF8", status: "SUCCEEDED", outcome: "success", artifactId: artifact.id, lane: "executor" });

    const prefixBytes = Buffer.byteLength("前缀\n", "utf8");
    const monitored = await runtime.monitorJob("J-UTF8", { sinceCursor: String(prefixBytes), triggers: ["new_output"], waitMs: 100 });
    assert.equal(monitored.cursor, String(Buffer.byteLength("前缀\n命中结果", "utf8")));
    assert.equal(monitored.output, "命中结果");
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
