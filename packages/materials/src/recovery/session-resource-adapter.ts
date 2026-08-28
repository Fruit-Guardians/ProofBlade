import type {
  ExternalResourceAdapter,
  ExternalResourceAdapterSource,
  ExternalResourceInspection,
  ExternalResourceRecord,
  ExternalResourceKind,
} from "./external-resource-registry.js";
import { resolveExternalResourceAdapters } from "./external-resource-registry.js";
import type { ContainerRuntimePort, ContainerSessionHandle } from "../container/contracts.js";
import type { SessionRuntimeCreateRequest, SessionRuntimeCreateWireResponse, SessionRuntimeHealthCapabilities, SessionRuntimeHealthStatus } from "./session-runtime-wire.js";

/** The session resources that can be owned by an external, durable broker. */
export type BrokeredSessionKind = Extract<ExternalResourceKind, "pwn-session" | "http-session">;

/** A Pwn binding that the current process can pass back to SessionRegistry. */
export interface PwnSessionRuntimeBinding {
  readonly kind: "pwn-session";
  readonly externalId: string;
  readonly handle: ContainerSessionHandle;
  /** Runtime bridge whose session methods understand the opaque handle after restart. */
  readonly runtime: Pick<ContainerRuntimePort, "sessionWrite" | "sessionRead" | "sessionSignal" | "closeSession">;
}

/** An HTTP binding backed by a stateful external session service. */
export interface HttpSessionRuntimeBinding {
  readonly kind: "http-session";
  readonly externalId: string;
  readonly fetchImpl: typeof fetch;
  readonly stateHash?: string;
}

export type SessionRuntimeBinding = PwnSessionRuntimeBinding | HttpSessionRuntimeBinding;

export interface SessionRuntimeAdoptResult {
  state: "CONFIRMED" | "UNKNOWN";
  summary?: string;
  /** Current-process binding required for a confirmed handoff. */
  binding?: SessionRuntimeBinding;
}

/** A binding retained in memory for the lane that is about to resume a run. */
export interface SessionRuntimeHandoff {
  readonly resourceId: string;
  readonly record: ExternalResourceRecord;
  readonly binding: SessionRuntimeBinding;
}

/** Narrow capability used by recovery to extract a binding without coupling it to a broker. */
export interface SessionRuntimeBindingSource {
  takeBinding(resourceId: string): SessionRuntimeBinding | undefined;
}

/**
 * Application-owned broker for a session that can outlive the ProofBlade
 * process.  A broker must validate run/generation/scope/policy/recipe before
 * returning MATCH; a process-local docker-exec id is not a durable handle.
 */
export interface SessionRuntimeBroker {
  readonly name: string;
  readonly kind: BrokeredSessionKind;
  inspect(record: ExternalResourceRecord, signal?: AbortSignal): Promise<ExternalResourceInspection>;
  adopt(record: ExternalResourceRecord, inspection: ExternalResourceInspection, signal?: AbortSignal): Promise<SessionRuntimeAdoptResult>;
  release(record: ExternalResourceRecord, reason: string, signal?: AbortSignal): Promise<{ released: boolean; summary?: string }>;
  /** Optional bounded capability probe used before a Coding lane starts. */
  health?(signal?: AbortSignal): Promise<{ status: SessionRuntimeHealthStatus; capabilities: SessionRuntimeHealthCapabilities; summary?: string }>;
}

/** A session broker that can allocate a new durable runtime binding. */
export interface SessionRuntimeCreateBroker extends SessionRuntimeBroker {
  create(request: SessionRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<SessionRuntimeCreateWireResponse>;
  createBinding(record: ExternalResourceRecord, signal?: AbortSignal): Promise<SessionRuntimeBinding>;
}

/**
 * Resource adapter for brokered Pwn/HTTP sessions.  It deliberately does not
 * create a replacement session: absence of a broker or an ambiguous handle
 * remains UNKNOWN and therefore cannot be auto-released or treated as a live
 * recovered session.
 */
export class SessionResourceAdapter implements ExternalResourceAdapter, SessionRuntimeBindingSource {
  public readonly kind: BrokeredSessionKind;
  private readonly adoptedBindings = new Map<string, SessionRuntimeBinding>();

  public constructor(private readonly broker: SessionRuntimeBroker) {
    if (!broker.name.trim()) throw new Error("Session runtime broker requires a stable name");
    this.kind = broker.kind;
  }

  public async inspect(record: ExternalResourceRecord, signal?: AbortSignal): Promise<ExternalResourceInspection> {
    if (!record.externalId) return { status: "UNKNOWN", binding: "UNKNOWN", summary: `${this.kind} resource has no opaque runtime handle` };
    const inspection = await this.broker.inspect(record, signal);
    return normalizeInspection(record, inspection);
  }

  public async adopt(record: ExternalResourceRecord, inspection: ExternalResourceInspection, signal?: AbortSignal): Promise<SessionRuntimeAdoptResult> {
    if (!isExactMatch(record, inspection)) {
      return { state: "UNKNOWN", summary: inspection.summary ?? `${this.kind} broker did not confirm the exact session handle` };
    }
    const outcome = await this.broker.adopt(record, inspection, signal);
    if (outcome.state === "CONFIRMED") {
      if (!outcome.binding) {
        return { state: "UNKNOWN", summary: outcome.summary ?? "Broker confirmed ownership but returned no current-process runtime binding" };
      }
      assertBinding(record, outcome.binding);
      this.adoptedBindings.set(record.id, outcome.binding);
    }
    return outcome;
  }

  /** Take the binding produced by the last successful adopt for one resource. */
  public takeBinding(resourceId: string): SessionRuntimeBinding | undefined {
    const binding = this.adoptedBindings.get(resourceId);
    this.adoptedBindings.delete(resourceId);
    return binding;
  }

  public async release(record: ExternalResourceRecord, reason: string, signal?: AbortSignal): Promise<{ released: boolean; summary?: string }> {
    if (!record.externalId) return { released: false, summary: `${this.kind} resource has no opaque runtime handle` };
    const inspection = normalizeInspection(record, await this.broker.inspect(record, signal));
    if (inspection.status === "ABSENT") return { released: true, summary: `${this.kind} session was already absent` };
    if (!isExactMatch(record, inspection)) {
      return { released: false, summary: inspection.summary ?? `${this.kind} session ownership is ambiguous; refusing release` };
    }
    return await this.broker.release(record, reason, signal);
  }
}

export function sessionResourceAdapter(broker: SessionRuntimeBroker | undefined): SessionResourceAdapter | undefined {
  return broker ? new SessionResourceAdapter(broker) : undefined;
}

/** Compose one or more broker adapters without eagerly resolving a lazy source. */
export function withSessionResourceAdapters(
  source: ExternalResourceAdapterSource | undefined,
  brokers: readonly SessionRuntimeBroker[] = [],
): ExternalResourceAdapterSource | undefined {
  const adapters = brokers.map((broker) => new SessionResourceAdapter(broker));
  if (adapters.length === 0) return source;
  return async (context) => [...await resolveExternalResourceAdapters(source, context), ...adapters];
}

function normalizeInspection(record: ExternalResourceRecord, inspection: ExternalResourceInspection): ExternalResourceInspection {
  if (inspection.status !== "PRESENT" || inspection.binding !== "MATCH") return inspection;
  if (inspection.externalId !== undefined && inspection.externalId !== record.externalId) {
    return { status: "PRESENT", binding: "MISMATCH", externalId: inspection.externalId, summary: "Broker returned a different external session handle" };
  }
  if (inspection.externalId === undefined) {
    return { status: "UNKNOWN", binding: "UNKNOWN", summary: "Broker did not echo the inspected external session handle" };
  }
  return inspection;
}

function isExactMatch(record: ExternalResourceRecord, inspection: ExternalResourceInspection): boolean {
  return inspection.status === "PRESENT"
    && inspection.binding === "MATCH"
    && record.externalId !== undefined
    && inspection.externalId === record.externalId;
}

function assertBinding(record: ExternalResourceRecord, binding: SessionRuntimeBinding): void {
  if (binding.kind !== record.kind || binding.externalId !== record.externalId) {
    throw new Error(`Broker returned a binding that does not match ${record.id}`);
  }
  if (binding.kind === "pwn-session") {
    if (binding.handle.externalId !== binding.externalId || binding.handle.ref.runId !== record.runId || binding.handle.ref.generation !== record.generation) {
      throw new Error(`Pwn broker returned a handle with the wrong immutable binding for ${record.id}`);
    }
    if (typeof binding.runtime.sessionWrite !== "function" || typeof binding.runtime.sessionRead !== "function" || typeof binding.runtime.sessionSignal !== "function" || typeof binding.runtime.closeSession !== "function") {
      throw new Error(`Pwn broker returned a runtime without the required session methods for ${record.id}`);
    }
  }
}
