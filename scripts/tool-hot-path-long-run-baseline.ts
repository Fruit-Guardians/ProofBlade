/**
 * Long-Run scaling baseline (plan item T0, the part §7.2.1 still listed as
 * unmeasured).
 *
 * The earlier baselines used one short Run. §7.2.1 asks for a Run with ~10,000
 * events, because the open question was whether the per-call cost of the control
 * chain grows with Run history. Two different answers came out of measuring it,
 * and the difference is the whole point of this script:
 *
 * - a real tool call does NOT degrade: the snapshot cache is refreshed after a
 *   commit, so a read costs the same at 10 events and at 10,000.
 * - an explicit `replay()` DOES scale linearly, because that path folds the
 *   whole event stream by design.
 *
 * So the history-dependent cost is real but sits on the rebuild path (explicit
 * replay, projection repair after corruption or a missing projection), not on the
 * tool hot path. Measuring only one of the two would have supported either a
 * false alarm or a false all-clear.
 *
 * Usage:
 *   tsx scripts/tool-hot-path-long-run-baseline.ts [--points 10,1000,5000,10000]
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  CodingClaimVerifier,
  CodingEvidenceGraph,
  EvidenceCurationGate,
  ExperimentGate,
  ProofBladeToolRuntime,
  createServices,
  createCodingTools,
  demoTask,
  type CodingResourceContext,
  type ProofBladeConfig,
} from "@proofblade/materials";

const points = (readArgument("--points") ?? "10,1000,5000,10000")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0)
  .sort((left, right) => left - right);

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "baseline",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "baseline",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "BASELINE_API_KEY",
      contextWindow: 4096,
      maxTokens: 512,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      input: ["text"],
    },
  },
} as ProofBladeConfig;

const root = await mkdtemp(join(tmpdir(), "proofblade-long-run-"));
try {
  const services = createServices(root, config);
  const runId = "BASELINE-LONG-1";
  await services.control.createRun(runId, { ...demoTask(runId, root, config), mode: "coding_assistant", target_kind: "unknown", verification: { kind: "reproduction", required_reproductions: 0 } });
  const eventsPath = join(root, "runs", runId, "events.jsonl");
  const projectionPath = join(root, "runs", runId, "projection.json");

  // A context sufficient to drive `read`; the tool path is what is under test.
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
  const target = join(root, "measured.txt");
  await writeFile(target, "baseline contents\n", "utf8");
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
          return { toolCallId, command, requestedProvider: "builtin", provider: "builtin", providerVersion: "baseline", applied: false, originalCommandHash: command, rewrittenCommandHash: command };
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
  if (!read) throw new Error("read tool not found");

  console.log("Long-Run scaling baseline (real ControlStore, real tool call)");
  console.log("");
  console.log("| events | events.jsonl | projection.json | read p50 | snapshot() p50 | replay() |");
  console.log("|---:|---:|---:|---:|---:|---:|");

  for (const point of points) {
    await growTo(services, runId, eventsPath, point);
    // Warm the projection so the read measures the steady state, and take a few
    // samples: a single read on Windows can absorb a disk-cache miss.
    const readSamples: number[] = [];
    const snapshotSamples: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      let started = performance.now();
      await read.execute(`read-${point}-${index}`, { path: target } as never, new AbortController().signal, undefined, context);
      readSamples.push(performance.now() - started);
      started = performance.now();
      await services.control.snapshot(runId);
      snapshotSamples.push(performance.now() - started);
    }
    // `replay()` folds the whole stream by design; one sample is enough and it is
    // the expensive one.
    const replayStarted = performance.now();
    await services.control.replay(runId);
    const replayMs = performance.now() - replayStarted;

    console.log([
      `| ${point}`,
      await fileSize(eventsPath),
      await fileSize(projectionPath),
      ms(percentile(readSamples, 0.5)),
      ms(percentile(snapshotSamples, 0.5)),
      ms(replayMs),
    ].join(" | ") + " |");
  }

  console.log("");
  console.log("Read as: `read` and `snapshot()` should stay FLAT across the row range --");
  console.log("the snapshot cache is refreshed after each commit, so Run history is not");
  console.log("paid per tool call. `replay()` grows with the stream by design; it is the");
  console.log("rebuild path (explicit replay, projection repair), not the hot path.");
} finally {
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    console.error(`warning: could not remove the temporary baseline root: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Append recorded tool results until the event log reaches `target` events. */
async function growTo(services: ReturnType<typeof createServices>, runId: string, eventsPath: string, target: number): Promise<void> {
  for (;;) {
    const current = await eventCount(eventsPath);
    if (current >= target) return;
    const size = Math.min(500, target - current);
    await services.control.append(runId, Array.from({ length: size }, (_, index) => ({
      schemaVersion: 1 as const,
      lane: "executor" as const,
      correlationId: `history-${current + index}`,
      actor: "tool" as const,
      type: "tool_result_recorded" as const,
      payload: { toolCallId: `history-${current + index}`, toolName: "read", outputBytes: 128, isError: false },
    })));
  }
}

async function eventCount(path: string): Promise<number> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

async function fileSize(path: string): Promise<string> {
  try {
    return String((await stat(path)).size);
  } catch {
    return "-";
  }
}

function percentile(sortedInput: readonly number[], fraction: number): number {
  const sorted = [...sortedInput].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

function ms(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  return value;
}
