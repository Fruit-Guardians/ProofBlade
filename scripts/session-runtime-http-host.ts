import { resolve } from "node:path";
import { DurableHttpSessionRuntimeHost } from "@proofblade/materials";

/**
 * Deployment host module for the durable HTTP session service. It intentionally
 * exposes only `http-session`; Pwn requires a separate supervisor host and is
 * not silently downgraded to an in-process implementation.
 */
export function createSessionRuntimeHost(): DurableHttpSessionRuntimeHost {
  const statePath = resolve(process.env.PROOFBLADE_HTTP_SESSION_STATE ?? ".proofblade/http-session-host.json");
  return new DurableHttpSessionRuntimeHost({
    statePath,
    ...(process.env.PROOFBLADE_SESSION_RUNTIME_STATE_KEY ? { stateKey: process.env.PROOFBLADE_SESSION_RUNTIME_STATE_KEY } : {}),
  });
}

export default createSessionRuntimeHost;
