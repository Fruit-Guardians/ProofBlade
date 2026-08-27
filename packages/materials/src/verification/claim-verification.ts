import type { ControlStore, VerifierControlPort } from "../control/control-store.js";
import type { ArtifactRef, DomainRecordInput, Evidence, RawEffectResult, RunSnapshot } from "../domain/types.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { EffectJournal, VerifierEffectJournal, VerifierReplayHandle, VerifierReplayInput } from "../effects/effect-journal.js";
import { CodingEvidenceGraph } from "../knowledge/evidence-graph.js";
import { beginVerificationRequest, readDurableVerificationResult } from "./verification-key.js";
import { parseVerifierOutcomeEnvelope, serializeVerifierOutcomeEnvelope, type VerifierOutcomeEnvelope } from "./outcome-envelope.js";
import { type LinkReasoningNodesInput } from "../knowledge/evidence-graph.js";

export interface ClaimReproduction {
  verified: boolean;
  candidate: string;
  candidateHash: string;
  commandHash: string;
  artifactId: string;
  candidateArtifactId: string;
  executionArtifactId: string;
  outcomeArtifactId: string;
  evidenceId: string;
  completionId: string;
  toolCallId: string;
  supportingEvidenceIds: string[];
}

export interface ClaimVerificationProjection {
  required: boolean;
  status: "not_required" | "verified" | "unverified";
  candidateHash?: string;
  commandHash?: string;
  artifactId?: string;
  evidenceId?: string;
  completionId?: string;
  outcomeArtifactId?: string;
  toolCallId?: string;
  reason?: string;
}

/** Keep candidate-shaped output visibly non-authoritative until projection verifies it. */
export function rewriteUnverifiedClaimText(assistantText: string, reason = "没有找到当前 generation 的受信复现链。"): string {
  const rewritten = assistantText.replace(/\bflag\s*[:：]/gi, "候选（未验证）：");
  if (rewritten.startsWith("[ProofBlade] 本轮候选未验证：")) return rewritten;
  return [`[ProofBlade] 本轮候选未验证：${reason}`, rewritten].filter((value) => value.length > 0).join("\n");
}

interface ClaimReceipt {
  schemaVersion: 3;
  kind: "claim_reproduction";
  runId: string;
  taskId: string;
  taskHash: string;
  generation: number;
  completionId: string;
  candidateHash: string;
  candidateArtifactId: string;
  commandHash: string;
  effectId: string;
  executionArtifactId: string;
  sessionId: string;
  attemptId: string;
  outputHash: string;
  exitCode: number | null;
  targetHash: string;
  verificationRuleHash: string;
  recordedAt: string;
}

export class CodingClaimVerifier {
  public constructor(
    private readonly runId: string,
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
    private readonly journal: EffectJournal,
    private readonly verifierJournal: VerifierEffectJournal,
    private readonly verifierControl: VerifierControlPort,
  ) {}

  /** Commit verifier-owned Evidence without exposing the verifier port to the lane. */
  public async recordVerifierEvidence(evidence: Omit<Evidence, "createdSeq" | "provenance">): Promise<void> {
    await this.verifierControl.dispatch(this.runId, { type: "evidence", evidence });
  }

  /** Commit verifier-owned Web/Pwn domain records after their Evidence is durable. */
  public async recordVerifierDomainRecords(records: DomainRecordInput[]): Promise<void> {
    if (records.length === 0) return;
    await this.verifierControl.dispatchBatch(this.runId, records.map((record) => ({ type: "domain_record", record })));
  }

  /** Persist an external verifier replay before opening its clean resource. */
  public async prepareReplay(input: VerifierReplayInput): Promise<VerifierReplayHandle> {
    return await this.journal.prepareVerifierReplay(this.runId, input);
  }

  /** Bind a clean session to a prepared verifier replay. */
  public async startReplay(effectId: string, sessionId: string, externalId?: string): Promise<void> {
    await this.journal.startVerifierReplay(this.runId, effectId, sessionId, externalId);
  }

  /** Persist a replay result without claiming a candidate verdict. */
  public async finishReplay(effectId: string, result: RawEffectResult): Promise<{ effectId: string; artifactId: string }> {
    return await this.journal.finishVerifierReplay(this.runId, effectId, result);
  }

  /** Execute a verifier-owned web attestation without exposing the verifier port to the lane. */
  public async executeWebReproductionEffect(input: {
    completionId: string;
    candidateHash: string;
    candidateArtifactId: string;
    attemptId: string;
    sessionId: string;
    cwd: string;
    payload: string;
  }, signal?: AbortSignal): Promise<{ effectId: string; artifactId: string }> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const execution = await this.journal.executeVerifierWith(this.runId, {
      operation: "web_reproduce",
      args: {
        runId: this.runId,
        taskId: snapshot.task.task_id,
        generation: snapshot.generation,
        completionId: input.completionId,
        candidateHash: input.candidateHash,
        candidateArtifactId: input.candidateArtifactId,
        taskHash: snapshot.taskHash,
        targetHash: sha256(snapshot.task.target),
        verificationRuleHash: sha256(canonicalJson(snapshot.task.verification)),
        attemptId: input.attemptId,
      },
      replayPolicy: "pure",
      cwd: input.cwd,
      sessionId: input.sessionId,
      artifactSensitivity: "flag_candidate",
      recoveryInput: { content: input.payload, filename: `web-verifier-input-${input.attemptId}.json`, mime: "application/json", sensitivity: "flag_candidate" },
    }, async () => ({ stdout: input.payload, stderr: "", exitCode: 0, durationMs: 0 }), signal);
    return { effectId: execution.effectId, artifactId: execution.artifactId };
  }

  /** Execute a verifier-owned browser clean-context attestation. */
  public async executeBrowserReproductionEffect(input: {
    completionId: string;
    candidateHash: string;
    candidateArtifactId: string;
    attemptId: string;
    sessionId: string;
    cwd: string;
    payload: string;
  }, signal?: AbortSignal): Promise<{ effectId: string; artifactId: string }> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const execution = await this.journal.executeVerifierWith(this.runId, {
      operation: "browser_reproduce",
      args: {
        runId: this.runId,
        taskId: snapshot.task.task_id,
        generation: snapshot.generation,
        completionId: input.completionId,
        candidateHash: input.candidateHash,
        candidateArtifactId: input.candidateArtifactId,
        taskHash: snapshot.taskHash,
        targetHash: sha256(snapshot.task.target),
        verificationRuleHash: sha256(canonicalJson(snapshot.task.verification)),
        attemptId: input.attemptId,
      },
      replayPolicy: "pure",
      cwd: input.cwd,
      sessionId: input.sessionId,
      artifactSensitivity: "flag_candidate",
      recoveryInput: { content: input.payload, filename: `browser-verifier-input-${input.attemptId}.json`, mime: "application/json", sensitivity: "flag_candidate" },
    }, async () => ({ stdout: input.payload, stderr: "", exitCode: 0, durationMs: 0 }), signal);
    return { effectId: execution.effectId, artifactId: execution.artifactId };
  }

  /** Execute a verifier-owned Pwn attestation over a fresh session transcript. */
  public async executePwnReproductionEffect(input: {
    completionId: string;
    candidateHash: string;
    candidateArtifactId: string;
    attemptId: string;
    sessionId: string;
    cwd: string;
    payload: string;
  }, signal?: AbortSignal): Promise<{ effectId: string; artifactId: string }> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const pwnEndpoint = snapshot.task.verification.pwn?.target.kind === "remote"
      ? parsePwnEndpoint(snapshot.task.verification.pwn.target.endpoint)
      : undefined;
    const execution = await this.journal.executeVerifierWith(this.runId, {
      operation: "pwn_reproduce",
      args: {
        runId: this.runId,
        taskId: snapshot.task.task_id,
        generation: snapshot.generation,
        completionId: input.completionId,
        candidateHash: input.candidateHash,
        candidateArtifactId: input.candidateArtifactId,
        taskHash: snapshot.taskHash,
        targetHash: sha256(snapshot.task.target),
        verificationRuleHash: sha256(canonicalJson(snapshot.task.verification)),
        commandHash: sha256(snapshot.task.verification.command ?? ""),
        attemptId: input.attemptId,
        ...(pwnEndpoint ? { endpoint: pwnEndpoint } : {}),
      },
      replayPolicy: "pure",
      command: snapshot.task.verification.command,
      cwd: input.cwd,
      sessionId: input.sessionId,
      artifactSensitivity: "flag_candidate",
      recoveryInput: { content: input.payload, filename: `pwn-verifier-input-${input.attemptId}.json`, mime: "application/json", sensitivity: "flag_candidate" },
    }, async () => ({ stdout: input.payload, stderr: "", exitCode: 0, durationMs: 0 }), signal);
    return { effectId: execution.effectId, artifactId: execution.artifactId };
  }

  /** Mark a web verifier Completion accepted/rejected after its bound Evidence is recorded. */
  public async finalizeWebReproduction(completionId: string, accepted: boolean, evidenceIds: string[]): Promise<void> {
    await this.verifierControl.dispatch(this.runId, { type: "completion_verified", completionId, accepted, evidenceIds });
  }

  /** Mark a browser verifier Completion accepted/rejected after its Evidence is recorded. */
  public async finalizeBrowserReproduction(completionId: string, accepted: boolean, evidenceIds: string[]): Promise<void> {
    await this.verifierControl.dispatch(this.runId, { type: "completion_verified", completionId, accepted, evidenceIds });
  }

  /** Mark a Pwn verifier Completion accepted/rejected after its bound Evidence. */
  public async finalizePwnReproduction(completionId: string, accepted: boolean, evidenceIds: string[]): Promise<void> {
    await this.verifierControl.dispatch(this.runId, { type: "completion_verified", completionId, accepted, evidenceIds });
  }

  /** Execute and attest a claim through a journaled verifier Effect. */
  public async record(input: {
    candidate: string;
    command: string;
    cwd: string;
    toolCallId: string;
    supportingEvidenceIds?: string[];
    signal?: AbortSignal;
    /** Used only for non-task-bound observational commands. */
    execute?: (signal: AbortSignal) => Promise<RawEffectResult>;
  }): Promise<ClaimReproduction> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const candidate = input.candidate.trim();
    const command = input.command.trim();
    if (!candidate || !command || !input.toolCallId.trim()) throw new Error("Claim reproduction requires a candidate, command, and tool call id");
    if (command.includes(candidate)) throw new Error("Reproduction command embeds the candidate literal; derive it from workspace inputs instead");
    const candidateHash = sha256(candidate);
    const commandHash = sha256(command);
    const supportingEvidenceIds = [...new Set(input.supportingEvidenceIds ?? [])];
    const taskBoundCommand = snapshot.task.verification.kind === "reproduction"
      && typeof snapshot.task.verification.command === "string"
      ? snapshot.task.verification.command.trim()
      : undefined;
    const verifierDefinedCommand = taskBoundCommand === command;
    if (taskBoundCommand && !verifierDefinedCommand) {
      throw new Error("verify_claim must use the exact immutable task-bound verification command");
    }
    const missingEvidence = supportingEvidenceIds.filter((evidenceId) => !snapshot.evidence[evidenceId]);
    if (missingEvidence.length > 0) throw new Error(`Unknown supporting evidence ids: ${missingEvidence.join(", ")}`);
    for (const evidenceId of supportingEvidenceIds) {
      const evidence = snapshot.evidence[evidenceId]!;
      if (evidence.provenance?.runId !== this.runId || evidence.provenance?.generation !== snapshot.generation) throw new Error(`Supporting evidence is stale: ${evidenceId}`);
    }

    const request = await beginVerificationRequest(this.controlStore, this.runId, {
      kind: "claim",
      policyHash: sha256(canonicalJson({ taskHash: snapshot.taskHash, verification: snapshot.task.verification })),
      recipeHash: sha256(canonicalJson({ candidateHash, commandHash })),
      sourceIds: supportingEvidenceIds,
    });
    if (!request.created) {
      const durable = await readDurableVerificationResult(this.controlStore, this.runId, request.request);
      if (!durable) throw new Error(`Claim verification request ${request.request.id} requires durable recovery; refusing to execute another command`);
      const durableSnapshot = await this.controlStore.snapshot(this.runId);
      const candidateArtifact = durableSnapshot.artifacts[durable.completion.artifactId];
      if (!candidateArtifact) throw new Error(`Durable claim candidate is missing: ${durable.completion.artifactId}`);
      const durableCandidate = (await this.artifactStore.readText(this.runId, candidateArtifact)).trim();
      const projection = await this.projectCompletion(durableSnapshot, durable.completion, durableCandidate);
      if (!projection || !projection.evidenceId) throw new Error(`Durable claim verification ${durable.completion.id} is incomplete`);
      const evidence = durableSnapshot.evidence[projection.evidenceId];
      const effect = evidence?.source.effectId ? durableSnapshot.effects[evidence.source.effectId] : undefined;
      if (!evidence || !effect) throw new Error(`Durable claim verification ${durable.completion.id} has no bound Effect`);
      const receipt = await this.findClaimReceipt(durableSnapshot, durable.completion, durableCandidate, evidence, effect);
      if (!receipt) throw new Error(`Durable claim verification ${durable.completion.id} has no valid receipt`);
      return {
        verified: true,
        candidate: durableCandidate,
        candidateHash: durable.completion.candidateHash,
        commandHash: receipt.commandHash,
        artifactId: receiptArtifactId(durableSnapshot, evidence, receipt),
        candidateArtifactId: durable.completion.artifactId,
        executionArtifactId: receipt.executionArtifactId,
        outcomeArtifactId: projection.outcomeArtifactId ?? receiptArtifactId(durableSnapshot, evidence, receipt),
        evidenceId: projection.evidenceId,
        completionId: durable.completion.id,
        toolCallId: receipt.sessionId,
        supportingEvidenceIds,
      };
    }

    const completionId = id("C");
    const factId = id("F");
    const candidateArtifact = await this.artifactStore.putText(this.runId, candidate, {
      filename: `claim-candidate-${input.toolCallId}.txt`,
      mime: "text/plain",
      sensitivity: "flag_candidate",
      semantic: {
        name: "最终候选",
        summary: `等待受信复现的候选 sha256=${candidateHash}.`,
        tags: ["verification", "candidate"],
        role: "result",
        relatedIds: supportingEvidenceIds,
        annotatedBy: "harness",
      },
    });
    await this.controlStore.dispatch(this.runId, {
      type: "completion_proposed",
      completion: { id: completionId, purpose: "claim_reproduction", candidateHash, artifactId: candidateArtifact.id, verificationKey: request.request.key },
      lane: "main",
    });

    const boundSnapshot = await this.controlStore.snapshot(this.runId);
    const signal = input.signal ?? new AbortController().signal;
    const requiredAttempts = verifierDefinedCommand ? Math.max(1, boundSnapshot.task.verification.required_reproductions) : 1;
    const operation = verifierDefinedCommand ? "claim_reproduction" : "claim_observation";
    const attempts: Array<{
      attemptId: string;
      sessionId: string;
      evidenceId: string;
      execution: { effectId: string; result: RawEffectResult; artifactId: string };
      receiptArtifact: ArtifactRef;
    }> = [];
    for (let attemptIndex = 0; attemptIndex < requiredAttempts; attemptIndex += 1) {
      const sessionId = requiredAttempts === 1 ? input.toolCallId : `${input.toolCallId}:attempt-${attemptIndex + 1}`;
      const attemptId = sha256(`${this.runId}:${completionId}:${boundSnapshot.generation}:${sessionId}:${commandHash}`);
      const effectInput = {
        operation,
        args: {
          runId: this.runId,
          taskId: boundSnapshot.task.task_id,
          generation: boundSnapshot.generation,
          completionId,
          candidateHash,
          candidateArtifactId: candidateArtifact.id,
          taskHash: boundSnapshot.taskHash,
          targetHash: sha256(boundSnapshot.task.target),
          verificationRuleHash: sha256(canonicalJson(boundSnapshot.task.verification)),
          commandHash,
          toolCallId: input.toolCallId,
          attemptId,
        },
        replayPolicy: "pure",
        command,
        cwd: input.cwd,
        sessionId,
        artifactSensitivity: "flag_candidate",
      } as const;
      const execution = verifierDefinedCommand
        ? await this.verifierJournal.execute(this.runId, effectInput, signal)
        : await this.journal.executeWith(this.runId, effectInput, async (_request, innerSignal) => {
          if (!input.execute) throw new Error("A model-supplied claim command requires the ordinary lane executor");
          const result = await input.execute(innerSignal);
          if (result.exitCode !== 0) return result;
          if (!stdoutContainsExactCandidate(result.stdout, candidate)) return { ...result, stderr: `${result.stderr}\nreproduction output did not contain the exact candidate`, exitCode: 1 };
          return result;
        }, signal);
      if (execution.result.exitCode !== 0 || !stdoutContainsExactCandidate(execution.result.stdout, candidate)) throw new Error("Reproduction command did not successfully derive the exact candidate");

      const receipt: ClaimReceipt = {
        schemaVersion: 3,
        kind: "claim_reproduction",
        runId: this.runId,
        taskId: boundSnapshot.task.task_id,
        taskHash: boundSnapshot.taskHash,
        generation: boundSnapshot.generation,
        completionId,
        candidateHash,
        candidateArtifactId: candidateArtifact.id,
        commandHash,
        effectId: execution.effectId,
        executionArtifactId: execution.artifactId,
        sessionId,
        attemptId,
        outputHash: sha256(`${execution.result.stdout}\n${execution.result.stderr}`),
        exitCode: execution.result.exitCode,
        targetHash: sha256(boundSnapshot.task.target),
        verificationRuleHash: sha256(canonicalJson(boundSnapshot.task.verification)),
        recordedAt: new Date().toISOString(),
      };
      const receiptArtifact = await this.artifactStore.putText(this.runId, canonicalJson(receipt), {
        filename: `claim-reproduction-${input.toolCallId}-${attemptIndex + 1}.json`,
        mime: "application/json",
        sensitivity: "flag_candidate",
        semantic: {
          name: "最终候选复现收据",
          summary: `候选 ${candidateHash.slice(0, 12)}... 由 effect ${execution.effectId} 成功复现。`,
          tags: ["verification", "candidate", "reproduction", "receipt"],
          role: "result",
          relatedIds: [...supportingEvidenceIds, completionId, candidateArtifact.id, execution.artifactId],
          annotatedBy: "harness",
        },
      });
      attempts.push({ attemptId, sessionId, evidenceId: id("EV"), execution, receiptArtifact });
    }

    const evidenceCommands = attempts.map(({ evidenceId, execution, receiptArtifact }) => ({
      type: "evidence" as const,
      evidence: {
        id: evidenceId,
        kind: verifierDefinedCommand ? "reproduction" as const : "observation" as const,
        name: verifierDefinedCommand ? "最终候选复现通过" : "候选命令执行记录",
        summary: verifierDefinedCommand
          ? `Candidate sha256=${candidateHash} reproduced by the task-defined command sha256=${commandHash}.`
          : `Candidate sha256=${candidateHash} appeared in an audited model-supplied command sha256=${commandHash}; this is not verifier-grade reproduction Evidence.`,
        tags: verifierDefinedCommand ? ["verification", "candidate", "reproduction"] : ["verification", "candidate", "untrusted-command"],
        dependsOn: supportingEvidenceIds,
        source: {
          tool: operation,
          effectId: execution.effectId,
          artifactId: execution.artifactId,
          artifactIds: [execution.artifactId, receiptArtifact.id, candidateArtifact.id],
          generation: boundSnapshot.generation,
        },
        confidence: verifierDefinedCommand ? 1 : 0.9,
        supports: [completionId],
        refutes: [],
      },
    }));
    const evidenceIds = attempts.map((attempt) => attempt.evidenceId);
    const locallyJudged = verifierDefinedCommand;
    const primary = attempts[0]!;
    const outcomeEnvelope = serializeVerifierOutcomeEnvelope({
      schemaVersion: 1,
      requestKey: request.request.key,
      runId: this.runId,
      generation: boundSnapshot.generation,
      kind: "claim",
      policyHash: request.request.policyHash,
      recipeHash: request.request.recipeHash,
      candidateHash,
      externalStatus: "CONFIRMED",
      attempts: attempts.map((attempt, index) => ({
        id: attempt.attemptId,
        phase: verifierDefinedCommand ? "claim_reproduction" : "claim_observation",
        status: "PASSED",
        artifactId: attempt.execution.artifactId,
        summary: verifierDefinedCommand
          ? `Verifier attempt ${index + 1} derived the exact candidate.`
          : `Audited observation ${index + 1} contained the exact candidate.`,
      })),
      primaryArtifactId: primary.execution.artifactId,
      transcriptArtifactIds: attempts.map((attempt) => attempt.execution.artifactId),
      stageSummary: {
        attemptCount: attempts.length,
        requiredAttempts,
        verifierDefinedCommand,
      },
      accepted: locallyJudged,
      evidenceIds,
      terminal: true,
    });
    const outcomeArtifact = await this.artifactStore.putText(this.runId, outcomeEnvelope, {
      filename: `claim-outcome-${input.toolCallId}.json`,
      mime: "application/json",
      sensitivity: "flag_candidate",
      semantic: {
        name: "最终候选验证结果索引",
        summary: `Claim outcome envelope for candidate sha256=${candidateHash}.`,
        tags: ["verification", "candidate", "outcome", "attestation"],
        role: "result",
        relatedIds: [...supportingEvidenceIds, completionId, candidateArtifact.id, ...attempts.flatMap((attempt) => [attempt.execution.artifactId, attempt.receiptArtifact.id])],
        annotatedBy: "harness",
      },
    });
    for (const evidenceCommand of evidenceCommands) evidenceCommand.evidence.source.artifactIds.push(outcomeArtifact.id);
    if (verifierDefinedCommand) {
      await this.verifierControl.dispatchBatch(this.runId, [
        ...evidenceCommands,
        { type: "completion_verified", completionId, accepted: true, evidenceIds },
      ]);
    } else {
      await this.controlStore.dispatch(this.runId, { ...evidenceCommands[0]!, lane: "executor" });
    }
    const factCommand = {
      type: "fact" as const,
      fact: {
        id: factId,
        statement: `${verifierDefinedCommand ? "Reproduced" : "Observed"} claim sha256=${candidateHash}`,
        status: verifierDefinedCommand ? "CONFIRMED" as const : "PROPOSED" as const,
        evidenceIds: [...supportingEvidenceIds, ...evidenceIds],
      },
    };
    if (verifierDefinedCommand) await this.verifierControl.dispatch(this.runId, factCommand);
    else await this.controlStore.dispatch(this.runId, { ...factCommand, lane: "executor" });

    const graph = new CodingEvidenceGraph(this.runId, this.controlStore, this.artifactStore);
    const graphLinks: LinkReasoningNodesInput[] = [{ from: candidateArtifact.id, to: completionId, relation: "derived_from", explanation: "The exact candidate Artifact is hash-bound to this Completion.", confidence: 1 }];
    for (const attempt of attempts) {
      graphLinks.push(
        { from: attempt.execution.artifactId, to: attempt.evidenceId, relation: "derived_from", explanation: "Journaled execution Artifact generated verifier Evidence.", confidence: 1 },
        { from: attempt.receiptArtifact.id, to: attempt.evidenceId, relation: "derived_from", explanation: "Immutable verifier receipt anchors the reproduction provenance.", confidence: 1 },
        { from: outcomeArtifact.id, to: attempt.evidenceId, relation: "derived_from", explanation: "The bounded outcome envelope indexes the final claim attestation.", confidence: 1 },
        ...supportingEvidenceIds.map((supportingEvidenceId) => ({ from: supportingEvidenceId, to: attempt.evidenceId, relation: "depends_on" as const, explanation: "Final reproduction uses this upstream Evidence.", confidence: 1 })),
        { from: attempt.evidenceId, to: factId, relation: "supports", explanation: "Reproduction Evidence confirms the hash-bound claim.", confidence: 1 },
        { from: attempt.evidenceId, to: completionId, relation: "reproduces", explanation: "Reproduction Evidence verifies this exact Completion.", confidence: 1 },
      );
    }
    await graph.linkNodesBatch(graphLinks);
    const graphSnapshot = await this.controlStore.snapshot(this.runId);
    const relatedTreeIds = Object.values(graphSnapshot.reasoningTrees).filter((tree) => supportingEvidenceIds.some((value) => tree.nodeIds.includes(value))).map((tree) => tree.id);
    await graph.createTree({
      name: locallyJudged ? "最终候选复现" : "候选观察链",
      summary: locallyJudged
        ? `候选 ${candidateHash.slice(0, 12)}... 已由当前 generation 的 journaled verifier effect 复现。`
        : `候选 ${candidateHash.slice(0, 12)}... 来自模型命令观察，等待任务绑定的 verifier 规则。`,
      purpose: "汇总最终结论、上游分析依据与可重复验证结果。",
      explanation: locallyJudged
        ? "该树以 Completion 为根，连接候选、执行记录、收据、reproduction Evidence 与确认 Fact。"
        : "该树只记录模型命令观察，不代表候选已通过受信 verifier。",
      rootNodeId: completionId,
      nodeIds: [candidateArtifact.id, outcomeArtifact.id, ...attempts.flatMap((attempt) => [attempt.execution.artifactId, attempt.receiptArtifact.id, attempt.evidenceId]), ...supportingEvidenceIds, factId, completionId],
      relatedTreeIds,
      tags: ["verification", "candidate", "reproduction"],
      status: locallyJudged ? "SUPPORTED" : "ACTIVE",
    });

    return { verified: locallyJudged, candidate, candidateHash, commandHash, artifactId: primary.receiptArtifact.id, candidateArtifactId: candidateArtifact.id, executionArtifactId: primary.execution.artifactId, outcomeArtifactId: outcomeArtifact.id, evidenceId: primary.evidenceId, completionId, toolCallId: input.toolCallId, supportingEvidenceIds };
  }

  /** Rebuild verification exclusively from durable current-generation state. */
  public async project(userPrompt: string, assistantText: string): Promise<ClaimVerificationProjection> {
    const required = requiresClaimVerification(userPrompt, assistantText);
    if (!required) return { required: false, status: "not_required" };
    const candidate = extractFinalCandidate(assistantText);
    if (!candidate) return { required: true, status: "unverified", reason: "最终回答没有唯一、明确的候选值。" };
    const candidateHash = sha256(candidate);
    const snapshot = await this.controlStore.snapshot(this.runId);
    const completions = Object.values(snapshot.completions)
      .filter((completion) => completion.status === "ACCEPTED" && completion.runId === this.runId && completion.generation === snapshot.generation && completion.candidateHash === candidateHash)
      .sort((left, right) => right.createdSeq - left.createdSeq || left.id.localeCompare(right.id));
    for (const completion of completions) {
      const projection = await this.projectCompletion(snapshot, completion, candidate);
      if (projection) return projection;
    }
    return { required: true, status: "unverified", reason: "没有找到与最终候选哈希精确匹配的当前 generation 完整验证链。" };
  }

  private async projectCompletion(snapshot: RunSnapshot, completion: RunSnapshot["completions"][string], candidate: string): Promise<ClaimVerificationProjection | undefined> {
    const candidateArtifact = snapshot.artifacts[completion.artifactId];
    if (!candidateArtifact || candidateArtifact.runId !== this.runId || candidateArtifact.generation !== snapshot.generation || candidateArtifact.sha256 !== completion.candidateHash) return undefined;
    try {
      if ((await this.artifactStore.readText(this.runId, candidateArtifact)).trim() !== candidate) return undefined;
    } catch {
      return undefined;
    }
    const requiredReproductions = Math.max(1, snapshot.task.verification.required_reproductions);
    if (completion.evidenceIds.length < requiredReproductions) return undefined;
    const projected = completion.evidenceIds.map((evidenceId) => snapshot.evidence[evidenceId]);
    if (projected.some((value) => !value || value.kind !== "reproduction" || value.provenance?.runId !== this.runId || value.provenance?.generation !== snapshot.generation || value.provenance?.recordedBy !== "verifier" || !value.supports.includes(completion.id))) return undefined;
    const evidence = projected as Evidence[];
    const effectIds = new Set<string>();
    const sessionIds = new Set<string>();
    const attemptIds = new Set<string>();
    const transcriptHashes = new Set<string>();
    const receipts: ClaimReceipt[] = [];
    for (const item of evidence) {
      const effect = item.provenance.effect ? snapshot.effects[item.provenance.effect.id] : undefined;
      const verdict = effect?.verification;
      const effectArtifact = effect?.artifactId ? snapshot.artifacts[effect.artifactId] : undefined;
      if (!effect || !effectArtifact || effect.status !== "FINISHED" || effect.outcome !== "success" || effect.exitCode !== 0
        || effect.producerLane !== "verifier" || effect.generation !== snapshot.generation
        || effect.artifactId !== item.source.artifactId || effectArtifact.sourceEffectId !== effect.id
        || effect.sessionId !== item.provenance.effect?.sessionId
        || !verdict?.valid || !verdict.accepted || verdict.runId !== this.runId || verdict.taskId !== snapshot.task.task_id
        || verdict.taskHash !== snapshot.taskHash || verdict.generation !== snapshot.generation
        || verdict.completionId !== completion.id || verdict.candidateHash !== completion.candidateHash
        || verdict.candidateArtifactId !== completion.artifactId || verdict.operation !== effect.operation
        || verdict.sessionId !== effect.sessionId || verdict.attemptId !== effect.args.attemptId
        || verdict.resultArtifactId !== effect.artifactId || verdict.resultArtifactSha256 !== effectArtifact.sha256
        || verdict.transcriptHash !== effectArtifact.sha256) return undefined;
      effectIds.add(effect.id);
      sessionIds.add(verdict.sessionId);
      attemptIds.add(verdict.attemptId);
      transcriptHashes.add(verdict.transcriptHash);
      if (effect.operation !== "claim_reproduction") continue;
      const receipt = await this.findClaimReceipt(snapshot, completion, candidate, item, effect);
      if (!receipt) return undefined;
      receipts.push(receipt);
    }
    if (effectIds.size !== evidence.length || sessionIds.size !== evidence.length || attemptIds.size !== evidence.length || transcriptHashes.size !== evidence.length) return undefined;
    const request = completion.verificationKey
      ? Object.values(snapshot.verificationRequests).find((value) => value.key === completion.verificationKey)
      : undefined;
    if (!request || request.kind !== "claim" || request.runId !== this.runId || request.generation !== snapshot.generation
      || request.status !== "BOUND" || request.completionId !== completion.id) return undefined;
    const outcome = await this.findClaimOutcome(snapshot, completion, evidence, request);
    if (!outcome) return undefined;
    const primary = evidence[0]!;
    const receipt = receipts[0];
    return { required: true, status: "verified", candidateHash: completion.candidateHash, commandHash: receipt?.commandHash, artifactId: completion.artifactId, evidenceId: primary.id, completionId: completion.id, outcomeArtifactId: outcome.artifactId, toolCallId: receipt?.sessionId };
  }

  private async findClaimOutcome(
    snapshot: RunSnapshot,
    completion: RunSnapshot["completions"][string],
    evidence: Evidence[],
    request: RunSnapshot["verificationRequests"][string],
  ): Promise<{ artifactId: string; envelope: VerifierOutcomeEnvelope } | undefined> {
    const evidenceIds = evidence.map((item) => item.id);
    const executionArtifactIds = evidence.map((item) => item.source.artifactId).filter((value): value is string => typeof value === "string");
    if (executionArtifactIds.length !== evidence.length) return undefined;
    for (const artifactId of new Set(evidence.flatMap((item) => item.provenance.artifactIds))) {
      const artifact = snapshot.artifacts[artifactId];
      if (!artifact || artifact.sourceEffectId !== undefined || artifact.mime !== "application/json"
        || artifact.runId !== this.runId || artifact.generation !== snapshot.generation) continue;
      try {
        const envelope = parseVerifierOutcomeEnvelope(JSON.parse(await this.artifactStore.readText(this.runId, artifact)));
        if (envelope.kind !== "claim"
          || envelope.requestKey !== request.key
          || envelope.runId !== this.runId
          || envelope.generation !== snapshot.generation
          || envelope.policyHash !== request.policyHash
          || envelope.recipeHash !== request.recipeHash
          || envelope.candidateHash !== completion.candidateHash
          || envelope.externalStatus !== "CONFIRMED"
          || envelope.accepted !== true
          || !envelope.terminal
          || !sameIds(envelope.evidenceIds, evidenceIds)
          || envelope.attempts.length !== evidence.length
          || envelope.attempts.some((attempt) => attempt.status !== "PASSED" || !attempt.artifactId || !executionArtifactIds.includes(attempt.artifactId))
          || !sameIds(envelope.transcriptArtifactIds, executionArtifactIds)
          || envelope.primaryArtifactId !== executionArtifactIds[0]) continue;
        const attemptArtifactIds = envelope.attempts.map((attempt) => attempt.artifactId).filter((value): value is string => typeof value === "string");
        if (attemptArtifactIds.length !== evidence.length || !sameIds(attemptArtifactIds, executionArtifactIds)
          || evidence.some((item) => !item.provenance.artifactIds.includes(artifact.id))) continue;
        return { artifactId: artifact.id, envelope };
      } catch {
        // Receipt and execution Artifacts are also JSON; only a valid, bound
        // final envelope is allowed to attest the Completion.
      }
    }
    return undefined;
  }

  private async findClaimReceipt(
    snapshot: RunSnapshot,
    completion: RunSnapshot["completions"][string],
    candidate: string,
    evidence: Evidence,
    effect: RunSnapshot["effects"][string],
  ): Promise<ClaimReceipt | undefined> {
    for (const artifactId of evidence.provenance.artifactIds) {
      const artifact = snapshot.artifacts[artifactId];
      // The Effect's single verifier-authority Artifact is the immutable raw
      // execution result. The claim receipt is a separate derived Artifact,
      // made trustworthy by its immutable inclusion in verifier-recorded
      // Evidence and by the exact effect/result hashes checked below.
      if (!artifact || artifact.id === effect.artifactId || artifact.sourceEffectId !== undefined
        || artifact.mime !== "application/json" || artifact.runId !== this.runId
        || artifact.generation !== snapshot.generation) continue;
      try {
        const parsed = JSON.parse(await this.artifactStore.readText(this.runId, artifact)) as Partial<ClaimReceipt>;
        if (parsed.schemaVersion !== 3
          || parsed.kind !== "claim_reproduction"
          || parsed.runId !== this.runId
          || parsed.taskId !== snapshot.task.task_id
          || parsed.taskHash !== snapshot.taskHash
          || parsed.generation !== snapshot.generation
          || parsed.completionId !== completion.id
          || parsed.candidateHash !== completion.candidateHash
          || parsed.candidateArtifactId !== completion.artifactId
          || parsed.effectId !== effect.id
          || typeof parsed.executionArtifactId !== "string"
          || parsed.executionArtifactId !== effect.artifactId
          || parsed.sessionId !== effect.sessionId
          || parsed.attemptId !== effect.verification?.attemptId
          || parsed.commandHash !== effect.commandHash
          || parsed.exitCode !== 0
          || parsed.targetHash !== sha256(snapshot.task.target)
          || parsed.verificationRuleHash !== sha256(canonicalJson(snapshot.task.verification))) continue;
        const executionArtifact = snapshot.artifacts[parsed.executionArtifactId];
        if (!executionArtifact || executionArtifact.sourceEffectId !== effect.id || executionArtifact.generation !== snapshot.generation) continue;
        const execution = JSON.parse(await this.artifactStore.readText(this.runId, executionArtifact)) as Partial<RawEffectResult>;
        if (typeof execution.stdout !== "string" || typeof execution.stderr !== "string" || execution.exitCode !== 0 || !stdoutContainsExactCandidate(execution.stdout, candidate)) continue;
        if (parsed.outputHash !== sha256(`${execution.stdout}\n${execution.stderr}`)) continue;
        return parsed as ClaimReceipt;
      } catch {
        // Malformed receipt or execution Artifact: fail closed for this attempt.
      }
    }
    return undefined;
  }
}

function parsePwnEndpoint(endpoint: string | undefined): { host: string; port: number } | undefined {
  if (!endpoint) return undefined;
  const match = /^([^:]+):(\d+)$/.exec(endpoint.trim());
  if (!match) return undefined;
  const port = Number(match[2]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? { host: match[1]!.toLowerCase(), port } : undefined;
}

function receiptArtifactId(snapshot: RunSnapshot, evidence: Evidence, receipt: ClaimReceipt): string {
  return evidence.provenance.artifactIds.find((artifactId) => {
    const artifact = snapshot.artifacts[artifactId];
    return artifact?.mime === "application/json" && artifact.sourceEffectId === undefined;
  }) ?? receipt.executionArtifactId;
}

export function requiresClaimVerification(userPrompt: string, assistantText = ""): boolean {
  const prompt = userPrompt.toLowerCase();
  const answer = assistantText.toLowerCase();
  const challengeContext = /(?:\bctf\b|\bchallenge\b|这道题|题目|解题|逆向题|夺旗|靶题|破解|恢复.{0,12}(?:保护内容|密钥|明文))/.test(prompt);
  const resultRequest = /(?:\bflag\b|答案|最终结果|候选|密钥|口令|解密结果)/.test(prompt);
  const directFlagRequest = /(?:得到|找出|找到|求出|解出|恢复|提交|give|find|get|recover).{0,12}\bflag\b/.test(prompt)
    || /\bflag\b.{0,12}(?:是什么|在哪|结果|value)/.test(prompt);
  const flagShapedAnswer = /(?:\b[a-z0-9_]{0,24})?flag\s*\{[^}\r\n]{1,512}\}/i.test(assistantText)
    || /\bPB\{[^}\r\n]{1,512}\}/.test(assistantText);
  return flagShapedAnswer || directFlagRequest || (challengeContext && resultRequest) || (challengeContext && /(?:完成|solve|恢复|解密)/.test(prompt) && answer.includes("flag"));
}

function extractFinalCandidate(assistantText: string): string | undefined {
  const shaped = [...assistantText.matchAll(/\b(?:[a-z0-9_]{0,32})?flag\{[^}\r\n]{1,512}\}|\bPB\{[^}\r\n]{1,512}\}/gi)].map((match) => match[0]);
  const unique = [...new Set(shaped)];
  if (unique.length === 1) return unique[0];
  const explicit = [...assistantText.matchAll(/(?:最终(?:结果|答案|候选)|final(?:\s+answer)?|answer)\s*[:：]\s*[`"']?([^`"'\r\n]{1,1024})/gi)]
    .map((match) => match[1]?.trim().replace(/[。.;；]+$/, ""))
    .filter((value): value is string => Boolean(value));
  const explicitUnique = [...new Set(explicit)];
  return explicitUnique.length === 1 ? explicitUnique[0] : undefined;
}

function stdoutContainsExactCandidate(stdout: string, candidate: string): boolean {
  return stdout.split(/\r?\n/).some((line) => line.trim() === candidate);
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
