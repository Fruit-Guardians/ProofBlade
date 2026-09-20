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
import { ObserverDiagnostics } from "../src/observability/observer-diagnostics.js";
import { createCodingTools, type CodingResourceContext } from "../src/runtime/coding-resources.js";
import { ProofBladeToolRuntime } from "../src/tools/runtime.js";
import { CodingClaimVerifier } from "../src/verification/claim-verification.js";

/**
 * Spill/archival failure semantics (PLAN-240 item D2).
 *
 * The plan requires that an oversized result uses spill as *transport* while the
 * tool call itself stays successful: "spill 失败保留工具成功和有界内联结果".
 * Before this work, an artifact write failure on the read path threw, so a
 * completed file read became a failed solve even though the model already held
 * every byte it needed.
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
      model: "d2",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "D2_API_KEY",
      contextWindow: 4096,
      maxTokens: 512,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      input: ["text"],
    },
  },
};

interface Scenario {
  readonly root: string;
  readonly result: { isError?: boolean; content: Array<{ type?: string; text?: string }>; details?: unknown };
  readonly diagnostics: ObserverDiagnostics;
}

/** Drive one read through a real Run, optionally with artifact storage down. */
async function readOnce(runId: string, content: string, breakArchival: boolean): Promise<Scenario> {
  const root = await mkdtemp(join(tmpdir(), "proofblade-d2-"));
  const services = createServices(root, config);
  await services.control.createRun(runId, { ...demoTask(runId, root, config), mode: "coding_assistant", target_kind: "unknown", verification: { kind: "reproduction", required_reproductions: 0 } });
  if (breakArchival) {
    services.artifacts.putText = (async () => { throw new Error("artifact storage unavailable"); }) as typeof services.artifacts.putText;
  }
  const diagnostics = new ObserverDiagnostics();
  const runtime = new ProofBladeToolRuntime(
    runId,
    { fixtureId: runId, generation: 0, path: root, privatePath: join(root, ".proofblade") },
    services.runsRoot,
    services.control,
    services.artifacts,
    services.journal,
    root,
    { includeMcp: false },
  );
  const target = join(root, "target.txt");
  await writeFile(target, content, "utf8");
  const context = {
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
          return { toolCallId, command, requestedProvider: "builtin", provider: "builtin", providerVersion: "d2", applied: false, originalCommandHash: command, rewrittenCommandHash: command };
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

  const read = createCodingTools().find((tool) => tool.name === "read");
  assert.ok(read, "the read tool must exist");
  const result = await read.execute("read-1", { path: target }, new AbortController().signal, undefined, context) as Scenario["result"];
  await rm(root, { recursive: true, force: true });
  return { root, result, diagnostics };
}

test("[contract:archival-failure-keeps-read-successful] a failed archival returns the content inline instead of failing the read", async () => {
  const { result, diagnostics } = await readOnce("D2-FAIL-1", "important contents\n", true);

  assert.notEqual(result.isError, true, "a storage outage must not turn a completed read into a failure");
  const text = result.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
  assert.match(text, /important contents/, "the model must still receive the file contents");
  assert.match(text, /read unarchived/, "the model must be told the content carries no citable artifact id");
  assert.doesNotMatch(text, /artifact storage unavailable/, "the raw storage error must not leak into model content");

  // And the outage is visible to an operator rather than swallowed.
  assert.equal(diagnostics.total(), 1);
  assert.equal(diagnostics.failures()[0]?.runId, "D2-FAIL-1");
  assert.match(diagnostics.failures()[0]?.message ?? "", /artifact storage unavailable/);
});

test("a healthy archival still reports an artifact id and no diagnostics", async () => {
  const { result, diagnostics } = await readOnce("D2-OK-1", "important contents\n", false);

  assert.notEqual(result.isError, true);
  const details = result.details as { artifactId?: string; archivalFailed?: boolean } | undefined;
  assert.ok(details?.artifactId, "a successful read must still be citable");
  assert.equal(details?.archivalFailed, undefined);
  assert.equal(diagnostics.total(), 0, "the healthy path must stay quiet");
});

test("the inline fallback stays bounded because the read itself is capped", async () => {
  // The fallback returns the result the contract already produced, and
  // readCompleteFile caps that at MAX_COMPLETE_READ_BYTES, so a storage outage
  // cannot push an unbounded file into the context.
  const { result } = await readOnce("D2-FAIL-BIG", `${"y".repeat(400_000)}\n`, true);

  const text = result.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
  assert.notEqual(result.isError, true);
  assert.ok(
    Buffer.byteLength(text) <= 256 * 1024 + 512,
    `inline fallback should stay within the read cap, got ${Buffer.byteLength(text)} bytes`,
  );
});
