import { canonicalJson, sha256 } from "../domain/utils.js";
import { externalResourceBindingTransactionId } from "../recovery/external-resource-registry.js";
import {
  HttpBrowserRuntimeBroker,
  BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
  type BrowserRuntimeCreateRequest,
  type BrowserRuntimeHealthWireResponse,
  type BrowserRuntimeWireResource,
} from "./browser-runtime-broker.js";
import { HttpBrowserRuntimeContextPort } from "./browser-runtime-actions.js";
import type {
  BrowserVerifierContextHandle,
  BrowserVerifierContextRequest,
  BrowserVerifierFactory,
} from "./browser-session.js";

/** Options for a verifier factory backed by the versioned browser broker. */
export interface HttpBrowserVerifierFactoryOptions {
  readonly broker: HttpBrowserRuntimeBroker;
  readonly name?: string;
}

/**
 * Application-owned factory that turns a broker create/open response into a
 * verifier context port. The create key is derived from the immutable request,
 * so a retry after a process boundary returns the existing context instead of
 * starting a second browser.
 */
export class HttpBrowserVerifierFactory implements BrowserVerifierFactory {
  public readonly name: string;
  public readonly runtimeBroker: HttpBrowserRuntimeBroker;

  public constructor(options: HttpBrowserVerifierFactoryOptions) {
    this.runtimeBroker = options.broker;
    this.name = options.name?.trim() || `${options.broker.name}-verifier`;
    if (!this.name) throw new Error("HTTP browser verifier factory requires a stable name");
  }

  /** Probe the broker before registering Browser replay capabilities. */
  public async probe(signal?: AbortSignal): Promise<BrowserRuntimeHealthWireResponse> {
    return await this.runtimeBroker.health(signal);
  }

  public async createContext(request: BrowserVerifierContextRequest, signal?: AbortSignal): Promise<BrowserVerifierContextHandle> {
    if (!request.verificationKey?.trim()) throw new Error("HTTP browser verifier requires a stable verification key");
    const scopeHash = browserScopeHash(request);
    const createRequest: BrowserRuntimeCreateRequest = {
      runId: request.runId,
      generation: request.generation,
      ownerLane: "verifier",
      target: request.target,
      policyHash: request.policyHash,
      ...(request.recipeHash ? { recipeHash: request.recipeHash } : {}),
      verificationKey: request.verificationKey,
      allowedHosts: [...request.allowedHosts],
      allowedPorts: [...request.allowedPorts],
      maxResponseBytes: request.maxResponseBytes,
      scopeHash,
    };
    const idempotencyKey = sha256(canonicalJson(createRequest));
    const created = await this.runtimeBroker.create(createRequest, idempotencyKey, signal);
    if (created.state === "UNKNOWN" || !created.sessionId || !created.externalId || !created.initialUrl || !created.stateHash) {
      throw new Error(created.summary ?? "Browser broker did not confirm a created context");
    }
    assertSameScope(request, created.initialUrl);
    const resourceId = `session:${created.sessionId}`;
    const bindingTxnId = externalResourceBindingTransactionId({
      id: resourceId,
      kind: "browser-context",
      runId: request.runId,
      generation: request.generation,
      ownerLane: "verifier",
      requestKey: request.verificationKey,
      policyHash: request.policyHash,
      ...(request.recipeHash ? { recipeHash: request.recipeHash } : {}),
      scopeHash,
    });
    const resource: BrowserRuntimeWireResource = {
      schemaVersion: BROWSER_RUNTIME_WIRE_SCHEMA_VERSION,
      id: resourceId,
      kind: "browser-context",
      runId: request.runId,
      generation: request.generation,
      ownerLane: "verifier",
      externalId: created.externalId,
      ...(request.verificationKey ? { requestKey: request.verificationKey } : {}),
      policyHash: request.policyHash,
      ...(request.recipeHash ? { recipeHash: request.recipeHash } : {}),
      scopeHash,
      bindingTxnId,
    };
    const transport = this.runtimeBroker.transport;
    const context = new HttpBrowserRuntimeContextPort({
      baseUrl: this.runtimeBroker.endpoint,
      resource,
      initialUrl: created.initialUrl,
      initialStateHash: created.stateHash,
      fetchImpl: transport.fetchImpl,
      timeoutMs: transport.timeoutMs,
      headers: transport.headers,
      heartbeat: async (heartbeatSignal) => await this.runtimeBroker.heartbeatWireResource(resource, heartbeatSignal),
      bind: async ({ bindingTxnId: requestedBindingTxnId, controlSessionId }, bindSignal) => {
        if (controlSessionId !== created.sessionId || requestedBindingTxnId !== bindingTxnId) throw new Error("Browser broker binding does not match the created context");
        const response = await this.runtimeBroker.bindWireResource(resource, bindSignal);
        if (response.state !== "BOUND") throw new Error(response.summary ?? "Browser broker did not confirm the binding marker");
      },
      release: async (reason, releaseSignal) => await this.runtimeBroker.releaseWireResource(resource, reason, releaseSignal),
    });
    return { context, externalId: created.externalId, sessionId: created.sessionId };
  }
}

function browserScopeHash(request: BrowserVerifierContextRequest): string {
  const target = new URL(request.target);
  return sha256(canonicalJson({ target: target.origin, allowedHosts: request.allowedHosts, allowedPorts: request.allowedPorts }));
}

function assertSameScope(request: BrowserVerifierContextRequest, initialUrl: string): void {
  const target = new URL(request.target);
  const initial = new URL(initialUrl);
  if (initial.origin !== target.origin) throw new Error("Browser broker create response crossed the verifier origin");
  const hosts = request.allowedHosts.map((host) => host.toLowerCase());
  if (hosts.length > 0 && !hosts.includes(initial.hostname.toLowerCase())) throw new Error("Browser broker create response is outside the verifier host scope");
  const port = Number(initial.port || (initial.protocol === "https:" ? 443 : 80));
  if (request.allowedPorts.length > 0 && !request.allowedPorts.includes(port)) throw new Error("Browser broker create response is outside the verifier port scope");
}
