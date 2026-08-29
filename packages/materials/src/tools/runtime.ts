import { dirname, isAbsolute, join } from "node:path";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { ControlStore } from "../control/control-store.js";
import type { EffectJournal } from "../effects/effect-journal.js";
import type { FixtureRef } from "../sandbox/fixture.js";
import type { CompletionProposal, DomainRecordInput, JobRecord, KnowledgeLevel, KnowledgeProjection, RawEffectResult, RunSnapshot, RuntimeResourceSnapshot } from "../domain/types.js";
import { DeterministicObserver, type ObservationOutcome } from "../knowledge/observer.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import { isCtfCandidate, redactCtfCandidates } from "../domain/candidate.js";
import { snipText } from "@proofblade/molecules";
import { CapabilityRegistry, ProofBladeCapabilityRouter, type CapabilityDiscoveryInput, type CapabilityInvocationResult } from "../capabilities/router.js";
import { listBundledCapabilities } from "../capabilities/catalog.js";
import { BinaryCapabilityBackend, BundledCapabilityBackend, CapabilityBackendResolver, FirmwareCapabilityBackend, McpCapabilityBackend, McpReverseCapabilityBackend, RizinCapabilityBackend } from "../capabilities/backend.js";
import { BackgroundJobRunner, type BackgroundJobStartInput, type JobMonitorInput, type JobMonitorResult, type JobOutput } from "../jobs/background-runner.js";
import { McpProjectRegistry } from "../mcp/registry.js";
import { beginSubmissionVerificationRequest } from "../verification/verification-key.js";
import { boundProjectionList, projectKnowledge, readKnowledge, readProjectKnowledge, searchKnowledge, searchProjectKnowledge, type KnowledgeReadResult, type ProjectKnowledgeSource } from "../knowledge/projection.js";
import { EvidenceConsolidator, type ConsolidateInput, type ConsolidateResult } from "../knowledge/consolidation.js";
import type { ProofBladeSkillRegistry } from "../skills/registry.js";

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
  private readonly skills?: ProofBladeSkillRegistry;

  public constructor(
    public readonly runId: string,
    public readonly fixture: FixtureRef,
    private readonly runsRoot: string,
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
    private readonly journal: EffectJournal,
    projectRoot = dirname(runsRoot),
    options: { includeMcp?: boolean; skills?: ProofBladeSkillRegistry } = {},
  ) {
    this.observer = new DeterministicObserver(controlStore);
    this.mcp = McpProjectRegistry.load(projectRoot);
    this.skills = options.skills;
    const includeMcp = options.includeMcp !== false;
    const registry = new CapabilityRegistry([...listBundledCapabilities(), ...(includeMcp ? this.mcp.capabilityManifests() : [])]);
    const backends = new CapabilityBackendResolver([
      new RizinCapabilityBackend(),
      ...(includeMcp ? [new McpReverseCapabilityBackend(this.mcp)] : []),
      new BinaryCapabilityBackend(),
      new FirmwareCapabilityBackend(),
      new BundledCapabilityBackend(),
      ...(includeMcp ? [new McpCapabilityBackend(this.mcp)] : []),
    ]);
    this.capabilityRouter = new ProofBladeCapabilityRouter(runId, fixture, runsRoot, controlStore, artifactStore, journal, registry, backends);
    this.jobs = new BackgroundJobRunner(runId, controlStore, artifactStore, this.capabilityRouter);
  }

  public listCapabilities(): ReturnType<ProofBladeCapabilityRouter["listCapabilities"]> {
    return this.capabilityRouter.listCapabilities();
  }

  public discoverCapabilities(input: CapabilityDiscoveryInput = {}): ReturnType<ProofBladeCapabilityRouter["discover"]> {
    return this.capabilityRouter.discover(input);
  }

  public resolveCapabilityPolicy(input: { capabilityId: string; operation: string; input: Record<string, unknown> }): ReturnType<ProofBladeCapabilityRouter["resolveInvocationPolicy"]> {
    return this.capabilityRouter.resolveInvocationPolicy(input);
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
    if (input.capabilityId !== "proofblade.target" && input.capabilityId !== "proofblade.binary" && input.capabilityId !== "proofblade.firmware" && !(input.capabilityId.startsWith("mcp.") && input.operation === "call")) return result;
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
    const domainRecordIds = await this.recordBinaryProfile(input, result, stored, observed.evidenceId);
    return {
      ...result,
      observationId: observed.observationId,
      evidenceId: observed.evidenceId,
      ...(domainRecordIds.length > 0 ? { domainRecordIds } : {}),
      progressKey: progressKey(`capability:${input.capabilityId}.${input.operation}`, artifact.sha256),
    };
  }

  /**
   * Binary identify/inspect output is the one trustworthy, structured source
   * for a native target profile.  Persist only bounded metadata; the raw
   * output remains in the Effect Artifact and the profile references it.
   */
  private async recordBinaryProfile(
    input: { capabilityId: string; operation: string; input: Record<string, unknown> },
    result: CapabilityInvocationResult,
    stored: RawEffectResult,
    evidenceId: string,
  ): Promise<string[]> {
    if (input.capabilityId !== "proofblade.binary" || !["identify", "inspect_elf"].includes(input.operation)) return [];
    const snapshot = await this.controlStore.snapshot(this.runId);
    if (!["pwn", "mixed", "unknown"].includes(snapshot.task.target_kind)) return [];
    const parsed = parseJsonRecord(stored.stdout);
    const identity = input.operation === "inspect_elf" && isRecord(parsed.identity) ? parsed.identity : parsed;
    const bits = numberField(identity.bits);
    const architecture = stringField(identity.architecture) ?? "unknown";
    const format = stringField(identity.format) ?? "unknown";
    if (bits !== 32 && bits !== 64) return [];
    const checksec = input.operation === "inspect_elf" && isRecord(parsed.checksec) ? parsed.checksec : undefined;
    const protections = checksecProtections(checksec);
    const path = typeof input.input.path === "string" ? input.input.path : "target";
    const recordId = `PWN-BINARY-${snapshot.generation}-${sha256(`${path}:${input.operation}`).slice(0, 32)}`;
    const record: Extract<DomainRecordInput, { kind: "pwn_binary_profile" }> = {
      id: recordId,
      kind: "pwn_binary_profile",
      summary: `${format} ${architecture} ${bits}-bit binary profile; protections=${protections.join(",") || "unknown"}.`,
      artifactIds: [result.artifactId],
      evidenceIds: [evidenceId],
      effectId: result.effectId,
      format,
      architecture,
      bits,
      protections,
    };
    await this.controlStore.dispatchTransaction(this.runId, (current) => {
      if (current.domainRecords[recordId]) return { commands: [], project: () => undefined };
      return { commands: [{ type: "domain_record" as const, record, lane: "executor" as const }], project: () => undefined };
    });
    return [recordId];
  }

  /**
   * Observe an artifact produced by a coding-lane tool that did not originate
   * in the Effect Journal (for example read/bash output rewriting). The
   * synthetic effect id is derived from the immutable artifact id, so retries
   * are idempotent and the observer never emits duplicate evidence.
   */
  public async observeArtifact(input: { operation: string; artifactId: string; exitCode?: number | null }): Promise<ObservationOutcome & { progressKey: string }> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const artifact = snapshot.artifacts[input.artifactId];
    if (!artifact) throw new Error(`Unknown artifact: ${input.artifactId}`);
    const stored = await this.artifactStore.readText(this.runId, artifact);
    const observed = await this.observer.observe(this.runId, {
      operation: input.operation,
      artifactId: artifact.id,
      generation: snapshot.generation,
      result: {
        stdout: stored.slice(0, MAX_AUTOMATIC_OBSERVATION_CHARS),
        stderr: "",
        exitCode: input.exitCode ?? 0,
        durationMs: 0,
      },
    });
    return { ...observed, progressKey: progressKey(input.operation, artifact.sha256) };
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

  public async monitorJob(jobId: string, input: JobMonitorInput = {}): Promise<JobMonitorResult> {
    return await this.jobs.monitor(jobId, input);
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
    if (!isCtfCandidate(normalized)) throw new Error("Candidate must be one complete CTF prefix{...} value");
    const snapshot = await this.controlStore.snapshot(this.runId);
    // When the live platform is the judge, the flag may be platform-provided
    // (dynamic-flag challenges) or computed off-target (crypto/reverse) and need
    // not appear verbatim in a captured observation. Keep format check, budget,
    // and dedup, but soften the observation-anchoring hard gate to advisory.
    const platformJudged = snapshot.task.verification.kind === "platform_submission";
    const supportingObservations = Object.values(snapshot.observations).filter((item) =>
      item.source.generation === snapshot.generation && item.candidateKinds.includes("flag-shaped-value"),
    );
    if (!platformJudged && supportingObservations.length === 0) throw new Error("Inspect the target and collect flag-shaped evidence before proposing completion");
    let observed = false;
    for (const observation of supportingObservations) {
      const artifact = snapshot.artifacts[observation.source.artifactId];
      if (!artifact) continue;
      const stored = await this.artifactStore.readText(this.runId, artifact);
      const observationText = rawObservationText(stored);
      if (observationText.includes(normalized)) {
        observed = true;
        break;
      }
    }
    if (!platformJudged && !observed) throw new Error("Candidate does not occur in a successful target observation");
    const candidateHash = sha256(normalized);
    // Only completions that are actually SUBMITTABLE count against the budget and
    // are eligible for dedup. `verify_claim` also proposes completions, but its
    // artifact is a claim-reproduction JSON blob, not the bare flag. Counting those
    // let a few verify_claim calls exhaust max_submissions with nothing ever sent,
    // and deduping against one handed it back to IndependentVerifier, which
    // compared sha256(json blob) to candidateHash and threw "Candidate hash
    // mismatch" — losing an already-correct flag. The predicate below IS the
    // verifier's own precondition, so a reused completion always passes it.
    const submissionCount = Object.values(snapshot.completions).filter((item) =>
      item.purpose === "submission" && item.runId === snapshot.runId,
    ).length;
    const submittable = await this.submittableCompletions(snapshot);
    const existing = submittable.find((item) => item.candidateHash === candidateHash);
    if (existing) return { completionId: existing.id, candidateHash };
    // The submission budget is a run-wide, durable accounting invariant. It must
    // not reset with fixture generation and must not depend on an Artifact still
    // being readable, otherwise reset/deletion can mint fresh attempts.
    if (submissionCount >= snapshot.task.constraints.max_submissions) throw new Error("Submission budget exhausted");
    const artifact = await this.artifactStore.putText(this.runId, normalized, {
      filename: `candidate-${candidateHash.slice(0, 12)}.txt`,
      mime: "text/plain",
      sensitivity: "flag_candidate",
    });
    const completionId = id("C");
    const verificationRequest = platformJudged
      ? await beginSubmissionVerificationRequest(this.controlStore, this.runId, { candidateHash, candidateArtifactId: artifact.id })
      : undefined;
    await this.controlStore.dispatch(this.runId, {
      type: "completion_proposed",
      completion: { id: completionId, purpose: "submission", candidateHash, artifactId: artifact.id, ...(verificationRequest ? { verificationKey: verificationRequest.request.key } : {}) },
      lane: "executor",
    });
    return { completionId, candidateHash };
  }

  /** Completions explicitly proposed for submission whose Artifact is still the exact candidate. */
  public async submittableCompletions(snapshot: RunSnapshot): Promise<CompletionProposal[]> {
    const submittable: CompletionProposal[] = [];
    for (const item of Object.values(snapshot.completions)) {
      if (item.purpose !== "submission" || item.runId !== snapshot.runId || item.generation !== snapshot.generation) continue;
      const artifact = snapshot.artifacts[item.artifactId];
      if (!artifact || artifact.runId !== snapshot.runId || artifact.generation !== snapshot.generation) continue;
      try {
        const stored = (await this.artifactStore.readText(this.runId, artifact)).trim();
        if (sha256(stored) === item.candidateHash) submittable.push(item);
      } catch {
        // An unreadable artifact cannot be submitted, so it does not count.
      }
    }
    return submittable;
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

  public async inspectKnowledge(uri: string, level: KnowledgeLevel = "L0", maxChars = 6_000): Promise<KnowledgeReadResult> {
    if (uri.trim().toLocaleLowerCase().startsWith("pb://project/")) return readProjectKnowledge(this.projectKnowledgeSource(), uri, level, maxChars);
    const snapshot = await this.controlStore.snapshot(this.runId);
    return await readKnowledge(snapshot, this.artifactStore, uri, level, maxChars);
  }

  public async searchKnowledge(query = "", maxResults = 50, maxChars = 12_000, includeStale = false): Promise<KnowledgeProjection[]> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const run = searchKnowledge(snapshot, query, 200, 64_000, includeStale);
    const project = searchProjectKnowledge(this.projectKnowledgeSource(), query, 200, 64_000);
    return boundProjectionList([...project, ...run].sort((left, right) => left.uri.localeCompare(right.uri)), maxResults, maxChars);
  }

  private projectKnowledgeSource(): ProjectKnowledgeSource {
    const capabilities = this.capabilityRouter.listCapabilities();
    const skillCatalogHash = this.skills?.catalogHash() ?? sha256(canonicalJson([]));
    return {
      skills: this.skills,
      skillCatalogHash,
      tools: capabilities.capabilities.map((capability) => ({ id: capability.id, description: capability.description, version: capability.version })),
      toolCatalogHash: capabilities.catalogHash,
      mcpServers: this.mcp.summaries().map(({ name, description, configHash, status }) => ({ name, description, configHash, status })),
      mcpCatalogHash: this.mcp.catalogHash(),
    };
  }

  public async consolidateKnowledge(input: ConsolidateInput = {}): Promise<ConsolidateResult> {
    return await new EvidenceConsolidator(this.controlStore, this.artifactStore).consolidate(this.runId, input);
  }

  public async searchHistory(query: string): Promise<Array<Record<string, unknown>>> {
    const normalized = query.trim().toLowerCase();
    if (normalized.length < 2) throw new Error("History query must contain at least two characters");
    const snapshot = await this.controlStore.snapshot(this.runId);
    const rows = [
      ...Object.values(snapshot.facts).filter((item) => item.runId === snapshot.runId && item.generation === snapshot.generation).map((item) => ({ kind: "fact", id: item.id, status: item.status, text: item.statement, evidenceIds: item.evidenceIds, createdSeq: item.createdSeq })),
      ...Object.values(snapshot.hypotheses).filter((item) => item.runId === snapshot.runId && item.generation === snapshot.generation).map((item) => ({ kind: "hypothesis", id: item.id, status: item.status, text: item.statement, evidenceIds: item.evidenceIds, createdSeq: item.createdSeq })),
      ...Object.values(snapshot.observations).filter((item) => item.runId === snapshot.runId && item.generation === snapshot.generation).map((item) => ({ kind: "observation", id: item.id, text: item.summary, artifactId: item.source.artifactId, createdSeq: item.createdSeq })),
      ...Object.values(snapshot.evidence).filter((item) => item.provenance?.runId === snapshot.runId && item.provenance.generation === snapshot.generation).map((item) => ({ kind: "evidence", id: item.id, text: item.summary, artifactId: item.source.artifactId, createdSeq: item.createdSeq })),
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

const MAX_AUTOMATIC_OBSERVATION_CHARS = 64_000;

function progressKey(operation: string, contentKey: string): string {
  return sha256(canonicalJson({ operation, contentKey }));
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/[\u0000\r\n]/g, " ");
  return trimmed.length > 0 ? trimmed.slice(0, 128) : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function checksecProtections(value: Record<string, unknown> | undefined): string[] {
  if (!value) return [];
  return ["pie", "nx", "relro", "canary"].flatMap((key) => {
    const state = value[key];
    if (state === true) return [key.toUpperCase()];
    if (state === false) return [`${key.toUpperCase()}=disabled`];
    return state === null ? [`${key.toUpperCase()}=unknown`] : [];
  });
}

/**
 * Journal artifacts are JSON-wrapped RawEffectResults, while coding-lane read
 * and bash artifacts are intentionally plain text. Both may anchor a
 * candidate, so observation consumers must not assume one storage shape.
 */
function rawObservationText(stored: string): string {
  try {
    const parsed = JSON.parse(stored) as Partial<RawEffectResult>;
    if (typeof parsed.stdout === "string" || typeof parsed.stderr === "string") {
      return `${parsed.stdout ?? ""}\n${parsed.stderr ?? ""}`;
    }
  } catch {
    // Plain coding artifacts are already the observation text.
  }
  return stored;
}

function assertEvidence(evidence: Record<string, unknown>, evidenceIds: string[]): void {
  const missing = evidenceIds.filter((id) => !Object.hasOwn(evidence, id));
  if (missing.length > 0) throw new Error(`Unknown evidence ids: ${missing.join(", ")}`);
}

function scrubCandidate(statement: string): string {
  return redactCtfCandidates(statement, (candidate) => `[candidate sha256=${sha256(candidate)}]`);
}
