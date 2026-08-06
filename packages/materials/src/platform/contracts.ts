import type { TargetKind } from "../domain/types.js";

export type ContestStatus = "SCHEDULED" | "RUNNING" | "ENDED";
export type PlatformChallengeStatus = "LOCKED" | "OPEN" | "SOLVED" | "CLOSED";
export type PlatformSubmissionStatus = "PENDING" | "ACCEPTED" | "WRONG" | "DUPLICATE" | "COOLDOWN" | "REJECTED";

export interface ContestSnapshot {
  schemaVersion: 1;
  contestId: string;
  name: string;
  status: ContestStatus;
  startsAt: string;
  endsAt: string;
  serverTime: string;
  score: number;
}

export interface PlatformAttachmentRef {
  id: string;
  name: string;
  mediaType: string;
  bytes: number;
  sha256: string;
}

export interface PlatformChallenge {
  id: string;
  revision: string;
  title: string;
  category: TargetKind;
  description: string;
  points: number;
  status: PlatformChallengeStatus;
  attachments: PlatformAttachmentRef[];
}

export interface PlatformAttachmentContent {
  attachment: PlatformAttachmentRef;
  stream: AsyncIterable<Uint8Array>;
}

export interface PlatformSubmissionInput {
  challengeId: string;
  candidate: string;
  attemptKey: string;
}

export interface PlatformSubmissionReceipt {
  attemptKey: string;
  challengeId: string;
  candidateHash: string;
  status: PlatformSubmissionStatus;
  submittedAt: string;
  platformSubmissionId?: string;
  cooldownUntil?: string;
  scoreAwarded?: number;
}

export interface PlatformSubmissionReconciliation {
  status: "CONFIRMED" | "ABSENT" | "UNKNOWN";
  challengeStatus: PlatformChallengeStatus;
  receipt?: PlatformSubmissionReceipt;
}

/**
 * Host-owned competition boundary. Implementations own credentials and never
 * expose authenticated URLs, cookies, or platform tokens to model tools.
 */
export interface CompetitionPlatformPort {
  snapshot(signal?: AbortSignal): Promise<ContestSnapshot>;
  listChallenges(signal?: AbortSignal): Promise<PlatformChallenge[]>;
  openAttachment(challengeId: string, attachmentId: string, signal?: AbortSignal): Promise<PlatformAttachmentContent>;
  submitCandidate(input: PlatformSubmissionInput, signal?: AbortSignal): Promise<PlatformSubmissionReceipt>;
  reconcileSubmission(attemptKey: string, challengeId: string, signal?: AbortSignal): Promise<PlatformSubmissionReconciliation>;
}

export type CompetitionPlatformErrorCode =
  | "PLATFORM_UNAUTHENTICATED"
  | "PLATFORM_RATE_LIMITED"
  | "PLATFORM_UNAVAILABLE"
  | "PLATFORM_PROTOCOL_ERROR"
  | "CONTEST_NOT_RUNNING"
  | "CHALLENGE_NOT_FOUND"
  | "ATTACHMENT_NOT_FOUND";

export class CompetitionPlatformError extends Error {
  public constructor(
    public readonly code: CompetitionPlatformErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly retryAt?: string,
  ) {
    super(message);
    this.name = "CompetitionPlatformError";
  }
}
