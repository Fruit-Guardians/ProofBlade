import {
  createAssistantMessageEventStream,
  isRetryableAssistantError,
  type Api,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type ProviderStreams,
  type StreamOptions,
} from "@earendil-works/pi-ai";

export interface ProviderRequestScope {
  provider: string;
  model: string;
  /** Stable, non-secret identity of the selected profile endpoint. */
  endpoint: string;
  maxConcurrentRequests: number;
}

export interface ProviderRequestQueueInfo extends ProviderRequestScope {
  queueDepth: number;
}

export interface ProviderRequestStartInfo extends ProviderRequestScope {
  queueDepth: number;
  waitMs: number;
}

export interface ProviderRequestCancelInfo extends ProviderRequestStartInfo {
  reason: string;
}

/**
 * A Lane-specific bridge supplies durable request ids and records scheduling
 * transitions. The scheduler itself remains reusable outside the CTF store.
 */
export interface ProviderRequestSchedulingObserver {
  queued(info: ProviderRequestQueueInfo): Promise<string | undefined> | string | undefined;
  started(requestId: string | undefined, info: ProviderRequestStartInfo): Promise<void> | void;
  cancelled(requestId: string | undefined, info: ProviderRequestCancelInfo): Promise<void> | void;
  payload?(requestId: string | undefined, payload: unknown): Promise<void> | void;
  response?(requestId: string | undefined, response: { status: number; headers: Record<string, string> }): Promise<void> | void;
  completed?(requestId: string | undefined, message: AssistantMessage): Promise<void> | void;
  /** A transient stream error was classified retryable; a re-issue is scheduled. */
  retried?(requestId: string | undefined, info: ProviderRequestScope & { attempt: number; maxRetries: number; delayMs: number; reason: string }): Promise<void> | void;
}

export interface ProviderRequestSchedulerStatus extends ProviderRequestScope {
  active: number;
  queued: number;
}

interface PendingRequest {
  resolve: (permit: ProviderRequestPermit) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  queuedAt: number;
  queueDepth: number;
}

interface ProviderRequestPermit {
  waitMs: number;
  queueDepth: number;
  release(): void;
}

interface SchedulerPool {
  scope: ProviderRequestScope;
  active: number;
  queue: PendingRequest[];
}

class ProviderRequestQueueAbortedError extends Error {
  public constructor() {
    super("Provider request was cancelled while waiting for a concurrency slot");
    this.name = "ProviderRequestQueueAbortedError";
  }
}

/**
 * Process-local, FIFO concurrency control for actual Provider requests.
 * The pool key deliberately includes the endpoint identity through the caller
 * supplied provider id and model id; separate models never block one another.
 */
export class ProviderRequestScheduler {
  private readonly pools = new Map<string, SchedulerPool>();
  private readonly idleTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  /**
   * @param options.idleTimeoutMs Max time to wait BETWEEN provider stream events
   *   before the stream is treated as stalled. A provider can return HTTP 200 and
   *   then hang mid-stream (headers received, body never completes); without this
   *   bound the `for await` below would wait forever, and because `permit.release()`
   *   sits in `finally` the concurrency slot would be held forever too — enough
   *   stalls deadlock the whole fleet. 0 disables the watchdog. Default 120s.
   * @param options.maxRetries Bounded retries for a TRANSIENT stream error (e.g.
   *   HTTP 200 then a mid-body error a token or two in). The retry re-issues the
   *   SAME provider request at the stream boundary — it never restarts the agent
   *   turn, so it cannot duplicate the user message or re-run tools. Only errors
   *   classified retryable by pi-ai (5xx, socket hang up, "provider returned
   *   error", …) are retried; one idle stall is also retried at the same stream
   *   boundary, while quota/billing still fail fast. 0 disables retries. Default 2.
   * @param options.retryBaseDelayMs Base backoff; delay is baseDelayMs * 2^(n-1).
   */
  public constructor(options: { idleTimeoutMs?: number; maxRetries?: number; retryBaseDelayMs?: number } = {}) {
    const idle = options.idleTimeoutMs ?? 120_000;
    if (!Number.isFinite(idle) || idle < 0) throw new Error("Provider idleTimeoutMs must be a non-negative number");
    this.idleTimeoutMs = idle;
    const retries = options.maxRetries ?? 2;
    if (!Number.isInteger(retries) || retries < 0 || retries > 8) throw new Error("Provider maxRetries must be an integer in [0, 8]");
    this.maxRetries = retries;
    const baseDelay = options.retryBaseDelayMs ?? 500;
    if (!Number.isFinite(baseDelay) || baseDelay < 0) throw new Error("Provider retryBaseDelayMs must be a non-negative number");
    this.retryBaseDelayMs = baseDelay;
  }

  public wrap(streams: ProviderStreams, scope: ProviderRequestScope, observer?: ProviderRequestSchedulingObserver): ProviderStreams {
    assertScope(scope);
    return {
      stream: (model, context, options) => this.schedule(streams.stream, model, context, options, scope, observer),
      streamSimple: (model, context, options) => this.schedule(streams.streamSimple, model, context, options, scope, observer),
    };
  }

  public statuses(): ProviderRequestSchedulerStatus[] {
    return [...this.pools.values()]
      .map((pool) => ({ ...pool.scope, active: pool.active, queued: pool.queue.length }))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  }

  private schedule(
    start: (model: Model<Api>, context: Context, options?: StreamOptions) => AssistantMessageEventStream,
    model: Model<Api>,
    context: Context,
    options: StreamOptions | undefined,
    scope: ProviderRequestScope,
    observer: ProviderRequestSchedulingObserver | undefined,
  ): AssistantMessageEventStream {
    const output = createAssistantMessageEventStream();
    void this.forward(start, model, context, options, scope, observer, output);
    return output;
  }

  private async forward(
    start: (model: Model<Api>, context: Context, options?: StreamOptions) => AssistantMessageEventStream,
    model: Model<Api>,
    context: Context,
    options: StreamOptions | undefined,
    scope: ProviderRequestScope,
    observer: ProviderRequestSchedulingObserver | undefined,
    output: AssistantMessageEventStream,
  ): Promise<void> {
    let requestId: string | undefined;
    let permit: ProviderRequestPermit | undefined;
    const requestedAt = Date.now();
    let queueDepth = 0;
    try {
      const pool = this.pool(scope);
      queueDepth = pool.queue.length;
      requestId = await observer?.queued({ ...scope, queueDepth });
      permit = await this.acquire(pool, options?.signal);
    } catch (error) {
      // Failed BEFORE the provider stream started (queue abort / acquire error).
      // This is a cancellation, never retried; tell the observer, then emit.
      const waitMs = Math.max(0, Date.now() - requestedAt);
      const reason = error instanceof Error ? error.message : String(error);
      try {
        await observer?.cancelled(requestId, { ...scope, queueDepth, waitMs, reason });
      } catch (observerError) {
        output.push(errorEvent(model, observerError));
        permit?.release();
        return;
      }
      output.push(errorEvent(model, error));
      permit?.release();
      return;
    }
    try {
      await observer?.started(requestId, { ...scope, queueDepth: permit.queueDepth, waitMs: permit.waitMs });
      // Bounded retry at the STREAM boundary. Each attempt buffers its events and
      // is committed to `output` only once it terminates (success or a final,
      // non-retryable/ budget-exhausted error). A retryable error mid-stream
      // discards the buffer and re-issues the SAME request — so a partial stream
      // never leaks duplicate events downstream, and because we re-issue the
      // provider call (not the agent turn) no user message or tool is repeated.
      let attempt = 0;
      for (;;) {
        // Fresh idle watchdog per attempt; a provider that honors the signal can
        // cancel its fetch, and the race in drainAttempt guarantees liveness even
        // if it does not. Fresh observedOptions so payload/response telemetry
        // fires for each real HTTP request.
        const idle = new AbortController();
        const signal = options?.signal ? AbortSignal.any([options.signal, idle.signal]) : idle.signal;
        const source = start(model, context, observedOptions({ ...options, signal }, requestId, observer));
        const outcome = await this.drainAttempt(source, idle);
        // A terminal error this attempt produced (either a real error event or a
        // synthetic one from an idle stall / iterator throw).
        const errorMessage = outcome.kind === "error" ? outcome.event.error : outcome.kind === "threw" ? errorEvent(model, outcome.error).error : undefined;
        const retryable = errorMessage !== undefined && attempt < this.maxRetries && !options?.signal?.aborted
          && (isRetryableAssistantError(errorMessage) || isIdleProviderError(errorMessage));
        if (retryable) {
          attempt += 1;
          const delayMs = this.retryBaseDelayMs * 2 ** (attempt - 1);
          await observer?.retried?.(requestId, { ...scope, attempt, maxRetries: this.maxRetries, delayMs, reason: errorMessage!.errorMessage ?? "transient provider error" });
          const aborted = await backoff(delayMs, options?.signal);
          if (aborted) {
            // Cancelled during backoff: emit an aborted terminal so the consumer
            // (and telemetry) get a final state instead of hanging.
            const abortedEvent = errorEvent(model, new ProviderRequestQueueAbortedError());
            await completeSafe(observer, requestId, abortedEvent.error);
            output.push(abortedEvent);
            return;
          }
          continue; // discard this attempt's buffer, re-issue
        }
        // Commit this attempt: flush its buffered events in order, then fire the
        // single terminal completion for telemetry.
        for (const event of outcome.events) output.push(event);
        if (outcome.kind === "success") {
          await completeSafe(observer, requestId, outcome.message);
        } else if (outcome.kind === "error") {
          // The real error event is already in outcome.events (flushed above).
          await completeSafe(observer, requestId, outcome.event.error);
        } else {
          // threw: drainAttempt buffered only non-terminal deltas before the
          // throw, so synthesize the terminal error event, complete, and push it.
          const event = errorEvent(model, outcome.error);
          await completeSafe(observer, requestId, event.error);
          output.push(event);
        }
        return;
      }
    } catch (error) {
      // We already own the permit here, so a synchronous/async throw from
      // observer.started(), start() (the production stack wraps ProviderRequestBudget,
      // whose start() throws synchronously once the deadline is exhausted), an
      // observedOptions callback, or observer.retried() would otherwise escape this
      // fire-and-forget forward() as an unhandled rejection AND leave the output
      // stream without a terminal event — hanging the consumer (or crashing Node).
      // Emit a terminal error and fire the single completion so the turn ends
      // cleanly; the permit is still released in finally. drainAttempt handles its
      // own stream errors, so this path is the pre/post-stream synchronous throws.
      const event = errorEvent(model, error);
      await completeSafe(observer, requestId, event.error);
      output.push(event);
    } finally {
      permit.release();
    }
  }

  /**
   * Drive ONE provider-stream attempt with an inter-event idle watchdog,
   * BUFFERING every event rather than pushing it downstream. Returns an outcome
   * so `forward` can decide to commit (flush the buffer) or retry (discard it):
   *   - success: the stream reached a `done` event.
   *   - error:   the stream reached a real `error` event (buffered, terminal).
   *   - threw:   the stream stalled (idle watchdog) or the iterator threw before
   *              any terminal event — a synthetic error is derived by the caller.
   * Each event resets the idle timer; if none arrives within idleTimeoutMs the
   * attempt is treated as stalled and unwinds (best-effort aborting the fetch),
   * so a provider that ignores the abort signal still cannot hang the slot.
   * Buffering costs live token streaming during a call, which the fleet does not
   * rely on, in exchange for a retry that never leaks a partial stream.
   */
  private async drainAttempt(source: AssistantMessageEventStream, idle: AbortController): Promise<AttemptOutcome> {
    const events: AssistantMessageEvent[] = [];
    if (this.idleTimeoutMs <= 0) {
      for await (const event of source) {
        events.push(event);
        if (event.type === "done") return { kind: "success", events, message: event.message };
        if (event.type === "error") return { kind: "error", events, event };
      }
      return { kind: "threw", events, error: new Error("Provider stream ended without a terminal event") };
    }
    const iterator = source[Symbol.asyncIterator]();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Local, not an instance field: concurrent streams each run their own attempt
    // and must not share one timer handle.
    let rearm: () => void = () => {};
    const stall = new Promise<never>((_, reject) => {
      rearm = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const reason = new Error(`Provider stream idle for more than ${this.idleTimeoutMs}ms`);
          idle.abort(reason);
          reject(reason);
        }, this.idleTimeoutMs);
      };
      rearm();
    });
    try {
      for (;;) {
        const pending = iterator.next();
        // If the stall timer wins the race, `pending` is left in flight and may
        // later reject once the abort tears down the fetch; swallow that so it
        // never surfaces as an unhandled rejection.
        pending.catch(() => {});
        const next = await Promise.race([pending, stall]);
        if (next.done) return { kind: "threw", events, error: new Error("Provider stream ended without a terminal event") };
        rearm();
        const event = next.value;
        events.push(event);
        if (event.type === "done") return { kind: "success", events, message: event.message };
        if (event.type === "error") return { kind: "error", events, event };
      }
    } catch (error) {
      return { kind: "threw", events, error };
    } finally {
      clearTimeout(timer);
      // Best-effort close so the abandoned generator can run its own cleanup.
      void iterator.return?.(undefined).catch(() => {});
    }
  }

  private pool(scope: ProviderRequestScope): SchedulerPool {
    const key = `${scope.provider}\u0000${scope.model}\u0000${scope.endpoint}`;
    const existing = this.pools.get(key);
    if (existing) {
      // Provider profiles can be edited while the GUI remains open. The latest
      // complete profile is authoritative; drain immediately if it raises the
      // limit, while existing active requests finish normally if it lowers it.
      existing.scope = { ...scope };
      this.drain(existing);
      return existing;
    }
    const pool: SchedulerPool = { scope: { ...scope }, active: 0, queue: [] };
    this.pools.set(key, pool);
    return pool;
  }

  private async acquire(pool: SchedulerPool, signal: AbortSignal | undefined): Promise<ProviderRequestPermit> {
    if (signal?.aborted) throw new ProviderRequestQueueAbortedError();
    const queuedAt = Date.now();
    return await new Promise<ProviderRequestPermit>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, signal, queuedAt, queueDepth: pool.queue.length };
      pending.onAbort = () => {
        const index = pool.queue.indexOf(pending);
        if (index >= 0) pool.queue.splice(index, 1);
        reject(new ProviderRequestQueueAbortedError());
      };
      if (signal) signal.addEventListener("abort", pending.onAbort, { once: true });
      pool.queue.push(pending);
      this.drain(pool);
    });
  }

  private drain(pool: SchedulerPool): void {
    while (pool.active < pool.scope.maxConcurrentRequests && pool.queue.length > 0) {
      const pending = pool.queue.shift()!;
      if (pending.signal?.aborted) {
        pending.signal.removeEventListener("abort", pending.onAbort!);
        pending.reject(new ProviderRequestQueueAbortedError());
        continue;
      }
      pending.signal?.removeEventListener("abort", pending.onAbort!);
      pool.active += 1;
      let released = false;
      pending.resolve({
        waitMs: Math.max(0, Date.now() - pending.queuedAt),
        queueDepth: pending.queueDepth,
        release: () => {
          if (released) return;
          released = true;
          pool.active = Math.max(0, pool.active - 1);
          this.drain(pool);
        },
      });
    }
  }
}

function isIdleProviderError(message: { errorMessage?: string }): boolean {
  return /provider stream idle for more than \d+ms/i.test(message.errorMessage ?? "");
}

/** Outcome of one buffered provider-stream attempt (see drainAttempt). */
type AttemptOutcome =
  | { kind: "success"; events: AssistantMessageEvent[]; message: AssistantMessage }
  | { kind: "error"; events: AssistantMessageEvent[]; event: Extract<AssistantMessageEvent, { type: "error" }> }
  | { kind: "threw"; events: AssistantMessageEvent[]; error: unknown };

/** Abortable backoff sleep. Resolves true if the signal aborted during the wait. */
function backoff(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  if (delayMs <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(false); }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Fire the terminal observer completion exactly once, swallowing any throw so an
 * observer failure never blocks the terminal event from reaching the consumer
 * (which would hang the turn). The single call site here means the double-count
 * hazard that PR #51 guarded against cannot recur.
 */
async function completeSafe(observer: ProviderRequestSchedulingObserver | undefined, requestId: string | undefined, message: AssistantMessage): Promise<void> {
  try {
    await observer?.completed?.(requestId, message);
  } catch {
    // Best-effort: the terminal event pushed to output is the consumer's signal.
  }
}

const sharedScheduler = new ProviderRequestScheduler();

export function providerRequestScheduler(): ProviderRequestScheduler {
  return sharedScheduler;
}

export function configuredMaxConcurrentRequests(value: number | undefined): number {
  return value ?? 1;
}

function assertScope(scope: ProviderRequestScope): void {
  if (!scope.provider.trim() || !scope.model.trim() || !scope.endpoint.trim()) throw new Error("Provider scheduling requires non-empty provider, model, and endpoint ids");
  if (!Number.isInteger(scope.maxConcurrentRequests) || scope.maxConcurrentRequests < 1 || scope.maxConcurrentRequests > 32) {
    throw new Error("Provider maxConcurrentRequests must be an integer between 1 and 32");
  }
}

function observedOptions(options: StreamOptions | undefined, requestId: string | undefined, observer: ProviderRequestSchedulingObserver | undefined): StreamOptions | undefined {
  if (!observer?.payload && !observer?.response) return options;
  return {
    ...options,
    onPayload: async (payload, model) => {
      const next = await options?.onPayload?.(payload, model);
      await observer.payload?.(requestId, next ?? payload);
      return next;
    },
    onResponse: async (response, model) => {
      await options?.onResponse?.(response, model);
      await observer.response?.(requestId, response);
    },
  };
}

function errorEvent(model: Model<Api>, error: unknown): Extract<AssistantMessageEvent, { type: "error" }> {
  const message = error instanceof Error ? error.message : String(error);
  const aborted = error instanceof ProviderRequestQueueAbortedError;
  return {
    type: "error",
    reason: aborted ? "aborted" : "error",
    error: {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: aborted ? "aborted" : "error",
      errorMessage: message,
      timestamp: Date.now(),
    },
  };
}
