import { dirname, isAbsolute, join } from "node:path";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { ControlStore } from "../control/control-store.js";
import type { EffectJournal } from "../effects/effect-journal.js";
import type { FixtureRef } from "../sandbox/fixture.js";
import type { JobRecord, RawEffectResult, RuntimeResourceSnapshot } from "../domain/types.js";
import { DeterministicObserver } from "../knowledge/observer.js";
import { id, sha256 } from "../domain/utils.js";
import { snipText } from "@proofblade/molecules";
import { CapabilityRegistry, ProofBladeCapabilityRouter, type CapabilityInvocationResult } from "../capabilities/router.js";
import { listBundledCapabilities } from "../capabilities/catalog.js";
import { BinaryCapabilityBackend, BundledCapabilityBackend, CapabilityBackendResolver, McpCapabilityBackend, McpReverseCapabilityBackend, RizinCapabilityBackend } from "../capabilities/backend.js";
import { BackgroundJobRunner, type BackgroundJobStartInput, type JobOutput } from "../jobs/background-runner.js";
import { McpProjectRegistry } from "../mcp/registry.js";

export interface InspectTargetResult {
  output: string;
  observationId: string;
  evidenceId: string;
  artifactId: string;
  truncated: boolean;
}

export class ProofBladeToolRuntime {
  private readonly observer: DeterministicObserver;
  private readonly capabilityRouter: ProofBladeCapabilityRouter;
  private readonly jobs: BackgroundJobRunner;
  private readonly mcp: McpProjectRegistry;

  public constructor(
    public readonly runId: string,
    public readonly fixture: FixtureRef,
    private readonly runsRoot: string,
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
    private readonly journal: EffectJournal,
    projectRoot = dirname(runsRoot),
  ) {
    this.observer = new DeterministicObserver(controlStore);
    this.mcp = McpProjectRegistry.load(projectRoot);
    const registry = new CapabilityRegistry([...listBundledCapabilities(), ...this.mcp.capabilityManifests()]);
    const backends = new CapabilityBackendResolver([new RizinCapabilityBackend(), new McpReverseCapabilityBackend(this.mcp), new BinaryCapabilityBackend(), new BundledCapabilityBackend(), new McpCapabilityBackend(this.mcp)]);
    this.capabilityRouter = new ProofBladeCapabilityRouter(runId, fixture, runsRoot, controlStore, artifactStore, journal, registry, backends);
    this.jobs = new BackgroundJobRunner(runId, controlStore, artifactStore, this.capabilityRouter);
  }

  public listCapabilities(): ReturnType<ProofBladeCapabilityRouter["listCapabilities"]> {
    return this.capabilityRouter.listCapabilities();
  }

  public resourceSnapshot(base: RuntimeResourceSnapshot): RuntimeResourceSnapshot {
    return {
      ...base,
      mcpCatalogHash: this.mcp.catalogHash(),
      mcpServers: this.mcp.summaries().filter((server) => !server.disabled).map(({ name, description, configHash }) => ({ name, description, configHash })),
    };
  }

  public async invokeCapability(input: { capabilityId: string; operation: string; input: Record<string, unknown> }, signal?: AbortSignal): Promise<CapabilityInvocationResult> {
    const result = await this.capabilityRouter.invoke({ capabilityId: input.capabilityId, operation: input.operation, input: input.input }, signal);
    if (input.capabilityId !== "proofblade.target" && input.capabilityId !== "proofblade.binary" && !(input.capabilityId.startsWith("mcp.") && input.operation === "call")) return result;
    const snapshot = await this.controlStore.snapshot(this.runId);
    const artifact = snapshot.artifacts[result.artifactId];
    if (!artifact) return result;
    const stored = JSON.parse(await this.artifactStore.readText(this.runId, artifact)) as RawEffectResult;
    const observed = await this.observer.observe(this.runId, {
      operation: `capability:${input.capabilityId}.${input.operation}`,
      effectId: result.effectId,
      artifactId: result.artifactId,
      generation: snapshot.generation,
      result: stored,
    });
    return { ...result, observationId: observed.observationId, evidenceId: observed.evidenceId };
  }

  public async runBackground(input: BackgroundJobStartInput): Promise<Record<string, unknown>> {
    const job = await this.jobs.start(input);
    return { jobId: job.id, status: job.status, capabilityId: job.capabilityId, operation: job.operation, backendId: job.backendId, backendVersion: job.backendVersion, replayPolicy: job.replayPolicy, generation: job.generation };
  }

  public async readJobOutput(jobId: string, maxChars = 4_000): Promise<JobOutput> {
    return await this.jobs.readOutput(jobId, maxChars);
  }

  public async stopJob(jobId: string, reason?: string): Promise<Record<string, unknown>> {
    const job = await this.jobs.cancel(jobId, reason);
    return { jobId: job.id, status: job.status, reason: job.error };
  }

  public async jobStatus(jobId: string): Promise<JobRecord> {
    return await this.jobs.poll(jobId);
  }

  public async waitJob(jobId: string, timeoutMs?: number): Promise<JobRecord> {
    return await this.jobs.wait(jobId, timeoutMs);
  }

  public async listJobs(): Promise<JobRecord[]> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    return Object.values(snapshot.jobs).sort((a, b) => a.createdSeq - b.createdSeq);
  }

  public async recoverJobs(): Promise<JobOutput[]> {
    const jobs = await this.jobs.recover();
    return await Promise.all(jobs.map(async (job) => this.jobs.readOutput(job.id).catch(() => ({ jobId: job.id, status: job.status, output: "", truncated: false, originalChars: 0 }))));
  }

  public async close(): Promise<void> {
    await this.jobs.close();
    await this.mcp.close();
  }

  public async inspectTarget(path?: string): Promise<InspectTargetResult> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const operation = path ? "fixture_read" : "fixture_inspect";
    const executed = await this.journal.execute(this.runId, {
      operation,
      args: { path: path ?? "", generation: snapshot.generation },
      replayPolicy: "pure",
      cwd: this.fixture.path,
    });
    const observed = await this.observer.observe(this.runId, {
      operation,
      effectId: executed.effectId,
      artifactId: executed.artifactId,
      generation: snapshot.generation,
      result: executed.result,
    });
    const visible = snipText(executed.result.stdout, 6_000);
    return {
      output: `<untrusted-observation source="${operation}" artifact="${executed.artifactId}">\n${visible.text}\n</untrusted-observation>`,
      observationId: observed.observationId,
      evidenceId: observed.evidenceId,
      artifactId: executed.artifactId,
      truncated: visible.truncated,
    };
  }

  public async proposeIntent(input: { title: string; description: string; priority?: number }): Promise<{ intentId: string }> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const duplicate = Object.values(snapshot.intents).find((item) => item.title.toLowerCase() === input.title.toLowerCase() && item.status !== "REJECTED");
    if (duplicate) return { intentId: duplicate.id };
    const intentId = id("I");
    await this.controlStore.dispatch(this.runId, {
      type: "intent",
      intent: { id: intentId, title: input.title, description: input.description, phase: snapshot.phase, status: "OPEN", priority: input.priority ?? 5, ownerLane: "executor" },
      lane: "executor",
    });
    return { intentId };
  }

  public async proposeHypothesis(input: { statement: string; evidenceIds?: string[] }): Promise<{ hypothesisId: string }> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const evidenceIds = input.evidenceIds ?? [];
    assertEvidence(snapshot.evidence, evidenceIds);
    const hypothesisId = id("H");
    await this.controlStore.dispatch(this.runId, {
      type: "hypothesis",
      hypothesis: { id: hypothesisId, statement: scrubCandidate(input.statement), status: "OPEN", evidenceIds },
      lane: "executor",
    });
    return { hypothesisId };
  }

  public async proposeFact(input: { statement: string; evidenceIds: string[] }): Promise<{ factId: string }> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    if (input.evidenceIds.length === 0) throw new Error("propose_fact requires evidence ids");
    assertEvidence(snapshot.evidence, input.evidenceIds);
    const factId = id("F");
    await this.controlStore.dispatch(this.runId, {
      type: "fact",
      fact: { id: factId, statement: scrubCandidate(input.statement), status: "PROPOSED", evidenceIds: input.evidenceIds },
      lane: "executor",
    });
    return { factId };
  }

  public async submitCandidate(candidate: string): Promise<{ completionId: string; candidateHash: string }> {
    const normalized = candidate.trim();
    if (!/^PB\{[^}\r\n]+\}$/.test(normalized)) throw new Error("Candidate must be one complete PB{...} value");
    const snapshot = await this.controlStore.snapshot(this.runId);
    const supportingObservations = Object.values(snapshot.observations).filter((item) =>
      item.source.generation === snapshot.generation && item.candidateKinds.includes("flag-shaped-value"),
    );
    if (supportingObservations.length === 0) throw new Error("Inspect the target and collect flag-shaped evidence before proposing completion");
    let observed = false;
    for (const observation of supportingObservations) {
      const artifact = snapshot.artifacts[observation.source.artifactId];
      if (!artifact) continue;
      const stored = JSON.parse(await this.artifactStore.readText(this.runId, artifact)) as RawEffectResult;
      if (stored.stdout.includes(normalized) || stored.stderr.includes(normalized)) {
        observed = true;
        break;
      }
    }
    if (!observed) throw new Error("Candidate does not occur in a successful target observation");
    if (Object.keys(snapshot.completions).length >= snapshot.task.constraints.max_submissions) throw new Error("Submission budget exhausted");
    const candidateHash = sha256(normalized);
    const existing = Object.values(snapshot.completions).find((item) => item.candidateHash === candidateHash);
    if (existing) return { completionId: existing.id, candidateHash };
    const artifact = await this.artifactStore.putText(this.runId, normalized, {
      filename: `candidate-${candidateHash.slice(0, 12)}.txt`,
      mime: "text/plain",
      sensitivity: "flag_candidate",
    });
    const completionId = id("C");
    await this.controlStore.dispatch(this.runId, {
      type: "completion_proposed",
      completion: { id: completionId, candidateHash, artifactId: artifact.id },
      lane: "executor",
    });
    return { completionId, candidateHash };
  }

  public async status(): Promise<Record<string, unknown>> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    return {
      runId: snapshot.runId,
      status: snapshot.status,
      phase: snapshot.phase,
      generation: snapshot.generation,
      observations: Object.keys(snapshot.observations),
      evidence: Object.keys(snapshot.evidence),
      hypotheses: Object.keys(snapshot.hypotheses),
      completions: Object.values(snapshot.completions).map((item) => ({ id: item.id, candidateHash: item.candidateHash, status: item.status })),
      jobs: Object.values(snapshot.jobs).map((item) => ({ id: item.id, capabilityId: item.capabilityId, operation: item.operation, backendId: item.backendId, backendVersion: item.backendVersion, status: item.status, artifactId: item.artifactId })),
      handoffs: Object.values(snapshot.handoffs).map((item) => ({ id: item.id, status: item.status, phase: item.phase, knowledgeVersion: item.knowledgeVersion, actionIds: item.nextActions.map((action) => action.id) })),
      remainingToolCalls: snapshot.task.constraints.max_tool_calls - Object.keys(snapshot.effects).length,
    };
  }

  public async readArtifact(artifactId: string, maxChars = 4_000): Promise<Record<string, unknown>> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const artifact = snapshot.artifacts[artifactId];
    if (!artifact) throw new Error(`Unknown artifact: ${artifactId}`);
    const executed = await this.journal.execute(this.runId, {
      operation: "artifact_read",
      args: { artifactId, path: artifact.path, sha256: artifact.sha256, maxChars, generation: snapshot.generation },
      replayPolicy: "pure",
      cwd: join(this.runsRoot, this.runId),
    });
    const snipped = snipText(executed.result.stdout, maxChars);
    return {
      artifactId,
      sha256: artifact.sha256,
      output: snipped.text,
      truncated: snipped.truncated,
      originalChars: snipped.originalChars,
      resultArtifactId: executed.artifactId,
    };
  }

  public async searchHistory(query: string): Promise<Array<Record<string, unknown>>> {
    const normalized = query.trim().toLowerCase();
    if (normalized.length < 2) throw new Error("History query must contain at least two characters");
    const snapshot = await this.controlStore.snapshot(this.runId);
    const rows = [
      ...Object.values(snapshot.facts).map((item) => ({ kind: "fact", id: item.id, status: item.status, text: item.statement, evidenceIds: item.evidenceIds, createdSeq: item.createdSeq })),
      ...Object.values(snapshot.hypotheses).map((item) => ({ kind: "hypothesis", id: item.id, status: item.status, text: item.statement, evidenceIds: item.evidenceIds, createdSeq: item.createdSeq })),
      ...Object.values(snapshot.observations).map((item) => ({ kind: "observation", id: item.id, text: item.summary, artifactId: item.source.artifactId, createdSeq: item.createdSeq })),
      ...Object.values(snapshot.evidence).map((item) => ({ kind: "evidence", id: item.id, text: item.summary, artifactId: item.source.artifactId, createdSeq: item.createdSeq })),
      ...Object.values(snapshot.checkpoints).map((item) => ({ kind: "checkpoint", id: item.id, text: item.reason, artifactId: item.artifactId, createdSeq: item.createdSeq })),
      ...Object.values(snapshot.jobs).map((item) => ({ kind: "job", id: item.id, text: `${item.capabilityId}.${item.operation} ${item.status}`, artifactId: item.artifactId, createdSeq: item.createdSeq })),
      ...Object.values(snapshot.handoffs).map((item) => ({ kind: "handoff", id: item.id, text: `${item.phase} ${item.status} ${item.knowledgeVersion}`, artifactId: undefined, createdSeq: item.createdSeq })),
    ];
    return rows
      .filter((item) => JSON.stringify(item).toLowerCase().includes(normalized))
      .sort((a, b) => b.createdSeq - a.createdSeq)
      .slice(0, 20)
      .map(({ createdSeq: _createdSeq, ...item }) => item);
  }

  public candidateArtifactPath(path: string): string {
    if (isAbsolute(path)) throw new Error("Stored artifact paths must be relative");
    return join(this.runsRoot, this.runId, path);
  }
}

function assertEvidence(evidence: Record<string, unknown>, evidenceIds: string[]): void {
  const missing = evidenceIds.filter((id) => !Object.hasOwn(evidence, id));
  if (missing.length > 0) throw new Error(`Unknown evidence ids: ${missing.join(", ")}`);
}

function scrubCandidate(statement: string): string {
  return statement.replace(/PB\{[^}\r\n]+\}/g, (candidate) => `[candidate sha256=${sha256(candidate)}]`);
}
