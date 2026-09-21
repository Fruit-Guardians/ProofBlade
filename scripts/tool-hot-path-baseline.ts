/**
 * Provider-free tool hot-path baseline (plan item T0).
 *
 * Measures what the ProofBlade control chain adds around a tool that has already
 * finished, so the claim "a few-millisecond command becomes a multi-second tool
 * call" can be confirmed or refuted with numbers instead of mechanism.
 *
 * Deliberately excluded:
 * - a real Provider (the model call is not the subject of this measurement);
 * - Docker and network access;
 * - `events.jsonl`/projection writes, which the ControlStore double replaces
 *   with counters. That keeps the run reproducible on a locked-down host and
 *   makes the counters comparable across machines, where a wall-clock `fsync`
 *   measurement would not be.
 *
 * Usage:
 *   tsx scripts/tool-hot-path-baseline.ts [--iterations N] [--json]
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  ToolTimingRecorder,
  createCodingTools,
  withToolTiming,
  type CodingResourceContext,
  type ToolTimingReport,
} from "@proofblade/materials";

interface BenchmarkCase {
  readonly name: string;
  readonly tool: string;
  readonly params: Record<string, unknown>;
}

const iterations = readNumberArgument("--iterations") ?? 50;
const asJson = process.argv.includes("--json");

const root = await mkdtemp(join(tmpdir(), "proofblade-baseline-"));
try {
  const small = join(root, "small.txt");
  const medium = join(root, "medium.txt");
  await writeFile(small, "hello proofblade\n", "utf8");
  await writeFile(medium, `${"x".repeat(64 * 1024)}\n`, "utf8");

  const recorder = new ToolTimingRecorder(iterations * 8);
  const tools = createCodingTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  // Real ExecutionEnv for path/file semantics, with only `exec` doubled. Using
  // the real class keeps `absolutePath`/`readTextFile` behaviour identical to
  // production; doubling `exec` removes shell and process-spawn cost, and makes
  // the run reproducible on a host that forbids child processes.
  const created = new NodeExecutionEnv({ cwd: root });
  const environment = new Proxy(created, {
    get(target, property, receiver) {
      if (property === "exec") {
        return async (_command: string, options?: { onStdout?: (value: string) => void }) => {
          options?.onStdout?.("benchmark-output\n");
          return { ok: true, value: { stdout: "benchmark-output\n", stderr: "", exitCode: 0 } };
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });

  // Minimal context: only the members these two tools touch. Anything the
  // ControlStore-backed path would do is counted instead of executed.
  const context = {
    env: environment,
    skills: {},
    mcp: {},
    enabledSkills: new Set<string>(),
    enabledMcpServers: new Set<string>(),
    completedReads: new Map(),
  } as unknown as CodingResourceContext;

  const cases: BenchmarkCase[] = [
    { name: "read-1B", tool: "read", params: { path: small } },
    { name: "read-64KiB", tool: "read", params: { path: medium } },
    { name: "bash-noop", tool: "bash", params: { command: "true" } },
    { name: "bash-output", tool: "bash", params: { command: "echo benchmark-output" } },
  ];

  for (const benchmark of cases) {
    const tool = byName.get(benchmark.tool);
    if (!tool) throw new Error(`tool not found: ${benchmark.tool}`);
    // Wrap per case so samples carry the case label: one `read` on a 1 B file
    // and one on a 64 KiB file must not be averaged together under `read`.
    const instrumented = withToolTiming(tool, recorder, benchmark.name);
    for (let index = 0; index < iterations; index += 1) {
      await instrumented.execute(`${benchmark.name}-${index}`, benchmark.params as never, new AbortController().signal, undefined, context);
    }
  }

  const report = recorder.summarize(cases.map((benchmark) => benchmark.name));
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ iterations, summaries }, null, 2)}\n`);
  } else {
    printReport(iterations, cases, report);
  }
} finally {
  await rm(root, { recursive: true, force: true });
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

function printReport(iterations: number, cases: readonly BenchmarkCase[], report: ToolTimingReport): void {
  const summaries = report.groups;
  console.log(`Tool hot-path baseline (${iterations} iterations per case, provider-free)`);
  console.log("");
  // `wrapper` rather than `framework`: both marks are taken inside the timing
  // wrapper, so this span is the wrapper's own entry cost, not agent-loop
  // dispatch delay. The previous column name attributed it to the framework,
  // which nothing here can observe.
  console.log("| case | tool | n | errors | exec p50 | exec p95 | wrapper p50 | wrapper p95 | total p50 | total p95 | total p99 |");
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const benchmark of cases) {
    const summary = summaries.find((item) => item.group === benchmark.name);
    if (!summary) {
      console.log(`| ${benchmark.name} | ${benchmark.tool} | 0 | - | - | - | - | - | - | - | - |`);
      continue;
    }
    const execution = summary.phases.executionStart_executionEnd;
    const wrapper = summary.phases.scheduled_executionStart;
    console.log([
      `| ${benchmark.name}`,
      benchmark.tool,
      String(summary.count),
      String(summary.errorCount),
      format(execution?.p50),
      format(execution?.p95),
      format(wrapper?.p50),
      format(wrapper?.p95),
      format(summary.total.p50),
      format(summary.total.p95),
      format(summary.total.p99),
    ].join(" | ") + " |");
  }
  console.log("");
  // The counter columns are all zero here, and the reason is not that the hot
  // path is clean: nothing in this harness increments them. They exist on the
  // handle for a producer to call, and a producer needs a ControlStore. Saying
  // "must stay at zero" invited reading them as evidence, which they are not.
  console.log("Counters: all zero, and that means \"nothing incremented them\" in this harness -- not");
  console.log("\"the synchronous path is clean\". This harness has no ControlStore, so nothing can");
  console.log("increment these; `scripts/tool-hot-path-real-run-baseline.ts` is where they carry data.");
  console.log("");
  console.log("| case | n | controlCommits | eventFsyncs | projectionWrites | artifactReadbacks | hashRuns |");
  console.log("|---|---:|---:|---:|---:|---:|---:|");
  for (const summary of summaries) {
    console.log(`| ${summary.group} | ${summary.count} | ${summary.counters.controlCommits} | ${summary.counters.eventFsyncs} | ${summary.counters.projectionWrites} | ${summary.counters.artifactReadbacks} | ${summary.counters.hashRuns} |`);
  }
  console.log("");
  console.log(`Retained samples: ${report.retained} of capacity ${report.capacity}; dropped: ${report.dropped}.`);
  if (report.dropped > 0) console.log("WARNING: samples were evicted, so the percentiles above describe a suffix of the run, not all of it.");
  console.log("");
  console.log("NOT measured here: ControlStore commit, `fsync`, projection rewrite, Artifact read-back and");
  console.log("hash counts are counted (all zero above) rather than executed, because this harness has no");
  console.log("ControlStore. The production gap those phases add is the subject of the next items (T1/T2),");
  console.log("and must be measured against a real Run before §7.2.3 thresholds are set.");
}

function format(value: number | undefined): string {
  return value === undefined ? "-" : `${value.toFixed(3)}ms`;
}
