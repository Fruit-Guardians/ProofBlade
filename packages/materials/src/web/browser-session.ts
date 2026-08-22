import type { ControlStore } from "../control/control-store.js";
import type { Lane } from "../domain/types.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { ExperimentGate } from "../competition/experiment-gate.js";
import { DeterministicObserver } from "../knowledge/observer.js";

export interface BrowserContextPort {
  goto(url: string, signal?: AbortSignal): Promise<{ status?: number; content: string }>;
  storageState(): Promise<unknown>;
  close(): Promise<void>;
}

/** Bounded response/state record for a browser interaction. */
export interface BrowserExchangeArtifact {
  schemaVersion: 1;
  kind: "browser_exchange";
  request: { url: string };
  response: { status?: number; content: string };
  stateHash: string;
}

export interface BrowserNavigationResponse {
  status?: number;
  content: string;
  artifactId: string;
  stateHash: string;
  observationId: string;
  evidenceId: string;
  candidateKinds: string[];
}

/** Durable adapter around a persistent Playwright-compatible browser context. */
export class BrowserContextBackend {
  public readonly sessionId = id("BROWSER");
  private closed = false;
  private interactionCount = 0;
  private readonly base: URL;
  private readonly observer: DeterministicObserver;
  private generation?: number;

  public constructor(
    private readonly runId: string,
    private readonly ownerLane: Lane,
    private readonly startUrl: string,
    private readonly driver: BrowserContextPort,
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
    private readonly experimentGate?: ExperimentGate,
    private readonly allowedHosts?: string[],
    private readonly allowedPorts?: number[],
  ) {
    this.base = new URL(startUrl);
    this.observer = new DeterministicObserver(controlStore);
    if (!/^https?:$/.test(this.base.protocol)) throw new Error("Browser session requires an http(s) start URL");
    assertBrowserScope(this.base, allowedHosts, allowedPorts);
  }

  public async open(): Promise<void> {
    const stateHash = sha256(canonicalJson(await this.driver.storageState()));
    const snapshot = await this.controlStore.snapshot(this.runId);
    this.generation = snapshot.generation;
    await this.controlStore.dispatch(this.runId, { type: "session_opened", session: { id: this.sessionId, runId: this.runId, kind: "browser", ownerLane: this.ownerLane, generation: snapshot.generation, endpoint: this.base.origin, stateHash }, lane: this.ownerLane });
  }

  public async navigate(url = this.startUrl, signal?: AbortSignal): Promise<BrowserNavigationResponse> {
    if (this.closed) throw new Error(`Browser session is closed: ${this.sessionId}`);
    const snapshot = await this.controlStore.snapshot(this.runId);
    const record = snapshot.sessions[this.sessionId];
    if (!record || record.status !== "OPEN") throw new Error(`Browser session is not OPEN: ${this.sessionId}`);
    if (record.generation !== this.generation || snapshot.generation !== this.generation) throw new Error(`Browser session generation drift: ${this.sessionId}`);
    const resolved = new URL(url, this.base);
    if (resolved.origin !== this.base.origin) throw new Error(`Browser session navigation crosses origin: ${resolved}`);
    assertBrowserScope(resolved, this.allowedHosts, this.allowedPorts);
    const input = { url: resolved.toString() };
    await this.experimentGate?.assertAllowed({ runId: this.runId, action: "browser_navigate", input });
    const result = await this.driver.goto(resolved.toString(), signal);
    const stateHash = sha256(canonicalJson(await this.driver.storageState()));
    const exchange: BrowserExchangeArtifact = { schemaVersion: 1, kind: "browser_exchange", request: input, response: { ...(result.status === undefined ? {} : { status: result.status }), content: result.content.slice(0, 1_048_576) }, stateHash };
    this.interactionCount += 1;
    const artifact = await this.artifactStore.putText(this.runId, JSON.stringify(exchange), { filename: `browser-${this.sessionId}-${String(this.interactionCount).padStart(4, "0")}.exchange.json`, mime: "application/json", sensitivity: "public", semantic: { name: `Browser response ${resolved.pathname}`, summary: `Replayable browser response${result.status ? ` with status ${result.status}` : ""}.`, tags: ["web", "browser", "exchange"], role: "supporting", relatedIds: [], annotatedBy: "harness" } });
    const observed = await this.observer.observe(this.runId, {
      operation: "browser_navigate",
      artifactId: artifact.id,
      generation: snapshot.generation,
      result: { stdout: result.content.slice(0, 1_048_576), stderr: "", exitCode: result.status !== undefined && result.status >= 400 ? result.status : 0, durationMs: 0 },
    });
    await this.controlStore.dispatch(this.runId, { type: "session_interacted", sessionId: this.sessionId, transcriptArtifactId: artifact.id, stateHash, waitReason: "idle", lane: this.ownerLane });
    await this.experimentGate?.record({ runId: this.runId, action: "browser_navigate", input, outcome: result.status !== undefined && result.status >= 500 ? "failure" : "success", summary: `Browser navigation${result.status ? ` returned ${result.status}` : " completed"}.` });
    return { ...result, artifactId: artifact.id, stateHash, observationId: observed.observationId, evidenceId: observed.evidenceId, candidateKinds: observed.candidateKinds };
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
    }
  }
}

function assertBrowserScope(url: URL, allowedHosts?: string[], allowedPorts?: number[]): void {
  if (allowedHosts?.length && !allowedHosts.map((host) => host.toLowerCase()).includes(url.hostname.toLowerCase())) throw new Error(`Browser session host is outside task scope: ${url.hostname}`);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (allowedPorts?.length && !allowedPorts.includes(port)) throw new Error(`Browser session port is outside task scope: ${port}`);
}
