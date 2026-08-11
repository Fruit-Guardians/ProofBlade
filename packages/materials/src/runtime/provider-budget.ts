import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderStreams,
  type StreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";

export type ProviderBudgetTermination = "budget_exhausted" | "deadline_exhausted";

export class ProviderBudgetExceededError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProviderBudgetExceededError";
  }
}

interface ProviderReservation {
  maximumUsd: number;
  settled: boolean;
}

/**
 * Enforces a per-Run provider budget before each HTTP request. The reservation
 * uses a model's maximum context and completion sizes, so a request cannot be
 * started when its worst supported cost would exceed the remaining budget.
 */
export class ProviderRequestBudget {
  private readonly deadline = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout> | undefined;
  private spentUsd = 0;
  private reservedUsd = 0;
  private stoppedAs: ProviderBudgetTermination | undefined;

  public constructor(private readonly options: { maxCostUsd?: number; deadlineAt: number }) {
    if (options.maxCostUsd !== undefined && (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0)) {
      throw new Error("Provider maxCostUsd must be a positive finite number");
    }
    if (!Number.isFinite(options.deadlineAt)) throw new Error("Provider deadlineAt must be finite");
    const remaining = options.deadlineAt - Date.now();
    if (remaining <= 0) this.expireDeadline();
    else this.timer = setTimeout(() => this.expireDeadline(), remaining);
  }

  public get signal(): AbortSignal {
    return this.deadline.signal;
  }

  public get termination(): ProviderBudgetTermination | undefined {
    return this.stoppedAs;
  }

  public close(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  public wrap(streams: ProviderStreams): ProviderStreams {
    return {
      stream: (model, context, options) => this.start(model, context, options, streams.stream),
      streamSimple: (model, context, options) => this.start(model, context, options, streams.streamSimple),
    };
  }

  private start(
    model: Model<Api>,
    context: Context,
    options: StreamOptions | undefined,
    start: (model: Model<Api>, context: Context, options?: StreamOptions) => AssistantMessageEventStream,
  ): AssistantMessageEventStream {
    const reservation = this.reserve(model, options);
    let source: AssistantMessageEventStream;
    try {
      source = start(model, context, {
        ...options,
        // A Provider-level retry is a second billable HTTP request that is
        // invisible to this wrapper. Live budgeted evaluation retries only at
        // a new, separately reserved Agent turn.
        maxRetries: 0,
        signal: options?.signal ? AbortSignal.any([options.signal, this.signal]) : this.signal,
      });
    } catch (error) {
      this.abandon(reservation);
      throw error;
    }
    const output = createAssistantMessageEventStream();
    void this.forward(model, source, output, reservation);
    return output;
  }

  private reserve(model: Model<Api>, options: StreamOptions | undefined): ProviderReservation {
    this.throwIfDeadlineExpired();
    const maximumUsd = this.maximumRequestCost(model, options?.maxTokens);
    if (this.options.maxCostUsd !== undefined && this.spentUsd + this.reservedUsd + maximumUsd > this.options.maxCostUsd + 1e-9) {
      this.stoppedAs = "budget_exhausted";
      throw new ProviderBudgetExceededError(`Provider cost budget exhausted before request: reserved=${round(this.spentUsd + this.reservedUsd + maximumUsd)} USD limit=${this.options.maxCostUsd} USD`);
    }
    this.reservedUsd += maximumUsd;
    return { maximumUsd, settled: false };
  }

  private async forward(model: Model<Api>, source: AssistantMessageEventStream, output: AssistantMessageEventStream, reservation: ProviderReservation): Promise<void> {
    try {
      for await (const event of source) {
        const usage = terminalUsage(event);
        if (usage) this.settle(reservation, usage);
        output.push(event);
      }
      if (!reservation.settled) {
        this.abandon(reservation);
        output.push(providerErrorEvent(model, this.signal.aborted ? "aborted" : "error", this.signal.aborted ? "Provider deadline exhausted" : "Provider stream ended without a terminal message", reservation.maximumUsd));
      }
    } catch (error) {
      this.abandon(reservation);
      output.push(providerErrorEvent(model, this.signal.aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error), reservation.maximumUsd));
    }
  }

  private settle(reservation: ProviderReservation, usage: Usage): void {
    if (reservation.settled) return;
    reservation.settled = true;
    this.reservedUsd = Math.max(0, this.reservedUsd - reservation.maximumUsd);
    const reported = Number.isFinite(usage.cost.total) && usage.cost.total > 0 ? usage.cost.total : 0;
    const charged = reported > 0 ? reported : reservation.maximumUsd;
    if (reported === 0 && charged > 0) {
      usage.cost.output += charged;
      usage.cost.total = charged;
    }
    this.spentUsd += charged;
    if (this.options.maxCostUsd !== undefined && this.spentUsd > this.options.maxCostUsd + 1e-9) this.stoppedAs = "budget_exhausted";
  }

  private abandon(reservation: ProviderReservation): void {
    if (reservation.settled) return;
    reservation.settled = true;
    this.reservedUsd = Math.max(0, this.reservedUsd - reservation.maximumUsd);
    // An interrupted request may already have reached the Provider. Retaining
    // its reservation prevents a retry from silently exceeding the Run budget.
    this.spentUsd += reservation.maximumUsd;
    if (this.options.maxCostUsd !== undefined && this.spentUsd >= this.options.maxCostUsd - 1e-9) this.stoppedAs = "budget_exhausted";
  }

  private throwIfDeadlineExpired(): void {
    if (this.signal.aborted) {
      this.stoppedAs = "deadline_exhausted";
      throw new ProviderBudgetExceededError("Provider deadline exhausted before request");
    }
  }

  private expireDeadline(): void {
    this.stoppedAs = "deadline_exhausted";
    this.deadline.abort(new ProviderBudgetExceededError("Provider deadline exhausted"));
  }

  private maximumRequestCost(model: Model<Api>, configuredMaxTokens: number | undefined): number {
    const inputRate = Math.max(model.cost.input, model.cost.cacheRead, model.cost.cacheWrite);
    const outputTokens = Math.max(model.maxTokens, configuredMaxTokens ?? 0);
    return ((model.contextWindow * inputRate) + (outputTokens * model.cost.output)) / 1_000_000;
  }
}

function terminalUsage(event: AssistantMessageEvent): Usage | undefined {
  if (event.type === "done") return event.message.usage;
  if (event.type === "error") return event.error.usage;
  return undefined;
}

function providerErrorEvent(model: Model<Api>, reason: "error" | "aborted", errorMessage: string, chargedUsd: number): Extract<AssistantMessageEvent, { type: "error" }> {
  return {
    type: "error",
    reason,
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
        cost: { input: 0, output: chargedUsd, cacheRead: 0, cacheWrite: 0, total: chargedUsd },
      },
      stopReason: reason,
      errorMessage,
      timestamp: Date.now(),
    },
  };
}

function round(value: number): number {
  return Number(value.toFixed(6));
}
