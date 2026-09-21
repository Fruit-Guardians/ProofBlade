import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServices, demoTask, type ProofBladeConfig } from "../src/app/demo.js";
import { PiCodingLane } from "../src/runtime/coding-lane.js";
import { createCodingTools } from "../src/runtime/coding-resources.js";
import { CodingClaimVerifier } from "../src/verification/claim-verification.js";

/**
 * Observation diagnostics must be reachable in production, not just in tests.
 *
 * `CodingResourceContext.observerDiagnostics` is optional, and the review found
 * that no production caller ever supplied one: every
 * `context.observerDiagnostics?.record(...)` in coding-resources resolved to a
 * no-op, so a failing ControlStore on the observation path left no trace and
 * "no observations" was indistinguishable from "every observation failed",
 * which is the exact ambiguity the diagnostics were introduced to remove.
 *
 * The existing suites could not catch that: they construct a context literal and
 * inject their own ObserverDiagnostics, so they pass whether or not the lane
 * wires one up. This test builds a real lane and asserts the sink exists and is
 * the same object the lane reports.
 */

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
      apiKeyEnv: "DIAGNOSTICS_API_KEY",
      contextWindow: 4096,
      maxTokens: 512,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      input: ["text"],
    },
  },
};

test("[contract:observer-failure-is-diagnostic-only] a production lane exposes an observation-diagnostics sink", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-lane-diagnostics-"));
  let lane: PiCodingLane | undefined;
  try {
    const services = createServices(root, config);
    const runId = "LANE-DIAGNOSTICS-1";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const verifier = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);

    lane = await PiCodingLane.create({
      runId,
      projectRoot: root,
      installRoot: root,
      runDir: join(services.runsRoot, runId),
      controlStore: services.control,
      artifactStore: services.artifacts,
      journal: services.journal,
      claimVerifier: verifier,
      config,
    });

    const diagnostics = lane.observerDiagnostics();
    assert.ok(diagnostics, "a production lane must expose observation diagnostics");
    // A lane that has done nothing yet has recorded nothing, so the counter is a
    // meaningful zero rather than an absent sink: `total()` is the reading an
    // operator uses to tell "healthy" from "the observation path is failing".
    assert.equal(diagnostics.total(), 0, "a fresh lane has no observation failures");
    assert.deepEqual(diagnostics.failures(), []);
    // The same instance must be what the tool context records into; a second
    // instance would make the lane's reading permanently zero.
    assert.equal(lane.observerDiagnostics(), diagnostics, "the lane must report a stable sink");
  } finally {
    await lane?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a real tool failure reaches the lane's diagnostics, not /dev/null", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-lane-diagnostics-flow-"));
  let lane: PiCodingLane | undefined;
  try {
    const services = createServices(root, config);
    const runId = "LANE-DIAGNOSTICS-2";
    await services.control.createRun(runId, demoTask(runId, root, config));
    const verifier = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);

    // Make the observation path fail on the real tool context, so a successful
    // read has to record a diagnostic instead of failing.
    let seen: import("../src/runtime/coding-resources.js").CodingResourceContext | undefined;
    lane = await PiCodingLane.create({
      runId,
      projectRoot: root,
      installRoot: root,
      runDir: join(services.runsRoot, runId),
      controlStore: services.control,
      artifactStore: services.artifacts,
      journal: services.journal,
      claimVerifier: verifier,
      config,
      instrumentToolContext: (context) => {
        seen = context;
        const runtime = context.runtime;
        if (runtime) {
          (runtime as { observeArtifact?: unknown }).observeArtifact = async () => {
            throw new Error("control store unavailable");
          };
        }
      },
    });

    assert.ok(seen, "the lane must build a tool context");
    assert.ok(seen.observerDiagnostics, "the lane must supply the diagnostics sink to its tools");

    // Drive the archived-read path directly through the lane's own context.
    const readTool = createCodingTools().find((tool) => tool.name === "read");
    assert.ok(readTool, "the read tool must exist");
    const target = join(root, "diagnosed.txt");
    await writeFile(target, "the observation of this read will fail\n", "utf8");
    const result = await readTool.execute("read-diag", { path: target }, new AbortController().signal, undefined, seen);
    assert.notEqual(result.isError, true, "a failing observation must not fail the read");

    const diagnostics = lane.observerDiagnostics();
    assert.equal(diagnostics.total(), 1, "the failure must be recorded on the lane's sink, not swallowed");
    assert.equal(diagnostics.failures()[0]?.stage, "artifact-observation");
    assert.match(String(diagnostics.failures()[0]?.message), /control store unavailable/);
  } finally {
    await lane?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
