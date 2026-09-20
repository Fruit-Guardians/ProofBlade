import type { AgentHarnessTool } from "@earendil-works/pi-agent-core/node";
import type { CodingResourceContext } from "../runtime/coding-resources.js";

/**
 * A monotonic clock in milliseconds.
 *
 * `performance.now()` is monotonic and unaffected by wall-clock adjustments, so
 * a stage duration cannot go negative when NTP steps the system clock mid-call.
 * `Date.now()` would make that possible and silently corrupt the baseline.
 */
function monotonicNow(): number {
  return performance.now();
}

/**
 * The stages of one tool call, in the order they occur.
 *
 * `scheduled -> executionStart` covers the framework's own dispatch delay,
 * `executionStart -> executionEnd` the tool body, and
 * `executionEnd -> subscribersEnd` everything the ProofBlade control chain adds
 * after the tool itself has finished — which is the span this work exists to
 * shrink. `executionEnd -> toolResultEmitted` is recorded by the result
 * projection, so it stays `undefined` until that boundary is instrumented.
 */
export const TOOL_TIMING_STAGES = [
  "scheduled",
  "executionStart",
  "executionEnd",
  "toolResultEmitted",
  "subscribersEnd",
] as const;

/** One of the observed boundaries of a tool call. */
export type ToolTimingStage = (typeof TOOL_TIMING_STAGES)[number];

/**
 * Acceptance-relevant counters for a single tool call.
 *
 * These are counts rather than durations: they do not depend on machine load, so
 * CI can assert on them where a timing threshold would be flaky.
 */
export interface ToolTimingCounters {
  /** Synchronous ControlStore commits the call performed before returning. */
  readonly controlCommits: number;
  /** `fsync` calls the call performed on the event log. */
  readonly eventFsyncs: number;
  /** Projection rewrites the call performed. */
  readonly projectionWrites: number;
  /** Artifact files the call read back after writing them. */
  readonly artifactReadbacks: number;
  /** How many times the call hashed its content. */
  readonly hashRuns: number;
}

/** Counter keys that a caller may increment while recording a sample. */
export type ToolTimingCounter = keyof ToolTimingCounters;

/** One recorded tool call. */
export interface ToolTimingSample {
  /** Tool name as the model sees it. */
  readonly tool: string;
  /**
   * Caller-supplied label for this call, when one was given to `begin`.
   *
   * A tool name is not always specific enough to group by: one `read` on a 1 B
   * file and one on a 64 KiB file are different measurements, and averaging them
   * under `read` hides the difference a baseline exists to show.
   */
  readonly label?: string;
  /** Whether the call returned an error result. */
  readonly isError: boolean;
  /** Monotonic timestamps, in milliseconds, keyed by stage. */
  readonly marks: Partial<Record<ToolTimingStage, number>>;
  /** Stage-to-stage durations in milliseconds, in `TOOL_TIMING_STAGES` order. */
  readonly phases: Readonly<Record<string, number>>;
  /** End-to-end duration from `scheduled` to the last recorded mark. */
  readonly totalMs: number;
  /** Acceptance counters observed for this call. */
  readonly counters: ToolTimingCounters;
}

/** Aggregated summary over the retained samples. */
export interface ToolTimingSummary {
  /** Tool name as the model sees it. */
  readonly tool: string;
  /** Grouping label; equals `tool` when no explicit label was supplied. */
  readonly group: string;
  readonly count: number;
  readonly errorCount: number;
  /** Duration percentiles for the end-to-end span. */
  readonly total: { readonly p50: number; readonly p95: number; readonly p99: number };
  /** Duration percentiles per phase, keyed by `<from>_<to>`. */
  readonly phases: Readonly<Record<string, { readonly p50: number; readonly p95: number; readonly p99: number }>>;
  /** Sum of the acceptance counters over the retained samples. */
  readonly counters: ToolTimingCounters;
}

/** Default number of retained samples. */
export const DEFAULT_TOOL_TIMING_CAPACITY = 512;

/**
 * Round to three decimals so two runs on the same machine render identically and
 * a report diff shows real movement instead of float noise.
 */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Nearest-rank percentile over a sorted ascending array.
 *
 * Nearest-rank is used instead of interpolation so every reported number is an
 * actually observed duration; an interpolated p99 for a 100-sample buffer would
 * report a value no call ever took.
 *
 * @param sorted - durations in ascending order; must be non-empty.
 * @param fraction - percentile as a fraction in `[0, 1]`.
 * @returns the observed duration at that rank.
 */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, fraction));
  const rank = Math.ceil(clamped * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
}

/**
 * In-process, bounded recorder for tool-call stage timings.
 *
 * Deliberately memory-only. Measuring tool latency must not itself perform a
 * durable write, so this never touches ControlStore, the event log, or the
 * filesystem: a recorder that persisted each sample would add exactly the
 * synchronous barrier this work is trying to remove, and would make the
 * measurement change the thing being measured.
 *
 * Not thread-safe and not shared across lanes by design — each lane owns one.
 */
export class ToolTimingRecorder {
  readonly #capacity: number;
  #samples: ToolTimingSample[] = [];
  #dropped = 0;

  /**
   * @param capacity - maximum retained samples; oldest are dropped first.
   */
  public constructor(capacity: number = DEFAULT_TOOL_TIMING_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("ToolTimingRecorder capacity must be a positive integer");
    this.#capacity = capacity;
  }

  /** Retained samples, oldest first. */
  public samples(): readonly ToolTimingSample[] {
    return this.#samples;
  }

  /** How many samples were evicted because the buffer was full. */
  public droppedCount(): number {
    return this.#dropped;
  }

  /** Discard every retained sample. */
  public clear(): void {
    this.#samples = [];
    this.#dropped = 0;
  }

  /**
   * Start recording one tool call.
   *
   * The returned handle keeps its own marks and counters, so concurrent calls
   * cannot interleave into one another's sample.
   *
   * @param tool - tool name as the model sees it.
   * @param label - optional grouping label for this specific call.
   * @returns a handle that records marks and finishes the sample.
   */
  public begin(tool: string, label?: string): ToolTimingHandle {
    if (typeof tool !== "string" || tool.length === 0) throw new Error("ToolTimingRecorder.begin requires a tool name");
    if (label !== undefined && label.length === 0) throw new Error("ToolTimingRecorder.begin rejects an empty label");
    return new ToolTimingHandle(this, tool, label);
  }

  /**
   * Append a finished sample, evicting the oldest when at capacity.
   *
   * @param sample - the completed sample.
   */
  public record(sample: ToolTimingSample): void {
    this.#samples.push(sample);
    while (this.#samples.length > this.#capacity) {
      this.#samples.shift();
      this.#dropped += 1;
    }
  }

  /**
   * Aggregate the retained samples, grouped by label when one was supplied and
   * by tool name otherwise.
   *
   * @param groups - restrict the summary to these group keys; all when omitted.
   * @returns one summary per group that has at least one retained sample.
   */
  public summarize(groups?: readonly string[]): ToolTimingSummary[] {
    const wanted = groups === undefined ? undefined : new Set(groups);
    const grouped = new Map<string, ToolTimingSample[]>();
    for (const sample of this.#samples) {
      const key = sample.label ?? sample.tool;
      if (wanted && !wanted.has(key)) continue;
      const bucket = grouped.get(key);
      if (bucket) bucket.push(sample);
      else grouped.set(key, [sample]);
    }
    const summaries: ToolTimingSummary[] = [];
    for (const [key, samples] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const totals = samples.map((sample) => sample.totalMs).sort((left, right) => left - right);
      const phaseNames = new Set<string>();
      for (const sample of samples) for (const name of Object.keys(sample.phases)) phaseNames.add(name);
      const phases: Record<string, { p50: number; p95: number; p99: number }> = {};
      for (const name of [...phaseNames].sort()) {
        const values = samples.map((sample) => sample.phases[name]).filter((value): value is number => typeof value === "number").sort((left, right) => left - right);
        if (values.length === 0) continue;
        phases[name] = { p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99) };
      }
      summaries.push({
        tool: samples[0]!.tool,
        group: key,
        count: samples.length,
        errorCount: samples.filter((sample) => sample.isError).length,
        total: { p50: percentile(totals, 0.5), p95: percentile(totals, 0.95), p99: percentile(totals, 0.99) },
        phases,
        counters: sumCounters(samples),
      });
    }
    return summaries;
  }
}

/** Per-call recording handle produced by {@link ToolTimingRecorder.begin}. */
export class ToolTimingHandle {
  readonly #recorder: ToolTimingRecorder;
  readonly #tool: string;
  readonly #label: string | undefined;
  readonly #marks: Partial<Record<ToolTimingStage, number>> = {};
  #counters: Record<ToolTimingCounter, number> = { controlCommits: 0, eventFsyncs: 0, projectionWrites: 0, artifactReadbacks: 0, hashRuns: 0 };
  #finished = false;

  /**
   * @param recorder - owning recorder.
   * @param tool - tool name as the model sees it.
   * @param label - optional grouping label for this specific call.
   */
  public constructor(recorder: ToolTimingRecorder, tool: string, label?: string) {
    this.#recorder = recorder;
    this.#tool = tool;
    this.#label = label;
    this.#marks.scheduled = monotonicNow();
  }

  /**
   * Record a stage boundary. Re-marking a stage keeps the first timestamp so a
   * retry inside one call cannot shorten a phase.
   *
   * @param stage - the boundary being crossed.
   */
  public mark(stage: ToolTimingStage): void {
    if (this.#marks[stage] === undefined) this.#marks[stage] = monotonicNow();
  }

  /**
   * Increment an acceptance counter for this call.
   *
   * @param counter - which counter to increment.
   * @param by - amount to add; defaults to 1.
   */
  public count(counter: ToolTimingCounter, by = 1): void {
    this.#counters[counter] += by;
  }

  /**
   * Close the sample and hand it to the recorder.
   *
   * Idempotent: a second call is ignored, so a `finally` block and an explicit
   * finish cannot double-record.
   *
   * @param isError - whether the call returned an error result.
   */
  public finish(isError = false): void {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#marks.subscribersEnd === undefined) this.#marks.subscribersEnd = monotonicNow();
    const phases: Record<string, number> = {};
    // Only phases whose BOTH boundaries were instrumented are reported. The
    // subscribers span is closed here rather than by the projection, so
    // emitting it would attribute the projection's uninstrumented work to the
    // subscriber boundary and overstate it — a baseline must not invent time
    // for a span nobody measured.
    for (let index = 1; index < TOOL_TIMING_STAGES.length; index += 1) {
      const from = TOOL_TIMING_STAGES[index - 1]!;
      const to = TOOL_TIMING_STAGES[index]!;
      if (from === "executionEnd" && to === "subscribersEnd") continue;
      const start = this.#marks[from];
      const end = this.#marks[to];
      if (start !== undefined && end !== undefined) phases[`${from}_${to}`] = round(end - start);
    }
    const scheduled = this.#marks.scheduled ?? 0;
    const last = this.#marks.subscribersEnd ?? scheduled;
    this.#recorder.record({
      tool: this.#tool,
      ...(this.#label === undefined ? {} : { label: this.#label }),
      isError,
      marks: { ...this.#marks },
      phases,
      totalMs: round(last - scheduled),
      counters: { ...this.#counters },
    });
  }
}

function sumCounters(samples: readonly ToolTimingSample[]): ToolTimingCounters {
  const total: Record<ToolTimingCounter, number> = { controlCommits: 0, eventFsyncs: 0, projectionWrites: 0, artifactReadbacks: 0, hashRuns: 0 };
  for (const sample of samples) for (const key of Object.keys(total) as ToolTimingCounter[]) total[key] += sample.counters[key];
  return total;
}

/**
 * Wrap a tool so its execution is timed into `recorder`.
 *
 * The wrapper is transparent: it forwards the contract fields, the return value
 * and any thrown error unchanged, and marking stages cannot alter them. When it
 * receives no recorder it returns the original tool, so enabling timing is the
 * only difference between a measured and an unmeasured lane.
 *
 * Only the boundaries reachable from the tool wrapper are marked. The
 * agent-loop span `scheduled -> executionStart` is attributed by whoever owns
 * the dispatch, and `executionEnd -> toolResultEmitted` is marked by the Pi
 * result projection once that boundary is instrumented.
 *
 * @param tool - the tool to wrap.
 * @param recorder - destination for the samples.
 * @param label - optional grouping label recorded with every sample.
 * @returns the instrumented tool, or the original when no recorder is given.
 */
export function withToolTiming<TContext extends CodingResourceContext>(
  tool: AgentHarnessTool<TContext>,
  recorder: ToolTimingRecorder | undefined,
  label?: string,
): AgentHarnessTool<TContext> {
  if (!recorder) return tool;
  const inner = tool.execute;
  const wrapped: AgentHarnessTool<TContext> = {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const handle = recorder.begin(tool.name, label);
      handle.mark("executionStart");
      try {
        const result = await inner(toolCallId, params, signal, onUpdate, context);
        handle.mark("executionEnd");
        // A tool that returns an error result must not be counted as a success
        // in the baseline, or error paths disappear from the summary. The
        // harness result type does not declare `isError`, so read it defensively
        // rather than casting the result to a wider shape.
        const isError = typeof result === "object" && result !== null && (result as { isError?: unknown }).isError === true;
        handle.finish(isError);
        return result;
      } catch (error) {
        handle.mark("executionEnd");
        handle.finish(true);
        throw error;
      }
    },
  };
  return wrapped;
}

/**
 * Wrap every tool in a list.
 *
 * @param tools - tools to instrument.
 * @param recorder - destination for the samples; when omitted the list is returned unchanged.
 * @param label - optional grouping label recorded with every sample.
 * @returns the instrumented list.
 */
export function withToolTimingOnTools<TContext extends CodingResourceContext>(
  tools: AgentHarnessTool<TContext>[],
  recorder: ToolTimingRecorder | undefined,
  label?: string,
): AgentHarnessTool<TContext>[] {
  if (!recorder) return tools;
  return tools.map((tool) => withToolTiming(tool, recorder, label));
}
