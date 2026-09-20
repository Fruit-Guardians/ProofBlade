/**
 * Real-Run tool hot-path baseline (plan item T0, second half).
 *
 * The provider-free baseline (`npm run baseline:tools`) established that a
 * command's own execution is sub-millisecond and that framework dispatch is
 * negligible. It could not say anything about the ProofBlade control chain,
 * because it had no ControlStore: artifact writes, the run lock, `fsync` and
 * projection rewrites were counted rather than performed.
 *
 * This script closes that gap. It drives real `read` and `bash` calls against a
 * real ControlStore in an isolated temporary project, and counts what the chain
 * actually does per call, so §7.2.1 can be filled with measured numbers and the
 * §7.2.2 invariant counters can be asserted.
 *
 * Deliberately isolated: the temporary root gets its own `runs/` directory, so a
 * mis-measurement can never write into the repository's evidence chain.
 *
 * Usage:
 *   tsx scripts/tool-hot-path-real-run-baseline.ts [--iterations N] [--json]
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core/node";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  CodingClaimVerifier,
  CodingEvidenceGraph,
  EvidenceCurationGate,
  ExperimentGate,
  ProofBladeToolRuntime,
  ToolTimingRecorder,
  createCodingTools,
  createServices,
  demoTask,
  type CodingResourceContext,
  type ControlStore,
  type ProofBladeConfig,
  type ToolTimingSummary,
} from "@proofblade/materials";

const iterations = readNumberArgument("--iterations") ?? 10;
const asJson = process.argv.includes("--json");

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test",
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

/**
 * Durable events appended to `events.jsonl`.
 *
 * The measurement is anchored on the event log rather than on calls to
 * `ControlStore`'s public methods. Those methods are only the outermost seam:
 * `ArtifactStore`, the Effect Journal and the observer ports all reach the store
 * through internal paths, so instrumenting the public API silently reports zero
 * for work that really happened. The log line count is the cost the model
 * actually waits on, and it cannot be bypassed.
 */
async function eventCount(eventsPath: string): Promise<number> {
  try {
    const text = await readFile(eventsPath, "utf8");
    return text.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/** Per-call measurements gathered while the real control chain runs. */
interface RealRunSample {
  readonly case: string;
  readonly events: number;
  readonly projectionWrites: number;
  readonly artifactReadbacks: number;
  readonly commandMs: number;
  readonly frameworkMs: number;
  readonly failed: boolean;
}

const root = await mkdtemp(join(tmpdir(), "proofblade-real-baseline-"));
const samples: RealRunSample[] = [];
let cleanupWarning: string | undefined;
try {
  const runsRoot = join(root, config.storage.runsDir);
  const services = createServices(root, config);
  const runId = "BASELINE-REAL-001";
  await services.control.createRun(runId, codingTask(runId, root));
  const eventsPath = join(runsRoot, runId, "events.jsonl");

  const counters = { artifactReadbacks: 0 };
  instrumentArtifactStore(services.artifacts, counters);

  const recorder = new ToolTimingRecorder(iterations * 4);
  const target = join(root, "measured.txt");
  await writeFile(target, `${"x".repeat(32 * 1024)}\n`, "utf8");
  const tiny = join(root, "tiny.txt");
  await writeFile(tiny, "x\n", "utf8");
  const context = buildContext(runId, root, services);

  const cases = [
    // Control: the smallest possible tool body, so its framework column is the
    // floor this chain adds with no artifact and no output processing. Without
    // it, a framework number cannot be attributed to the chain rather than to
    // the tool body.
    { name: "read-1B", tool: "read", params: { path: tiny } },
    { name: "read-32KiB", tool: "read", params: { path: target } },
    // The Pi bash tool executes under a POSIX shell even on Windows, so the
    // command must be shell-neutral rather than a cmd.exe builtin.
    { name: "bash-noop", tool: "bash", params: { command: "echo baseline" } },
  ] as const;

  for (const benchmark of cases) {
    const tool = createCodingTools().find((item) => item.name === benchmark.tool);
    if (!tool) throw new Error(`tool not found: ${benchmark.tool}`);
    for (let index = 0; index < iterations; index += 1) {
      const eventsBefore = await eventCount(eventsPath);
      const readbacksBefore = counters.artifactReadbacks;
      const projectionBefore = await projectionStamp(runsRoot, runId);
      const started = performance.now();
      const handle = recorder.begin(benchmark.tool, benchmark.name);
      handle.mark("executionStart");
      const commandStarted = performance.now();
      // A failing call is still a measurement: error paths are part of the hot
      // path (§2.6 measures them explicitly), so retain the sample and record it.
      let failed = false;
      try {
        await (tool as AgentHarnessTool<CodingResourceContext>).execute(`${benchmark.name}-${index}`, benchmark.params as never, new AbortController().signal, undefined, context);
      } catch {
        failed = true;
      }
      const commandMs = performance.now() - commandStarted;
      handle.mark("executionEnd");
      handle.finish(failed);
      const projectionAfter = await projectionStamp(runsRoot, runId);
      samples.push({
        case: benchmark.name,
        events: await eventCount(eventsPath) - eventsBefore,
        projectionWrites: (projectionAfter === projectionBefore ? 0 : 1),
        artifactReadbacks: counters.artifactReadbacks - readbacksBefore,
        commandMs: round(commandMs),
        frameworkMs: round(performance.now() - started),
        failed,
      });
    }
  }

  const summaries = recorder.summarize(cases.map((item) => item.name));
  assertMeasured(samples);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ iterations, samples, summaries }, null, 2)}\n`);
  } else {
    printReport(iterations, samples, summaries);
  }
  await services.control.flushProjection(runId).catch(() => undefined);
} finally {
  // Windows keeps the runs directory busy while a spawned shell or an fs handle
  // is still winding down. A failed teardown must not discard the measurement
  // that was just taken, so it is reported and the OS temp cleaner takes over.
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    cleanupWarning = error instanceof Error ? error.message : String(error);
  }
}

if (cleanupWarning) console.error(`warning: could not remove the temporary baseline root: ${cleanupWarning}`);

function codingTask(runId: string, projectRoot: string) {
  return {
    ...demoTask(runId, projectRoot, config),
    mode: "coding_assistant" as const,
    target_kind: "unknown" as const,
    objective: "Measure the real control-chain cost of one tool call.",
    verification: { kind: "reproduction" as const, required_reproductions: 0 },
  };
}

/**
 * Wrap artifact reads with a counter.
 *
 * Unlike the control store, `ArtifactStore.readText` is the only read path the
 * tools use, so counting here genuinely reflects the read-backs this work
 * targets. A read-back is defined as reading an artifact the same call just
 * wrote; the case-level assertions below check that count directly.
 */
function instrumentArtifactStore(artifacts: { readText: (...args: never[]) => Promise<string> }, counters: { artifactReadbacks: number }): void {
  const original = artifacts.readText.bind(artifacts);
  artifacts.readText = (async (...args: never[]) => {
    counters.artifactReadbacks += 1;
    return await original(...args);
  }) as typeof artifacts.readText;
}

/** Projection existence and modification time, so a rewrite is visible. */
async function projectionStamp(runsRoot: string, runId: string): Promise<string> {
  try {
    const stats = await stat(join(runsRoot, runId, "projection.json"));
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return "absent";
  }
}

function buildContext(runId: string, projectRoot: string, services: ReturnType<typeof createServices>): CodingResourceContext {
  const runtime = new ProofBladeToolRuntime(
    runId,
    { fixtureId: runId, generation: 0, path: projectRoot, privatePath: join(projectRoot, ".proofblade") },
    services.runsRoot,
    services.control,
    services.artifacts,
    services.journal,
    projectRoot,
    { includeMcp: false },
  );
  return {
    env: new NodeExecutionEnv({ cwd: projectRoot }),
    skills: {} as never,
    mcp: { summaries: () => [] } as never,
    enabledSkills: new Set<string>(),
    enabledMcpServers: new Set<string>(),
    claimVerifier: new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier),
    evidenceGraph: new CodingEvidenceGraph(runId, services.control, services.artifacts),
    evidenceCurationGate: new EvidenceCurationGate(runId, services.control),
    runtime,
    // Without an output-rewrite pipeline the read tool returns early and archives
    // nothing, so its counters would read zero for the wrong reason. This
    // pass-through pipeline exercises the artifact + observation chain, which is
    // the path the plan is about.
    outputRewrite: passthroughRewrite(services.artifacts, runId),
    completedReads: new Map(),
    artifactOutputRefs: new Map(),
    // The real gate, so the measurement includes what production actually does
    // (PLAN-240 T3 made its projection write deferred).
    experimentGate: new ExperimentGate(services.control),
  } as unknown as CodingResourceContext;
}

/**
 * A pass-through output-rewrite pipeline: it archives the text unchanged and
 * reports the raw output, which is what the builtin provider does when RTK is
 * absent.
 */
function passthroughRewrite(artifactStore: ReturnType<typeof createServices>["artifacts"], runId: string) {
  return {
    port: {
      async prepare({ toolCallId, command }: { toolCallId: string; command: string }) {
        return {
          toolCallId,
          command,
          requestedProvider: "builtin",
          provider: "builtin",
          providerVersion: "baseline",
          applied: false,
          originalCommandHash: command,
          rewrittenCommandHash: command,
        };
      },
      async finalize(_ticket: unknown, visibleOutput: string) {
        const bytes = Buffer.byteLength(visibleOutput);
        return { rawOutput: visibleOutput, rawBytes: bytes, visibleBytes: bytes, rawTruncated: false, rawCapture: "visible-output" as const };
      },
    },
    artifactStore,
    runId,
  } as unknown as NonNullable<CodingResourceContext["outputRewrite"]>;
}

function printReport(iterations: number, samples: readonly RealRunSample[], summaries: readonly ToolTimingSummary[]): void {
  console.log(`Real-Run tool hot-path baseline (${iterations} iterations per case, real ControlStore)`);
  console.log("");
  console.log("| case | n | failed | durable events appended | projection writes | artifact read-backs |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const name of [...new Set(samples.map((sample) => sample.case))]) {
    const group = samples.filter((sample) => sample.case === name);
    console.log(`| ${name} | ${group.length} | ${group.filter((item) => item.failed).length} | ${sum(group.map((item) => item.events))} | ${sum(group.map((item) => item.projectionWrites))} | ${sum(group.map((item) => item.artifactReadbacks))} |`);
  }
  console.log("");
  console.log("Per-call latency (command = tool body, framework = everything around it):");
  console.log("");
  console.log("| case | command p50 | command p95 | framework p50 | framework p95 |");
  console.log("|---|---:|---:|---:|---:|");
  for (const name of [...new Set(samples.map((sample) => sample.case))]) {
    const group = samples.filter((sample) => sample.case === name).map((item) => item.commandMs).sort((a, b) => a - b);
    const framework = samples.filter((sample) => sample.case === name).map((item) => item.frameworkMs).sort((a, b) => a - b);
    console.log(`| ${name} | ${ms(percentileOf(group, 0.5))} | ${ms(percentileOf(group, 0.95))} | ${ms(percentileOf(framework, 0.5))} | ${ms(percentileOf(framework, 0.95))} |`);
  }
  console.log("");
  console.log(`Recorder groups: ${summaries.map((item) => `${item.group}=${item.count}`).join(", ")}`);
  console.log("");
  console.log("Read as: each row is ONE tool call. The event column is the durable appends the");
  console.log("model waits on -- each one is a run-lock acquire plus an event-log fsync.");
  console.log("A ZERO in a column is only meaningful together with the failure column: a case");
  console.log("that failed every iteration did no work and must not be read as 'free'.");
}

/** Guard against reporting a zero that means "nothing ran" rather than "nothing cost". */
function assertMeasured(samples: readonly RealRunSample[]): void {
  for (const name of [...new Set(samples.map((sample) => sample.case))]) {
    const group = samples.filter((sample) => sample.case === name);
    const succeeded = group.filter((item) => !item.failed).length;
    if (succeeded === 0) {
      throw new Error(`case ${name} failed on every iteration; its zero counters mean "nothing ran", not "nothing cost"`);
    }
  }
}

function percentileOf(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function ms(value: number): string {
  return `${value.toFixed(3)}ms`;
}

function readNumberArgument(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const raw = process.argv[index + 1];
  if (raw === undefined) throw new Error(`${name} requires a value`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
