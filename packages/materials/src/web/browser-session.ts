import type { ControlStore } from "../control/control-store.js";
import type { Lane } from "../domain/types.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { ExperimentGate } from "../competition/experiment-gate.js";

export interface BrowserContextPort {
  goto(url: string, signal?: AbortSignal): Promise<{ status?: number; content: string }>;
  storageState(): Promise<unknown>;
  close(): Promise<void>;
}

/** Durable adapter around a persistent Playwright-compatible browser context. */
export class BrowserContextBackend {
  public readonly sessionId = id("BROWSER");
  private closed = false;

  public constructor(
    private readonly runId: string,
    private readonly ownerLane: Lane,
    private readonly startUrl: string,
    private readonly driver: BrowserContextPort,
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
    private readonly experimentGate?: ExperimentGate,
  ) {}

  public async open(): Promise<void> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    await this.controlStore.dispatch(this.runId, { type: "session_opened", session: { id: this.sessionId, runId: this.runId, kind: "browser", ownerLane: this.ownerLane, generation: snapshot.generation, endpoint: this.startUrl }, lane: this.ownerLane });
  }

  public async navigate(url = this.startUrl, signal?: AbortSignal): Promise<{ status?: number; content: string; artifactId: string; stateHash: string }> {
    if (this.closed) throw new Error(`Browser session is closed: ${this.sessionId}`);
    if (new URL(url).origin !== new URL(this.startUrl).origin) throw new Error(`Browser session navigation crosses origin: ${url}`);
    const input = { url };
    await this.experimentGate?.assertAllowed({ runId: this.runId, action: "browser_navigate", input });
    const result = await this.driver.goto(url, signal);
    const stateHash = sha256(canonicalJson(await this.driver.storageState()));
    const artifact = await this.artifactStore.putText(this.runId, result.content.slice(0, 1_048_576), { filename: `browser-${this.sessionId}.html`, mime: "text/html", sensitivity: "public", semantic: { name: `Browser response ${new URL(url).pathname}`, summary: `Persistent browser response${result.status ? ` with status ${result.status}` : ""}.`, tags: ["web", "browser"], role: "supporting", relatedIds: [], annotatedBy: "harness" } });
    await this.controlStore.dispatch(this.runId, { type: "session_interacted", sessionId: this.sessionId, transcriptArtifactId: artifact.id, stateHash, waitReason: "idle", lane: this.ownerLane });
    await this.experimentGate?.record({ runId: this.runId, action: "browser_navigate", input, outcome: result.status !== undefined && result.status >= 500 ? "failure" : "success", summary: `Browser navigation${result.status ? ` returned ${result.status}` : " completed"}.` });
    return { ...result, artifactId: artifact.id, stateHash };
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.driver.close();
    await this.controlStore.dispatch(this.runId, { type: "session_closed", sessionId: this.sessionId, reason: "browser-context-closed", exitCode: 0, lane: this.ownerLane });
  }
}
