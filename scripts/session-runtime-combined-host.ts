import { resolve } from "node:path";
import {
  DurableHttpSessionRuntimeHost,
  type SessionRuntimeActionService,
  type SessionRuntimeCreateRequest,
  type SessionRuntimeCreatedSession,
  type SessionRuntimeHost,
  type SessionRuntimeHostInspection,
  type SessionRuntimeHostPresence,
  type SessionRuntimeHealthCapabilities,
  type SessionRuntimeHealthStatus,
} from "@proofblade/materials";
import { createPwnSessionRuntimeHost } from "./session-runtime-pwn-host.ts";

/**
 * Deployment adapter that exposes the HTTP and Pwn hosts behind one durable
 * session-runtime service. Each request is dispatched by its immutable kind;
 * no host is allowed to handle the other kind's lifecycle or actions.
 */
export class CombinedSessionRuntimeHost implements SessionRuntimeHost {
  public readonly actions: SessionRuntimeActionService;

  public constructor(
    private readonly httpHost: SessionRuntimeHost,
    private readonly pwnHost: SessionRuntimeHost,
  ) {
    if (!httpHost || !pwnHost) throw new Error("Combined session runtime host requires HTTP and Pwn hosts");
    if (!httpHost.actions || typeof httpHost.actions.httpRequest !== "function") throw new Error("Combined session runtime host requires an HTTP action surface");
    if (!pwnHost.actions || typeof pwnHost.actions.pwnWrite !== "function" || typeof pwnHost.actions.pwnRead !== "function" || typeof pwnHost.actions.pwnSignal !== "function" || typeof pwnHost.actions.pwnClose !== "function") {
      throw new Error("Combined session runtime host requires a complete Pwn action surface");
    }
    this.actions = {
      pwnWrite: async (resource, data, options, signal) => await this.pwnHost.actions!.pwnWrite(resource, data, options, signal),
      pwnRead: async (resource, options, signal) => await this.pwnHost.actions!.pwnRead(resource, options, signal),
      pwnSignal: async (resource, signalName, signal) => await this.pwnHost.actions!.pwnSignal(resource, signalName, signal),
      pwnClose: async (resource, signal) => await this.pwnHost.actions!.pwnClose(resource, signal),
      httpRequest: async (resource, request, signal) => await this.httpHost.actions!.httpRequest(resource, request, signal),
    };
  }

  public async create(request: SessionRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<SessionRuntimeCreatedSession> {
    return await this.hostForRequest(request).create(request, idempotencyKey, signal);
  }

  public async inspect(externalId: string, request: SessionRuntimeCreateRequest, signal?: AbortSignal): Promise<SessionRuntimeHostInspection> {
    return await this.hostForRequest(request).inspect(externalId, request, signal);
  }

  public async adopt(externalId: string, request: SessionRuntimeCreateRequest, signal?: AbortSignal): Promise<boolean> {
    return await this.hostForRequest(request).adopt(externalId, request, signal);
  }

  public async release(externalId: string, request: SessionRuntimeCreateRequest, reason: string, signal?: AbortSignal): Promise<boolean> {
    return await this.hostForRequest(request).release(externalId, request, reason, signal);
  }

  public async inspectByIdempotency(request: SessionRuntimeCreateRequest, idempotencyKey: string, signal?: AbortSignal): Promise<{ status: SessionRuntimeHostPresence; created?: SessionRuntimeCreatedSession }> {
    const host = this.hostForRequest(request);
    return host.inspectByIdempotency
      ? await host.inspectByIdempotency(request, idempotencyKey, signal)
      : { status: "UNKNOWN" };
  }

  public async heartbeat(externalId: string, signal?: AbortSignal, request?: SessionRuntimeCreateRequest): Promise<void> {
    if (!request) throw new Error("Combined session runtime heartbeat requires the immutable session kind");
    const host = this.hostForRequest(request);
    if (!host.heartbeat) throw new Error(`Combined session runtime host does not expose heartbeat for ${request.kind}`);
    await host.heartbeat(externalId, signal, request);
  }

  public async health(signal?: AbortSignal): Promise<{ status: SessionRuntimeHealthStatus; capabilities: SessionRuntimeHealthCapabilities; summary?: string }> {
    const [http, pwn] = await Promise.all([
      readHealth(this.httpHost, signal, "http-session"),
      readHealth(this.pwnHost, signal, "pwn-session"),
    ]);
    const complete = http.status === "READY"
      && pwn.status === "READY"
      && http.capabilities.stableAcrossRestart
      && pwn.capabilities.stableAcrossRestart
      && http.capabilities.kinds.includes("http-session")
      && pwn.capabilities.kinds.includes("pwn-session");
    const status: SessionRuntimeHealthStatus = complete
      ? "READY"
      : [http.status, pwn.status].includes("UNAVAILABLE") ? "UNAVAILABLE" : "DEGRADED";
    return {
      status,
      capabilities: {
        kinds: complete ? ["http-session", "pwn-session"] : [],
        maxRequestBytes: Math.min(http.capabilities.maxRequestBytes, pwn.capabilities.maxRequestBytes),
        maxResponseBytes: Math.min(http.capabilities.maxResponseBytes, pwn.capabilities.maxResponseBytes),
        stableAcrossRestart: complete,
      },
      summary: complete
        ? "combined HTTP/Pwn session runtime is restart-stable"
        : `combined session runtime is not ready (http=${http.status}, pwn=${pwn.status})`,
    };
  }

  private hostForRequest(request: SessionRuntimeCreateRequest): SessionRuntimeHost {
    return request.kind === "http-session" ? this.httpHost : this.pwnHost;
  }
}

/** Build the reference combined host for one session-runtime service. */
export async function createSessionRuntimeHost(): Promise<SessionRuntimeHost> {
  const httpStatePath = resolve(process.env.PROOFBLADE_HTTP_SESSION_STATE ?? ".proofblade/http-session-host.json");
  const httpHost = new DurableHttpSessionRuntimeHost({
    statePath: httpStatePath,
    ...(process.env.PROOFBLADE_SESSION_RUNTIME_STATE_KEY ? { stateKey: process.env.PROOFBLADE_SESSION_RUNTIME_STATE_KEY } : {}),
  });
  const supervisorModule = process.env.PROOFBLADE_PWN_SUPERVISOR_MODULE?.trim();
  if (!supervisorModule) throw new Error("Set PROOFBLADE_PWN_SUPERVISOR_MODULE for the combined HTTP/Pwn session host");
  const pwnHost = await createPwnSessionRuntimeHost(supervisorModule);
  return new CombinedSessionRuntimeHost(httpHost, pwnHost);
}

export default createSessionRuntimeHost;

async function readHealth(host: SessionRuntimeHost, signal: AbortSignal | undefined, kind: "http-session" | "pwn-session"): Promise<{ status: SessionRuntimeHealthStatus; capabilities: SessionRuntimeHealthCapabilities }> {
  if (!host.health) return { status: "DEGRADED", capabilities: defaultCapabilities(kind) };
  try {
    return await host.health(signal);
  } catch {
    return { status: "UNAVAILABLE", capabilities: defaultCapabilities(kind) };
  }
}

function defaultCapabilities(kind: "http-session" | "pwn-session"): SessionRuntimeHealthCapabilities {
  return { kinds: [kind], maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576, stableAcrossRestart: false };
}

if (process.argv[1] && process.argv[1].endsWith("session-runtime-combined-host.ts")) {
  void createSessionRuntimeHost()
    .then(async (host) => console.log(JSON.stringify({ host: "combined-session-runtime", health: await host.health?.() })))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
}
