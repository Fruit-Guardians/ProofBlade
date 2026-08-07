import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
    "invoke_capability",
    "run_background",
    "read_job_output",
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
  assert.equal(solverToolContractHash(), "e6205b8076af79ef76d26d031eb4313ce472541265634b60de91a111eb552ca5");
  assert.equal(bundledCapabilityCatalogHash(), "7b8e742875d5d4cba6b7a0e2107376c0f19cfd90cb4985cf8bd8db397fa81b62");
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
    await services.control.dispatch(runId, { type: "fixture_reset", generation });
    const runtime = new ProofBladeToolRuntime(runId, fixture, services.runsRoot, services.control, services.artifacts, services.journal);
    const catalog = runtime.listCapabilities();
    assert.ok(catalog.catalogHash.length === 64);
    assert.deepEqual(catalog.capabilities.map((item) => item.id), ["proofblade.artifact", "proofblade.target"]);
    const inspected = await runtime.invokeCapability({ capabilityId: "proofblade.target", operation: "inspect", input: {} });
    assert.match(inspected.output, /^<untrusted-observation/);
    assert.equal(inspected.artifactId.length > 0, true);
    const archived = await runtime.invokeCapability({ capabilityId: "proofblade.artifact", operation: "read", input: { artifactId: inspected.artifactId, maxChars: 256 } });
    assert.equal(archived.truncated, true);
    await assert.rejects(() => runtime.invokeCapability({ capabilityId: "proofblade.target", operation: "inspect", input: { path: "../outside" } }));
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("background jobs complete, timeout, cancel, and recover through durable records", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-jobs-"));
  try {
    const services = createServices(root, config);
    const runId = "JOBS-001";
    const task = fixtureTask(runId, "reverse-strings-1", root, config);
    await services.control.createRun(runId, task);
    const fixture = await services.sandbox.build(task);
    const generation = await services.sandbox.reset(fixture);
    await services.control.dispatch(runId, { type: "fixture_reset", generation });
    const runtime = new ProofBladeToolRuntime(runId, fixture, services.runsRoot, services.control, services.artifacts, services.journal);

    const success = await runtime.runBackground({ capabilityId: "proofblade.target", operation: "list", input: {} });
    const completed = await runtime.waitJob(String(success.jobId));
    assert.equal(completed.status, "SUCCEEDED");
    assert.match((await runtime.readJobOutput(completed.id)).output, /binary-info|strings/);

    const timeout = await runtime.runBackground({ capabilityId: "proofblade.target", operation: "delay", input: { milliseconds: 250 }, timeoutMs: 50 });
    assert.equal((await runtime.waitJob(String(timeout.jobId), 2_000)).status, "TIMED_OUT");

    const cancel = await runtime.runBackground({ capabilityId: "proofblade.target", operation: "delay", input: { milliseconds: 1_000 }, timeoutMs: 5_000 });
    await runtime.stopJob(String(cancel.jobId), "test cancellation");
    assert.equal((await runtime.waitJob(String(cancel.jobId), 2_000)).status, "CANCELLED");

    await services.control.dispatch(runId, {
      type: "job_queued",
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
      job: { id: "J-REDACTED", capabilityId: "proofblade.target", operation: "list", args: {}, argsRedacted: true, replayPolicy: "pure", status: "QUEUED", lane: "executor", generation },
      lane: "executor",
    });
    await runtime.recoverJobs();
    const redacted = await runtime.jobStatus("J-REDACTED");
    assert.equal(redacted.status, "UNKNOWN");
    assert.match(redacted.error ?? "", /arguments were redacted/);

    await services.control.dispatch(runId, {
      type: "job_queued",
      job: { id: "J-TERMINAL", capabilityId: "proofblade.target", operation: "list", args: {}, replayPolicy: "pure", status: "QUEUED", lane: "executor", generation },
      lane: "executor",
    });
    await services.control.dispatch(runId, { type: "fail", reason: "terminal recovery fixture" });
    await runtime.recoverJobs();
    assert.equal((await runtime.jobStatus("J-TERMINAL")).status, "UNKNOWN");
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
