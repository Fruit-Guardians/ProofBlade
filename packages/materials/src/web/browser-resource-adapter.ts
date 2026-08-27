import type {
  ExternalResourceAdapter,
  ExternalResourceAdapterSource,
  ExternalResourceInspection,
  ExternalResourceRecord,
} from "../recovery/external-resource-registry.js";
import { resolveExternalResourceAdapters } from "../recovery/external-resource-registry.js";
import type { BrowserRuntimeAdoptResult, BrowserRuntimeBinding, BrowserRuntimeBroker, BrowserVerifierFactory } from "./browser-session.js";

/** A browser binding retained for the process that will resume verification. */
export interface BrowserRuntimeHandoff {
  readonly resourceId: string;
  readonly record: ExternalResourceRecord;
  readonly binding: BrowserRuntimeBinding;
}

/** Narrow recovery seam used to transfer an adopted browser context exactly once. */
export interface BrowserRuntimeBindingSource {
  takeBinding(resourceId: string): BrowserRuntimeBinding | undefined;
}

export interface BrowserRuntimeBrokerOptions {
  /** Upper bound for one broker RPC; timeout is fail-closed and retryable. */
  readonly timeoutMs?: number;
}

/**
 * Registry adapter for a browser runtime with an explicit durable broker.
 * Playwright's in-process factory does not provide one and therefore cannot
 * be used to inspect or adopt a context after a process restart.
 */
export class BrowserContextResourceAdapter implements ExternalResourceAdapter, BrowserRuntimeBindingSource {
  public readonly kind = "browser-context" as const;
  private readonly adoptedBindings = new Map<string, BrowserRuntimeBinding>();
  private readonly timeoutMs: number;

  public constructor(private readonly broker: BrowserRuntimeBroker, options: BrowserRuntimeBrokerOptions = {}) {
    if (!broker.name.trim()) throw new Error("Browser runtime broker requires a stable name");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) throw new Error("Browser runtime broker timeout must be between 100 and 120000 milliseconds");
  }

  public async inspect(record: ExternalResourceRecord, signal?: AbortSignal): Promise<ExternalResourceInspection> {
    if (!record.externalId) return { status: "UNKNOWN", binding: "UNKNOWN", summary: "browser resource has no opaque runtime handle" };
    return normalizeInspection(record, await this.withTimeout("inspect", signal, (innerSignal) => this.broker.inspect(record, innerSignal)));
  }

  public async adopt(record: ExternalResourceRecord, inspection: ExternalResourceInspection, signal?: AbortSignal): Promise<BrowserRuntimeAdoptResult> {
    if (!isExactMatch(record, inspection)) return { state: "UNKNOWN", summary: inspection.summary ?? "browser broker did not confirm the exact context" };
    const result = await this.withTimeout("adopt", signal, (innerSignal) => this.broker.adopt(record, inspection, innerSignal));
    if (result.state === "CONFIRMED") {
      if (this.broker.bind && record.bindingTxnId) {
        const bound = await this.withTimeout("bind", signal, (innerSignal) => this.broker.bind!(record, innerSignal));
        if (bound.state !== "BOUND" || bound.externalId !== record.externalId) return { state: "UNKNOWN", summary: bound.summary ?? "browser broker did not persist the binding marker" };
      }
      if (!result.binding) return { state: "UNKNOWN", summary: result.summary ?? "browser broker confirmed ownership without a runtime binding" };
      if (result.binding.kind !== "browser-context" || result.binding.externalId !== record.externalId) return { state: "UNKNOWN", summary: "browser broker returned a binding for a different context" };
      this.adoptedBindings.set(record.id, result.binding);
    }
    return result;
  }

  /** Take the binding produced by the last successful adopt for one resource. */
  public takeBinding(resourceId: string): BrowserRuntimeBinding | undefined {
    const binding = this.adoptedBindings.get(resourceId);
    this.adoptedBindings.delete(resourceId);
    return binding;
  }

  public async release(record: ExternalResourceRecord, reason: string, signal?: AbortSignal): Promise<{ released: boolean; summary?: string }> {
    if (!record.externalId) return { released: false, summary: "browser resource has no opaque runtime handle" };
    const inspection = await this.inspect(record, signal);
    if (inspection.status === "ABSENT") return { released: true, summary: "browser context was already absent" };
    if (!isExactMatch(record, inspection)) return { released: false, summary: inspection.summary ?? "browser context ownership is ambiguous; refusing release" };
    return await this.withTimeout("release", signal, (innerSignal) => this.broker.release(record, reason, innerSignal));
  }

  private async withTimeout<T>(operation: string, signal: AbortSignal | undefined, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`Browser broker ${this.broker.name} ${operation} timed out`));
        reject(new Error(`Browser broker ${this.broker.name} ${operation} timed out`));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([call(merged), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function normalizeInspection(record: ExternalResourceRecord, inspection: ExternalResourceInspection): ExternalResourceInspection {
  if (inspection.status !== "PRESENT" || inspection.binding !== "MATCH") return inspection;
  if (inspection.externalId !== record.externalId) {
    return { status: "PRESENT", binding: "MISMATCH", ...(inspection.externalId ? { externalId: inspection.externalId } : {}), summary: inspection.externalId ? "Browser broker returned a different opaque handle" : "Browser broker did not echo the inspected opaque handle" };
  }
  return inspection;
}

function isExactMatch(record: ExternalResourceRecord, inspection: ExternalResourceInspection): boolean {
  return inspection.status === "PRESENT"
    && inspection.binding === "MATCH"
    && record.externalId !== undefined
    && inspection.externalId === record.externalId;
}

/** Return the broker adapter exposed by a verifier factory, if any. */
export function browserResourceAdapter(factory: BrowserVerifierFactory | undefined): BrowserContextResourceAdapter | undefined {
  return factory?.runtimeBroker ? new BrowserContextResourceAdapter(factory.runtimeBroker) : undefined;
}

/**
 * Add a factory's browser adapter to an existing recovery source without
 * changing the source's lazy binding semantics. Duplicate kinds are left for
 * ExternalResourceRegistry to reject rather than silently choosing one.
 */
export function withBrowserResourceAdapter(
  source: ExternalResourceAdapterSource | undefined,
  factory: BrowserVerifierFactory | undefined,
): ExternalResourceAdapterSource | undefined {
  const adapter = browserResourceAdapter(factory);
  if (!adapter) return source;
  return async (context) => [...await resolveExternalResourceAdapters(source, context), adapter];
}
