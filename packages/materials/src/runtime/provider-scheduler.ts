import {
  createAssistantMessageEventStream,
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

  /**
   * @param options.idleTimeoutMs Max time to wait BETWEEN provider stream events
   *   before the stream is treated as stalled. A provider can return HTTP 200 and
   *   then hang mid-stream (headers received, body never completes); without this
   *   bound the `for await` below would wait forever, and because `permit.release()`
   *   sits in `finally` the concurrency slot would be held forever too — enough
   *   stalls deadlock the whole fleet. 0 disables the watchdog. Default 120s.
   */
  public constructor(options: { idleTimeoutMs?: number } = {}) {
    const idle = options.idleTimeoutMs ?? 120_000;
    if (!Number.isFinite(idle) || idle < 0) throw new Error("Provider idleTimeoutMs must be a non-negative number");
    this.idleTimeoutMs = idle;
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
    let sourceCreated = false;
    const requestedAt = Date.now();
    let queueDepth = 0;
    try {
      const pool = this.pool(scope);
      queueDepth = pool.queue.length;
      requestId = await observer?.queued({ ...scope, queueDepth });
      permit = await this.acquire(pool, options?.signal);
      await observer?.started(requestId, { ...scope, queueDepth: permit.queueDepth, waitMs: permit.waitMs });
      // Combine the caller's signal with an internal idle-watchdog signal so a
      // provider that honors AbortSignal can cancel the underlying fetch when the
      // stream stalls. The race below is the real guarantee though: even a
      // provider that ignores the signal cannot keep us (and the permit) hung.
      const idle = new AbortController();
      const signal = options?.signal ? AbortSignal.any([options.signal, idle.signal]) : idle.signal;
      const source = start(model, context, observedOptions({ ...options, signal }, requestId, observer));
      sourceCreated = true;
      await this.consume(source, idle, output, requestId, observer);
    } catch (error) {
      const event = errorEvent(model, error);
      if (!sourceCreated) {
        const waitMs = Math.max(0, Date.now() - requestedAt);
        const reason = error instanceof Error ? error.message : String(error);
        try {
          await observer?.cancelled(requestId, { ...scope, queueDepth, waitMs, reason });
        } catch (observerError) {
          output.push(errorEvent(model, observerError));
          return;
        }
      } else {
        // The stream had already started when it threw — the idle watchdog is the
        // main case. Emit the terminal observer completion (with the synthetic
        // error message) so telemetry records a final state and writes the
        // model_usage terminal event. Without it the request stays "in flight"
        // forever and a restart would recover it as an unfinished request.
        // Guard it so an observer failure never blocks the terminal error event
        // from reaching the consumer, which would otherwise hang.
        try {
          await observer?.completed?.(requestId, event.error);
        } catch {
          // Best-effort: the error event below is the consumer's terminal signal.
        }
      }
      output.push(event);
    } finally {
      permit?.release();
    }
  }

  /**
   * Drive the provider stream with an inter-event idle watchdog. Each event
   * resets the timer; if none arrives within idleTimeoutMs the stream is treated
   * as stalled: we abort (best-effort cancel of the underlying fetch) and throw,
   * which unwinds `forward` — producing an error event for the retry path and,
   * critically, releasing the concurrency permit in its `finally`. Racing the
   * iterator against the timer means a provider that ignores the abort signal
   * still cannot keep the slot hung.
   */
  private async consume(
    source: AssistantMessageEventStream,
    idle: AbortController,
    output: AssistantMessageEventStream,
    requestId: string | undefined,
    observer: ProviderRequestSchedulingObserver | undefined,
  ): Promise<void> {
    if (this.idleTimeoutMs <= 0) {
      for await (const event of source) {
        output.push(event);
        if (event.type === "done") await observer?.completed?.(requestId, event.message);
        else if (event.type === "error") await observer?.completed?.(requestId, event.error);
      }
      return;
    }
    const iterator = source[Symbol.asyncIterator]();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // `rearm` is deliberately a local, not an instance field: concurrent streams
    // each run their own consume() and must not share one timer handle.
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
        if (next.done) break;
        rearm();
        const event = next.value;
        output.push(event);
        if (event.type === "done") await observer?.completed?.(requestId, event.message);
        else if (event.type === "error") await observer?.completed?.(requestId, event.error);
      }
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
