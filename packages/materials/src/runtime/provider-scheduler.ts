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
      const source = start(model, context, observedOptions(options, requestId, observer));
      sourceCreated = true;
      for await (const event of source) {
        output.push(event);
        if (event.type === "done") await observer?.completed?.(requestId, event.message);
        else if (event.type === "error") await observer?.completed?.(requestId, event.error);
      }
    } catch (error) {
      if (!sourceCreated) {
        const waitMs = Math.max(0, Date.now() - requestedAt);
        const reason = error instanceof Error ? error.message : String(error);
        try {
          await observer?.cancelled(requestId, { ...scope, queueDepth, waitMs, reason });
        } catch (observerError) {
          output.push(errorEvent(model, observerError));
          return;
        }
      }
      output.push(errorEvent(model, error));
    } finally {
      permit?.release();
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
