import type { ProofBladeConfig } from "../config.js";
import { tryCreateConfiguredBrowserVerifierFactory } from "../web/browser-verifier-composition.js";
import { tryCreateConfiguredSessionRuntimeBrokers } from "./session-runtime-composition.js";

export type RuntimePreflightStatus = "READY" | "UNAVAILABLE" | "NOT_CONFIGURED";

/** A redacted, operator-facing result for one configured runtime kind. */
export interface RuntimePreflightItem {
  readonly configured: boolean;
  readonly tokenAvailable: boolean;
  readonly status: RuntimePreflightStatus;
  readonly stableAcrossRestart?: boolean;
  readonly name?: string;
  readonly reason?: string;
}

/** Read-only startup report for all brokered runtimes. */
export interface RuntimePreflightReport {
  readonly ready: boolean;
  readonly browser: RuntimePreflightItem;
  readonly sessions: {
    readonly "http-session": RuntimePreflightItem;
    readonly "pwn-session": RuntimePreflightItem;
  };
}

/**
 * Probe configured Browser, HTTP-session, and Pwn-session brokers without
 * creating a resource. A configured but unavailable broker makes the report
 * fail-closed; an omitted broker remains an explicit optional local mode.
 */
export async function preflightConfiguredRuntimes(
  config: Pick<ProofBladeConfig, "runtime">,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<RuntimePreflightReport> {
  const browserConfig = config.runtime.browserBroker;
  const browserTokenEnv = browserConfig?.tokenEnv ?? "PROOFBLADE_BROWSER_RUNTIME_TOKEN";
  const browserTokenAvailable = browserConfig === undefined || Boolean(environment[browserTokenEnv]);
  let browser: RuntimePreflightItem;
  if (browserConfig === undefined) {
    browser = {
      configured: false,
      tokenAvailable: true,
      status: "NOT_CONFIGURED",
      reason: "no durable browser broker configured; local browser runtime remains optional",
    };
  } else if (!browserTokenAvailable) {
    browser = {
      configured: true,
      tokenAvailable: false,
      status: "UNAVAILABLE",
      reason: `missing ${browserTokenEnv}`,
    };
  } else {
    const factory = tryCreateConfiguredBrowserVerifierFactory(config, environment);
    if (!factory?.probe) {
      browser = {
        configured: true,
        tokenAvailable: true,
        status: "UNAVAILABLE",
        reason: "configured browser broker does not expose a health probe",
      };
    } else {
      try {
        const result = await factory.probe(signal);
        const stableAcrossRestart = result.capabilities?.stableAcrossRestart;
        const ready = result.status === "READY" && stableAcrossRestart === true;
        browser = {
          configured: true,
          tokenAvailable: true,
          status: ready ? "READY" : "UNAVAILABLE",
          stableAcrossRestart,
          name: factory.name,
          reason: ready ? undefined : "browser broker is not READY with restart-stable capabilities",
        };
      } catch {
        browser = {
          configured: true,
          tokenAvailable: true,
          status: "UNAVAILABLE",
          name: factory.name,
          reason: "browser broker health probe failed",
        };
      }
    }
  }

  const sessionConfig = config.runtime.sessionBroker;
  const sessionTokenEnv = sessionConfig?.tokenEnv ?? "PROOFBLADE_SESSION_RUNTIME_TOKEN";
  const sessionTokenAvailable = sessionConfig === undefined || Boolean(environment[sessionTokenEnv]);
  const sessionComposition = tryCreateConfiguredSessionRuntimeBrokers(config, environment);
  const sessionHealth = new Map<string, { ready: boolean; stableAcrossRestart?: boolean; name?: string }>();
  if (sessionConfig !== undefined && sessionTokenAvailable) {
    await Promise.all(sessionComposition.brokers.map(async (broker) => {
      try {
        const result = broker.health ? await broker.health(signal) : undefined;
        sessionHealth.set(broker.kind, {
          ready: result?.status === "READY"
            && result.capabilities.stableAcrossRestart
            && result.capabilities.kinds.includes(broker.kind),
          ...(result ? { stableAcrossRestart: result.capabilities.stableAcrossRestart } : {}),
          name: broker.name,
        });
      } catch {
        sessionHealth.set(broker.kind, { ready: false, name: broker.name });
      }
    }));
  }
  const sessionItem = (kind: "http-session" | "pwn-session"): RuntimePreflightItem => {
    if (sessionConfig === undefined) {
      return {
        configured: false,
        tokenAvailable: true,
        status: "NOT_CONFIGURED",
        reason: "no durable session broker configured; local runtime remains optional",
      };
    }
    if (!sessionTokenAvailable) {
      return {
        configured: true,
        tokenAvailable: false,
        status: "UNAVAILABLE",
        reason: `missing ${sessionTokenEnv}`,
      };
    }
    const health = sessionHealth.get(kind);
    return {
      configured: true,
      tokenAvailable: true,
      status: health?.ready === true ? "READY" : "UNAVAILABLE",
      ...(health?.stableAcrossRestart === undefined ? {} : { stableAcrossRestart: health.stableAcrossRestart }),
      ...(health?.name === undefined ? {} : { name: health.name }),
      ...(health?.ready === true ? {} : { reason: "session broker is not READY, restart-stable, and kind-complete" }),
    };
  };
  const sessions = { "http-session": sessionItem("http-session"), "pwn-session": sessionItem("pwn-session") } as const;
  return {
    ready: browser.status !== "UNAVAILABLE"
      && sessions["http-session"].status !== "UNAVAILABLE"
      && sessions["pwn-session"].status !== "UNAVAILABLE",
    browser,
    sessions,
  };
}
