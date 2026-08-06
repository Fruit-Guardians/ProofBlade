import { createHash } from "node:crypto";
import type { TargetKind } from "../domain/types.js";
import {
  CompetitionPlatformError,
  type CompetitionPlatformPort,
  type ContestSnapshot,
  type PlatformAttachmentContent,
  type PlatformAttachmentRef,
  type PlatformChallenge,
  type PlatformChallengeStatus,
  type PlatformSubmissionInput,
  type PlatformSubmissionReceipt,
  type PlatformSubmissionReconciliation,
} from "./contracts.js";

export interface ContestSimulatorChallengeDefinition {
  id: string;
  revision?: string;
  title: string;
  category: TargetKind;
  description: string;
  points: number;
  answer: string;
  cooldownMs?: number;
  attachments?: Record<string, string | Uint8Array>;
}

export interface ContestSimulatorDefinition {
  contestId: string;
  name: string;
  startsAt: string;
  endsAt: string;
  challenges: ContestSimulatorChallengeDefinition[];
}

export interface ContestSimulatorOptions {
  now?: () => Date;
  disconnectAfterCommit?: (input: PlatformSubmissionInput, receipt: PlatformSubmissionReceipt) => boolean;
}

interface StoredChallenge {
  definition: ContestSimulatorChallengeDefinition;
  attachments: Map<string, { ref: PlatformAttachmentRef; content: Uint8Array }>;
  solved: boolean;
  cooldownUntil?: string;
}

/** Deterministic platform double for unattended end-to-end and recovery tests. */
export class CompetitionPlatformSimulator implements CompetitionPlatformPort {
  private readonly challenges = new Map<string, StoredChallenge>();
  private readonly submissions = new Map<string, PlatformSubmissionReceipt>();
  private readonly disconnectedAttempts = new Set<string>();
  private submissionSequence = 0;
  private score = 0;
  private readonly startsAtMs: number;
  private readonly endsAtMs: number;
  private readonly now: () => Date;

  public constructor(
    private readonly contest: Omit<ContestSimulatorDefinition, "challenges">,
    challengeDefinitions: ContestSimulatorChallengeDefinition[],
    private readonly options: ContestSimulatorOptions = {},
  ) {
    this.startsAtMs = parseTime(contest.startsAt, "startsAt");
    this.endsAtMs = parseTime(contest.endsAt, "endsAt");
    if (this.endsAtMs <= this.startsAtMs) throw new Error("Contest endsAt must be after startsAt");
    this.now = options.now ?? (() => new Date());
    for (const definition of challengeDefinitions) {
      validateChallenge(definition);
      if (this.challenges.has(definition.id)) throw new Error(`Duplicate simulator challenge: ${definition.id}`);
      this.challenges.set(definition.id, {
        definition: { ...definition, attachments: undefined },
        attachments: buildAttachments(definition.attachments),
        solved: false,
      });
    }
  }

  public static create(definition: ContestSimulatorDefinition, options: ContestSimulatorOptions = {}): CompetitionPlatformSimulator {
    const { challenges, ...contest } = definition;
    return new CompetitionPlatformSimulator(contest, challenges, options);
  }

  public async snapshot(signal?: AbortSignal): Promise<ContestSnapshot> {
    checkSignal(signal);
    const now = this.now();
    return {
      schemaVersion: 1,
      contestId: this.contest.contestId,
      name: this.contest.name,
      status: now.getTime() < this.startsAtMs ? "SCHEDULED" : now.getTime() >= this.endsAtMs ? "ENDED" : "RUNNING",
      startsAt: new Date(this.startsAtMs).toISOString(),
      endsAt: new Date(this.endsAtMs).toISOString(),
      serverTime: now.toISOString(),
      score: this.score,
    };
  }

  public async listChallenges(signal?: AbortSignal): Promise<PlatformChallenge[]> {
    checkSignal(signal);
    const contest = await this.snapshot(signal);
    return [...this.challenges.values()].map((entry) => ({
      id: entry.definition.id,
      revision: entry.definition.revision ?? "1",
      title: entry.definition.title,
      category: entry.definition.category,
      description: entry.definition.description,
      points: entry.definition.points,
      status: challengeStatus(entry, contest.status),
      attachments: [...entry.attachments.values()].map(({ ref }) => ({ ...ref })),
    })).sort((a, b) => a.id.localeCompare(b.id));
  }

  public async openAttachment(challengeId: string, attachmentId: string, signal?: AbortSignal): Promise<PlatformAttachmentContent> {
    checkSignal(signal);
    const challenge = this.challenge(challengeId);
    const stored = challenge.attachments.get(attachmentId);
    if (!stored) throw new CompetitionPlatformError("ATTACHMENT_NOT_FOUND", `Unknown attachment: ${challengeId}.${attachmentId}`, false);
    const content = stored.content.slice();
    return {
      attachment: { ...stored.ref },
      stream: (async function* () { yield content; })(),
    };
  }

  public async submitCandidate(input: PlatformSubmissionInput, signal?: AbortSignal): Promise<PlatformSubmissionReceipt> {
    checkSignal(signal);
    validateSubmission(input);
    const candidateHash = sha256(input.candidate.trim());
    const existing = this.submissions.get(input.attemptKey);
    if (existing) {
      if (existing.challengeId !== input.challengeId || existing.candidateHash !== candidateHash) {
        throw new CompetitionPlatformError("PLATFORM_PROTOCOL_ERROR", `Attempt key collision: ${input.attemptKey}`, false);
      }
      return structuredClone(existing);
    }
    const contest = await this.snapshot(signal);
    if (contest.status !== "RUNNING") throw new CompetitionPlatformError("CONTEST_NOT_RUNNING", `Contest is ${contest.status.toLowerCase()}`, false);
    const challenge = this.challenge(input.challengeId);
    const now = this.now();
    const submittedAt = now.toISOString();
    const base = {
      attemptKey: input.attemptKey,
      challengeId: input.challengeId,
      candidateHash,
      submittedAt,
      platformSubmissionId: `SIM-${String(++this.submissionSequence).padStart(6, "0")}`,
    };
    let receipt: PlatformSubmissionReceipt;
    if (challenge.solved) {
      receipt = { ...base, status: "DUPLICATE", scoreAwarded: 0 };
    } else if (challenge.cooldownUntil && now.getTime() < Date.parse(challenge.cooldownUntil)) {
      receipt = { ...base, status: "COOLDOWN", cooldownUntil: challenge.cooldownUntil, scoreAwarded: 0 };
    } else if (input.candidate.trim() === challenge.definition.answer) {
      challenge.solved = true;
      challenge.cooldownUntil = undefined;
      this.score += challenge.definition.points;
      receipt = { ...base, status: "ACCEPTED", scoreAwarded: challenge.definition.points };
    } else {
      const cooldownMs = challenge.definition.cooldownMs ?? 0;
      challenge.cooldownUntil = cooldownMs > 0 ? new Date(now.getTime() + cooldownMs).toISOString() : undefined;
      receipt = { ...base, status: "WRONG", ...(challenge.cooldownUntil ? { cooldownUntil: challenge.cooldownUntil } : {}), scoreAwarded: 0 };
    }
    this.submissions.set(input.attemptKey, structuredClone(receipt));
    if (!this.disconnectedAttempts.has(input.attemptKey) && this.options.disconnectAfterCommit?.(input, receipt)) {
      this.disconnectedAttempts.add(input.attemptKey);
      throw new CompetitionPlatformError("PLATFORM_UNAVAILABLE", "Simulated response loss after platform commit", true);
    }
    return structuredClone(receipt);
  }

  public async reconcileSubmission(attemptKey: string, challengeId: string, signal?: AbortSignal): Promise<PlatformSubmissionReconciliation> {
    checkSignal(signal);
    const challenge = this.challenge(challengeId);
    const contest = await this.snapshot(signal);
    const receipt = this.submissions.get(attemptKey);
    if (!receipt) return { status: "ABSENT", challengeStatus: challengeStatus(challenge, contest.status) };
    if (receipt.challengeId !== challengeId) throw new CompetitionPlatformError("PLATFORM_PROTOCOL_ERROR", `Attempt ${attemptKey} belongs to another challenge`, false);
    return { status: "CONFIRMED", challengeStatus: challengeStatus(challenge, contest.status), receipt: structuredClone(receipt) };
  }

  private challenge(id: string): StoredChallenge {
    const challenge = this.challenges.get(id);
    if (!challenge) throw new CompetitionPlatformError("CHALLENGE_NOT_FOUND", `Unknown challenge: ${id}`, false);
    return challenge;
  }
}

function buildAttachments(values: Record<string, string | Uint8Array> | undefined): Map<string, { ref: PlatformAttachmentRef; content: Uint8Array }> {
  const output = new Map<string, { ref: PlatformAttachmentRef; content: Uint8Array }>();
  for (const [name, raw] of Object.entries(values ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!name || name.includes("/") || name.includes("\\")) throw new Error(`Invalid simulator attachment name: ${name}`);
    const content = typeof raw === "string" ? new TextEncoder().encode(raw) : raw.slice();
    output.set(name, { ref: { id: name, name, mediaType: "application/octet-stream", bytes: content.byteLength, sha256: sha256(content) }, content });
  }
  return output;
}

function challengeStatus(challenge: StoredChallenge, contestStatus: ContestSnapshot["status"]): PlatformChallengeStatus {
  if (challenge.solved) return "SOLVED";
  if (contestStatus === "SCHEDULED") return "LOCKED";
  return contestStatus === "ENDED" ? "CLOSED" : "OPEN";
}

function validateChallenge(value: ContestSimulatorChallengeDefinition): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id)) throw new Error(`Invalid simulator challenge id: ${value.id}`);
  if (!value.title.trim() || !value.description.trim()) throw new Error(`Simulator challenge ${value.id} requires title and description`);
  if (!Number.isFinite(value.points) || value.points < 0) throw new Error(`Simulator challenge ${value.id} has invalid points`);
  if (!value.answer.trim()) throw new Error(`Simulator challenge ${value.id} requires a non-empty hidden answer`);
  if (value.cooldownMs !== undefined && (!Number.isInteger(value.cooldownMs) || value.cooldownMs < 0)) throw new Error(`Simulator challenge ${value.id} has invalid cooldownMs`);
}

function validateSubmission(input: PlatformSubmissionInput): void {
  if (!input.challengeId.trim() || !input.candidate.trim() || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.attemptKey)) {
    throw new CompetitionPlatformError("PLATFORM_PROTOCOL_ERROR", "Submission requires challengeId, candidate, and a stable attemptKey", false);
  }
}

function parseTime(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Contest ${field} must be an ISO timestamp`);
  return parsed;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted"));
}
