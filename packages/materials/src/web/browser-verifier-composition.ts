import type { ProofBladeConfig } from "../config.js";
import { HttpBrowserRuntimeContextPort } from "./browser-runtime-actions.js";
import { browserRuntimeWireResource, HttpBrowserRuntimeBroker } from "./browser-runtime-broker.js";
import { HttpBrowserVerifierFactory } from "./browser-runtime-factory.js";
import { tryCreatePlaywrightBrowserVerifierFactory } from "./playwright-browser-verifier.js";
import type { BrowserVerifierFactory } from "./browser-session.js";

/**
 * Compose the Browser verifier for an application entrypoint.
 *
 * A configured broker is authoritative: if its token is unavailable this
 * returns undefined rather than silently falling back to a process-local
 * Playwright context. Without broker configuration, the local adapter remains
 * available for development and explicit smoke tests.
 */
export function tryCreateConfiguredBrowserVerifierFactory(
  config: Pick<ProofBladeConfig, "runtime">,
  environment: NodeJS.ProcessEnv = process.env,
): BrowserVerifierFactory | undefined {
  const brokerConfig = config.runtime.browserBroker;
  if (!brokerConfig) return tryCreatePlaywrightBrowserVerifierFactory();
  // The standalone service always authenticates. Keep an ergonomic default
  // while allowing deployments to choose a different environment variable.
  const tokenEnv = brokerConfig.tokenEnv ?? "PROOFBLADE_BROWSER_RUNTIME_TOKEN";
  const token = environment[tokenEnv];
  if (!token) return undefined;
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  let broker: HttpBrowserRuntimeBroker;
  broker = new HttpBrowserRuntimeBroker({
    baseUrl: brokerConfig.baseUrl,
    ...(brokerConfig.name ? { name: brokerConfig.name } : {}),
    ...(brokerConfig.timeoutMs === undefined ? {} : { timeoutMs: brokerConfig.timeoutMs }),
    ...(headers ? { headers } : {}),
    connectContext: async ({ record }) => {
      if (!record.externalId) throw new Error("Browser broker adoption requires an opaque external handle");
      const transport = broker.transport;
      const resource = browserRuntimeWireResource(record);
      return new HttpBrowserRuntimeContextPort({
        baseUrl: broker.endpoint,
        resource,
        fetchImpl: transport.fetchImpl,
        timeoutMs: transport.timeoutMs,
        headers: transport.headers,
        release: async (reason, signal) => await broker.release(record, reason, signal),
      });
    },
  });
  return new HttpBrowserVerifierFactory({ broker });
}
