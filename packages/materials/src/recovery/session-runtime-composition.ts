import type { ProofBladeConfig } from "../config.js";
import type { ContainerRef } from "../container/contracts.js";
import { sha256 } from "../domain/utils.js";
import { HttpSessionRuntimeBroker } from "./session-runtime-wire.js";
import type { ExternalResourceRecord } from "./external-resource-registry.js";
import type { SessionRuntimeBinding, SessionRuntimeCreateBroker } from "./session-resource-adapter.js";

export interface SessionRuntimePreflight {
  readonly brokers: readonly SessionRuntimeCreateBroker[];
  readonly unavailableKinds: readonly SessionRuntimeCreateBroker["kind"][];
}

export interface SessionRuntimeBrokerComposition {
  readonly configured: boolean;
  readonly tokenAvailable: boolean;
  readonly brokers: readonly SessionRuntimeCreateBroker[];
}

/**
 * Compose the two session broker clients used by a production entrypoint.
 *
 * A configured broker is authoritative: the caller can inspect `configured`
 * and `tokenAvailable` and fail closed instead of silently switching a remote
 * session to a process-local implementation. Without configuration no broker
 * is created, preserving the explicit local Docker/HTTP development path.
 */
export function tryCreateConfiguredSessionRuntimeBrokers(
  config: Pick<ProofBladeConfig, "runtime">,
  environment: NodeJS.ProcessEnv = process.env,
): SessionRuntimeBrokerComposition {
  const brokerConfig = config.runtime.sessionBroker;
  if (!brokerConfig) return { configured: false, tokenAvailable: true, brokers: [] };
  const tokenEnv = brokerConfig.tokenEnv ?? "PROOFBLADE_SESSION_RUNTIME_TOKEN";
  const token = environment[tokenEnv];
  if (!token) return { configured: true, tokenAvailable: false, brokers: [] };
  const headers = { authorization: `Bearer ${token}` };
  let pwnBroker: HttpSessionRuntimeBroker;
  let httpBroker: HttpSessionRuntimeBroker;
  pwnBroker = new HttpSessionRuntimeBroker({
    baseUrl: brokerConfig.baseUrl,
    kind: "pwn-session",
    ...(brokerConfig.name ? { name: `${brokerConfig.name}:pwn` } : {}),
    ...(brokerConfig.timeoutMs === undefined ? {} : { timeoutMs: brokerConfig.timeoutMs }),
    headers,
    connectBinding: async (record, _signal) => createPwnBinding(pwnBroker, record),
  });
  httpBroker = new HttpSessionRuntimeBroker({
    baseUrl: brokerConfig.baseUrl,
    kind: "http-session",
    ...(brokerConfig.name ? { name: `${brokerConfig.name}:http` } : {}),
    ...(brokerConfig.timeoutMs === undefined ? {} : { timeoutMs: brokerConfig.timeoutMs }),
    headers,
    connectBinding: async (record, _signal) => createHttpBinding(httpBroker, record),
  });
  return { configured: true, tokenAvailable: true, brokers: [pwnBroker, httpBroker] };
}

/**
 * Probe configured brokers once before a Coding lane is exposed to the model.
 * Brokers without a health method remain usable for injected test/development
 * implementations; the production HTTP broker always exposes the probe.
 * A degraded, unstable, or kind-mismatched service is removed from the live
 * composition and reported as unavailable so callers cannot fall back to a
 * local implementation silently.
 */
export async function preflightSessionRuntimeBrokers(
  brokers: readonly SessionRuntimeCreateBroker[],
  signal?: AbortSignal,
): Promise<SessionRuntimePreflight> {
  const outcomes = await Promise.all(brokers.map(async (broker) => {
    if (!broker.health) return { broker, available: true };
    try {
      const result = await broker.health(signal);
      return {
        broker,
        available: result.status === "READY"
          && result.capabilities.stableAcrossRestart
          && result.capabilities.kinds.includes(broker.kind),
      };
    } catch {
      return { broker, available: false };
    }
  }));
  return {
    brokers: outcomes.filter((outcome) => outcome.available).map((outcome) => outcome.broker),
    unavailableKinds: outcomes.filter((outcome) => !outcome.available).map((outcome) => outcome.broker.kind),
  };
}

function createPwnBinding(broker: HttpSessionRuntimeBroker, record: ExternalResourceRecord): SessionRuntimeBinding {
  if (!record.externalId) throw new Error("Pwn session broker adoption requires an opaque externalId");
  const sessionId = controlSessionId(record);
  const ref = syntheticPwnRef(record);
  const handle = { sessionId, externalId: record.externalId, ref };
  return { kind: "pwn-session", externalId: record.externalId, handle, runtime: broker.createPwnRuntime(handle, record) };
}

function createHttpBinding(broker: HttpSessionRuntimeBroker, record: ExternalResourceRecord): SessionRuntimeBinding {
  if (!record.externalId) throw new Error("HTTP session broker adoption requires an opaque externalId");
  return { kind: "http-session", externalId: record.externalId, fetchImpl: broker.createHttpFetch(record) };
}

function controlSessionId(record: ExternalResourceRecord): string {
  if (record.controlSessionId) return record.controlSessionId;
  if (record.id.startsWith("session:") && record.id.length > "session:".length) return record.id.slice("session:".length);
  throw new Error(`Session resource ${record.id} has no control session id`);
}

function syntheticPwnRef(record: ExternalResourceRecord): ContainerRef {
  const identity = sha256(`${record.runId}:${record.generation}:${record.externalId}`);
  return {
    runId: record.runId,
    generation: record.generation,
    containerId: `session-runtime-${identity.slice(0, 24)}`,
    name: `session-runtime-${identity.slice(24, 40)}`,
    profile: "pwn",
    image: "proofblade/session-runtime",
    imageDigest: `sha256:${sha256("proofblade/session-runtime")}`,
    workspaceHostPath: process.cwd(),
    workspaceContainerPath: "/workspace",
    networkPolicy: "target-only",
  };
}
