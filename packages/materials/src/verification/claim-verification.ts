import type { ControlStore, VerifierControlPort } from "../control/control-store.js";
import type { ArtifactRef, Evidence, RawEffectResult, RunSnapshot } from "../domain/types.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { EffectJournal, VerifierEffectJournal } from "../effects/effect-journal.js";
import { CodingEvidenceGraph } from "../knowledge/evidence-graph.js";

export interface ClaimReproduction {
  verified: boolean;
  candidate: string;
  candidateHash: string;
  commandHash: string;
  artifactId: string;
  candidateArtifactId: string;
  executionArtifactId: string;
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
  toolCallId?: string;
  reason?: string;
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
    const verifierDefinedCommand = snapshot.task.verification.kind === "reproduction"
      && typeof snapshot.task.verification.command === "string"
      && snapshot.task.verification.command.trim() === command;
    const missingEvidence = supportingEvidenceIds.filter((evidenceId) => !snapshot.evidence[evidenceId]);
    if (missingEvidence.length > 0) throw new Error(`Unknown supporting evidence ids: ${missingEvidence.join(", ")}`);
    for (const evidenceId of supportingEvidenceIds) {
      const evidence = snapshot.evidence[evidenceId]!;
      if (evidence.provenance?.runId !== this.runId || evidence.provenance?.generation !== snapshot.generation) throw new Error(`Supporting evidence is stale: ${evidenceId}`);
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
      completion: { id: completionId, purpose: "claim_reproduction", candidateHash, artifactId: candidateArtifact.id },
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
    await graph.linkNodes({ from: candidateArtifact.id, to: completionId, relation: "derived_from", explanation: "The exact candidate Artifact is hash-bound to this Completion.", confidence: 1 });
    for (const attempt of attempts) {
      await graph.linkNodes({ from: attempt.execution.artifactId, to: attempt.evidenceId, relation: "derived_from", explanation: "Journaled execution Artifact generated verifier Evidence.", confidence: 1 });
      await graph.linkNodes({ from: attempt.receiptArtifact.id, to: attempt.evidenceId, relation: "derived_from", explanation: "Immutable verifier receipt anchors the reproduction provenance.", confidence: 1 });
      for (const supportingEvidenceId of supportingEvidenceIds) await graph.linkNodes({ from: supportingEvidenceId, to: attempt.evidenceId, relation: "depends_on", explanation: "Final reproduction uses this upstream Evidence.", confidence: 1 });
      await graph.linkNodes({ from: attempt.evidenceId, to: factId, relation: "supports", explanation: "Reproduction Evidence confirms the hash-bound claim.", confidence: 1 });
      await graph.linkNodes({ from: attempt.evidenceId, to: completionId, relation: "reproduces", explanation: "Reproduction Evidence verifies this exact Completion.", confidence: 1 });
    }
    const graphSnapshot = await this.controlStore.snapshot(this.runId);
    const relatedTreeIds = Object.values(graphSnapshot.reasoningTrees).filter((tree) => supportingEvidenceIds.some((value) => tree.nodeIds.includes(value))).map((tree) => tree.id);
    await graph.createTree({
      name: "最终候选复现",
      summary: `候选 ${candidateHash.slice(0, 12)}... 已由当前 generation 的 journaled verifier effect 复现。`,
      purpose: "汇总最终结论、上游分析依据与可重复验证结果。",
      explanation: "该树以 Completion 为根，连接候选、执行记录、收据、reproduction Evidence 与确认 Fact。",
      rootNodeId: completionId,
      nodeIds: [candidateArtifact.id, ...attempts.flatMap((attempt) => [attempt.execution.artifactId, attempt.receiptArtifact.id, attempt.evidenceId]), ...supportingEvidenceIds, factId, completionId],
      relatedTreeIds,
      tags: ["verification", "candidate", "reproduction"],
      status: locallyJudged ? "SUPPORTED" : "ACTIVE",
    });

    const primary = attempts[0]!;
    return { verified: locallyJudged, candidate, candidateHash, commandHash, artifactId: primary.receiptArtifact.id, candidateArtifactId: candidateArtifact.id, executionArtifactId: primary.execution.artifactId, evidenceId: primary.evidenceId, completionId, toolCallId: input.toolCallId, supportingEvidenceIds };
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
    const primary = evidence[0]!;
    const receipt = receipts[0];
    return { required: true, status: "verified", candidateHash: completion.candidateHash, commandHash: receipt?.commandHash, artifactId: completion.artifactId, evidenceId: primary.id, completionId: completion.id, toolCallId: receipt?.sessionId };
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
