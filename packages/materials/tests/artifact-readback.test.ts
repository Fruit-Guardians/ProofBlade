import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core/node";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { ProofBladeToolRuntime } from "../src/tools/runtime.js";
import { createServices, demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { createCodingTools, type CodingResourceContext } from "../src/runtime/coding-resources.js";
import { ProofBladeSkillRegistry } from "../src/skills/registry.js";
import { CodingEvidenceGraph } from "../src/knowledge/evidence-graph.js";
import { EvidenceCurationGate } from "../src/knowledge/evidence-curation-gate.js";
import { CodingClaimVerifier } from "../src/verification/claim-verification.js";
import type { OutputRewritePort } from "@proofblade/molecules";

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

/**
 * A minimal output-rewrite pipeline: it archives the text unchanged and reports
 * the raw output, which is exactly what the observer used to read back.
 */
function passthroughRewrite(artifactStore: ReturnType<typeof createServices>["artifacts"], runId: string) {
  return {
    port: {
      async prepare({ toolCallId, command }: { toolCallId: string; command: string }) {
        return { toolCallId, command, requestedProvider: "builtin", provider: "builtin", providerVersion: "test", applied: false, originalCommandHash: command, rewrittenCommandHash: command };
      },
      async finalize(_ticket: unknown, visibleOutput: string) {
        return { rawOutput: visibleOutput, rawBytes: Buffer.byteLength(visibleOutput), visibleBytes: Buffer.byteLength(visibleOutput), rawTruncated: false, rawCapture: "visible-output" as const };
      },
    } as unknown as OutputRewritePort,
    artifactStore,
    runId,
  };
}

test("an ordinary read observes its artifact without reading it back from disk", async () => {
  // PLAN-240 item T1. The observer only inspects bounded stdout for candidate and
  // failure signatures, so re-reading the artifact it was just handed the exact
  // bytes of is pure overhead on the tool hot path.
  const root = await mkdtemp(join(tmpdir(), "proofblade-readback-"));
  try {
    const services = createServices(root, config);
    const runId = "READBACK-001";
    await services.control.createRun(runId, demoTask(runId, root, config));
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

    // Count every artifact read the tool path performs.
    let reads = 0;
    const originalReadText = services.artifacts.readText.bind(services.artifacts);
    services.artifacts.readText = (async (...args: Parameters<typeof originalReadText>) => {
      reads += 1;
      return await originalReadText(...args);
    }) as typeof services.artifacts.readText;

    const target = join(root, "notes.txt");
    await writeFile(target, "ordinary contents\n", "utf8");
    const context = {
      env: new NodeExecutionEnv({ cwd: root }),
      skills: {} as ProofBladeSkillRegistry,
      mcp: { summaries: () => [] },
      enabledSkills: new Set<string>(),
      enabledMcpServers: new Set<string>(),
      claimVerifier: new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier),
      evidenceGraph: new CodingEvidenceGraph(runId, services.control, services.artifacts),
      evidenceCurationGate: new EvidenceCurationGate(runId, services.control),
      runtime,
      outputRewrite: passthroughRewrite(services.artifacts, runId),
      completedReads: new Map(),
      artifactOutputRefs: new Map(),
    } as unknown as CodingResourceContext;

    const read = createCodingTools().find((tool) => tool.name === "read");
    assert.ok(read, "the read tool must exist");
    const result = await (read as AgentHarnessTool<CodingResourceContext>).execute("read-1", { path: target }, new AbortController().signal, undefined, context);

    assert.notEqual(result.isError, true);
    assert.equal(reads, 0, "observing an ordinary read must not read the artifact back from disk");

    // The observation must still be real: it is attached to the result and
    // durable in the store.
    const details = result.details as { artifactId?: string; observationId?: string; evidenceId?: string } | undefined;
    assert.ok(details?.artifactId, "the read result must still be archived");
    const snapshot = await services.control.snapshot(runId);
    assert.ok(snapshot.artifacts[details.artifactId], "the archived artifact must be readable from the store");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the observer still sees the artifact text it classifies", async () => {
  // Removing the read-back must not blind the observer: a flag-shaped value in
  // the output must still be detected, which requires it to receive the bytes.
  const root = await mkdtemp(join(tmpdir(), "proofblade-readback-detect-"));
  try {
    const services = createServices(root, config);
    const runId = "READBACK-002";
    await services.control.createRun(runId, demoTask(runId, root, config));
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
    const target = join(root, "flag.txt");
    await writeFile(target, "the answer is flag{readback_probe}\n", "utf8");
    const context = {
      env: new NodeExecutionEnv({ cwd: root }),
      skills: {} as ProofBladeSkillRegistry,
      mcp: { summaries: () => [] },
      enabledSkills: new Set<string>(),
      enabledMcpServers: new Set<string>(),
      claimVerifier: new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier),
      evidenceGraph: new CodingEvidenceGraph(runId, services.control, services.artifacts),
      evidenceCurationGate: new EvidenceCurationGate(runId, services.control),
      runtime,
      outputRewrite: passthroughRewrite(services.artifacts, runId),
      completedReads: new Map(),
      artifactOutputRefs: new Map(),
    } as unknown as CodingResourceContext;

    const read = createCodingTools().find((tool) => tool.name === "read");
    assert.ok(read);
    const result = await (read as AgentHarnessTool<CodingResourceContext>).execute("read-1", { path: target }, new AbortController().signal, undefined, context);

    const details = result.details as { candidateKinds?: string[] } | undefined;
    assert.deepEqual(details?.candidateKinds, ["flag-shaped-value"], "the observer must still classify the archived text");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
