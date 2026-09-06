import type { ArtifactRef, EffectRequest, RawEffectResult, ReplayPolicy, RunSnapshot, VerificationRequestKind, VerificationVerdict } from "../domain/types.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import { ControlStore, createEffectInput, type DomainCommand, type VerifierEffectControlPort } from "../control/control-store.js";
import { ArtifactStore } from "./artifact-store.js";
import type { SandboxPort } from "../sandbox/fixture.js";
import { toToolFailure } from "../tools/errors.js";
import { parseVerifierOutcomeEnvelope } from "../verification/outcome-envelope.js";

export type EffectFaultPoint = "after_proposed" | "after_started" | "after_execute" | "after_artifact";
export type EffectFaultInjector = (point: EffectFaultPoint, effectId: string) => void | Promise<void>;
export interface VerifierRecoveryInput {
  content: string;
  filename: string;
  mime?: string;
  sensitivity?: ArtifactRef["sensitivity"];
}

/** Immutable input needed to recover one external verifier replay. */
export interface VerifierReplayInput {
  verificationRequestId: string;
  verificationKey: string;
  kind: VerificationRequestKind;
  policyHash: string;
  recipeHash: string;
  attemptId: string;
  cwd: string;
  recoveryInput: VerifierRecoveryInput;
  timeoutMs?: number;
}

export interface VerifierReplayHandle {
  effectId: string;
  attemptId: string;
  inputArtifactId: string;
}

export type JournalInput = Omit<EffectRequest, "id" | "idempotencyKey"> & { replayPolicy?: ReplayPolicy; artifactSensitivity?: ArtifactRef["sensitivity"]; recoveryInput?: VerifierRecoveryInput };

export interface EffectReconcileOptions {
  /** Leave verifier-owned external work for VerificationRecoveryService. */
  skipVerifierEffects?: boolean;
}

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

  /**
   * Resume one verifier Effect that was durably proposed before its executor
   * started. The caller supplies the verifier-owned executor, but the journal
   * reconstructs every request field from the persisted Effect so the original
   * idempotency key and immutable arguments cannot be replaced.
   */
  public async resumeVerifierProposed(
    runId: string,
    effectId: string,
    executor?: (request: EffectRequest, signal: AbortSignal) => Promise<RawEffectResult>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ effectId: string; result: RawEffectResult; artifactId: string }> {
    const snapshot = await this.controlStore.snapshot(runId);
    const effect = snapshot.effects[effectId];
    if (!effect) throw new Error(`Unknown verifier Effect ${effectId}`);
    if (effect.producerLane !== "verifier") throw new Error(`Effect ${effectId} is not verifier-owned`);
    if (effect.status !== "PROPOSED") throw new Error(`Verifier Effect ${effectId} is ${effect.status}; only PROPOSED Effects can resume`);
    const input: JournalInput = {
      operation: effect.operation,
      args: effect.args,
      replayPolicy: effect.replayPolicy,
      command: effect.command,
      cwd: effect.cwd,
      sessionId: effect.sessionId,
      timeoutMs: effect.timeoutMs,
    };
    const recoveryExecutor = executor ?? (async () => {
      const recovered = await this.readVerifierRecoveryInput(runId, effect);
      if (!recovered) throw new Error(`Verifier Effect ${effect.id} has no durable recovery input`);
      return recovered;
    });
    return await this.#executeWithAuthority(runId, input, recoveryExecutor, signal, true);
  }

  /** Resume a proposed replay through a backend adapter under the same Effect id. */
  public async resumeVerifierReplay(
    runId: string,
    effectId: string,
    executor: (request: EffectRequest, signal: AbortSignal) => Promise<RawEffectResult>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ effectId: string; result: RawEffectResult; artifactId: string }> {
    const snapshot = await this.controlStore.snapshot(runId);
    const effect = snapshot.effects[effectId];
    if (!effect || effect.operation !== "verification_replay" || effect.producerLane !== "verifier") throw new Error(`Unknown verification replay Effect ${effectId}`);
    if (effect.status !== "PROPOSED") throw new Error(`Verification replay ${effectId} is ${effect.status}; only PROPOSED Effects can resume`);
    await this.startVerifierReplay(runId, effectId, effect.sessionId ?? `replay:${String(effect.args.attemptId).slice(0, 32)}`);
    const request: EffectRequest = {
      id: effect.id,
      idempotencyKey: effect.idempotencyKey,
      operation: effect.operation,
      args: effect.args,
      replayPolicy: effect.replayPolicy,
      sessionId: effect.sessionId,
      cwd: effect.cwd,
      timeoutMs: effect.timeoutMs,
    };
    let result: RawEffectResult;
    try {
      result = await executor(request, signal);
    } catch (error) {
      result = { stdout: "", stderr: String(error), exitCode: null, durationMs: 0 };
    }
    await this.injectFault?.("after_execute", effectId);
    return await this.finishVerifierReplay(runId, effectId, result);
  }

  /**
   * Persist an external Web/Browser/Pwn/Claim replay before opening its
   * session or running its command. The replay Effect deliberately has no
   * Completion binding: the candidate is unknown until the external action
   * returns. Its immutable recipe is stored in a verifier-owned input Artifact.
   */
  public async prepareVerifierReplay(runId: string, input: VerifierReplayInput): Promise<VerifierReplayHandle> {
    const snapshot = await this.controlStore.snapshot(runId);
    const request = snapshot.verificationRequests[input.verificationRequestId];
    if (!request || request.key !== input.verificationKey || request.kind !== input.kind
      || request.policyHash !== input.policyHash || request.recipeHash !== input.recipeHash
      || request.generation !== snapshot.generation) {
      throw new Error(`Verification replay input does not match request ${input.verificationRequestId}`);
    }
    if (!input.attemptId.trim() || !input.cwd.trim()) throw new Error("Verification replay requires an attempt id and cwd");
    if (Buffer.byteLength(input.recoveryInput.content, "utf8") > 262_144) throw new Error("Verification replay input exceeds 256 KiB");
    const args = {
      runId,
      taskId: snapshot.task.task_id,
      generation: snapshot.generation,
      verificationRequestId: request.id,
      verificationKey: request.key,
      kind: request.kind,
      policyHash: request.policyHash,
      recipeHash: request.recipeHash,
      taskHash: snapshot.taskHash,
      targetHash: sha256(snapshot.task.target),
      verificationRuleHash: sha256(canonicalJson(snapshot.task.verification)),
      attemptId: input.attemptId,
    };
    const recoveryArtifactSha256 = sha256(input.recoveryInput.content);
    const effectArgs = { ...args, recoveryArtifactSha256 };
    const { effectId, idempotencyKey } = createEffectInput(runId, "verification_replay", effectArgs, "forbidden-replay", snapshot.generation);
    const existing = Object.values(snapshot.effects).find((effect) => effect.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.operation !== "verification_replay" || existing.producerLane !== "verifier") throw new Error(`Verification replay idempotency authority mismatch for ${input.attemptId}`);
      const existingArtifact = Object.values(snapshot.artifacts).find((artifact) => artifact.origin.registeredBy === "verifier"
        && artifact.sourceEffectId === undefined && artifact.sha256 === recoveryArtifactSha256);
      if (!existingArtifact) throw new Error(`Verification replay ${existing.id} is missing its immutable input Artifact`);
      return { effectId: existing.id, attemptId: input.attemptId, inputArtifactId: existingArtifact.id };
    }
    if (Object.keys(snapshot.effects).length >= snapshot.task.constraints.max_tool_calls) throw new Error(`Tool budget exhausted: ${snapshot.task.constraints.max_tool_calls}`);
    let inputArtifact = Object.values(snapshot.artifacts).find((artifact) => artifact.origin.registeredBy === "verifier"
      && artifact.sourceEffectId === undefined && artifact.sha256 === recoveryArtifactSha256);
    if (!inputArtifact) {
      const staged = await this.artifactStore.stageText(runId, input.recoveryInput.content, {
        filename: input.recoveryInput.filename,
        mime: input.recoveryInput.mime ?? "application/json",
        sensitivity: input.recoveryInput.sensitivity ?? "secret",
        semantic: { name: "Verifier replay input", summary: `Immutable replay input sha256=${recoveryArtifactSha256}.`, tags: ["verification", "replay-input"], role: "supporting", relatedIds: [], annotatedBy: "harness" },
      });
      await this.#verifierControl.registerInputArtifact(runId, { type: "artifact", generation: staged.generation, artifact: staged });
      inputArtifact = (await this.controlStore.snapshot(runId)).artifacts[staged.id];
    }
    if (!inputArtifact) throw new Error(`Verifier replay input Artifact ${recoveryArtifactSha256} was not registered`);
    const effect = {
      id: effectId,
      idempotencyKey,
      operation: "verification_replay",
      args: effectArgs,
      replayPolicy: "forbidden-replay" as const,
      sessionId: `replay:${input.attemptId.slice(0, 32)}`,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      status: "PROPOSED" as const,
      createdSeq: 0,
    };
    try {
      await this.#verifierControl.dispatch(runId, { type: "effect_proposed", effect });
    } catch (error) {
      const raced = await this.controlStore.snapshot(runId);
      const concurrent = Object.values(raced.effects).find((candidate) => candidate.idempotencyKey === idempotencyKey);
      if (!concurrent) throw error;
      return { effectId: concurrent.id, attemptId: input.attemptId, inputArtifactId: inputArtifact.id };
    }
    await this.injectFault?.("after_proposed", effectId);
    return { effectId, attemptId: input.attemptId, inputArtifactId: inputArtifact.id };
  }

  /** Bind the actual clean session to a previously persisted replay Effect. */
  public async startVerifierReplay(runId: string, effectId: string, sessionId: string, externalId?: string): Promise<void> {
    const snapshot = await this.controlStore.snapshot(runId);
    const effect = snapshot.effects[effectId];
    if (!effect || effect.operation !== "verification_replay" || effect.producerLane !== "verifier") throw new Error(`Unknown verification replay Effect ${effectId}`);
    if (!sessionId.trim()) throw new Error("Verification replay requires a session id");
    if (effect.status === "STARTED") {
      if (effect.sessionId !== sessionId) throw new Error(`Verification replay ${effectId} is already bound to another session`);
      return;
    }
    if (effect.status !== "PROPOSED") throw new Error(`Verification replay ${effectId} is ${effect.status}; it cannot start again`);
    await this.dispatch(runId, { type: "effect_started", effectId, sessionId, externalId, lane: "verifier" }, true);
    await this.injectFault?.("after_started", effectId);
  }

  /** Persist the bounded external replay result without claiming a candidate. */
  public async finishVerifierReplay(runId: string, effectId: string, result: RawEffectResult): Promise<{ effectId: string; result: RawEffectResult; artifactId: string }> {
    const snapshot = await this.controlStore.snapshot(runId);
    const effect = snapshot.effects[effectId];
    if (!effect || effect.operation !== "verification_replay" || effect.producerLane !== "verifier") throw new Error(`Unknown verification replay Effect ${effectId}`);
    if (effect.status !== "STARTED") throw new Error(`Verification replay ${effectId} is ${effect.status}; it must be STARTED before finishing`);
    assertReplayOutcomeBinding(effect, result);
    const artifact = await this.artifactStore.stageText(runId, JSON.stringify({ ...result, operation: effect.operation, args: effect.args }, null, 2), {
      mime: "application/json",
      sourceEffectId: effectId,
      filename: `verification-replay-${effectId}.json`,
      sensitivity: "public",
      semantic: { name: "Verifier replay result", summary: `Replay result for ${effectId}.`, tags: ["verification", "replay-result"], role: "intermediate", relatedIds: [], annotatedBy: "harness" },
    });
    await this.#verifierControl.registerResultArtifact(runId, { type: "artifact", generation: artifact.generation, artifact });
    await this.injectFault?.("after_artifact", effectId);
    const outcome = result.exitCode === 0 ? "success" : result.exitCode === null ? "timeout" : "error";
    await this.dispatch(runId, { ...effectFinishedCommand(effectId, outcome, result), artifactId: artifact.id, externalId: result.externalId, lane: "verifier" }, true);
    return { effectId, result, artifactId: artifact.id };
  }

  /** Adopt a replay result Artifact written immediately before a crash. */
  public async adoptVerifierReplayArtifact(runId: string, effectId: string, artifactId?: string): Promise<{ effectId: string; result: RawEffectResult; artifactId: string }> {
    let snapshot = await this.controlStore.snapshot(runId);
    const effect = snapshot.effects[effectId];
    if (!effect || effect.operation !== "verification_replay" || effect.producerLane !== "verifier") throw new Error(`Unknown verification replay Effect ${effectId}`);
    if (effect.status !== "PROPOSED" && effect.status !== "STARTED") throw new Error(`Verification replay ${effectId} is ${effect.status}; it cannot adopt an Artifact`);
    const candidates = Object.values(snapshot.artifacts).filter((artifact) => artifact.sourceEffectId === effect.id && artifact.origin.registeredBy === "verifier");
    const artifact = artifactId ? candidates.find((value) => value.id === artifactId) : candidates.length === 1 ? candidates[0] : undefined;
    if (!artifact || (effect.artifactId !== undefined && effect.artifactId !== artifact.id)) throw new Error(`Verification replay ${effectId} has no unique result Artifact to adopt`);
    const stored = JSON.parse(await this.artifactStore.readText(runId, artifact)) as Partial<RawEffectResult>;
    if (typeof stored.stdout !== "string" || typeof stored.stderr !== "string"
      || (typeof stored.exitCode !== "number" && stored.exitCode !== null) || typeof stored.durationMs !== "number") {
      throw new Error(`Verification replay Artifact ${artifact.id} is not a valid raw effect result`);
    }
    const result: RawEffectResult = { stdout: stored.stdout, stderr: stored.stderr, exitCode: stored.exitCode, durationMs: stored.durationMs, ...(typeof stored.externalId === "string" ? { externalId: stored.externalId } : {}) };
    assertReplayOutcomeBinding(effect, result);
    if (effect.status === "PROPOSED") {
      await this.dispatch(runId, { type: "effect_started", effectId: effect.id, sessionId: effect.sessionId, externalId: effect.externalId, lane: "verifier" }, true);
      snapshot = await this.controlStore.snapshot(runId);
    }
    const outcome = result.exitCode === 0 ? "success" : result.exitCode === null ? "timeout" : "error";
    await this.dispatch(runId, { ...effectFinishedCommand(effect.id, outcome, result), artifactId: artifact.id, externalId: result.externalId, lane: "verifier" }, true);
    return { effectId: effect.id, result, artifactId: artifact.id };
  }

  /** Read the immutable replay recipe for a backend adapter. */
  public async readVerifierReplayInput(runId: string, effectId: string): Promise<string> {
    const snapshot = await this.controlStore.snapshot(runId);
    const effect = snapshot.effects[effectId];
    if (!effect || effect.operation !== "verification_replay" || effect.producerLane !== "verifier") throw new Error(`Unknown verification replay Effect ${effectId}`);
    const hash = typeof effect.args.recoveryArtifactSha256 === "string" ? effect.args.recoveryArtifactSha256 : "";
    const artifact = Object.values(snapshot.artifacts).find((candidate) => candidate.origin.registeredBy === "verifier"
      && candidate.sourceEffectId === undefined && candidate.generation === snapshot.generation && candidate.sha256 === hash);
    if (!artifact) throw new Error(`Verification replay ${effectId} has no immutable input Artifact`);
    return await this.artifactStore.readText(runId, artifact);
  }

  /**
   * Adopt a verifier result Artifact that was durably written before the
   * process stopped.  This path never invokes a sandbox or external backend:
   * the Artifact must already be verifier-owned and uniquely sourced from the
   * same Effect, so recovery can finish the original Effect under its stable
   * idempotency identity without creating a second result Artifact.
   */
  public async adoptVerifierArtifact(
    runId: string,
    effectId: string,
    artifactId?: string,
  ): Promise<{ effectId: string; result: RawEffectResult; artifactId: string }> {
    let snapshot = await this.controlStore.snapshot(runId);
    const effect = snapshot.effects[effectId];
    if (!effect) throw new Error(`Unknown verifier Effect ${effectId}`);
    if (effect.producerLane !== "verifier") throw new Error(`Effect ${effectId} is not verifier-owned`);
    if (effect.status !== "PROPOSED" && effect.status !== "STARTED") {
      throw new Error(`Verifier Effect ${effectId} is ${effect.status}; only an unfinished Effect can adopt an Artifact`);
    }
    const candidates = Object.values(snapshot.artifacts).filter((artifact) =>
      artifact.sourceEffectId === effect.id && artifact.origin.registeredBy === "verifier",
    );
    const artifact = artifactId
      ? candidates.find((value) => value.id === artifactId)
      : candidates.length === 1 ? candidates[0] : undefined;
    if (!artifact || (effect.artifactId !== undefined && effect.artifactId !== artifact.id)) {
      throw new Error(`Verifier Effect ${effectId} has no unique verifier result Artifact to adopt`);
    }
    const stored = JSON.parse(await this.artifactStore.readText(runId, artifact)) as Partial<RawEffectResult>;
    if (typeof stored.stdout !== "string" || typeof stored.stderr !== "string"
      || (typeof stored.exitCode !== "number" && stored.exitCode !== null)
      || typeof stored.durationMs !== "number") {
      throw new Error(`Verifier result Artifact ${artifact.id} is not a valid raw effect result`);
    }
    const result: RawEffectResult = {
      stdout: stored.stdout,
      stderr: stored.stderr,
      exitCode: stored.exitCode,
      durationMs: stored.durationMs,
      ...(typeof stored.externalId === "string" ? { externalId: stored.externalId } : {}),
    };
    if (effect.status === "PROPOSED") {
      await this.dispatch(runId, { type: "effect_started", effectId: effect.id, lane: "verifier" }, true);
      snapshot = await this.controlStore.snapshot(runId);
    }
    const verification = await this.buildVerificationVerdict(runId, effect.id, effect.operation, effect.args, result, artifact);
    const outcome = result.exitCode === 0 ? "success" : result.exitCode === null ? "timeout" : "error";
    await this.dispatch(runId, {
      ...effectFinishedCommand(effect.id, outcome, result),
      artifactId: artifact.id,
      externalId: result.externalId,
      verification,
      lane: "verifier",
    }, true);
    return { effectId: effect.id, result, artifactId: artifact.id };
  }

  /**
   * Finish a verifier Effect after a trusted backend has independently
   * confirmed the external result.  The backend result is written under the
   * original Effect identity; this method is never a replay shortcut for an
   * unconfirmed STARTED/UNKNOWN operation.
   */
  public async finishVerifierResult(
    runId: string,
    effectId: string,
    result: RawEffectResult,
  ): Promise<{ effectId: string; result: RawEffectResult; artifactId: string }> {
    const snapshot = await this.controlStore.snapshot(runId);
    const effect = snapshot.effects[effectId];
    if (!effect) throw new Error(`Unknown verifier Effect ${effectId}`);
    if (effect.producerLane !== "verifier") throw new Error(`Effect ${effectId} is not verifier-owned`);
    if (effect.status !== "PROPOSED" && effect.status !== "STARTED") {
      throw new Error(`Verifier Effect ${effectId} is ${effect.status}; only an unfinished Effect can accept a reconciled result`);
    }
    if (effect.status === "PROPOSED") await this.dispatch(runId, { type: "effect_started", effectId, lane: "verifier" }, true);
    return await this.finish(runId, effectId, effect.operation, effect.args, result, undefined, true);
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
    const recoveryArtifactSha256 = trustedVerifier && input.recoveryInput ? sha256(input.recoveryInput.content) : undefined;
    const effectArgs = recoveryArtifactSha256 ? { ...input.args, recoveryArtifactSha256 } : input.args;
    const { effectId, idempotencyKey } = createEffectInput(runId, input.operation, effectArgs, replayPolicy, snapshot.generation);
    const existing = Object.values(snapshot.effects).find((effect) => effect.idempotencyKey === idempotencyKey);
    const activeEffectId = existing?.id ?? effectId;
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
      throw new Error(`Finished Effect ${existing.id} is missing its result Artifact`);
    }
    if (existing && existing.status !== "PROPOSED") {
      throw new Error(`Effect ${existing.id} is ${existing.status}; reconcile it before retrying`);
    }
    if (!existing && Object.keys(snapshot.effects).length >= snapshot.task.constraints.max_tool_calls) {
      throw new Error(`Tool budget exhausted: ${snapshot.task.constraints.max_tool_calls}`);
    }
    if (!existing && trustedVerifier && input.recoveryInput && recoveryArtifactSha256) {
      let recoveryArtifact = Object.values(snapshot.artifacts).find((artifact) => artifact.origin.registeredBy === "verifier"
        && artifact.sourceEffectId === undefined && artifact.sha256 === recoveryArtifactSha256);
      if (!recoveryArtifact) {
        const staged = await this.artifactStore.stageText(runId, input.recoveryInput.content, {
          filename: input.recoveryInput.filename,
          mime: input.recoveryInput.mime ?? "application/json",
          sensitivity: input.recoveryInput.sensitivity ?? "result_candidate",
          semantic: { name: "Verifier recovery input", summary: `Durable verifier input sha256=${recoveryArtifactSha256}.`, tags: ["verification", "recovery-input"], role: "supporting", relatedIds: [], annotatedBy: "harness" },
        });
        await this.#verifierControl.registerInputArtifact(runId, { type: "artifact", generation: staged.generation, artifact: staged });
      }
    }
    const effect = existing ?? {
      id: effectId,
      idempotencyKey,
      replayPolicy,
      operation: input.operation,
      args: effectArgs,
      command: input.command,
      sessionId: input.sessionId,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      status: "PROPOSED" as const,
      createdSeq: 0,
    };
    const resumedProposal = existing?.status === "PROPOSED";
    if (!resumedProposal) {
      await this.dispatch(runId, { type: "effect_proposed", effect, lane: trustedVerifier ? "verifier" : "executor" }, trustedVerifier);
      await this.injectFault?.("after_proposed", effectId);
      await this.dispatch(runId, { type: "effect_started", effectId: activeEffectId, lane: trustedVerifier ? "verifier" : "executor" }, trustedVerifier);
      await this.injectFault?.("after_started", activeEffectId);
    } else {
      // A crash before the external executor was entered is safe to resume:
      // the immutable proposal already owns the idempotency key and its
      // original command/arguments. Never propose a second Effect.
      await this.dispatch(runId, { type: "effect_started", effectId: activeEffectId, lane: trustedVerifier ? "verifier" : "executor" }, trustedVerifier);
    }
    const request: EffectRequest = existing
      ? { ...input, args: effect.args, command: effect.command, sessionId: effect.sessionId, cwd: effect.cwd, timeoutMs: effect.timeoutMs, replayPolicy: effect.replayPolicy, id: effect.id, idempotencyKey: effect.idempotencyKey }
      : { ...input, args: effectArgs, replayPolicy, id: effectId, idempotencyKey };
    let result: RawEffectResult;
    try {
      result = await executor(request, signal);
    } catch (error) {
      result = { stdout: "", stderr: String(error), exitCode: null, durationMs: 0 };
    }
    await this.injectFault?.("after_execute", activeEffectId);
    return await this.finish(runId, activeEffectId, effect.operation, effect.args, result, input.artifactSensitivity, trustedVerifier);
  }

  private async readVerifierRecoveryInput(runId: string, effect: RunSnapshot["effects"][string]): Promise<RawEffectResult | undefined> {
    const hash = typeof effect.args.recoveryArtifactSha256 === "string" ? effect.args.recoveryArtifactSha256 : undefined;
    if (!hash || !["result_verification", "claim_reproduction", "web_reproduce", "browser_reproduce", "pwn_reproduce"].includes(effect.operation)) return undefined;
    const snapshot = await this.controlStore.snapshot(runId);
    const artifacts = Object.values(snapshot.artifacts).filter((artifact) => artifact.origin.registeredBy === "verifier"
      && artifact.generation === snapshot.generation
      && artifact.sourceEffectId === undefined && artifact.sha256 === hash);
    if (artifacts.length !== 1) return undefined;
    const content = await this.artifactStore.readText(runId, artifacts[0]!);
    return { stdout: content, stderr: "", exitCode: 0, durationMs: 0 };
  }

  public async reconcile(runId: string, options: EffectReconcileOptions = {}): Promise<string[]> {
    const snapshot = await this.controlStore.snapshot(runId);
    const reconciled: string[] = [];
    for (const effect of Object.values(snapshot.effects)) {
      if (effect.status !== "STARTED" && effect.status !== "PROPOSED") continue;
      if (options.skipVerifierEffects && effect.producerLane === "verifier") continue;
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
      sensitivity: artifactSensitivity ?? (/(?:PB|FLAG)\{[^}\r\n]+\}/.test(`${result.stdout}\n${result.stderr}`) ? "result_candidate" : "public"),
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
    } else if ((operation === "result_verification" || operation === "claim_reproduction") && args.resultArtifactMode === "artifact" && result.exitCode === 0) {
      try {
        const parsed = JSON.parse(result.stdout) as { accepted?: unknown; resultHash?: unknown };
        valid = typeof parsed.accepted === "boolean" && parsed.resultHash === completion.candidateHash;
        accepted = valid && parsed.accepted === true;
      } catch {
        valid = false;
      }
    } else if ((operation === "result_verification" || operation === "claim_reproduction") && result.exitCode === 0) {
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
    } else if (operation === "browser_reproduce" && result.exitCode === 0) {
      try {
        const parsed = JSON.parse(result.stdout) as { schemaVersion?: unknown; accepted?: unknown; candidateHash?: unknown; responseArtifactIds?: unknown; stateHashes?: unknown };
        valid = parsed.schemaVersion === 1
          && typeof parsed.accepted === "boolean"
          && parsed.candidateHash === completion.candidateHash
          && Array.isArray(parsed.responseArtifactIds)
          && parsed.responseArtifactIds.length <= 64
          && parsed.responseArtifactIds.every((value) => typeof value === "string" && value.length > 0 && value.length <= 96)
          && Array.isArray(parsed.stateHashes)
          && parsed.stateHashes.length <= 64
          && parsed.stateHashes.every((value) => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value));
        accepted = valid && parsed.accepted === true;
      } catch {
        valid = false;
      }
    } else if (operation === "pwn_reproduce" && result.exitCode === 0) {
      try {
        const parsed = JSON.parse(result.stdout) as {
          schemaVersion?: unknown;
          accepted?: unknown;
          candidateHash?: unknown;
          observedCandidateHash?: unknown;
          shellConfirmed?: unknown;
          flagRead?: unknown;
          candidateMatch?: unknown;
          stages?: unknown;
          transcript?: unknown;
        };
        const stages = Array.isArray(parsed.stages) && parsed.stages.length > 0 && parsed.stages.length <= 64
          && parsed.stages.every((stage) => stage && typeof stage === "object"
            && typeof (stage as Record<string, unknown>).name === "string"
            && typeof (stage as Record<string, unknown>).ok === "boolean");
        const allStagesOk = stages && (parsed.stages as Array<{ ok: boolean }>).every((stage) => stage.ok);
        const flagHashShape = parsed.observedCandidateHash === undefined
          || (typeof parsed.observedCandidateHash === "string" && /^[a-f0-9]{64}$/i.test(parsed.observedCandidateHash));
        const barrierAccepted = parsed.shellConfirmed === true && parsed.flagRead === true && allStagesOk && parsed.candidateMatch === true;
        valid = parsed.schemaVersion === 1
          && typeof parsed.accepted === "boolean"
          && parsed.candidateHash === completion.candidateHash
          && typeof parsed.shellConfirmed === "boolean"
          && typeof parsed.flagRead === "boolean"
          && typeof parsed.candidateMatch === "boolean"
          && typeof parsed.transcript === "string"
          && parsed.transcript.length <= 65_536
          && flagHashShape
          && parsed.accepted === barrierAccepted;
        accepted = valid && parsed.accepted === true;
      } catch {
        valid = false;
      }
    }
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

function assertReplayOutcomeBinding(effect: RunSnapshot["effects"][string], result: RawEffectResult): void {
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Verification replay ${effect.id} must return a JSON outcome envelope`);
  }
  const envelope = parseVerifierOutcomeEnvelope(value, { replay: true });
  const expected = {
    requestKey: String(effect.args.verificationKey ?? ""),
    runId: String(effect.args.runId ?? ""),
    generation: Number(effect.args.generation),
    kind: effect.args.kind,
    policyHash: String(effect.args.policyHash ?? ""),
    recipeHash: String(effect.args.recipeHash ?? ""),
  };
  if (envelope.requestKey !== expected.requestKey
    || envelope.runId !== expected.runId
    || envelope.generation !== expected.generation
    || envelope.kind !== expected.kind
    || envelope.policyHash !== expected.policyHash
    || envelope.recipeHash !== expected.recipeHash) {
    throw new Error(`Verification replay ${effect.id} outcome envelope does not match its immutable Effect binding`);
  }
}
