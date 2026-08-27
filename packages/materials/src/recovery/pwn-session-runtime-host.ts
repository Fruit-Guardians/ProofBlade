import {
  type SessionRuntimeActionService,
  type SessionRuntimeCreateRequest,
  normalizeSessionRuntimeCreateRequest,
} from "./session-runtime-wire.js";
import type {
  SessionRuntimeCreatedSession,
  SessionRuntimeHost,
  SessionRuntimeHostInspection,
  SessionRuntimeHostPresence,
} from "./session-runtime-service.js";

/** The Pwn-only action surface a deployment supervisor must own. */
export type PwnSessionSupervisorActions = Pick<
  SessionRuntimeActionService,
  "pwnWrite" | "pwnRead" | "pwnSignal" | "pwnClose"
>;

/**
 * Deployment-owned contract for a restart-stable Pwn process/tube supervisor.
 * The supervisor, not ProofBlade, owns the child process, socket/PTY and
 * transcript cursor. Implementations must preserve an exact opaque handle
 * across service restarts and must never create a replacement during inspect,
 * adopt or idempotency reconciliation.
 */
export interface PwnSessionSupervisor {
  readonly actions: PwnSessionSupervisorActions;
  create(request: SessionRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<SessionRuntimeCreatedSession>;
  inspect(externalId: string, request: SessionRuntimeCreateRequest, signal?: AbortSignal): Promise<SessionRuntimeHostInspection>;
  adopt(externalId: string, request: SessionRuntimeCreateRequest, signal?: AbortSignal): Promise<boolean>;
  release(externalId: string, request: SessionRuntimeCreateRequest, reason: string, signal?: AbortSignal): Promise<boolean>;
  inspectByIdempotency?(request: SessionRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<{ status: SessionRuntimeHostPresence; created?: SessionRuntimeCreatedSession }>;
  heartbeat?(externalId: string, signal?: AbortSignal): Promise<void>;
  health?(signal?: AbortSignal): Promise<{ status: "READY" | "DEGRADED" | "UNAVAILABLE"; capabilities: { readonly kinds: readonly ("pwn-session" | "http-session")[]; readonly maxRequestBytes: number; readonly maxResponseBytes: number; readonly stableAcrossRestart: boolean }; summary?: string }>;
}

/**
 * Adapts a deployment Pwn supervisor to the generic session host consumed by
 * `DurableSessionRuntimeService`. It deliberately exposes no HTTP capability;
 * a mixed or misdeclared host is downgraded during health preflight instead of
 * silently widening the supervisor's authority.
 */
export class PwnSessionRuntimeHost implements SessionRuntimeHost {
  public readonly actions: SessionRuntimeActionService;

  public constructor(private readonly supervisor: PwnSessionSupervisor) {
    if (!supervisor || typeof supervisor.create !== "function" || typeof supervisor.inspect !== "function" || typeof supervisor.adopt !== "function" || typeof supervisor.release !== "function") {
      throw new Error("Pwn session runtime host requires a complete supervisor");
    }
    if (!supervisor.actions || typeof supervisor.actions.pwnWrite !== "function" || typeof supervisor.actions.pwnRead !== "function" || typeof supervisor.actions.pwnSignal !== "function" || typeof supervisor.actions.pwnClose !== "function") {
      throw new Error("Pwn session runtime host requires all Pwn action capabilities");
    }
    this.actions = {
      pwnWrite: async (resource, data, options, signal) => await supervisor.actions.pwnWrite(resource, data, options, signal),
      pwnRead: async (resource, options, signal) => await supervisor.actions.pwnRead(resource, options, signal),
      pwnSignal: async (resource, signalName, signal) => await supervisor.actions.pwnSignal(resource, signalName, signal),
      pwnClose: async (resource, signal) => await supervisor.actions.pwnClose(resource, signal),
      httpRequest: async () => { throw new Error("Pwn session runtime host does not expose HTTP actions"); },
    };
  }

  public async create(request: SessionRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<SessionRuntimeCreatedSession> {
    return await this.supervisor.create(assertPwnRequest(request), idempotencyKey, signal);
  }

  public async inspect(externalId: string, request: SessionRuntimeCreateRequest, signal?: AbortSignal): Promise<SessionRuntimeHostInspection> {
    return await this.supervisor.inspect(externalId, assertPwnRequest(request), signal);
  }

  public async adopt(externalId: string, request: SessionRuntimeCreateRequest, signal?: AbortSignal): Promise<boolean> {
    return await this.supervisor.adopt(externalId, assertPwnRequest(request), signal);
  }

  public async release(externalId: string, request: SessionRuntimeCreateRequest, reason: string, signal?: AbortSignal): Promise<boolean> {
    return await this.supervisor.release(externalId, assertPwnRequest(request), reason, signal);
  }

  public async inspectByIdempotency(request: SessionRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<{ status: SessionRuntimeHostPresence; created?: SessionRuntimeCreatedSession }> {
    if (!this.supervisor.inspectByIdempotency) return { status: "UNKNOWN" };
    return await this.supervisor.inspectByIdempotency(assertPwnRequest(request), idempotencyKey, signal);
  }

  public async heartbeat(externalId: string, signal?: AbortSignal): Promise<void> {
    if (!this.supervisor.heartbeat) throw new Error("Pwn session supervisor does not expose heartbeat");
    await this.supervisor.heartbeat(externalId, signal);
  }

  public async health(signal?: AbortSignal): Promise<{ status: "READY" | "DEGRADED" | "UNAVAILABLE"; capabilities: { readonly kinds: readonly ["pwn-session"]; readonly maxRequestBytes: number; readonly maxResponseBytes: number; readonly stableAcrossRestart: boolean }; summary?: string }> {
    if (!this.supervisor.health) return { status: "DEGRADED", capabilities: defaultCapabilities(false), summary: "Pwn session supervisor does not expose a health probe" };
    const result = await this.supervisor.health(signal);
    const capabilities = {
      kinds: ["pwn-session"] as const,
      maxRequestBytes: result.capabilities.maxRequestBytes,
      maxResponseBytes: result.capabilities.maxResponseBytes,
      stableAcrossRestart: result.capabilities.stableAcrossRestart,
    };
    if (!result.capabilities.kinds.includes("pwn-session") || result.capabilities.kinds.includes("http-session")) {
      return {
        status: result.status === "UNAVAILABLE" ? "UNAVAILABLE" : "DEGRADED",
        capabilities: { ...capabilities, stableAcrossRestart: false },
        summary: "Pwn session supervisor declared an invalid or mixed capability set",
      };
    }
    return { status: result.status, capabilities, ...(result.summary ? { summary: result.summary } : {}) };
  }
}

function assertPwnRequest(request: SessionRuntimeCreateRequest): SessionRuntimeCreateRequest & { kind: "pwn-session"; pwn: NonNullable<SessionRuntimeCreateRequest["pwn"]> } {
  const normalized = normalizeSessionRuntimeCreateRequest(request);
  if (normalized.kind !== "pwn-session" || !normalized.pwn) throw new Error("Pwn session runtime host only supports complete pwn-session requests");
  return normalized as SessionRuntimeCreateRequest & { kind: "pwn-session"; pwn: NonNullable<SessionRuntimeCreateRequest["pwn"]> };
}

function defaultCapabilities(stableAcrossRestart: boolean): { readonly kinds: readonly ["pwn-session"]; readonly maxRequestBytes: number; readonly maxResponseBytes: number; readonly stableAcrossRestart: boolean } {
  return { kinds: ["pwn-session"], maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576, stableAcrossRestart };
}
