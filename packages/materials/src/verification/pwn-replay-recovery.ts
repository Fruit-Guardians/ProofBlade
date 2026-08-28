import type { ContainerRef } from "../container/contracts.js";
import type { SessionRegistry } from "../container/session-registry.js";
import type { CompletionProposal, Effect, EffectRequest, RawEffectResult, VerificationRequest } from "../domain/types.js";
import type { ControlStore } from "../control/control-store.js";
import { PwnSession } from "../pwn/pwn-session.js";
import { PwnReproducer, type ExploitStage } from "./pwn-reproducer.js";
import type { PwnVerifierPolicy } from "./pwn-reproduction-verifier.js";
import type { VerificationExternalResolution, VerificationRecoveryAdapter } from "../recovery/verification-recovery.js";
import { serializeVerifierOutcomeEnvelope } from "./outcome-envelope.js";

interface StoredPwnRecipe {
  schemaVersion?: unknown;
  kind?: unknown;
  stages?: unknown;
}

/** Dependencies needed to resume a PROPOSED Pwn replay Effect. */
export interface PwnReplayRecoveryOptions {
  runId: string;
  controlStore: ControlStore;
  registry: SessionRegistry;
  refProvider: () => ContainerRef;
  policy: PwnVerifierPolicy;
  readRecipe: (effectId: string) => Promise<string>;
}

/**
 * Backend adapter for the part of Pwn recovery that is safe to replay.
 *
 * A PROPOSED replay has not opened a process, so the original recipe can be
 * executed once through a fresh verifier-owned session. A STARTED replay is
 * intentionally not guessed: the docker-exec child is not durable across a
 * ProofBlade process restart, and the adapter reports UNKNOWN instead of
 * creating a second process that could mutate the target twice.
 */
export class PwnReplayRecoveryAdapter implements VerificationRecoveryAdapter {
  public readonly kind = "pwn" as const;
  private readonly reproducer: PwnReproducer;

  public constructor(private readonly options: PwnReplayRecoveryOptions) {
    this.reproducer = new PwnReproducer(options.controlStore);
  }

  public supports(operation: string): boolean {
    return operation === "verification_replay";
  }

  public async resumeProposed(request: EffectRequest, signal: AbortSignal): Promise<RawEffectResult> {
    if (request.operation !== "verification_replay") throw new Error(`Pwn recovery cannot resume ${request.operation}`);
    if (request.args.kind !== "pwn") throw new Error("Pwn replay Effect has an invalid verification kind");
    const generation = request.args.generation;
    if (typeof generation !== "number" || !Number.isInteger(generation)) throw new Error("Pwn replay Effect has an invalid generation");
    const ref = this.options.refProvider();
    if (ref.runId !== this.options.runId || ref.generation !== generation) throw new Error("Pwn replay recovery target is stale");
    if (signal.aborted) throw signal.reason ?? new Error("Pwn replay recovery was aborted");
    const stored = JSON.parse(await this.options.readRecipe(request.id)) as StoredPwnRecipe;
    if (stored.schemaVersion !== 1 || stored.kind !== "pwn" || !Array.isArray(stored.stages)) throw new Error(`Pwn replay recipe ${request.id} is invalid`);
    const startedAt = Date.now();
    const execution = await this.reproducer.reproduceCaptured(
      this.options.runId,
      {
        stages: stored.stages as ExploitStage[],
        flagPath: this.options.policy.flagPath,
        flagPattern: this.options.policy.flagPattern,
      },
      async () => await this.openSession(ref),
    );
    const snapshot = await this.options.controlStore.snapshot(this.options.runId);
    const externalId = snapshot.sessions[execution.sessionId]?.externalId;
    const envelope = serializeVerifierOutcomeEnvelope({
      schemaVersion: 1,
      requestKey: String(request.args.verificationKey),
      runId: this.options.runId,
      generation,
      kind: "pwn",
      policyHash: String(request.args.policyHash),
      recipeHash: String(request.args.recipeHash),
      ...(externalId ? { externalId } : {}),
      externalStatus: "CONFIRMED",
      attempts: [{
        id: String(request.args.attemptId),
        phase: "pwn_replay",
        status: execution.reproduced ? "PASSED" : "FAILED",
        ...(externalId ? { externalId } : {}),
        summary: execution.reproduced ? "Pwn replay reached shell and read a policy-matching flag." : "Pwn replay did not pass all shell and flag barriers.",
      }],
      transcriptArtifactIds: [],
      stageSummary: {
        reproduced: execution.reproduced,
        shellConfirmed: execution.shellConfirmed,
        flagRead: execution.flag !== undefined,
        stageCount: execution.stages.length,
      },
      evidenceIds: [],
      terminal: false,
    }, { replay: true });
    return {
      stdout: envelope,
      stderr: "",
      exitCode: execution.reproduced ? 0 : 1,
      durationMs: Date.now() - startedAt,
      ...(externalId ? { externalId } : {}),
    };
  }

  public async reconcileStarted(input: { request: VerificationRequest; completion?: CompletionProposal; effect: Effect }, _signal: AbortSignal): Promise<VerificationExternalResolution> {
    return {
      status: "UNKNOWN",
      reason: `Pwn replay Effect ${input.effect.id} was already STARTED; the docker-exec session is not durable across process restart.`,
    };
  }

  private async openSession(ref: ContainerRef): Promise<PwnSession> {
    if (this.options.policy.target.kind === "remote") {
      if (!this.options.policy.target.endpoint) throw new Error("Pwn replay remote target requires an endpoint");
      return await PwnSession.openRemote(this.options.registry, {
        ref,
        ownerLane: "verifier",
        command: [...this.options.policy.target.command],
        endpoint: this.options.policy.target.endpoint,
      });
    }
    return await PwnSession.openLocal(this.options.registry, {
      ref,
      ownerLane: "verifier",
      command: [...this.options.policy.target.command],
    });
  }
}
