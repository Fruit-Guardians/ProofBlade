import type { ControlStore } from "../control/control-store.js";
import type { CompletionProposal, VerificationRequest, VerificationRequestKind } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";

export interface VerificationRequestInput {
  kind: VerificationRequestKind;
  policyHash: string;
  recipeHash: string;
  sourceIds?: string[];
}

export interface BegunVerificationRequest {
  request: VerificationRequest;
  created: boolean;
}

/** Begin the stable verifier request used by a platform submission Completion. */
export async function beginSubmissionVerificationRequest(
  controlStore: ControlStore,
  runId: string,
  input: { candidateHash: string; candidateArtifactId: string },
): Promise<BegunVerificationRequest> {
  const snapshot = await controlStore.snapshot(runId);
  const verificationRuleHash = sha256(canonicalJson(snapshot.task.verification));
  return await beginVerificationRequest(controlStore, runId, {
    kind: "claim",
    policyHash: sha256(canonicalJson({ taskHash: snapshot.taskHash, verificationRuleHash, platformSubmission: true })),
    recipeHash: sha256(canonicalJson({ purpose: "submission", candidateHash: input.candidateHash, candidateArtifactId: input.candidateArtifactId })),
  });
}

/** Build a stable identity for one verifier request, independent of sessions or random IDs. */
export function createVerificationKey(runId: string, generation: number, input: VerificationRequestInput): string {
  return sha256(canonicalJson({
    schemaVersion: 1,
    runId,
    generation,
    kind: input.kind,
    policyHash: input.policyHash,
    recipeHash: input.recipeHash,
    sourceIds: [...new Set(input.sourceIds ?? [])].sort(),
  }));
}

export function verificationRequestId(key: string): string {
  return `VR-${key.slice(0, 24)}`;
}

/**
 * Persist the request before any clean external session is opened. A request
 * already present after a restart is deliberately returned as `created:false`;
 * callers must recover its durable Effect/Completion instead of silently
 * starting another external experiment.
 */
export async function beginVerificationRequest(
  controlStore: ControlStore,
  runId: string,
  input: VerificationRequestInput,
): Promise<BegunVerificationRequest> {
  const snapshot = await controlStore.snapshot(runId);
  const key = createVerificationKey(runId, snapshot.generation, input);
  const requestId = verificationRequestId(key);
  const existing = snapshot.verificationRequests[requestId];
  if (existing) {
    if (existing.key !== key || existing.kind !== input.kind || existing.policyHash !== input.policyHash || existing.recipeHash !== input.recipeHash || existing.generation !== snapshot.generation) {
      throw new Error(`Verification request ${requestId} does not match the immutable current policy`);
    }
    return { request: existing, created: false };
  }
  try {
    await controlStore.dispatch(runId, {
      type: "verification_requested",
      request: {
        id: requestId,
        key,
        kind: input.kind,
        policyHash: input.policyHash,
        recipeHash: input.recipeHash,
      },
      lane: "verifier",
    });
  } catch (error) {
    // Two executor processes may both observe the missing request before one
    // wins the Run lock. Treat the losing duplicate as the same idempotent
    // begin operation, but preserve unrelated validation/storage failures.
    const raced = await controlStore.snapshot(runId);
    const concurrent = raced.verificationRequests[requestId];
    if (!concurrent || concurrent.key !== key) throw error;
    return { request: concurrent, created: false };
  }
  const after = await controlStore.snapshot(runId);
  const request = after.verificationRequests[requestId];
  if (!request) throw new Error(`Verification request ${requestId} was not persisted`);
  return { request, created: true };
}

export interface DurableVerificationResult {
  completion: CompletionProposal;
  candidate?: string;
  evidenceId?: string;
}

export async function readDurableVerificationResult(
  controlStore: ControlStore,
  runId: string,
  request: VerificationRequest,
): Promise<DurableVerificationResult | undefined> {
  if (!request.completionId) return undefined;
  const snapshot = await controlStore.snapshot(runId);
  const completion = snapshot.completions[request.completionId];
  if (!completion || completion.verificationKey !== request.key || completion.status === "PROPOSED") return undefined;
  return { completion, evidenceId: completion.evidenceIds[0] };
}
