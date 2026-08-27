import type { ContainerRef } from "../container/contracts.js";
import type { SessionRegistry } from "../container/session-registry.js";
import type { ControlStore } from "../control/control-store.js";
import type { Evidence, RawEffectResult } from "../domain/types.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import { PwnReproducer, type ExploitStage, type PwnReproduceExecution, type PwnReproduceOutcome, type StageResult } from "./pwn-reproducer.js";
import { PwnSession } from "../pwn/pwn-session.js";
import { beginVerificationRequest, readDurableVerificationResult } from "./verification-key.js";
import type { VerifierReplayHandle, VerifierReplayInput } from "../effects/effect-journal.js";
import { serializeVerifierOutcomeEnvelope } from "./outcome-envelope.js";

export interface PwnVerifierTarget {
  kind: "local" | "remote";
  command: string[];
  endpoint?: string;
}

export interface PwnVerifierPolicy {
  target: PwnVerifierTarget;
  flagPath: string;
  flagPattern: string;
}

/** The only adapter exposed to a model-facing PwnToolHandler. */
export interface PwnTrustedReproducer {
  reproduce(runId: string, stages: ExploitStage[], signal?: AbortSignal): Promise<PwnReproduceOutcome>;
}

/** Trusted Control/Effect boundary used by the Pwn verifier. */
export interface PwnVerifierPort {
  prepareReplay?(input: VerifierReplayInput): Promise<VerifierReplayHandle>;
  startReplay?(effectId: string, sessionId: string, externalId?: string): Promise<void>;
  finishReplay?(effectId: string, result: RawEffectResult): Promise<{ effectId: string; artifactId: string }>;
  executeEffect(input: {
    completionId: string;
    candidateHash: string;
    candidateArtifactId: string;
    attemptId: string;
    sessionId: string;
    cwd: string;
    payload: string;
  }, signal?: AbortSignal): Promise<{ effectId: string; artifactId: string }>;
  recordEvidence(runId: string, evidence: Omit<Evidence, "createdSeq" | "provenance">): Promise<void>;
  finalize(runId: string, completionId: string, accepted: boolean, evidenceIds: string[]): Promise<void>;
}

interface AttemptReceipt {
  attemptId: string;
  execution: PwnReproduceExecution;
  accepted: boolean;
  effectId?: string;
  effectArtifactId?: string;
  evidenceId: string;
}

/**
 * Re-run a model-proposed recipe in verifier-owned sessions and bind the
 * result to a Completion. The recipe is untrusted input; only the immutable
 * task target/flag policy and the structured session barriers determine the
 * verdict.
 */
export class PwnReproductionVerifier implements PwnTrustedReproducer {
  private readonly reproducer: PwnReproducer;

  public constructor(
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
    private readonly verifier: PwnVerifierPort,
    private readonly registry: SessionRegistry,
    private readonly refProvider: () => ContainerRef,
    private readonly policy: PwnVerifierPolicy,
  ) {
    this.reproducer = new PwnReproducer(controlStore);
  }

  public async reproduce(runId: string, stages: ExploitStage[], signal?: AbortSignal): Promise<PwnReproduceOutcome> {
    const before = await this.controlStore.snapshot(runId);
    if (before.task.target_kind !== "pwn" && before.task.target_kind !== "mixed" && before.task.target_kind !== "unknown") {
      throw new Error(`Pwn reproduction is not allowed for target kind ${before.task.target_kind}`);
    }
    if (before.generation !== this.refProvider().generation) throw new Error("Pwn reproduction target is from a stale generation");
    this.assertTargetAllowed(before.task.scope);
    const request = await beginVerificationRequest(this.controlStore, runId, {
      kind: "pwn",
      policyHash: sha256(canonicalJson(this.policy)),
      recipeHash: sha256(canonicalJson({ stages: structuredClone(stages) })),
    });
    if (!request.created) {
      const durable = await readDurableVerificationResult(this.controlStore, runId, request.request);
      if (durable) {
        const snapshot = await this.controlStore.snapshot(runId);
        const candidateArtifact = snapshot.artifacts[durable.completion.artifactId];
        if (!candidateArtifact) throw new Error(`Durable Pwn verification candidate is missing: ${durable.completion.artifactId}`);
        const candidate = await this.artifactStore.readText(runId, candidateArtifact);
        if (!durable.evidenceId) throw new Error("Durable Pwn verification has no Evidence");
        const outcome = await readDurablePwnOutcome(this.artifactStore, runId, snapshot, durable.completion.id, durable.completion.candidateHash);
        return {
          reproduced: durable.completion.status === "ACCEPTED",
          shellConfirmed: outcome.shellConfirmed,
          ...(durable.completion.status === "ACCEPTED" ? { flag: candidate } : {}),
          stages: outcome.stages,
          evidenceId: durable.evidenceId,
          completionId: durable.completion.id,
          candidateHash: durable.completion.candidateHash,
        };
      }
      throw new Error(`Pwn verification request ${request.request.id} requires durable recovery; refusing to open another clean process`);
    }

    const requiredAttempts = Math.max(1, before.task.verification.required_reproductions);
    const policyHash = sha256(canonicalJson(this.policy));
    const executions: PwnReproduceExecution[] = [];
    const attemptIds: string[] = [];
    for (let attempt = 0; attempt < requiredAttempts; attempt += 1) {
      const attemptId = sha256(`${runId}:${request.request.id}:pwn:${attempt + 1}`);
      attemptIds.push(attemptId);
      const replay = this.verifier.prepareReplay ? await this.verifier.prepareReplay({
        verificationRequestId: request.request.id,
        verificationKey: request.request.key,
        kind: "pwn",
        policyHash,
        recipeHash: request.request.recipeHash,
        attemptId,
        cwd: before.task.scope.allowed_workspace,
        recoveryInput: { content: JSON.stringify({ schemaVersion: 1, kind: "pwn", stages: structuredClone(stages) }), filename: `pwn-replay-${attemptId}.json`, mime: "application/json", sensitivity: "secret" },
      }) : undefined;
      const execution = await this.reproducer.reproduceCaptured(runId, {
        stages: structuredClone(stages),
        flagPath: this.policy.flagPath,
        flagPattern: this.policy.flagPattern,
      }, async () => await this.openVerifierSession(runId, before.generation), async (session) => {
        if (replay && this.verifier.startReplay) await this.verifier.startReplay(replay.effectId, session.sessionId);
      });
      const replaySnapshot = await this.controlStore.snapshot(runId);
      const replayExternalId = replaySnapshot.sessions[execution.sessionId]?.externalId;
      const replayEnvelope = serializeVerifierOutcomeEnvelope({
        schemaVersion: 1,
        requestKey: request.request.key,
        runId,
        generation: before.generation,
        kind: "pwn",
        policyHash,
        recipeHash: request.request.recipeHash,
        ...(replayExternalId ? { externalId: replayExternalId } : {}),
        externalStatus: "CONFIRMED",
        attempts: [{ id: attemptId, phase: "pwn_replay", status: execution.reproduced ? "PASSED" : "FAILED", ...(replayExternalId ? { externalId: replayExternalId } : {}), summary: execution.reproduced ? "Pwn replay reached shell and read a policy-matching flag." : "Pwn replay did not pass all shell and flag barriers." }],
        transcriptArtifactIds: [],
        stageSummary: { reproduced: execution.reproduced, shellConfirmed: execution.shellConfirmed, flagRead: execution.flag !== undefined, stageCount: execution.stages.length },
        evidenceIds: [],
        terminal: false,
      }, { replay: true });
      const replayResult: RawEffectResult = {
        stdout: replayEnvelope,
        stderr: "",
        exitCode: execution.reproduced ? 0 : 1,
        durationMs: 0,
        ...(replayExternalId ? { externalId: replayExternalId } : {}),
      };
      if (replay && this.verifier.finishReplay) await this.verifier.finishReplay(replay.effectId, replayResult);
      executions.push(execution);
      if (!execution.reproduced) break;
    }

    const candidate = executions[0]?.flag;
    const candidateToken = candidate ?? `__NO_PWN_FLAG__:${sha256(canonicalJson({
      runId,
      generation: before.generation,
      stages: executions[0]?.stages.map(({ name, ok }) => ({ name, ok })) ?? [],
      transcriptHash: sha256(executions[0]?.transcript ?? ""),
    })).slice(0, 24)}`;
    const candidateHash = sha256(candidateToken);
    const completionId = id("C");
    const candidateArtifact = await this.artifactStore.putText(runId, candidateToken, {
      filename: `pwn-candidate-${completionId}.txt`,
      mime: "text/plain",
      sensitivity: "flag_candidate",
      semantic: {
        name: "Pwn reproduction candidate",
        summary: `Candidate sha256=${candidateHash}.`,
        tags: ["pwn", "verification", "candidate"],
        role: "result",
        relatedIds: [],
        annotatedBy: "harness",
      },
    });
    await this.controlStore.dispatch(runId, {
      type: "completion_proposed",
      completion: { id: completionId, purpose: "harness_verification", candidateHash, artifactId: candidateArtifact.id, verificationKey: request.request.key },
      lane: "main",
    });

    const receipts: AttemptReceipt[] = [];
    for (const [index, execution] of executions.entries()) {
      const accepted = execution.reproduced && execution.flag === candidate;
      const evidenceId = id("EV");
      const attemptId = attemptIds[index] ?? sha256(`${runId}:${completionId}:${before.generation}:pwn:${index + 1}:${execution.sessionId}:${candidateHash}`);
      const payload = JSON.stringify({
        schemaVersion: 1,
        accepted,
        candidateHash,
        observedCandidateHash: execution.flag ? sha256(execution.flag) : undefined,
        shellConfirmed: execution.shellConfirmed,
        flagRead: execution.flag !== undefined,
        candidateMatch: accepted,
        stages: execution.stages.map(({ name, ok }) => ({ name, ok })),
        transcript: execution.transcript,
      });
      const effect = await this.verifier.executeEffect({
        completionId,
        candidateHash,
        candidateArtifactId: candidateArtifact.id,
        attemptId,
        sessionId: execution.sessionId,
        cwd: before.task.scope.allowed_workspace,
        payload,
      }, signal);
      await this.verifier.recordEvidence(runId, {
        id: evidenceId,
        kind: accepted ? "reproduction" : "negative",
        summary: accepted
          ? "A fresh verifier-owned Pwn process passed all exploit stages, shell marker, and flag extraction barriers."
          : "A verifier-owned Pwn reproduction attempt failed or disagreed with the candidate.",
        tags: ["pwn", "reproduction", "clean-process"],
        source: {
          tool: "pwn_reproduce",
          effectId: effect.effectId,
          artifactId: effect.artifactId,
          artifactIds: [effect.artifactId, candidateArtifact.id],
          generation: before.generation,
        },
        confidence: 1,
        supports: accepted ? [completionId] : [],
        refutes: accepted ? [] : [completionId],
      });
      receipts.push({ attemptId, execution, accepted, effectId: effect.effectId, effectArtifactId: effect.artifactId, evidenceId });
    }

    const reproduced = receipts.length === requiredAttempts && receipts.every((receipt) => receipt.accepted);
    const evidenceIds = reproduced
      ? receipts.map((receipt) => receipt.evidenceId)
      : receipts.filter((receipt) => !receipt.accepted).map((receipt) => receipt.evidenceId);
    await this.verifier.finalize(runId, completionId, reproduced, evidenceIds);
    const first = receipts[0]?.execution;
    return {
      reproduced,
      shellConfirmed: Boolean(first?.shellConfirmed && receipts.every((receipt) => receipt.execution.shellConfirmed)),
      ...(reproduced && candidate ? { flag: candidate } : {}),
      stages: first?.stages ?? [],
      evidenceId: evidenceIds[0] ?? receipts[0]?.evidenceId ?? id("EV"),
      completionId,
      candidateHash,
    };
  }

  private async openVerifierSession(runId: string, generation: number): Promise<PwnSession> {
    const ref = this.refProvider();
    if (ref.runId !== runId || ref.generation !== generation) throw new Error("Pwn verifier session is bound to a stale container generation");
    if (this.policy.target.kind === "remote") {
      if (!this.policy.target.endpoint) throw new Error("Pwn verifier remote target requires an endpoint");
      return await PwnSession.openRemote(this.registry, {
        ref,
        ownerLane: "verifier",
        command: [...this.policy.target.command],
        endpoint: this.policy.target.endpoint,
      });
    }
    return await PwnSession.openLocal(this.registry, { ref, ownerLane: "verifier", command: [...this.policy.target.command] });
  }

  private assertTargetAllowed(scope: { allowed_hosts: string[]; allowed_ports: number[]; allowed_endpoints?: Array<{ host: string; port: number }> }): void {
    if (this.policy.target.kind !== "remote" || !this.policy.target.endpoint) return;
    const match = /^([^:]+):(\d+)$/.exec(this.policy.target.endpoint.trim());
    if (!match) throw new Error("Pwn verifier endpoint is not a valid host:port");
    const host = match[1]!.toLowerCase();
    const port = Number(match[2]);
    const endpointAllowed = scope.allowed_endpoints
      ? scope.allowed_endpoints.some((value) => value.host.toLowerCase() === host && value.port === port)
      : (scope.allowed_hosts.length === 0 || scope.allowed_hosts.some((value) => value === "*" || value.toLowerCase() === host))
        && (scope.allowed_ports.length === 0 || scope.allowed_ports.includes(port));
    if (!endpointAllowed) throw new Error(`Pwn verifier endpoint ${host}:${port} is outside the task scope`);
  }
}

async function readDurablePwnOutcome(
  artifactStore: ArtifactStore,
  runId: string,
  snapshot: Awaited<ReturnType<ControlStore["snapshot"]>>,
  completionId: string,
  candidateHash: string,
): Promise<{ shellConfirmed: boolean; stages: StageResult[] }> {
  const effects = Object.values(snapshot.effects)
    .filter((effect) => effect.operation === "pwn_reproduce"
      && effect.producerLane === "verifier"
      && effect.status === "FINISHED"
      && effect.verification?.valid
      && effect.verification.completionId === completionId
      && effect.verification.candidateHash === candidateHash)
    .sort((left, right) => left.createdSeq - right.createdSeq || left.id.localeCompare(right.id));
  const effect = effects[0];
  const artifact = effect?.artifactId ? snapshot.artifacts[effect.artifactId] : undefined;
  if (!effect || !artifact) return { shellConfirmed: false, stages: [] };
  try {
    const stored = JSON.parse(await artifactStore.readText(runId, artifact)) as { stdout?: unknown };
    const parsed = typeof stored.stdout === "string" ? JSON.parse(stored.stdout) as Record<string, unknown> : undefined;
    if (!parsed || parsed.schemaVersion !== 1 || parsed.candidateHash !== candidateHash
      || typeof parsed.shellConfirmed !== "boolean" || !Array.isArray(parsed.stages)
      || parsed.stages.length < 1 || parsed.stages.length > 64) {
      return { shellConfirmed: false, stages: [] };
    }
    const stages: StageResult[] = [];
    for (const value of parsed.stages) {
      if (!value || typeof value !== "object") return { shellConfirmed: false, stages: [] };
      const stage = value as Record<string, unknown>;
      if (typeof stage.name !== "string" || stage.name.length === 0 || stage.name.length > 160 || typeof stage.ok !== "boolean") {
        return { shellConfirmed: false, stages: [] };
      }
      stages.push({ name: stage.name, ok: stage.ok, ...(typeof stage.detail === "string" && stage.detail.length <= 512 ? { detail: stage.detail } : {}) });
    }
    return { shellConfirmed: parsed.shellConfirmed, stages };
  } catch {
    return { shellConfirmed: false, stages: [] };
  }
}
