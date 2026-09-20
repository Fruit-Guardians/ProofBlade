import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createServices, demoTask } from "../src/app/demo.js";
import { ExperimentGate } from "../src/competition/experiment-gate.js";
import type { ProofBladeConfig } from "../src/config.js";
import { CodingEvidenceGraph } from "../src/knowledge/evidence-graph.js";
import { EvidenceCurationGate } from "../src/knowledge/evidence-curation-gate.js";
import {
  DEFAULT_OBSERVER_FAILURE_LIMIT,
  ObserverDiagnostics,
} from "../src/observability/observer-diagnostics.js";
import { createCodingTools, type CodingResourceContext } from "../src/runtime/coding-resources.js";
import { ProofBladeToolRuntime } from "../src/tools/runtime.js";import { CodingClaimVerifier } from "../src/verification/claim-verification.js";

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "d3",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "D3_API_KEY",
      contextWindow: 4096,
      maxTokens: 512,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      input: ["text"],
    },
  },
};

test("the diagnostics log is bounded but keeps a lifetime count", () => {
  const diagnostics = new ObserverDiagnostics(2);
  for (let index = 0; index < 5; index += 1) diagnostics.record("artifact-observation", "RUN-1", new Error(`failure ${index}`));

  assert.equal(diagnostics.total(), 5, "the lifetime count must not be capped");
  assert.deepEqual(diagnostics.failures().map((sample) => sample.message), ["failure 3", "failure 4"]);
  assert.deepEqual(diagnostics.failures().map((sample) => sample.sequence), [4, 5], "sequence must keep rising across eviction");

  diagnostics.clear();
  assert.deepEqual(diagnostics.failures(), []);
  assert.equal(diagnostics.total(), 5, "clear drops samples, not the count");
});

test("recording never throws, so it cannot become a new failure path", () => {
  const diagnostics = new ObserverDiagnostics();
  // A hostile error whose own toString throws must still not escape: this is
  // called from a catch block whose purpose is to contain a failure.
  const hostile = { toString() { throw new Error("cannot stringify"); } };
  assert.doesNotThrow(() => diagnostics.record("artifact-observation", "RUN-1", hostile));
  assert.equal(diagnostics.total(), 1);
  assert.ok((diagnostics.failures()[0]?.message.length ?? 0) > 0, "a fallback message must be recorded");
});

test("a long error message is bounded", () => {
  const diagnostics = new ObserverDiagnostics();
  diagnostics.record("artifact-observation", "RUN-1", new Error("x".repeat(5_000)));

  const message = diagnostics.failures()[0]?.message ?? "";
  assert.ok(message.length <= 401, `message should be bounded, got ${message.length}`);
  assert.ok(message.endsWith("…"), "a truncated message must be marked as truncated");
});

test("the diagnostics rejects a limit that cannot retain a sample", () => {
  assert.throws(() => new ObserverDiagnostics(0), /positive integer/);
  assert.throws(() => new ObserverDiagnostics(1.5), /positive integer/);
  assert.equal(DEFAULT_OBSERVER_FAILURE_LIMIT >= 1, true);
});

test("[contract:observer-failure-is-diagnostic-only] a throwing observer does not change the tool result", async () => {
  // D3's first half. The observation is best-effort, so a failure must leave the
  // model-visible content and the error flag exactly as they were.
  const root = await mkdtemp(join(tmpdir(), "proofblade-d3-"));
  try {
    const services = createServices(root, config);
    const runId = "D3-THROW-1";
    await services.control.createRun(runId, { ...demoTask(runId, root, config), mode: "coding_assistant", target_kind: "unknown", verification: { kind: "reproduction", required_reproductions: 0 } });

    const diagnostics = new ObserverDiagnostics();
    const context = buildContext(runId, root, services, diagnostics, explodingRuntime(runId));

    const target = join(root, "notes.txt");
    await writeFile(target, "observable contents\n", "utf8");
    const read = createCodingTools().find((tool) => tool.name === "read");
    assert.ok(read, "the read tool must exist");
    const result = await read.execute("read-1", { path: target }, new AbortController().signal, undefined, context);

    const text = result.content.filter((item) => item.type === "text").map((item) => (item as { text: string }).text).join("\n");
    assert.notEqual(result.isError, true, "a failed observation must not mark the tool result as failed");
    assert.match(text, /observable contents/, "the file contents must still reach the model");
    assert.doesNotMatch(text, /exploded/, "the observer's error must not leak into model content");

    // And the failure is visible rather than swallowed.
    assert.equal(diagnostics.total(), 1, "the failure must be recorded");
    assert.equal(diagnostics.failures()[0]?.stage, "artifact-observation");
    assert.equal(diagnostics.failures()[0]?.runId, runId);
    assert.match(diagnostics.failures()[0]?.message ?? "", /observer exploded/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a healthy observer records no diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-d3-ok-"));
  try {
    const services = createServices(root, config);
    const runId = "D3-OK-1";
    await services.control.createRun(runId, { ...demoTask(runId, root, config), mode: "coding_assistant", target_kind: "unknown", verification: { kind: "reproduction", required_reproductions: 0 } });

    const diagnostics = new ObserverDiagnostics();
    const context = buildContext(runId, root, services, diagnostics, workingRuntime(runId, root, services));

    const target = join(root, "notes.txt");
    await writeFile(target, "observable contents\n", "utf8");
    const read = createCodingTools().find((tool) => tool.name === "read");
    assert.ok(read);
    const result = await read.execute("read-1", { path: target }, new AbortController().signal, undefined, context);

    assert.notEqual(result.isError, true);
    assert.equal(diagnostics.total(), 0, "a working observation path must stay quiet");
    // The observation still happened, so the silence is not "nothing ran".
    const details = result.details as { observationId?: string } | undefined;
    assert.ok(details?.observationId, "the observation must have been recorded durably");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A runtime whose observation always fails, standing in for a control-store outage. */
function explodingRuntime(runId: string): ProofBladeToolRuntime {
  return { runId, observeArtifact: async () => { throw new Error("observer exploded"); } } as unknown as ProofBladeToolRuntime;
}

/** The real runtime, for the healthy-path control. */
function workingRuntime(runId: string, root: string, services: ReturnType<typeof createServices>): ProofBladeToolRuntime {
  return new ProofBladeToolRuntime(
    runId,
    { fixtureId: runId, generation: 0, path: root, privatePath: join(root, ".proofblade") },
    services.runsRoot,
    services.control,
    services.artifacts,
    services.journal,
    root,
    { includeMcp: false },
  );
}

function buildContext(
  runId: string,
  root: string,
  services: ReturnType<typeof createServices>,
  diagnostics: ObserverDiagnostics,
  runtime: ProofBladeToolRuntime,
): CodingResourceContext {
  return {
    env: new NodeExecutionEnv({ cwd: root }),
    skills: {} as never,
    mcp: { summaries: () => [] } as never,
    enabledSkills: new Set<string>(),
    enabledMcpServers: new Set<string>(),
    claimVerifier: new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier),
    evidenceGraph: new CodingEvidenceGraph(runId, services.control, services.artifacts),
    evidenceCurationGate: new EvidenceCurationGate(runId, services.control),
    runtime,
    observerDiagnostics: diagnostics,
    completedReads: new Map(),
    artifactOutputRefs: new Map(),
    experimentGate: new ExperimentGate(services.control),
    outputRewrite: {
      port: {
        async prepare({ toolCallId, command }: { toolCallId: string; command: string }) {
          return { toolCallId, command, requestedProvider: "builtin", provider: "builtin", providerVersion: "d3", applied: false, originalCommandHash: command, rewrittenCommandHash: command };
        },
        async finalize(_ticket: unknown, visibleOutput: string) {
          const bytes = Buffer.byteLength(visibleOutput);
          return { rawOutput: visibleOutput, rawBytes: bytes, visibleBytes: bytes, rawTruncated: false, rawCapture: "visible-output" as const };
        },
      },
      artifactStore: services.artifacts,
      runId,
    },
  } as unknown as CodingResourceContext;
}
