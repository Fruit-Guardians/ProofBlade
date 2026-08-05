import type { ArtifactStore } from "../effects/artifact-store.js";
import type { ControlStore } from "../control/control-store.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";

export interface ClaimReproduction {
  candidate: string;
  candidateHash: string;
  commandHash: string;
  artifactId: string;
  evidenceId: string;
  completionId: string;
  toolCallId: string;
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

export class CodingClaimVerifier {
  private readonly reproductions: ClaimReproduction[] = [];

  public constructor(
    private readonly runId: string,
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
  ) {}

  public async record(input: {
    candidate: string;
    command: string;
    cwd: string;
    output: string;
    toolCallId: string;
  }): Promise<ClaimReproduction> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const candidateHash = sha256(input.candidate);
    const commandHash = sha256(input.command);
    const completionId = id("C");
    const evidenceId = id("EV");
    const artifact = await this.artifactStore.putText(this.runId, canonicalJson({
      schemaVersion: 1,
      kind: "claim_reproduction",
      candidateHash,
      command: input.command,
      commandHash,
      cwd: input.cwd,
      output: input.output,
      toolCallId: input.toolCallId,
      recordedAt: new Date().toISOString(),
    }), {
      filename: `claim-reproduction-${input.toolCallId}.json`,
      mime: "application/json",
      sensitivity: "flag_candidate",
    });
    await this.controlStore.dispatch(this.runId, {
      type: "completion_proposed",
      completion: { id: completionId, candidateHash, artifactId: artifact.id },
      lane: "main",
    });
    await this.controlStore.dispatch(this.runId, {
      type: "evidence",
      evidence: {
        id: evidenceId,
        kind: "reproduction",
        summary: `Candidate sha256=${candidateHash} reproduced by command sha256=${commandHash}.`,
        source: { tool: "verify_claim", artifactId: artifact.id, generation: snapshot.generation },
        confidence: 1,
        supports: [completionId],
        refutes: [],
      },
      lane: "verifier",
    });
    await this.controlStore.dispatch(this.runId, {
      type: "completion_verified",
      completionId,
      accepted: true,
      evidenceIds: [evidenceId],
      lane: "verifier",
    });
    await this.controlStore.dispatch(this.runId, {
      type: "fact",
      fact: {
        id: id("F"),
        statement: `Reproduced claim sha256=${candidateHash}`,
        status: "CONFIRMED",
        evidenceIds: [evidenceId],
      },
      lane: "verifier",
    });
    const reproduction = {
      candidate: input.candidate,
      candidateHash,
      commandHash,
      artifactId: artifact.id,
      evidenceId,
      completionId,
      toolCallId: input.toolCallId,
    };
    this.reproductions.push(reproduction);
    return reproduction;
  }

  public project(userPrompt: string, assistantText: string): ClaimVerificationProjection {
    const required = requiresClaimVerification(userPrompt, assistantText);
    if (!required) return { required: false, status: "not_required" };
    const reproduced = [...this.reproductions].reverse().find((item) => assistantText.includes(item.candidate));
    if (!reproduced) {
      return {
        required: true,
        status: "unverified",
        reason: this.reproductions.length > 0
          ? "最终回答未包含本轮复现成功的候选。"
          : "本轮没有记录成功的候选复现。",
      };
    }
    return {
      required: true,
      status: "verified",
      candidateHash: reproduced.candidateHash,
      commandHash: reproduced.commandHash,
      artifactId: reproduced.artifactId,
      evidenceId: reproduced.evidenceId,
      completionId: reproduced.completionId,
      toolCallId: reproduced.toolCallId,
    };
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
