import type { ControlStore } from "../control/control-store.js";
import type { BrowserActionKind, BrowserSelector, Lane } from "../domain/types.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { ExperimentGate } from "../competition/experiment-gate.js";
import type {
  ExternalResourceInspection,
  ExternalResourceRecord,
  ExternalResourceRegistry,
} from "../recovery/external-resource-registry.js";
import { DeterministicObserver } from "../knowledge/observer.js";
import { BindingTransactionCoordinator } from "../recovery/binding-transaction-coordinator.js";

export interface BrowserContextPort {
  goto(url: string, signal?: AbortSignal): Promise<BrowserDriverResponse>;
  click?(selector: BrowserSelector, signal?: AbortSignal): Promise<BrowserDriverResponse>;
  fill?(selector: BrowserSelector, value: string, signal?: AbortSignal): Promise<BrowserDriverResponse>;
  submit?(selector: BrowserSelector, signal?: AbortSignal): Promise<BrowserDriverResponse>;
  wait?(milliseconds: number, signal?: AbortSignal): Promise<BrowserDriverResponse>;
  /** Current page URL, used to enforce same-origin scope after every action. */
  currentUrl(): Promise<string>;
  storageState(): Promise<unknown>;
  /** Optional redacted state hash for remote contexts that cannot expose storage values. */
  storageStateHash?(): Promise<string>;
  /** Persist the exact Control Store handoff marker in a remote runtime. */
  bind?(binding: { readonly bindingTxnId: string; readonly controlSessionId: string }, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserDriverResponse {
  status?: number;
  content: string;
}

/** Immutable input handed to a trusted browser verifier runtime. */
export interface BrowserVerifierContextRequest {
  readonly runId: string;
  readonly generation: number;
  readonly target: string;
  readonly policyHash: string;
  /** Stable hash of the immutable browser replay recipe, when one exists. */
  readonly recipeHash?: string;
  /** Stable verification request key used to bind a recoverable context. */
  readonly verificationKey?: string;
  readonly allowedHosts: readonly string[];
  readonly allowedPorts: readonly number[];
  readonly maxResponseBytes: number;
}

/**
 * Opaque handle returned by a browser runtime that can survive the creating
 * Node process. The handle is persisted in the external-resource ledger, but
 * the driver/context object itself never crosses the model boundary.
 */
export interface BrowserVerifierContextHandle {
  readonly context: BrowserContextPort;
  readonly externalId: string;
  /** Broker-generated session id used as the durable local session id. */
  readonly sessionId?: string;
}

/** Current-process binding returned when a broker adopts an existing context. */
export interface BrowserRuntimeBinding {
  readonly kind: "browser-context";
  readonly externalId: string;
  readonly context: BrowserContextPort;
}

export interface BrowserRuntimeAdoptResult {
  state: "CONFIRMED" | "UNKNOWN";
  summary?: string;
  /** Required for a recovered verifier to continue without creating a context. */
  binding?: BrowserRuntimeBinding;
}

/**
 * Broker boundary for browser runtimes that support cross-process recovery.
 * Implementations must validate every immutable field on the durable record
 * before returning MATCH; a Playwright in-process context is not a broker.
 */
export interface BrowserRuntimeBroker {
  readonly name: string;
  inspect(record: ExternalResourceRecord, signal?: AbortSignal): Promise<ExternalResourceInspection>;
  adopt(record: ExternalResourceRecord, inspection: ExternalResourceInspection, signal?: AbortSignal): Promise<BrowserRuntimeAdoptResult>;
  release(record: ExternalResourceRecord, reason: string, signal?: AbortSignal): Promise<{ released: boolean; summary?: string }>;
  /** Persist the exact Control Store handoff marker when the broker supports it. */
  bind?(record: ExternalResourceRecord, signal?: AbortSignal): Promise<{ state: "BOUND" | "UNKNOWN"; externalId?: string; summary?: string }>;
}

/**
 * Application-owned browser runtime boundary.
 *
 * Implementations may be backed by Playwright, a private browser service, or
 * another audited driver. They must return a fresh, unopened context and must
 * enforce the limits in the request before returning control to the verifier.
 * Model-facing MCP/browser tools must never implement this interface.
 */
export interface BrowserVerifierFactory {
  readonly name: string;
  /** Present only when the runtime owns a durable cross-process broker. */
  readonly runtimeBroker?: BrowserRuntimeBroker;
  /** Optional startup probe; non-READY runtimes are not registered for replay. */
  readonly probe?: (signal?: AbortSignal) => Promise<BrowserVerifierFactoryProbe>;
  createContext(request: BrowserVerifierContextRequest, signal?: AbortSignal): Promise<BrowserContextPort | BrowserVerifierContextHandle>;
}

export interface BrowserVerifierFactoryProbe {
  readonly status: "READY" | "DEGRADED" | "UNAVAILABLE";
  readonly summary?: string;
  readonly capabilities?: { readonly stableAcrossRestart: boolean };
}

/** Return a factory only when its optional runtime probe confirms readiness. */
export async function probeBrowserVerifierFactory(factory: BrowserVerifierFactory | undefined, signal?: AbortSignal): Promise<BrowserVerifierFactory | undefined> {
  if (!factory?.probe) return factory;
  try {
    const result = await factory.probe(signal);
    if (result.status !== "READY") return undefined;
    if (factory.runtimeBroker && result.capabilities?.stableAcrossRestart !== true) return undefined;
    return factory;
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
    return undefined;
  }
}

/** Bounded response/state record for a browser interaction. */
export interface BrowserExchangeArtifact {
  schemaVersion: 1;
  kind: "browser_exchange";
  request: {
    action: BrowserActionKind;
    url?: string;
    selector?: BrowserSelector;
    value?: string;
    milliseconds?: number;
  };
  response: { status?: number; content: string };
  stateHash: string;
}

export interface BrowserActionResponse {
  status?: number;
  content: string;
  artifactId: string;
  stateHash: string;
  observationId: string;
  evidenceId: string;
  candidateKinds: string[];
}

export type BrowserNavigationResponse = BrowserActionResponse;

interface BrowserContextResourceBinding {
  externalId: string;
  policyHash?: string;
  recipeHash?: string;
  scopeHash?: string;
  requestKey?: string;
}

/** Durable adapter around a persistent Playwright-compatible browser context. */
export class BrowserContextBackend {
  public readonly sessionId: string;
  private closed = false;
  private interactionCount = 0;
  private readonly base: URL;
  private readonly observer: DeterministicObserver;
  private generation?: number;
  private initialStorageEmpty = false;
  private opened = false;

  public constructor(
    private readonly runId: string,
    private readonly ownerLane: Lane,
    private readonly startUrl: string,
    private readonly driver: BrowserContextPort,
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
    private readonly experimentGate?: ExperimentGate,
    private readonly allowedHosts?: readonly string[],
    private readonly allowedPorts?: readonly number[],
    private readonly maxResponseBytes = 1_048_576,
    private readonly externalResources?: ExternalResourceRegistry,
    private readonly resourceBinding?: BrowserContextResourceBinding,
    sessionId?: string,
  ) {
    this.sessionId = sessionId ?? id("BROWSER");
    this.base = new URL(startUrl);
    this.observer = new DeterministicObserver(controlStore);
    if (!/^https?:$/.test(this.base.protocol)) throw new Error("Browser session requires an http(s) start URL");
    assertBrowserScope(this.base, allowedHosts, allowedPorts);
    if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 8 * 1_048_576) throw new Error("Browser session response limit must be between 1 and 8388608 bytes");
  }

  public async open(): Promise<void> {
    if (this.opened) throw new Error(`Browser session is already open: ${this.sessionId}`);
    if (this.closed) throw new Error(`Browser session is closed: ${this.sessionId}`);
    const snapshot = await this.controlStore.snapshot(this.runId);
    this.generation = snapshot.generation;
    const resourceId = `session:${this.sessionId}`;
    const externalId = this.resourceBinding?.externalId ?? this.sessionId;
    const coordinator = this.externalResources ? new BindingTransactionCoordinator(this.controlStore, this.externalResources) : undefined;
    const resourceInput = {
      id: resourceId,
      kind: "browser-context",
      runId: this.runId,
      generation: snapshot.generation,
      ownerLane: this.ownerLane,
      ...(this.resourceBinding ?? {}),
    } as const;
    let controlSessionCommitted = false;
    try {
      // Persist STARTED before writing the Control Store session event. If the
      // process exits between these writes, recovery sees the exact opaque
      // handle and can release it instead of treating the resource as a
      // harmless proposal or adopting a session with no durable owner.
      const prepared = coordinator ? await coordinator.prepare({ sessionId: this.sessionId, resource: { ...resourceInput, externalId } }) : undefined;
      const started = prepared ?? await this.externalResources?.registerStarted({ ...resourceInput, externalId });
      const storageState = await this.driver.storageState();
      this.initialStorageEmpty = isEmptyStorageState(storageState);
      const stateHash = this.driver.storageStateHash ? await this.driver.storageStateHash() : sha256(canonicalJson(storageState));
      const openedSession = { id: this.sessionId, runId: this.runId, kind: "browser" as const, ownerLane: this.ownerLane, generation: snapshot.generation, endpoint: this.base.origin, stateHash, externalId, ...(started?.bindingTxnId ? { bindingTxnId: started.bindingTxnId } : {}), ...(prepared ? { bindingIdentityHash: prepared.identityHash } : {}) };
      if (coordinator && prepared) await coordinator.commitControl(prepared, openedSession);
      else await this.controlStore.dispatch(this.runId, { type: "session_opened", session: openedSession, lane: this.ownerLane });
      controlSessionCommitted = true;
      if (this.driver.bind && started?.bindingTxnId) {
        await this.driver.bind({ bindingTxnId: started.bindingTxnId, controlSessionId: this.sessionId });
      }
      if (coordinator && prepared) await coordinator.finalize(prepared);
      else await this.externalResources?.markControlBound(resourceId, this.sessionId, started?.bindingTxnId);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      if (!controlSessionCommitted) {
        let closed = false;
        try {
          await this.driver.close();
          closed = true;
        } catch {
          // Keep the resource UNKNOWN when the external driver cannot be closed.
        }
        if (closed) await this.externalResources?.markReleased(resourceId, "browser session owner write failed; driver closed").catch(() => undefined);
        else await this.externalResources?.markUnknown(resourceId, summary).catch(() => undefined);
      } else {
        // The owner event is durable; a marker failure is recoverable and must
        // remain UNKNOWN so recovery can inspect/adopt the exact handle.
        await this.externalResources?.markUnknown(resourceId, summary).catch(() => undefined);
      }
      throw error;
    }
    this.opened = true;
  }

  /**
   * Bind an already-open browser context returned by a durable runtime broker.
   * No `session_opened` event is emitted: the existing SessionRecord and
   * external-resource record are the source of truth for this process.
   */
  public async adoptExisting(): Promise<void> {
    if (this.opened) throw new Error(`Browser session is already open: ${this.sessionId}`);
    if (this.closed) throw new Error(`Browser session is closed: ${this.sessionId}`);
    const snapshot = await this.controlStore.snapshot(this.runId);
    const record = snapshot.sessions[this.sessionId];
    if (!record || record.runId !== this.runId || record.kind !== "browser" || record.ownerLane !== "verifier" || record.status !== "OPEN") {
      throw new Error(`Browser session ${this.sessionId} is not an adoptable verifier session`);
    }
    if (record.generation !== snapshot.generation) throw new Error(`Browser session generation drift: ${this.sessionId}`);
    if (this.resourceBinding?.externalId !== undefined && record.externalId !== this.resourceBinding.externalId) {
      throw new Error(`Browser session ${this.sessionId} has a different opaque runtime handle`);
    }
    if (record.endpoint !== this.base.origin) throw new Error(`Browser session ${this.sessionId} endpoint does not match the verifier target`);
    this.generation = snapshot.generation;
    this.interactionCount = record.interactions;
    this.initialStorageEmpty = false;
    this.opened = true;
  }

  public async navigate(url = this.startUrl, signal?: AbortSignal): Promise<BrowserNavigationResponse> {
    const resolved = new URL(url, this.base);
    if (resolved.origin !== this.base.origin) throw new Error(`Browser session navigation crosses origin: ${resolved}`);
    assertBrowserScope(resolved, this.allowedHosts, this.allowedPorts);
    return await this.perform("navigate", { url: resolved.toString() }, (input) => this.driver.goto(input.url!, signal), signal, resolved.pathname);
  }

  public async click(selector: BrowserSelector, signal?: AbortSignal): Promise<BrowserActionResponse> {
    if (!this.driver.click) throw new Error("Browser verifier runtime does not support click actions");
    return await this.perform("click", { selector }, () => this.driver.click!(selector, signal), signal, "click");
  }

  public async fill(selector: BrowserSelector, value: string, signal?: AbortSignal): Promise<BrowserActionResponse> {
    if (!this.driver.fill) throw new Error("Browser verifier runtime does not support fill actions");
    return await this.perform("fill", { selector, value }, () => this.driver.fill!(selector, value, signal), signal, "fill");
  }

  public async submit(selector: BrowserSelector, signal?: AbortSignal): Promise<BrowserActionResponse> {
    if (!this.driver.submit) throw new Error("Browser verifier runtime does not support submit actions");
    return await this.perform("submit", { selector }, () => this.driver.submit!(selector, signal), signal, "submit");
  }

  public async wait(milliseconds: number, signal?: AbortSignal): Promise<BrowserActionResponse> {
    if (!this.driver.wait) throw new Error("Browser verifier runtime does not support wait actions");
    return await this.perform("wait", { milliseconds }, () => this.driver.wait!(milliseconds, signal), signal, "wait");
  }

  public get origin(): string {
    return this.base.origin;
  }

  /** Opaque runtime id used for replay Effect binding and diagnostics. */
  public get externalId(): string {
    return this.resourceBinding?.externalId ?? this.sessionId;
  }

  /** A verifier clean context must have no preloaded browser storage and no navigation yet. */
  public isPristine(): boolean {
    return !this.closed && this.interactionCount === 0 && this.initialStorageEmpty;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.driver.close();
    } finally {
      const snapshot = await this.controlStore.snapshot(this.runId);
      if (snapshot.sessions[this.sessionId] && !["CLOSED", "SUPERSEDED"].includes(snapshot.sessions[this.sessionId]!.status)) {
        await this.controlStore.dispatch(this.runId, { type: "session_closed", sessionId: this.sessionId, reason: "browser-context-closed", exitCode: 0, lane: this.ownerLane });
      }
      await this.externalResources?.markReleased(`session:${this.sessionId}`, "browser-context-closed").catch(() => undefined);
    }
  }

  private async perform(
    action: BrowserActionKind,
    input: Omit<BrowserExchangeArtifact["request"], "action">,
    execute: (input: Omit<BrowserExchangeArtifact["request"], "action">) => Promise<BrowserDriverResponse>,
    signal: AbortSignal | undefined,
    label: string,
  ): Promise<BrowserActionResponse> {
    if (this.closed) throw new Error(`Browser session is closed: ${this.sessionId}`);
    const snapshot = await this.controlStore.snapshot(this.runId);
    const record = snapshot.sessions[this.sessionId];
    if (!record || record.status !== "OPEN") throw new Error(`Browser session is not OPEN: ${this.sessionId}`);
    if (record.generation !== this.generation || snapshot.generation !== this.generation) throw new Error(`Browser session generation drift: ${this.sessionId}`);
    const gateInput = { action, ...input };
    await this.experimentGate?.assertAllowed({ runId: this.runId, action: `browser_${action}`, input: gateInput });
    const result = await execute(input);
    const currentUrl = new URL(await this.driver.currentUrl());
    if (currentUrl.origin !== this.base.origin) throw new Error(`Browser action crossed origin: ${currentUrl}`);
    assertBrowserScope(currentUrl, this.allowedHosts, this.allowedPorts);
    const stateHash = this.driver.storageStateHash ? await this.driver.storageStateHash() : sha256(canonicalJson(await this.driver.storageState()));
    const content = result.content.slice(0, this.maxResponseBytes);
    const exchange: BrowserExchangeArtifact = { schemaVersion: 1, kind: "browser_exchange", request: { action, ...input }, response: { ...(result.status === undefined ? {} : { status: result.status }), content }, stateHash };
    this.interactionCount += 1;
    const artifact = await this.artifactStore.putText(this.runId, JSON.stringify(exchange), { filename: `browser-${this.sessionId}-${String(this.interactionCount).padStart(4, "0")}.exchange.json`, mime: "application/json", sensitivity: "public", semantic: { name: `Browser ${label} response`, summary: `Replayable browser ${action} response${result.status ? ` with status ${result.status}` : ""}.`, tags: ["web", "browser", "exchange", action], role: "supporting", relatedIds: [], annotatedBy: "harness" } });
    const observed = await this.observer.observe(this.runId, {
      operation: `browser_${action}`,
      artifactId: artifact.id,
      generation: snapshot.generation,
      result: { stdout: content, stderr: "", exitCode: result.status !== undefined && result.status >= 400 ? result.status : 0, durationMs: 0 },
    });
    await this.controlStore.dispatch(this.runId, { type: "session_interacted", sessionId: this.sessionId, transcriptArtifactId: artifact.id, stateHash, waitReason: "idle", lane: this.ownerLane });
    await this.experimentGate?.record({ runId: this.runId, action: `browser_${action}`, input: gateInput, outcome: result.status !== undefined && result.status >= 500 ? "failure" : "success", summary: `Browser ${action}${result.status ? ` returned ${result.status}` : " completed"}.` });
    return { ...result, content, artifactId: artifact.id, stateHash, observationId: observed.observationId, evidenceId: observed.evidenceId, candidateKinds: observed.candidateKinds };
  }
}

function assertBrowserScope(url: URL, allowedHosts?: readonly string[], allowedPorts?: readonly number[]): void {
  if (allowedHosts?.length && !allowedHosts.map((host) => host.toLowerCase()).includes(url.hostname.toLowerCase())) throw new Error(`Browser session host is outside task scope: ${url.hostname}`);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (allowedPorts?.length && !allowedPorts.includes(port)) throw new Error(`Browser session port is outside task scope: ${port}`);
}

/** Wrap a trusted runtime driver in the durable verifier-owned session adapter. */
export async function openVerifierBrowserSession(
  factory: BrowserVerifierFactory,
  request: BrowserVerifierContextRequest,
  controlStore: ControlStore,
  artifactStore: ArtifactStore,
  signal?: AbortSignal,
  externalResources?: ExternalResourceRegistry,
): Promise<BrowserContextBackend> {
  if (!factory.name.trim()) throw new Error("Browser verifier factory requires a stable name");
  if (!request.runId.trim() || !Number.isInteger(request.generation) || request.generation < 0) throw new Error("Browser verifier request has invalid run binding");
  if (!/^[a-f0-9]{64}$/i.test(request.policyHash)) throw new Error("Browser verifier request has an invalid policy hash");
  if (!Array.isArray(request.allowedHosts) || !Array.isArray(request.allowedPorts) || request.allowedHosts.some((host) => typeof host !== "string" || !host.trim()) || request.allowedPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) throw new Error("Browser verifier request has an invalid network scope");
  const target = new URL(request.target);
  if (!/^https?:$/.test(target.protocol)) throw new Error("Browser verifier request target must use http(s)");
  if (request.recipeHash !== undefined && !/^[a-f0-9]{64}$/i.test(request.recipeHash)) throw new Error("Browser verifier request has an invalid recipe hash");
  const created = await factory.createContext(request, signal);
  const { context: driver, externalId, sessionId } = normalizeBrowserContext(created);
  if (externalId !== undefined && (!factory.runtimeBroker || !isSafeOpaqueHandle(externalId))) throw new Error("Browser verifier runtime returned an opaque handle without a valid broker");
  if (sessionId !== undefined && !isSafeOpaqueHandle(sessionId)) throw new Error("Browser verifier runtime returned an invalid session id");
  const scopeHash = sha256(canonicalJson({ target: target.origin, allowedHosts: request.allowedHosts, allowedPorts: request.allowedPorts }));
  return new BrowserContextBackend(
    request.runId,
    "verifier",
    target.toString(),
    driver,
    controlStore,
    artifactStore,
    undefined,
    [...request.allowedHosts],
    [...request.allowedPorts],
    request.maxResponseBytes,
      externalResources,
    externalId === undefined ? undefined : { externalId, policyHash: request.policyHash, ...(request.recipeHash ? { recipeHash: request.recipeHash } : {}), ...(request.verificationKey ? { requestKey: request.verificationKey } : {}), scopeHash },
    sessionId,
  );
}

/**
 * Re-open a context adopted by a BrowserRuntimeBroker without creating a new
 * browser process or emitting a duplicate `session_opened` event.
 */
export async function adoptVerifierBrowserSession(
  binding: BrowserRuntimeBinding,
  request: BrowserVerifierContextRequest,
  sessionId: string,
  controlStore: ControlStore,
  artifactStore: ArtifactStore,
  externalResources?: ExternalResourceRegistry,
): Promise<BrowserContextBackend> {
  if (binding.kind !== "browser-context" || !isSafeOpaqueHandle(binding.externalId)) throw new Error("Browser verifier runtime returned an invalid adopted binding");
  const target = new URL(request.target);
  if (!/^https?:$/.test(target.protocol)) throw new Error("Browser verifier request target must use http(s)");
  if (!Array.isArray(request.allowedHosts) || !Array.isArray(request.allowedPorts)) throw new Error("Browser verifier request has an invalid network scope");
  if (!/^[a-f0-9]{64}$/i.test(request.policyHash)) throw new Error("Browser verifier request has an invalid policy hash");
  if (request.recipeHash !== undefined && !/^[a-f0-9]{64}$/i.test(request.recipeHash)) throw new Error("Browser verifier request has an invalid recipe hash");
  assertBrowserScope(target, request.allowedHosts, request.allowedPorts);
  const scopeHash = sha256(canonicalJson({ target: target.origin, allowedHosts: request.allowedHosts, allowedPorts: request.allowedPorts }));
  const session = new BrowserContextBackend(
    request.runId,
    "verifier",
    target.toString(),
    binding.context,
    controlStore,
    artifactStore,
    undefined,
    [...request.allowedHosts],
    [...request.allowedPorts],
    request.maxResponseBytes,
    externalResources,
    {
      externalId: binding.externalId,
      policyHash: request.policyHash,
      ...(request.recipeHash ? { recipeHash: request.recipeHash } : {}),
      ...(request.verificationKey ? { requestKey: request.verificationKey } : {}),
      scopeHash,
    },
    sessionId,
  );
  await session.adoptExisting();
  return session;
}

function normalizeBrowserContext(value: BrowserContextPort | BrowserVerifierContextHandle): { context: BrowserContextPort; externalId?: string; sessionId?: string } {
  if (isBrowserContextHandle(value)) return { context: value.context, externalId: value.externalId, ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }) };
  return { context: value };
}

function isBrowserContextHandle(value: BrowserContextPort | BrowserVerifierContextHandle): value is BrowserVerifierContextHandle {
  return typeof value === "object" && value !== null && "context" in value && "externalId" in value;
}

function isSafeOpaqueHandle(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isEmptyStorageState(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const state = value as { cookies?: unknown; origins?: unknown };
  const keys = Object.keys(value);
  const cookiesEmpty = state.cookies === undefined || (Array.isArray(state.cookies) && state.cookies.length === 0);
  const originsEmpty = state.origins === undefined || (Array.isArray(state.origins) && state.origins.length === 0);
  return keys.length === 0 || (keys.every((key) => key === "cookies" || key === "origins") && cookiesEmpty && originsEmpty);
}
