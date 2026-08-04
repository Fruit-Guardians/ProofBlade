import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServices } from "../src/app/demo.js";
import { fixtureTask } from "../src/app/fixture-task.js";
import { ProofBladeToolRuntime } from "../src/tools/runtime.js";
import { solverToolContractHash, solverToolContractSnapshot } from "../src/runtime/solver-tools.js";
import { bundledCapabilityCatalogHash } from "../src/capabilities/catalog.js";
import type { ProofBladeConfig } from "../src/config.js";

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
    "propose_intent",
    "propose_hypothesis",
    "propose_fact",
    "submit_candidate",
    "read_artifact",
    "search_history",
    "report_status",
  ]);
  assert.equal(solverToolContractHash(), "690b104af4533cd917b1728aa5d35a3925a4c04bd910bf3e2f5cc71987d056f1");
  assert.equal(bundledCapabilityCatalogHash(), "7b8e742875d5d4cba6b7a0e2107376c0f19cfd90cb4985cf8bd8db397fa81b62");
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
