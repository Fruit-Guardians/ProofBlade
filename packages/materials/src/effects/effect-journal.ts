import type { ArtifactRef, EffectRequest, RawEffectResult, ReplayPolicy, RunSnapshot, VerificationVerdict } from "../domain/types.js";
import { id } from "../domain/utils.js";
import { ControlStore, createEffectInput, type DomainCommand, type VerifierEffectControlPort } from "../control/control-store.js";
import { ArtifactStore } from "./artifact-store.js";
import type { SandboxPort } from "../sandbox/fixture.js";
import { toToolFailure } from "../tools/errors.js";

export type EffectFaultPoint = "after_proposed" | "after_started" | "after_execute" | "after_artifact";
export type EffectFaultInjector = (point: EffectFaultPoint, effectId: string) => void | Promise<void>;
export type JournalInput = Omit<EffectRequest, "id" | "idempotencyKey"> & { replayPolicy?: ReplayPolicy; artifactSensitivity?: ArtifactRef["sensitivity"] };

export interface VerifierEffectJournal {
  /** Trusted verifier execution through the configured Sandbox only. */
  execute(runId: string, input: JournalInput, signal?: AbortSignal): Promise<{ effectId: string; result: RawEffectResult; artifactId: string }>;
}

/** Test-only seam. This type is never included in production AppServices. */
export interface VerifierEffectTestHarness {
  /** Harness-test seam; never pass this capability to an agent lane. */
  executeWith(runId: string, input: JournalInput, executor: (request: EffectRequest, signal: AbortSignal) => Promise<RawEffectResult>, signal?: AbortSignal): Promise<{ effectId: string; result: RawEffectResult; artifactId: string }>;
}

export interface EffectJournalPlane {
  journal: EffectJournal;
  verifierJournal: VerifierEffectJournal;
  verifierTestHarness: VerifierEffectTestHarness;
}

export class EffectJournal {
  #verifierControl: VerifierEffectControlPort;

  private constructor(
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
    private readonly sandbox: SandboxPort,
    verifierControl: VerifierEffectControlPort,
    private readonly injectFault?: EffectFaultInjector,
  ) {
    this.#verifierControl = verifierControl;
  }

  public static create(
    controlStore: ControlStore,
    artifactStore: ArtifactStore,
    sandbox: SandboxPort,
    verifierControl: VerifierEffectControlPort,
    injectFault?: EffectFaultInjector,
  ): EffectJournalPlane {
    const journal = new EffectJournal(controlStore, artifactStore, sandbox, verifierControl, injectFault);
    const verifierJournal: VerifierEffectJournal = Object.freeze({
      execute: async (runId: string, input: JournalInput, signal: AbortSignal = new AbortController().signal) =>
        await journal.#executeWithAuthority(runId, input, (request, innerSignal) => sandbox.execute(request, innerSignal), signal, true),
    });
    const verifierTestHarness: VerifierEffectTestHarness = Object.freeze({
      executeWith: async (runId: string, input: JournalInput, executor: (request: EffectRequest, signal: AbortSignal) => Promise<RawEffectResult>, signal: AbortSignal = new AbortController().signal) =>
        await journal.#executeWithAuthority(runId, input, executor, signal, true),
    });
    return { journal, verifierJournal, verifierTestHarness };
  }

  public async execute(runId: string, input: JournalInput, signal: AbortSignal = new AbortController().signal): Promise<{ effectId: string; result: RawEffectResult; artifactId: string }> {
    return await this.executeWith(runId, input, (request, innerSignal) => this.sandbox.execute(request, innerSignal), signal);
  }

  public async executeWith(
    runId: string,
    input: JournalInput,
    executor: (request: EffectRequest, signal: AbortSignal) => Promise<RawEffectResult>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ effectId: string; result: RawEffectResult; artifactId: string }> {
    return await this.#executeWithAuthority(runId, input, executor, signal, false);
  }

  /** Internal harness seam for verifier-owned effects that attest host-side work. */
  public async executeVerifierWith(
    runId: string,
    input: JournalInput,
    executor: (request: EffectRequest, signal: AbortSignal) => Promise<RawEffectResult>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ effectId: string; result: RawEffectResult; artifactId: string }> {
    return await this.#executeWithAuthority(runId, input, executor, signal, true);
  }

  async #executeWithAuthority(
    runId: string,
    input: JournalInput,
    executor: (request: EffectRequest, signal: AbortSignal) => Promise<RawEffectResult>,
    signal: AbortSignal,
    trustedVerifier: boolean,
  ): Promise<{ effectId: string; result: RawEffectResult; artifactId: string }> {
    const snapshot = await this.controlStore.snapshot(runId);
    const replayPolicy = this.sandbox.resolveReplayPolicy(input.operation, input.replayPolicy ?? "pure");
    const { effectId, idempotencyKey } = createEffectInput(runId, input.operation, input.args, replayPolicy, snapshot.generation);
    const existing = Object.values(snapshot.effects).find((effect) => effect.idempotencyKey === idempotencyKey);
    if (existing && (existing.producerLane === "verifier") !== trustedVerifier) {
      throw new Error(`Effect idempotency authority mismatch for ${input.operation}`);
    }
    if (existing?.status === "FINISHED" && existing.artifactId) {
      const artifact = snapshot.artifacts[existing.artifactId];
      if (artifact) {
        if (trustedVerifier) {
          const boundArtifacts = Object.values(snapshot.artifacts).filter((value) => value.sourceEffectId === existing.id);
          if (artifact.origin.registeredBy !== "verifier" || artifact.sourceEffectId !== existing.id
            || boundArtifacts.length !== 1 || boundArtifacts[0]?.id !== artifact.id) {
            throw new Error(`Finished verifier Effect ${existing.id} has no unique verifier-authority result Artifact`);
          }
        }
        const stored = JSON.parse(await this.artifactStore.readText(runId, artifact)) as RawEffectResult;
        return { effectId: existing.id, result: stored, artifactId: artifact.id };
      }
    }
    if (Object.keys(snapshot.effects).length >= snapshot.task.constraints.max_tool_calls) {
      throw new Error(`Tool budget exhausted: ${snapshot.task.constraints.max_tool_calls}`);
    }
    const effect = {
      id: effectId,
      idempotencyKey,
      replayPolicy,
      operation: input.operation,
      args: input.args,
      command: input.command,
      sessionId: input.sessionId,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      status: "PROPOSED" as const,
      createdSeq: 0,
    };
    await this.dispatch(runId, { type: "effect_proposed", effect, lane: trustedVerifier ? "verifier" : "executor" }, trustedVerifier);
    await this.injectFault?.("after_proposed", effectId);
    await this.dispatch(runId, { type: "effect_started", effectId, lane: trustedVerifier ? "verifier" : "executor" }, trustedVerifier);
    await this.injectFault?.("after_started", effectId);
    let result: RawEffectResult;
    try {
      result = await executor({ ...input, replayPolicy, id: effectId, idempotencyKey }, signal);
    } catch (error) {
      result = { stdout: "", stderr: String(error), exitCode: null, durationMs: 0 };
    }
    await this.injectFault?.("after_execute", effectId);
    return await this.finish(runId, effectId, input.operation, input.args, result, input.artifactSensitivity, trustedVerifier);
  }

  public async reconcile(runId: string): Promise<string[]> {
    const snapshot = await this.controlStore.snapshot(runId);
    const reconciled: string[] = [];
    for (const effect of Object.values(snapshot.effects)) {
      if (effect.status !== "STARTED" && effect.status !== "PROPOSED") continue;
      const effectGeneration = typeof effect.args.generation === "number" ? effect.args.generation : undefined;
      if (effectGeneration !== undefined && effectGeneration !== snapshot.generation) {
        await this.dispatch(runId, { type: "effect_reconciled", effectId: effect.id, outcome: "unknown", lane: effect.producerLane }, effect.producerLane === "verifier");
        reconciled.push(effect.id);
        continue;
      }
      if (effect.status === "PROPOSED") {
        await this.dispatch(runId, { type: "effect_started", effectId: effect.id, lane: effect.producerLane }, effect.producerLane === "verifier");
      }
      const boundArtifacts = Object.values(snapshot.artifacts).filter((artifact) => artifact.sourceEffectId === effect.id);
      const completedArtifact = effect.producerLane === "verifier"
        ? (boundArtifacts.length === 1 && boundArtifacts[0]?.origin.registeredBy === "verifier" ? boundArtifacts[0] : undefined)
        : boundArtifacts[0];
      if (completedArtifact) {
        const stored = JSON.parse(await this.artifactStore.readText(runId, completedArtifact)) as RawEffectResult;
        const outcome = stored.exitCode === 0 ? "success" : stored.exitCode === null ? "timeout" : "error";
        const verification = effect.producerLane === "verifier"
          ? await this.buildVerificationVerdict(runId, effect.id, effect.operation, effect.args, stored, completedArtifact)
          : undefined;
        await this.dispatch(runId, { ...effectFinishedCommand(effect.id, outcome, stored), artifactId: completedArtifact.id, externalId: stored.externalId, verification, lane: effect.producerLane }, effect.producerLane === "verifier");
        reconciled.push(effect.id);
        continue;
      }
      if (effect.operation.startsWith("mcp:")) {
        await this.dispatch(runId, { type: "effect_reconciled", effectId: effect.id, outcome: "unknown", lane: effect.producerLane }, effect.producerLane === "verifier");
        reconciled.push(effect.id);
        continue;
      }
      if (effect.producerLane === "verifier" && boundArtifacts.length > 0) {
        // A legacy/public or ambiguous result Artifact cannot be promoted into a
        // trusted verdict during recovery.
        await this.dispatch(runId, { type: "effect_reconciled", effectId: effect.id, outcome: "unknown", lane: effect.producerLane }, true);
        reconciled.push(effect.id);
        continue;
      }
      if (effect.replayPolicy === "forbidden-replay") {
        await this.dispatch(runId, { type: "effect_reconciled", effectId: effect.id, outcome: "unknown", lane: effect.producerLane }, effect.producerLane === "verifier");
        reconciled.push(effect.id);
        continue;
      }
      const result = await this.sandbox.reconcile(effect);
      if (result.action === "rerun") {
        const rerun = await this.sandbox.execute({
          id: effect.id,
          idempotencyKey: effect.idempotencyKey,
          operation: effect.operation,
          args: effect.args,
          replayPolicy: effect.replayPolicy,
          command: effect.command,
          cwd: effect.cwd,
          timeoutMs: effect.timeoutMs,
        }, new AbortController().signal);
        await this.finish(runId, effect.id, effect.operation, effect.args, rerun, undefined, effect.producerLane === "verifier");
      } else {
        await this.dispatch(runId, { type: "effect_reconciled", effectId: effect.id, outcome: result.outcome, lane: effect.producerLane }, effect.producerLane === "verifier");
      }
      reconciled.push(effect.id);
    }
    return reconciled;
  }

  private async finish(runId: string, effectId: string, operation: string, args: Record<string, unknown>, result: RawEffectResult, artifactSensitivity?: ArtifactRef["sensitivity"], trustedVerifier = false): Promise<{ effectId: string; result: RawEffectResult; artifactId: string }> {
    const artifactMeta = {
      mime: "application/json",
      sourceEffectId: effectId,
      filename: `${operation}-${effectId}.json`,
      sensitivity: artifactSensitivity ?? (/(?:PB|FLAG)\{[^}\r\n]+\}/.test(`${result.stdout}\n${result.stderr}`) ? "flag_candidate" : "public"),
    } satisfies Parameters<ArtifactStore["putText"]>[2];
    let artifact: ArtifactRef;
    if (trustedVerifier) {
      const staged = await this.artifactStore.stageText(runId, JSON.stringify({ ...result, operation, args }, null, 2), artifactMeta);
      await this.#verifierControl.registerResultArtifact(runId, { type: "artifact", generation: staged.generation, artifact: staged });
      const registered = (await this.controlStore.snapshot(runId)).artifacts[staged.id];
      if (!registered || registered.origin.registeredBy !== "verifier") throw new Error(`Verifier result Artifact ${staged.id} was not registered by verifier authority`);
      artifact = registered;
    } else {
      artifact = await this.artifactStore.putText(runId, JSON.stringify({ ...result, operation, args }, null, 2), artifactMeta);
    }
    await this.injectFault?.("after_artifact", effectId);
    const outcome = result.exitCode === 0 ? "success" : result.exitCode === null ? "timeout" : "error";
    const verification = trustedVerifier
      ? await this.buildVerificationVerdict(runId, effectId, operation, args, result, artifact)
      : undefined;
    await this.dispatch(runId, { ...effectFinishedCommand(effectId, outcome, result), artifactId: artifact.id, externalId: result.externalId, verification, lane: trustedVerifier ? "verifier" : "executor" }, trustedVerifier);
    return { effectId, result, artifactId: artifact.id };
  }

  private async buildVerificationVerdict(
    runId: string,
    effectId: string,
    operation: string,
    args: Record<string, unknown>,
    result: RawEffectResult,
    artifact: ArtifactRef,
  ): Promise<VerificationVerdict> {
    const snapshot = await this.controlStore.snapshot(runId);
    const completionId = String(args.completionId ?? "");
    const completion = snapshot.completions[completionId];
    if (!completion) throw new Error(`Verifier result references unknown completion ${completionId || "missing"}`);
    const effect = snapshot.effects[effectId];
    if (!effect || effect.status !== "STARTED") throw new Error(`Verifier result references an inactive effect ${effectId}`);
    const sessionId = String(effect?.sessionId ?? "");
    const attemptId = String(args.attemptId ?? "");
    let valid = false;
    let accepted = false;
    if (operation === "fixture_score" && result.exitCode === 0) {
      try {
        const parsed = JSON.parse(result.stdout) as { accepted?: unknown; candidateHash?: unknown };
        valid = typeof parsed.accepted === "boolean" && parsed.candidateHash === completion.candidateHash;
        accepted = valid && parsed.accepted === true;
      } catch {
        valid = false;
      }
    } else if (operation === "claim_reproduction" && result.exitCode === 0) {
      const candidateArtifact = snapshot.artifacts[completion.artifactId];
      if (candidateArtifact) {
        try {
          const candidate = (await this.artifactStore.readText(runId, candidateArtifact)).trim();
          valid = candidate.length > 0 && stdoutContainsExactCandidate(result.stdout, candidate);
          accepted = valid;
        } catch {
          valid = false;
        }
      }
    } else if (operation === "web_reproduce" && result.exitCode === 0) {
      try {
        const parsed = JSON.parse(result.stdout) as { accepted?: unknown; candidateHash?: unknown };
        valid = typeof parsed.accepted === "boolean" && parsed.candidateHash === completion.candidateHash;
        accepted = valid && parsed.accepted === true;
      } catch {
        valid = false;
      }
    }
    // pwn_reproduce remains fail-closed until the repository contains a
    // transcript-aware, task-owned scorer implementation.
    return {
      schemaVersion: 1,
      valid,
      accepted,
      operation: operation as VerificationVerdict["operation"],
      runId,
      taskId: snapshot.task.task_id,
      taskHash: snapshot.taskHash,
      generation: snapshot.generation,
      completionId: completion.id,
      candidateHash: completion.candidateHash,
      candidateArtifactId: completion.artifactId,
      attemptId,
      sessionId,
      resultArtifactId: artifact.id,
      resultArtifactSha256: artifact.sha256,
      transcriptHash: artifact.sha256,
    };
  }

  private async dispatch(runId: string, command: DomainCommand, trustedVerifier: boolean): Promise<void> {
    if (!trustedVerifier) {
      await this.controlStore.dispatch(runId, command);
      return;
    }
    const { lane: _lane, ...trusted } = command;
    await this.#verifierControl.dispatch(runId, trusted as never);
  }
}

function stdoutContainsExactCandidate(stdout: string, candidate: string): boolean {
  return stdout.split(/\r?\n/).some((line) => line.trim() === candidate);
}

function effectFinishedCommand(effectId: string, outcome: "success" | "error" | "timeout" | "unknown", result: RawEffectResult) {
  return {
    type: "effect_finished" as const,
    effectId,
    outcome,
    durationMs: result.durationMs,
    outputBytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    exitCode: result.exitCode,
    ...(outcome === "success" ? {} : { errorSignature: toToolFailure(new Error(result.stderr || outcome)).error.signature }),
  };
}
