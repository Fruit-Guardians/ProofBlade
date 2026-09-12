import type { ControlStore, VerificationRecoveryControlPort } from "../control/control-store.js";
import type { CompletionProposal, Effect, EffectRequest, RawEffectResult, RunSnapshot, TaskContract, VerificationRequest, VerificationRequestKind } from "../domain/types.js";
import type { EffectJournal } from "../effects/effect-journal.js";
import type { FixtureRef, SandboxPort } from "../sandbox/fixture.js";

/**
 * Durable disposition of one verifier request after a process restart.
 *
 * This service intentionally inspects only durable state. It never opens a
 * session, invokes a command, or guesses the result of an external Effect.
 * The verifier-specific executor can use the disposition to resume the same
 * Effect under its original idempotency key or route an ambiguous operation
 * to an explicit human/backend reconciliation flow.
 */
export type VerificationRecoveryStatus =
  | "TERMINAL"
  | "PENDING"
  | "PROPOSED_EFFECT"
  | "IN_FLIGHT_EFFECT"
  | "AMBIGUOUS"
  | "STALE"
  | "INVALID";

export interface VerificationRecoveryItem {
  requestId: string;
  key: string;
  kind: VerificationRequest["kind"];
  generation: number;
  status: VerificationRecoveryStatus;
  recoveryState: NonNullable<VerificationRequest["recoveryState"]>;
  recoveryReason?: string;
  completionId?: string;
  effectIds: string[];
  reason: string;
}

export interface VerificationRecoveryReport {
  runId: string;
  generation: number;
  projectionHash?: string;
  items: VerificationRecoveryItem[];
  terminal: number;
  pending: number;
  requiresRecovery: number;
  stale: number;
  invalid: number;
  recoveryRequired: number;
}

export type VerificationExternalResolution =
  | { status: "CONFIRMED"; result: RawEffectResult }
  | { status: "RUNNING"; reason: string }
  | { status: "UNKNOWN"; reason: string };

/** Context supplied when a recovery adapter is constructed for one Run. */
export interface VerificationRecoveryAdapterContext {
  runId: string;
  task: TaskContract;
  snapshot: RunSnapshot;
  fixture: FixtureRef;
}

/**
 * Backend-owned recovery contract. `resumeProposed` is allowed to execute
 * because the Effect was persisted before the external call began. For an
 * already-started operation, `reconcileStarted` must only inspect/query the
 * external system; it must never replay a non-idempotent action.
 */
export interface VerificationRecoveryAdapter {
  readonly kind: VerificationRequestKind;
  /** Restrict an adapter to operations it can safely resume/reconcile. */
  supports?(operation: string): boolean;
  resumeProposed(request: EffectRequest, signal: AbortSignal): Promise<RawEffectResult>;
  reconcileStarted(input: {
    request: VerificationRequest;
    completion?: CompletionProposal;
    effect: Effect;
  }, signal: AbortSignal): Promise<VerificationExternalResolution>;
}

/**
 * Recovery adapter for task-defined local claim commands.
 *
 * These commands are verifier-owned and already declared with the `pure`
 * replay policy. A proposal that never reached the command runner can safely
 * execute once through the same Sandbox. Once the Effect is STARTED, this
 * adapter deliberately refuses to guess whether the command ran.
 */
export class SandboxClaimRecoveryAdapter implements VerificationRecoveryAdapter {
  public readonly kind = "claim" as const;

  public constructor(private readonly sandbox: SandboxPort) {}

  public supports(operation: string): boolean {
    return operation === "result_verification" || operation === "claim_reproduction" || operation === "fixture_score";
  }

  public async resumeProposed(request: EffectRequest, signal: AbortSignal): Promise<RawEffectResult> {
    if (request.operation !== "result_verification" && request.operation !== "claim_reproduction" && request.operation !== "fixture_score") throw new Error(`Result verification recovery cannot resume ${request.operation}`);
    if ((request.operation === "result_verification" || request.operation === "claim_reproduction") && request.replayPolicy !== "pure") throw new Error(`Result verification recovery refuses replay policy ${request.replayPolicy}`);
    if (request.operation === "fixture_score" && request.replayPolicy !== "forbidden-replay") throw new Error(`Platform recovery refuses replay policy ${request.replayPolicy}`);
    return await this.sandbox.execute(request, signal);
  }

  public async reconcileStarted(input: { request: VerificationRequest; completion?: CompletionProposal; effect: Effect }, _signal: AbortSignal): Promise<VerificationExternalResolution> {
    return { status: "UNKNOWN", reason: `Claim Effect ${input.effect.id} was already STARTED; command completion cannot be inferred safely.` };
  }
}

/**
 * Deterministic lookup table for verifier recovery backends.
 *
 * A Run may have at most one adapter for each verification kind.  Silent
 * last-writer-wins registration would make recovery depend on composition
 * order, so duplicate kinds fail during startup instead.
 */
export class VerificationRecoveryAdapterRegistry {
  private readonly byKind: ReadonlyMap<VerificationRequestKind, VerificationRecoveryAdapter>;

  public constructor(adapters: readonly VerificationRecoveryAdapter[] = []) {
    const byKind = new Map<VerificationRequestKind, VerificationRecoveryAdapter>();
    for (const adapter of adapters) {
      if (byKind.has(adapter.kind)) throw new Error(`Duplicate verification recovery adapter for ${adapter.kind}`);
      byKind.set(adapter.kind, adapter);
    }
    this.byKind = byKind;
  }

  public get(kind: VerificationRequestKind): VerificationRecoveryAdapter | undefined {
    return this.byKind.get(kind);
  }

  public list(): readonly VerificationRecoveryAdapter[] {
    return [...this.byKind.values()];
  }
}

/** Static adapters or a factory that can bind adapters to the recovered fixture. */
export type VerificationRecoveryAdapterSource =
  | readonly VerificationRecoveryAdapter[]
  | ((context: VerificationRecoveryAdapterContext) => readonly VerificationRecoveryAdapter[] | Promise<readonly VerificationRecoveryAdapter[]>);

export async function resolveVerificationRecoveryAdapters(
  source: VerificationRecoveryAdapterSource | undefined,
  context: VerificationRecoveryAdapterContext,
): Promise<VerificationRecoveryAdapterRegistry> {
  if (!source) return new VerificationRecoveryAdapterRegistry();
  const adapters = typeof source === "function" ? await source(context) : source;
  return new VerificationRecoveryAdapterRegistry(adapters);
}

const VERIFIER_OPERATIONS = new Set([
  "result_verification",
  "claim_reproduction",
  "fixture_score",
  "web_reproduce",
  "browser_reproduce",
  "pwn_reproduce",
  "verification_replay",
]);

export class VerificationRecoveryService {
  public constructor(
    private readonly controlStore: ControlStore,
    private readonly effectJournal?: EffectJournal,
    adapters: readonly VerificationRecoveryAdapter[] | VerificationRecoveryAdapterRegistry = [],
    private readonly recoveryControl?: VerificationRecoveryControlPort,
  ) {
    this.adapters = adapters instanceof VerificationRecoveryAdapterRegistry
      ? adapters
      : new VerificationRecoveryAdapterRegistry(adapters);
  }

  private readonly adapters: VerificationRecoveryAdapterRegistry;

  /**
   * Inspect every stable VerificationRequest in a Run.
   *
   * No branch in this method performs an external action. In particular,
   * STARTED/UNKNOWN Effects remain unresolved instead of being replayed by a
   * generic sandbox recovery path. This is the safety boundary that lets the
   * caller decide whether a backend has a real reconciliation primitive.
   */
  public async inspect(runId: string): Promise<VerificationRecoveryReport> {
    const snapshot = await this.controlStore.snapshot(runId);
    const items = Object.values(snapshot.verificationRequests)
      .sort((left, right) => left.createdSeq - right.createdSeq || left.id.localeCompare(right.id))
      .map((request) => inspectRequest(snapshot, request));
    return {
      runId,
      generation: snapshot.generation,
      projectionHash: snapshot.projectionHash,
      items,
      terminal: items.filter((item) => item.status === "TERMINAL").length,
      pending: items.filter((item) => item.status === "PENDING").length,
      requiresRecovery: items.filter((item) => item.recoveryState === "RECOVERY_REQUIRED" || ["PROPOSED_EFFECT", "IN_FLIGHT_EFFECT", "AMBIGUOUS"].includes(item.status)).length,
      stale: items.filter((item) => item.status === "STALE").length,
      invalid: items.filter((item) => item.status === "INVALID").length,
      recoveryRequired: items.filter((item) => item.recoveryState === "RECOVERY_REQUIRED").length,
    };
  }

  /**
   * Reconcile only evidence that is already durable.  A verifier result
   * Artifact written immediately before a crash can safely finish its Effect;
   * no session, process, or platform request is recreated.  Effects without
   * such a uniquely bound Artifact remain visible to a backend-specific
   * recovery adapter in a later phase.
   */
  public async reconcile(runId: string, signal: AbortSignal = new AbortController().signal): Promise<VerificationRecoveryReport> {
    const report = await this.inspect(runId);
    if (this.effectJournal) for (const item of report.items) {
      if (!["PROPOSED_EFFECT", "IN_FLIGHT_EFFECT"].includes(item.status)) continue;
      const snapshot = await this.controlStore.snapshot(runId);
      const request = snapshot.verificationRequests[item.requestId];
      const completion = item.completionId ? snapshot.completions[item.completionId] : undefined;
      const adapter = this.adapters.get(item.kind);
      let adoptedArtifact = false;
      for (const effectId of item.effectIds) {
        const effect = snapshot.effects[effectId];
        if (!effect || (effect.status !== "PROPOSED" && effect.status !== "STARTED")) continue;
        const artifacts = Object.values(snapshot.artifacts).filter((artifact) =>
          artifact.sourceEffectId === effect.id && artifact.origin.registeredBy === "verifier",
        );
        if (artifacts.length !== 1) continue;
        if (effect.operation === "verification_replay") await this.effectJournal.adoptVerifierReplayArtifact(runId, effect.id, artifacts[0]!.id);
        else await this.effectJournal.adoptVerifierArtifact(runId, effect.id, artifacts[0]!.id);
        adoptedArtifact = true;
        break;
      }
      if (adoptedArtifact) continue;
      const effect = item.effectIds.map((effectId) => snapshot.effects[effectId]).find((candidate) => candidate && (candidate.status === "PROPOSED" || candidate.status === "STARTED"));
      if (!effect) continue;
      const effectAdapter = adapter && (adapter.supports?.(effect.operation) ?? true) ? adapter : undefined;
      if (effect.status === "PROPOSED" && item.status === "PROPOSED_EFFECT") {
        if (effectAdapter) {
          if (effect.operation === "verification_replay") await this.effectJournal.resumeVerifierReplay(runId, effect.id, (requestForEffect, innerSignal) => effectAdapter.resumeProposed(requestForEffect, innerSignal), signal);
          else await this.effectJournal.resumeVerifierProposed(runId, effect.id, (requestForEffect, innerSignal) => effectAdapter.resumeProposed(requestForEffect, innerSignal), signal);
        } else if (typeof effect.args.recoveryArtifactSha256 === "string") {
          if (effect.operation !== "verification_replay") await this.effectJournal.resumeVerifierProposed(runId, effect.id, undefined, signal);
        }
        continue;
      }
      if (!effectAdapter || !request) continue;
      if (effect.status !== "STARTED") continue;
      const resolution = await effectAdapter.reconcileStarted({ request, completion, effect }, signal);
      if (resolution.status === "CONFIRMED") {
        if (effect.operation === "verification_replay") await this.effectJournal.finishVerifierReplay(runId, effect.id, resolution.result);
        else if (completion) await this.effectJournal.finishVerifierResult(runId, effect.id, resolution.result);
      }
    }
    let reconciled = await this.inspect(runId);
    if (this.recoveryControl) {
      for (const item of reconciled.items) {
        const request = (await this.controlStore.snapshot(runId)).verificationRequests[item.requestId];
        if (!request) continue;
        if (item.status === "TERMINAL" && request.recoveryState === "RECOVERY_REQUIRED") {
          await this.recoveryControl.markResolved(runId, { requestId: item.requestId, reason: "Durable verifier chain is terminal and replayable." });
        } else if (["PENDING", "PROPOSED_EFFECT", "IN_FLIGHT_EFFECT", "AMBIGUOUS"].includes(item.status)
          && request.recoveryState !== "RECOVERY_REQUIRED" && request.recoveryState !== "RECOVERED") {
          await this.recoveryControl.markRequired(runId, { requestId: item.requestId, reason: item.reason });
        }
      }
      reconciled = await this.inspect(runId);
    }
    return reconciled;
  }

  /**
   * Resume a proposed verifier Effect using its persisted arguments. This is
   * deliberately narrower than `inspect`: STARTED, UNKNOWN and terminal
   * Effects cannot enter this path and require backend reconciliation instead.
   */
  public async resumeProposed(
    runId: string,
    requestId: string,
    executor: (request: EffectRequest, signal: AbortSignal) => Promise<RawEffectResult>,
    signal?: AbortSignal,
  ): Promise<{ effectId: string; result: RawEffectResult; artifactId: string }> {
    if (!this.effectJournal) throw new Error("Verification recovery resume requires an EffectJournal");
    const report = await this.inspect(runId);
    const item = report.items.find((value) => value.requestId === requestId);
    if (!item) throw new Error(`Unknown verification request ${requestId}`);
    if (item.status !== "PROPOSED_EFFECT" || item.effectIds.length !== 1) {
      throw new Error(`Verification request ${requestId} is ${item.status}; only one PROPOSED verifier Effect can resume`);
    }
    return await this.effectJournal.resumeVerifierProposed(runId, item.effectIds[0]!, executor, signal);
  }
}

function inspectRequest(snapshot: RunSnapshot, request: VerificationRequest): VerificationRecoveryItem {
  const base = {
    requestId: request.id,
    key: request.key,
    kind: request.kind,
    generation: request.generation,
    recoveryState: request.recoveryState ?? "READY",
    ...(request.recoveryReason ? { recoveryReason: request.recoveryReason } : {}),
  } satisfies Omit<VerificationRecoveryItem, "status" | "effectIds" | "reason" | "completionId">;
  if (request.runId !== snapshot.runId || request.generation !== snapshot.generation) {
    return { ...base, status: "STALE", effectIds: [], reason: "Verification request belongs to another Run or generation." };
  }
  const replayEffects = verifierReplayEffectsForRequest(snapshot, request);
  if (!request.completionId) {
    if (replayEffects.some((effect) => effect.status === "PROPOSED")) return { ...base, status: "PROPOSED_EFFECT", effectIds: replayEffects.map((effect) => effect.id), reason: "A verifier replay Effect is proposed before a Completion; it may only resume with its original recipe." };
    if (replayEffects.some((effect) => effect.status === "STARTED")) return { ...base, status: "IN_FLIGHT_EFFECT", effectIds: replayEffects.map((effect) => effect.id), reason: "A verifier replay Effect may have touched an external resource before a Completion was proposed." };
    if (replayEffects.length > 0) return { ...base, status: "AMBIGUOUS", effectIds: replayEffects.map((effect) => effect.id), reason: "A verifier replay finished before its candidate Completion was durable." };
    return { ...base, status: "PENDING", effectIds: [], reason: "Request is durable but no Completion has been proposed." };
  }
  const completion = snapshot.completions[request.completionId];
  if (!completion || completion.verificationKey !== request.key || completion.runId !== snapshot.runId || completion.generation !== snapshot.generation) {
    return { ...base, status: "INVALID", completionId: request.completionId, effectIds: [], reason: "Completion is missing or does not match the stable request identity." };
  }
  const effects = verifierEffectsForCompletion(snapshot, completion.id);
  const allEffects = [...replayEffects, ...effects].sort((left, right) => left.createdSeq - right.createdSeq || left.id.localeCompare(right.id));
  const effectIds = allEffects.map((effect) => effect.id);
  if (completion.status !== "PROPOSED") {
    const terminalError = validateTerminal(snapshot, completion.id);
    return terminalError
      ? { ...base, status: "INVALID", completionId: completion.id, effectIds, reason: terminalError }
      : { ...base, status: "TERMINAL", completionId: completion.id, effectIds, reason: `Completion ${completion.id} has a complete durable verifier chain.` };
  }
  if (effects.length === 0 && replayEffects.length === 0) {
    return { ...base, status: "PENDING", completionId: completion.id, effectIds, reason: "Completion is proposed but no verifier Effect is durable yet." };
  }
  if (replayEffects.some((effect) => effect.status === "PROPOSED")) {
    return { ...base, status: "PROPOSED_EFFECT", completionId: completion.id, effectIds, reason: "A verifier replay Effect is proposed and may only resume with its original recipe." };
  }
  if (replayEffects.some((effect) => effect.status === "STARTED")) {
    return { ...base, status: "IN_FLIGHT_EFFECT", completionId: completion.id, effectIds, reason: "A verifier replay Effect may have reached an external process; backend reconciliation is required." };
  }
  if (effects.some((effect) => effect.status === "PROPOSED")) {
    return { ...base, status: "PROPOSED_EFFECT", completionId: completion.id, effectIds, reason: "A verifier Effect is proposed and may only resume with its original idempotency key." };
  }
  if (effects.some((effect) => effect.status === "STARTED")) {
    return { ...base, status: "IN_FLIGHT_EFFECT", completionId: completion.id, effectIds, reason: "A verifier Effect may have reached an external process; backend reconciliation is required." };
  }
  return { ...base, status: "AMBIGUOUS", completionId: completion.id, effectIds, reason: "Verifier Effects are terminal or reconciled but the Completion remains proposed; rebuild the missing verifier result explicitly." };
}

function verifierEffectsForCompletion(snapshot: RunSnapshot, completionId: string): Effect[] {
  return Object.values(snapshot.effects)
    .filter((effect) => effect.producerLane === "verifier" && effect.args.completionId === completionId && VERIFIER_OPERATIONS.has(effect.operation))
    .sort((left, right) => left.createdSeq - right.createdSeq || left.id.localeCompare(right.id));
}

function verifierReplayEffectsForRequest(snapshot: RunSnapshot, request: VerificationRequest): Effect[] {
  return Object.values(snapshot.effects)
    .filter((effect) => effect.producerLane === "verifier" && effect.operation === "verification_replay" && effect.args.verificationRequestId === request.id)
    .sort((left, right) => left.createdSeq - right.createdSeq || left.id.localeCompare(right.id));
}

function validateTerminal(snapshot: RunSnapshot, completionId: string): string | undefined {
  const completion = snapshot.completions[completionId];
  if (!completion || (completion.status !== "ACCEPTED" && completion.status !== "REJECTED")) return "Completion is not terminal.";
  if (completion.evidenceIds.length === 0) return "Terminal Completion has no Evidence.";
  for (const evidenceId of completion.evidenceIds) {
    const evidence = snapshot.evidence[evidenceId];
    if (!evidence) return `Terminal Completion references missing Evidence ${evidenceId}.`;
    const effectId = evidence.provenance.effect?.id;
    const effect = effectId ? snapshot.effects[effectId] : undefined;
    const resultArtifact = effect?.artifactId ? snapshot.artifacts[effect.artifactId] : undefined;
    const verdict = effect?.verification;
    const accepted = completion.status === "ACCEPTED";
    const related = accepted
      ? evidence.kind === "reproduction" && evidence.supports.includes(completion.id)
      : evidence.kind === "negative" && evidence.refutes.includes(completion.id);
    if (evidence.provenance.recordedBy !== "verifier"
      || evidence.provenance.runId !== snapshot.runId
      || evidence.provenance.generation !== snapshot.generation
      || evidence.source.generation !== snapshot.generation
      || evidence.source.effectId !== effectId
      || !effect
      || effect.producerLane !== "verifier"
      || effect.status !== "FINISHED"
      || !resultArtifact
      || resultArtifact.sourceEffectId !== effect.id
      || evidence.source.artifactId !== resultArtifact.id
      || !verdict?.valid
      || verdict.accepted !== accepted
      || verdict.completionId !== completion.id
      || verdict.candidateHash !== completion.candidateHash
      || verdict.candidateArtifactId !== completion.artifactId
      || !related) {
      return `Terminal Evidence ${evidenceId} is not bound to a valid verifier Effect verdict.`;
    }
  }
  return undefined;
}
