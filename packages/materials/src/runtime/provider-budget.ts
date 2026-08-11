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
import type { HarnessEvent } from "../domain/types.js";

export type ProviderBudgetTermination = "budget_exhausted" | "deadline_exhausted";

export interface ProviderBudgetCostModel {
  cost: Pick<Model<Api>["cost"], "input" | "output" | "cacheRead" | "cacheWrite">;
  contextWindow: number;
  maxTokens: number;
}

export class ProviderBudgetExceededError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProviderBudgetExceededError";
  }
}

/**
 * Rebuild a Run's conservative provider spend from its durable telemetry.
 * A request without a terminal usage record may already have reached the
 * Provider, so it retains a full reservation across pause or process restart.
 */
export function recoverProviderSpend(events: ReadonlyArray<Pick<HarnessEvent, "type" | "payload">>, model: ProviderBudgetCostModel): number {
  const maximumUsd = maximumProviderRequestCost(model);
  const pending = new Set<string>();
  let spentUsd = 0;
  for (const event of events) {
    const payload = event.payload ?? {};
    if (event.type === "provider_request_started") {
      const requestId = stringField(payload, "requestId");
      if (requestId) pending.add(requestId);
      continue;
    }
    if (event.type !== "model_usage") continue;
    const requestId = stringField(payload, "requestId");
    if (requestId) pending.delete(requestId);
    spentUsd += usageCost(payload, model, maximumUsd);
  }
  return spentUsd + (pending.size * maximumUsd);
}

/** Returns the worst permitted price for one Provider request. */
export function maximumProviderRequestCost(model: ProviderBudgetCostModel, configuredMaxTokens?: number): number {
  const inputRate = Math.max(model.cost.input, model.cost.cacheRead, model.cost.cacheWrite);
  const outputTokens = Math.max(model.maxTokens, configuredMaxTokens ?? 0);
  return ((model.contextWindow * inputRate) + (outputTokens * model.cost.output)) / 1_000_000;
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
  private spentUsd: number;
  private reservedUsd = 0;
  private stoppedAs: ProviderBudgetTermination | undefined;

  public constructor(private readonly options: { maxCostUsd?: number; deadlineAt: number; initialSpentUsd?: number }) {
    if (options.maxCostUsd !== undefined && (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0)) {
      throw new Error("Provider maxCostUsd must be a positive finite number");
    }
    if (!Number.isFinite(options.deadlineAt)) throw new Error("Provider deadlineAt must be finite");
    if (options.initialSpentUsd !== undefined && (!Number.isFinite(options.initialSpentUsd) || options.initialSpentUsd < 0)) {
      throw new Error("Provider initialSpentUsd must be a non-negative finite number");
    }
    this.spentUsd = options.initialSpentUsd ?? 0;
    if (options.maxCostUsd !== undefined && this.spentUsd >= options.maxCostUsd - 1e-9) this.stoppedAs = "budget_exhausted";
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
    const maximumUsd = maximumProviderRequestCost(model, options?.maxTokens);
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

}

function usageCost(payload: Record<string, unknown>, model: ProviderBudgetCostModel, maximumUsd: number): number {
  const usage = objectField(payload, "usage");
  const cost = usage ? objectField(usage, "cost") : undefined;
  const reported = cost ? finiteNonNegative(cost.total) : undefined;
  if (reported !== undefined && reported > 0) return reported;
  if (!usage) return maximumUsd;
  const calculated = (
    (finiteNonNegative(usage.input) ?? 0) * model.cost.input
    + (finiteNonNegative(usage.output) ?? 0) * model.cost.output
    + (finiteNonNegative(usage.reasoning) ?? 0) * model.cost.output
    + (finiteNonNegative(usage.cacheRead) ?? 0) * model.cost.cacheRead
    + (finiteNonNegative(usage.cacheWrite) ?? 0) * model.cost.cacheWrite
  ) / 1_000_000;
  return calculated > 0 ? calculated : maximumUsd;
}

function objectField(value: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const candidate = value[field];
  return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as Record<string, unknown> : undefined;
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
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
