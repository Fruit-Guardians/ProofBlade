import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createServices, demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { CodingEvidenceGraph } from "../src/knowledge/evidence-graph.js";
import { EvidenceCurationGate } from "../src/knowledge/evidence-curation-gate.js";
import { ExperimentGate } from "../src/competition/experiment-gate.js";
import { createCodingTools, type CodingResourceContext } from "../src/runtime/coding-resources.js";
import { ProofBladeSkillRegistry } from "../src/skills/registry.js";
import { ProofBladeToolRuntime } from "../src/tools/runtime.js";
import { CodingClaimVerifier } from "../src/verification/claim-verification.js";

/**
 * Budget gates for the tool hot path (PLAN-240 item J).
 *
 * These assert COUNTS, never durations. A duration threshold on a shared CI
 * runner measures the runner, not the code, and a flaky gate gets disabled --
 * which is worse than no gate. Every number here is mechanically observable and
 * stable across machines:
 *
 * - durable events appended per tool call (the model waits on each one)
 * - projection rewrites on a hot-path commit (must stay zero)
 * - artifact read-backs of content the caller already holds (must stay zero)
 * - skill catalog parses across repeated loads (memo must hold)
 *
 * Baselines come from the measurements recorded in
 * `docs/PROOFBLADE_TOOL_HOT_PATH_COST_BREAKDOWN_ZH.md`. When a budget here
 * changes, that document and the plan's §7.2.2 need the same change; a budget is
 * a decision, not a threshold someone loosened.
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
      model: "budget-gate",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "BUDGET_API_KEY",
      contextWindow: 4096,
      maxTokens: 512,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      input: ["text"],
    },
  },
};

/** Measured budget: durable events one ordinary `read` may append. */
const READ_EVENT_BUDGET = 4;

interface Harness {
  readonly root: string;
  readonly runsRoot: string;
  readonly eventsPath: string;
  readonly projectionPath: string;
  readonly context: CodingResourceContext;
  readonly readbacks: { count: number };
}

/** A real Run on a real ControlStore, with the hot path's counters observed. */
async function harness(runId: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "proofblade-budget-"));
  const runsRoot = join(root, config.storage.runsDir);
  const services = createServices(root, config);
  await services.control.createRun(runId, { ...demoTask(runId, root, config), mode: "coding_assistant", target_kind: "unknown", verification: { kind: "reproduction", required_reproductions: 0 } });

  const readbacks = { count: 0 };
  const originalReadText = services.artifacts.readText.bind(services.artifacts);
  services.artifacts.readText = (async (...args: Parameters<typeof originalReadText>) => {
    readbacks.count += 1;
    return await originalReadText(...args);
  }) as typeof services.artifacts.readText;

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
    completedReads: new Map(),
    artifactOutputRefs: new Map(),
    experimentGate: new ExperimentGate(services.control),
    outputRewrite: {
      port: {
        async prepare({ toolCallId, command }: { toolCallId: string; command: string }) {
          return { toolCallId, command, requestedProvider: "builtin", provider: "builtin", providerVersion: "gate", applied: false, originalCommandHash: command, rewrittenCommandHash: command };
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

  return {
    root,
    runsRoot,
    eventsPath: join(runsRoot, runId, "events.jsonl"),
    projectionPath: join(runsRoot, runId, "projection.json"),
    context,
    readbacks,
  };
}

async function eventCount(path: string): Promise<number> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

async function stamp(path: string): Promise<string> {
  try {
    const stats = await stat(path);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return "absent";
  }
}

async function readTool() {
  const tool = createCodingTools().find((item) => item.name === "read");
  assert.ok(tool, "the read tool must exist");
  return tool;
}

test("[contract:hot-path-event-budget] an ordinary read stays within its durable-event budget", async () => {
  const h = await harness("BUDGET-READ-1");
  try {
    const target = join(h.root, "measured.txt");
    await writeFile(target, `${"x".repeat(4096)}\n`, "utf8");
    const before = await eventCount(h.eventsPath);

    const read = await readTool();
    const result = await read.execute("read-1", { path: target }, new AbortController().signal, undefined, h.context);
    assert.notEqual(result.isError, true);

    const appended = await eventCount(h.eventsPath) - before;
    assert.ok(
      appended <= READ_EVENT_BUDGET,
      `an ordinary read appended ${appended} durable events, budget is ${READ_EVENT_BUDGET}; each one is a run-lock acquire plus an fsync the model waits on`,
    );
    assert.ok(appended > 0, "a successful read must still archive its artifact durably");
  } finally {
    await rm(h.root, { recursive: true, force: true });
  }
});

test("[contract:hot-path-projection-budget] a hot-path read never rewrites the projection", async () => {
  // The derived projection is written at explicit barriers, not per event. A
  // regression here reintroduces a full RunSnapshot rewrite on every tool result.
  const h = await harness("BUDGET-READ-2");
  try {
    const target = join(h.root, "measured.txt");
    await writeFile(target, "hello\n", "utf8");
    const before = await stamp(h.projectionPath);

    const read = await readTool();
    await read.execute("read-1", { path: target }, new AbortController().signal, undefined, h.context);

    assert.equal(await stamp(h.projectionPath), before, "the projection must not be rewritten on the tool hot path");
  } finally {
    await rm(h.root, { recursive: true, force: true });
  }
});

test("[contract:hot-path-readback-budget] observing an archived artifact does not read it back", async () => {
  const h = await harness("BUDGET-READ-3");
  try {
    const target = join(h.root, "measured.txt");
    await writeFile(target, "hello\n", "utf8");

    const read = await readTool();
    await read.execute("read-1", { path: target }, new AbortController().signal, undefined, h.context);

    assert.equal(h.readbacks.count, 0, "the observer must consume the content the caller already holds");
  } finally {
    await rm(h.root, { recursive: true, force: true });
  }
});

test("[contract:skill-catalog-parse-budget] repeated skill loads parse the catalog once", async () => {
  // The version snapshot and every lane creation load this registry; parsing
  // every SKILL.md each time measured ~30ms per call.
  ProofBladeSkillRegistry.resetCache();
  try {
    const first = await ProofBladeSkillRegistry.load(process.cwd());
    const second = await ProofBladeSkillRegistry.load(process.cwd());

    const stats = ProofBladeSkillRegistry.cacheStats();
    assert.equal(stats.parses, 1, `repeated loads parsed the catalog ${stats.parses} times, budget is 1`);
    assert.equal(stats.hits, 1);
    assert.equal(second.catalogHash(), first.catalogHash(), "a memo hit must not change the catalog");
  } finally {
    ProofBladeSkillRegistry.resetCache();
  }
});

test("the budget constants stay in step with the documented baseline", async () => {
  // A budget silently drifted away from the document that justifies it is how
  // gates rot. This asserts the linkage is still real, not the numbers: the
  // breakdown document must keep stating the per-read event/commit baseline that
  // READ_EVENT_BUDGET encodes.
  const doc = await readFile(join(process.cwd(), "docs", "PROOFBLADE_TOOL_HOT_PATH_COST_BREAKDOWN_ZH.md"), "utf8");
  assert.match(doc, /events\.jsonl` 新增 4 条/, "the breakdown must still record the per-read event count");
  assert.match(doc, /4 条事件 \/ 2 个提交/, "the breakdown must still record the per-read commit count");
  assert.ok(READ_EVENT_BUDGET >= 2, "the read budget must permit at least artifact registration plus the derived observation");
});
