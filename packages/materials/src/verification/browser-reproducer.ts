import type { BrowserActionKind, BrowserSelector, Effect, RawEffectResult } from "../domain/types.js";
import type { ControlStore } from "../control/control-store.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import type { DomainRecordInput } from "../domain/types.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { VerifierReplayHandle } from "../effects/effect-journal.js";
import { BrowserContextBackend, type BrowserActionResponse, type BrowserExchangeArtifact, type BrowserVerifierContextRequest } from "../web/browser-session.js";
import type { BrowserRuntimeHandoff } from "../web/browser-resource-adapter.js";
import { compileBoundedPattern, compileFlagPattern, type BrowserWebExploitRecipe, type BrowserWebExploitStep, type WebVerifierPort } from "./web-reproducer.js";
import { beginVerificationRequest, readDurableVerificationResult } from "./verification-key.js";
import { parseVerifierOutcomeEnvelope, serializeVerifierOutcomeEnvelope } from "./outcome-envelope.js";

interface BrowserReplayRequest {
  action: BrowserActionKind;
  path: string;
  status?: number;
  artifactId: string;
  stateHash: string;
}

interface BrowserAttempt {
  attemptId: string;
  sessionId: string;
  artifactIds: string[];
  requests: BrowserReplayRequest[];
  success: boolean;
  candidate?: string;
  candidateArtifactId?: string;
  summary: string;
}

interface BrowserRecoveryState {
  /** Attempts whose replay result is already durable and need no external work. */
  completed: Map<number, BrowserAttempt>;
  /** One externally started attempt that can be adopted through the broker. */
  inFlight: Map<number, { effect: Effect; handoff: BrowserRuntimeHandoff }>;
  /** A proposed attempt has not touched the external browser and may use a clean context. */
  proposed: Map<number, Effect>;
}

export interface BrowserReproductionResult {
  reproduced: boolean;
  flag?: string;
  evidenceId: string;
  artifactId?: string;
}

const DEFAULT_BROWSER_MAX_STEPS = 64;
const DEFAULT_BROWSER_MAX_DURATION_MS = 120_000;
const DEFAULT_BROWSER_MAX_RESPONSE_BYTES = 1_048_576;

/** Creates an unopened verifier-owned browser context backed by a fresh driver. */
export type BrowserCleanSessionFactory = (request: BrowserVerifierContextRequest, signal?: AbortSignal) => Promise<BrowserContextBackend>;

/** Factory used only when recovery adopted an existing broker-owned context. */
export type BrowserRecoveredSessionFactory = (handoff: BrowserRuntimeHandoff, request: BrowserVerifierContextRequest, signal?: AbortSignal) => Promise<BrowserContextBackend>;

export interface BrowserReproducerRecoveryOptions {
  /** Bindings returned by RunRecoveryService before the coding lane starts. */
  readonly handoffs?: readonly BrowserRuntimeHandoff[];
  /** Application-owned adapter for turning one binding into a verifier session. */
  readonly createRecoveredSession?: BrowserRecoveredSessionFactory;
}

/**
 * Replays navigation-only Web chains in independent, empty browser contexts.
 * The driver factory is an application boundary: model lanes receive neither
 * the driver nor the verifier port, and the task-owned flag policy remains the
 * only source of acceptance rules.
 */
export class BrowserReproducer {
  private readonly recoveredHandoffs: readonly BrowserRuntimeHandoff[];
  private readonly createRecoveredSession?: BrowserRecoveredSessionFactory;

  public constructor(
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
    private readonly verifier: WebVerifierPort,
    recovery: BrowserReproducerRecoveryOptions = {},
  ) {
    this.recoveredHandoffs = recovery.handoffs ?? [];
    this.createRecoveredSession = recovery.createRecoveredSession;
  }

  public async reproduce(
    runId: string,
    recipe: BrowserWebExploitRecipe,
    createCleanSession: BrowserCleanSessionFactory,
    signal?: AbortSignal,
  ): Promise<BrowserReproductionResult> {
    const before = await this.controlStore.snapshot(runId);
    const policy = before.task.verification.web;
    if (!policy?.flag_pattern) throw new Error("Browser reproduction requires an immutable Web verification policy");
    if (policy.transport !== "browser") throw new Error("Browser reproduction requires the task Web transport policy to be browser");
    const flagPattern = compileFlagPattern(policy.flag_pattern);
    const policyHash = sha256(canonicalJson(policy));
    const requiredAttempts = Math.max(1, before.task.verification.required_reproductions);
    const maxSteps = policy.browser?.max_steps ?? DEFAULT_BROWSER_MAX_STEPS;
    const maxDurationMs = policy.browser?.max_duration_ms ?? DEFAULT_BROWSER_MAX_DURATION_MS;
    const maxResponseBytes = policy.browser?.max_response_bytes ?? DEFAULT_BROWSER_MAX_RESPONSE_BYTES;
    const allowedActions = policy.browser?.allowed_actions ?? ["navigate"];
    if (!allowedActions.includes("navigate")) throw new Error("Browser reproduction requires the navigate action until interactive actions are enabled");
    validateBrowserRecipe(recipe.steps, maxSteps, allowedActions);
    const request = await beginVerificationRequest(this.controlStore, runId, {
      kind: "browser",
      policyHash: sha256(canonicalJson(policy)),
      recipeHash: sha256(canonicalJson(recipe)),
    });
    let recoveryState: BrowserRecoveryState | undefined;
    if (!request.created) {
      const durable = await readDurableVerificationResult(this.controlStore, runId, request.request);
      if (durable) {
        const snapshot = await this.controlStore.snapshot(runId);
        const candidateArtifact = snapshot.artifacts[durable.completion.artifactId];
        if (!candidateArtifact) throw new Error(`Durable Browser verification candidate is missing: ${durable.completion.artifactId}`);
        const candidate = await this.artifactStore.readText(runId, candidateArtifact);
        if (!durable.evidenceId) throw new Error("Durable Browser verification has no Evidence");
        return {
          reproduced: durable.completion.status === "ACCEPTED",
          ...(durable.completion.status === "ACCEPTED" ? { flag: candidate } : {}),
          evidenceId: durable.evidenceId,
          artifactId: durable.completion.artifactId,
        };
      }
      recoveryState = await collectBrowserRecovery(
        this.controlStore,
        this.artifactStore,
        runId,
        request.request.id,
        request.request.key,
        policyHash,
        request.request.recipeHash,
        requiredAttempts,
        flagPattern,
        recipe.steps,
        this.recoveredHandoffs,
      );
      if (!this.createRecoveredSession && recoveryState.inFlight.size > 0) {
        throw new Error(`Browser verification request ${request.request.id} has an in-flight context but no recovery broker`);
      }
      if (recoveryState.completed.size === 0 && recoveryState.inFlight.size === 0 && recoveryState.proposed.size === 0) {
        throw new Error(`Browser verification request ${request.request.id} requires durable recovery; refusing to open another clean context`);
      }
    }
    const target = new URL(before.task.target);
    const factoryRequest: BrowserVerifierContextRequest = {
      runId,
      generation: before.generation,
      target: target.toString(),
      policyHash: sha256(canonicalJson(policy)),
      recipeHash: sha256(canonicalJson(recipe)),
      verificationKey: request.request.key,
      allowedHosts: [...before.task.scope.allowed_hosts],
      allowedPorts: [...before.task.scope.allowed_ports],
      maxResponseBytes,
    };
    const deadline = createReplayDeadline(signal, maxDurationMs);
    try {
      const attempts: BrowserAttempt[] = [...(recoveryState?.completed.entries() ?? [])]
        .sort(([left], [right]) => left - right)
        .map(([, attempt]) => attempt);
      for (let attemptIndex = 0; attemptIndex < requiredAttempts; attemptIndex += 1) {
        if (recoveryState?.completed.has(attemptIndex)) continue;
        const attemptId = sha256(`${runId}:${request.request.id}:browser:${attemptIndex + 1}`);
        const recovered = recoveryState?.inFlight.get(attemptIndex);
        const proposed = recoveryState?.proposed.get(attemptIndex);
        const useRecovered = recovered !== undefined;
        const replay = recovered
          ? await recoveredReplayHandle(this.controlStore, runId, recovered.effect, attemptId)
          : proposed
            ? await recoveredReplayHandle(this.controlStore, runId, proposed, attemptId)
          : this.verifier.prepareReplay ? await this.verifier.prepareReplay({
            verificationRequestId: request.request.id,
            verificationKey: request.request.key,
            kind: "browser",
            policyHash,
            recipeHash: request.request.recipeHash,
            attemptId,
            cwd: before.task.scope.allowed_workspace,
            recoveryInput: { content: JSON.stringify({ schemaVersion: 1, kind: "browser", steps: recipe.steps }), filename: `browser-replay-${attemptId}.json`, mime: "application/json", sensitivity: "secret" },
          }) : undefined;
        const session = useRecovered
          ? await this.createRecoveredSession!(recovered!.handoff, factoryRequest, deadline.signal)
          : await createCleanSession(factoryRequest, deadline.signal);
        if (!useRecovered) await session.open();
        const opened = (await this.controlStore.snapshot(runId)).sessions[session.sessionId];
        const validRecovered = useRecovered && opened?.id === sessionIdFromResourceId(recovered!.handoff.resourceId) && opened.interactions <= recipe.steps.length;
        const validClean = !useRecovered && Boolean(opened) && opened!.runId === runId && opened!.kind === "browser" && opened!.status === "OPEN" && opened!.ownerLane === "verifier" && opened!.generation === before.generation && opened!.endpoint === target.origin && session.origin === target.origin && !Object.hasOwn(before.sessions, session.sessionId) && session.isPristine();
        if (!opened || opened.runId !== runId || opened.kind !== "browser" || opened.status !== "OPEN" || opened.ownerLane !== "verifier" || opened.generation !== before.generation || opened.endpoint !== target.origin || session.origin !== target.origin || (!validRecovered && !validClean)) {
          await session.close().catch(() => undefined);
          throw new Error("Browser reproduction requires a new pristine verifier browser session in the current run");
        }
        if (replay && this.verifier.startReplay) await this.verifier.startReplay(replay.effectId, session.sessionId, session.externalId);
        const startStep = useRecovered ? opened.interactions : 0;
        const artifactIds: string[] = [];
        const requests: BrowserReplayRequest[] = [];
        let candidate: string | undefined;
        let candidateArtifactId: string | undefined;
        let success = true;
        let summary = "Clean browser contexts contained no flag.";
        let replayResult: RawEffectResult = { stdout: "", stderr: "replay interrupted", exitCode: null, durationMs: 0, externalId: session.sessionId };
        try {
          for (const step of recipe.steps.slice(startStep)) {
            const action = step.action ?? "navigate";
            const response = await executeBrowserAction(session, action, step, deadline.signal);
            artifactIds.push(response.artifactId);
            requests.push({ action, path: step.path ?? `browser:${action}`, ...(response.status === undefined ? {} : { status: response.status }), artifactId: response.artifactId, stateHash: response.stateHash });
            if (step.expectStatus !== undefined && response.status !== step.expectStatus) {
              success = false;
              summary = `Expected browser status ${step.expectStatus}, got ${response.status ?? "unknown"}.`;
              break;
            }
            if (step.expectPattern && !compileBoundedPattern(step.expectPattern, "browser step").test(response.content.slice(-65_536))) {
              success = false;
              summary = `Browser response did not match step expectation for ${step.path ?? action}.`;
              break;
            }
            const match = response.content.match(flagPattern)?.[0];
            if (match) {
              candidate = match;
              candidateArtifactId = response.artifactId;
            }
          }
          if (success && candidate && recipeInputsContain(recipe.steps, candidate)) {
            success = false;
            summary = "The candidate appeared in the browser replay recipe input; refusing to treat a reflected literal as reproduction.";
          } else if (success && candidate) {
            summary = "Clean browser context reproduced the flag from a navigation response.";
          }
          const accepted = success && Boolean(candidate);
          replayResult = {
            stdout: serializeVerifierOutcomeEnvelope({
              schemaVersion: 1,
              requestKey: request.request.key,
              runId,
              generation: before.generation,
              kind: "browser",
              policyHash,
              recipeHash: request.request.recipeHash,
              externalId: session.sessionId,
              externalStatus: "CONFIRMED",
              attempts: [{ id: attemptId, phase: "browser_replay", status: accepted ? "PASSED" : "FAILED", externalId: session.sessionId, summary: accepted ? "Browser replay produced a policy-matching candidate." : "Browser replay did not produce a policy-matching candidate." }],
              transcriptArtifactIds: artifactIds,
              stageSummary: { reproduced: accepted, actionCount: requests.length, artifactCount: artifactIds.length },
              evidenceIds: [],
              terminal: false,
            }, { replay: true }),
            stderr: "",
            exitCode: accepted ? 0 : 1,
            durationMs: 0,
            externalId: session.sessionId,
          };
          attempts.push({ attemptId, sessionId: session.sessionId, artifactIds, requests, success: accepted, ...(candidate ? { candidate } : {}), ...(candidateArtifactId ? { candidateArtifactId } : {}), summary });
        } catch (error) {
          success = false;
          summary = `Browser replay failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512);
          replayResult = {
            stdout: serializeVerifierOutcomeEnvelope({
              schemaVersion: 1,
              requestKey: request.request.key,
              runId,
              generation: before.generation,
              kind: "browser",
              policyHash,
              recipeHash: request.request.recipeHash,
              externalId: session.sessionId,
              externalStatus: "UNKNOWN",
              attempts: [{ id: attemptId, phase: "browser_replay", status: "UNKNOWN", externalId: session.sessionId, summary: "Browser replay ended with an unknown external result." }],
              transcriptArtifactIds: artifactIds,
              stageSummary: { reproduced: false, actionCount: requests.length, artifactCount: artifactIds.length },
              evidenceIds: [],
              terminal: false,
              failureReason: summary,
            }, { replay: true }),
            stderr: summary,
            exitCode: null,
            durationMs: 0,
            externalId: session.sessionId,
          };
          attempts.push({ attemptId, sessionId: session.sessionId, artifactIds, requests, success: false, ...(candidate ? { candidate } : {}), ...(candidateArtifactId ? { candidateArtifactId } : {}), summary });
        } finally {
          await session.close().catch(() => undefined);
          if (replay && this.verifier.finishReplay) await this.verifier.finishReplay(replay.effectId, replayResult);
        }
        if (!attempts.at(-1)!.success) break;
        recoveryState?.inFlight.delete(attemptIndex);
        recoveryState?.proposed.delete(attemptIndex);
      }
      const candidate = attempts.find((attempt) => attempt.candidate)?.candidate;
      const candidateArtifactId = attempts.find((attempt) => attempt.candidateArtifactId)?.candidateArtifactId;
      const reproduced = attempts.length === requiredAttempts && attempts.every((attempt) => attempt.success && attempt.candidate === candidate);
      const summary = reproduced
        ? "Clean verifier browser contexts reproduced the flag consistently."
        : attempts.find((attempt) => !attempt.success)?.summary ?? "Clean browser reproductions did not agree on a flag.";
      return await this.record(runId, reproduced, attempts, summary, candidate, before.task.scope.allowed_workspace, signal, candidateArtifactId, request.request.key);
    } finally {
      deadline.dispose();
    }
  }

  private async record(runId: string, reproduced: boolean, attempts: BrowserAttempt[], summary: string, flag: string | undefined, cwd: string, signal?: AbortSignal, primaryResponseArtifactId?: string, verificationKey?: string): Promise<BrowserReproductionResult> {
    const snapshot = await this.controlStore.snapshot(runId);
    const evidenceId = id("EV");
    const completionId = id("C");
    const artifactIds = attempts.flatMap((attempt) => attempt.artifactIds);
    const candidate = flag ?? `__NO_BROWSER_FLAG__:${sha256(canonicalJson({ runId, artifactIds, summary })).slice(0, 24)}`;
    const candidateHash = sha256(candidate);
    const candidateArtifact = await this.artifactStore.putText(runId, candidate, {
      filename: `browser-candidate-${completionId}.txt`,
      mime: "text/plain",
      sensitivity: "result_candidate",
      semantic: { name: "Browser reproduction candidate", summary: `Candidate sha256=${candidateHash}.`, tags: ["web", "browser", "verification", "candidate"], role: "result", relatedIds: [], annotatedBy: "harness" },
    });
    await this.controlStore.dispatch(runId, {
      type: "completion_proposed",
      completion: { id: completionId, purpose: "harness_verification", candidateHash, artifactId: candidateArtifact.id, ...(verificationKey ? { verificationKey } : {}) },
      lane: "main",
    });
    const evidenceIds: string[] = [];
    const effects: Array<{ effectId: string; artifactId: string }> = [];
    for (const [index, attempt] of attempts.entries()) {
      const attemptEvidenceId = index === 0 ? evidenceId : id("EV");
      const attemptId = attempt.attemptId;
      const effect = await this.verifier.executeEffect({
        completionId,
        candidateHash,
        candidateArtifactId: candidateArtifact.id,
        attemptId,
        sessionId: attempt.sessionId,
        cwd,
        payload: JSON.stringify({ schemaVersion: 1, accepted: reproduced, candidateHash, responseArtifactIds: attempt.artifactIds, stateHashes: attempt.requests.map((request) => request.stateHash) }),
      }, signal);
      effects.push(effect);
      const effectArtifactIds = [...new Set([effect.artifactId, ...attempt.artifactIds])];
      await this.verifier.recordEvidence(runId, {
        id: attemptEvidenceId,
        kind: reproduced ? "reproduction" : "negative",
        summary,
        tags: ["web", "browser", "reproduction", "clean-context"],
        source: { tool: "browser_reproduce", effectId: effect.effectId, artifactId: effect.artifactId, artifactIds: effectArtifactIds, generation: snapshot.generation },
        confidence: reproduced ? 1 : 0.8,
        supports: reproduced ? [completionId] : [],
        refutes: reproduced ? [] : [completionId],
      });
      evidenceIds.push(attemptEvidenceId);
    }
    await this.verifier.finalize(runId, completionId, reproduced, evidenceIds);
    if (["web", "mixed", "unknown"].includes(snapshot.task.target_kind)) {
      await this.verifier.recordDomainRecords(runId, buildBrowserDomainRecords(snapshot.generation, completionId, attempts, evidenceIds, effects, reproduced));
    }
    return { reproduced, ...(reproduced && flag ? { flag } : {}), evidenceId, ...(primaryResponseArtifactId ? { artifactId: primaryResponseArtifactId } : {}) };
  }
}

function validateBrowserRecipe(steps: BrowserWebExploitStep[], maxSteps: number, allowedActions: readonly string[]): void {
  if (steps.length < 1 || steps.length > maxSteps) throw new Error(`Browser reproduction requires 1-${maxSteps} browser steps`);
  for (const step of steps) {
    const raw = step as unknown as Record<string, unknown>;
    if (Object.hasOwn(raw, "method") || Object.hasOwn(raw, "headers") || Object.hasOwn(raw, "body")) throw new Error("Browser reproduction does not accept HTTP method, headers, or body fields");
    const action = step.action ?? "navigate";
    if (!allowedActions.includes(action)) throw new Error(`Browser action ${action} is not allowed by the immutable task policy`);
    if (action === "navigate" && (!step.path || step.path.length > 2_048)) throw new Error("Browser navigate action requires a bounded path");
    if (action === "click" || action === "submit") assertBrowserSelector(step.selector, action);
    if (action === "fill") {
      assertBrowserSelector(step.selector, action);
      if (typeof step.value !== "string" || step.value.length > 4_096) throw new Error("Browser fill action requires a bounded value");
    }
    if (action === "wait" && (!Number.isInteger(step.wait_ms) || step.wait_ms! < 1 || step.wait_ms! > 10_000)) throw new Error("Browser wait action requires 1-10000 milliseconds");
  }
}

function assertBrowserSelector(selector: BrowserSelector | undefined, action: string): asserts selector is BrowserSelector {
  if (!selector || !["role", "label", "test_id", "css"].includes(selector.kind) || typeof selector.value !== "string" || selector.value.length === 0 || selector.value.length > 256 || /[\u0000\r\n]/.test(selector.value)) throw new Error(`Browser ${action} action requires a bounded selector`);
  if (selector.name !== undefined && (selector.kind !== "role" || selector.name.length > 256 || /[\u0000\r\n]/.test(selector.name))) throw new Error("Browser role selector name is invalid");
}

async function executeBrowserAction(session: BrowserContextBackend, action: BrowserActionKind, step: BrowserWebExploitStep, signal: AbortSignal): Promise<BrowserActionResponse> {
  switch (action) {
    case "navigate":
      return await session.navigate(step.path, signal);
    case "click":
      return await session.click(step.selector!, signal);
    case "fill":
      return await session.fill(step.selector!, step.value!, signal);
    case "submit":
      return await session.submit(step.selector!, signal);
    case "wait":
      return await session.wait(step.wait_ms!, signal);
  }
}

function createReplayDeadline(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Browser reproduction deadline exceeded")), timeoutMs);
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  return { signal, dispose: () => clearTimeout(timer) };
}

function buildBrowserDomainRecords(generation: number, completionId: string, attempts: BrowserAttempt[], evidenceIds: string[], effects: Array<{ effectId: string; artifactId: string }>, reproduced: boolean): DomainRecordInput[] {
  const records: DomainRecordInput[] = [];
  for (const [attemptIndex, attempt] of attempts.entries()) {
    const requestRecordIds: string[] = [];
    for (const [requestIndex, request] of attempt.requests.entries()) {
      if (request.status === undefined) continue;
      const requestId = `WEB-BROWSER-${generation}-${completionId}-${attemptIndex}-${requestIndex}`;
      requestRecordIds.push(requestId);
      records.push({
        id: requestId,
        kind: "web_request",
        summary: `Verifier browser replay ${request.action.toUpperCase()} ${request.path} returned ${request.status}.`,
        artifactIds: [request.artifactId],
        evidenceIds: [evidenceIds[attemptIndex]!],
        method: request.action === "navigate" ? "GET" : request.action.toUpperCase(),
        path: request.path,
        status: request.status,
        sessionId: attempt.sessionId,
        stateHash: request.stateHash,
      });
    }
    const effect = effects[attemptIndex];
    records.push({
      id: `WEB-BROWSER-CHAIN-${generation}-${completionId}-${attemptIndex}`,
      kind: "web_exploit_chain",
      summary: attempt.summary,
      artifactIds: [...new Set([...(effect ? [effect.artifactId] : []), ...attempt.artifactIds])].slice(0, 32),
      evidenceIds: [evidenceIds[attemptIndex]!],
      ...(effect ? { effectId: effect.effectId } : {}),
      stepRecordIds: requestRecordIds,
      status: reproduced && attempt.success ? "reproduced" : "observed",
    });
  }
  return records;
}

function recipeInputsContain(steps: BrowserWebExploitStep[], candidate: string): boolean {
  const needle = candidate.toLowerCase();
  return steps.some((step) => [step.action ?? "navigate", step.path ?? "", step.value ?? "", step.selector?.kind ?? "", step.selector?.value ?? "", step.selector?.name ?? "", step.wait_ms === undefined ? "" : String(step.wait_ms)].some((value) => value.toLowerCase().includes(needle)));
}

async function recoveredReplayHandle(controlStore: ControlStore, runId: string, effect: Effect, attemptId: string): Promise<VerifierReplayHandle> {
  if ((effect.status !== "STARTED" && effect.status !== "PROPOSED") || effect.args.attemptId !== attemptId) throw new Error(`Browser replay Effect ${effect.id} is not the expected attempt`);
  const snapshot = await controlStore.snapshot(runId);
  const recoveryHash = typeof effect.args.recoveryArtifactSha256 === "string" ? effect.args.recoveryArtifactSha256 : undefined;
  const inputArtifact = recoveryHash
    ? Object.values(snapshot.artifacts).find((artifact) => artifact.origin.registeredBy === "verifier" && artifact.sourceEffectId === undefined && artifact.sha256 === recoveryHash)
    : undefined;
  if (!inputArtifact) throw new Error(`Browser replay Effect ${effect.id} has no immutable recipe Artifact`);
  return { effectId: effect.id, attemptId, inputArtifactId: inputArtifact.id };
}

async function collectBrowserRecovery(
  controlStore: ControlStore,
  artifactStore: ArtifactStore,
  runId: string,
  verificationRequestId: string,
  verificationKey: string,
  policyHash: string,
  recipeHash: string,
  requiredAttempts: number,
  flagPattern: RegExp,
  recipe: BrowserWebExploitStep[],
  handoffs: readonly BrowserRuntimeHandoff[],
): Promise<BrowserRecoveryState> {
  const snapshot = await controlStore.snapshot(runId);
  const state: BrowserRecoveryState = { completed: new Map(), inFlight: new Map(), proposed: new Map() };
  const expectedAttemptIds = new Map<number, string>();
  for (let index = 0; index < requiredAttempts; index += 1) expectedAttemptIds.set(index, sha256(`${runId}:${verificationRequestId}:browser:${index + 1}`));
  const matchingHandoffs = handoffs.filter((handoff) => handoff.record.runId === runId
    && handoff.record.generation === snapshot.generation
    && handoff.record.kind === "browser-context"
    && handoff.record.requestKey === verificationKey
    && handoff.record.policyHash === policyHash
    && handoff.record.recipeHash === recipeHash);
  for (const effect of Object.values(snapshot.effects)) {
    if (effect.operation !== "verification_replay" || effect.producerLane !== "verifier" || effect.args.verificationRequestId !== verificationRequestId) continue;
    const attemptId = typeof effect.args.attemptId === "string" ? effect.args.attemptId : undefined;
    const attemptIndex = attemptId === undefined ? undefined : [...expectedAttemptIds.entries()].find(([, expected]) => expected === attemptId)?.[0];
    if (attemptIndex === undefined) throw new Error(`Browser verification request ${verificationRequestId} contains an unexpected replay attempt`);
    if (attemptId === undefined) throw new Error(`Browser verification request ${verificationRequestId} contains an invalid replay attempt`);
    if (state.completed.has(attemptIndex) || state.inFlight.has(attemptIndex) || state.proposed.has(attemptIndex)) throw new Error(`Browser verification request ${verificationRequestId} contains duplicate attempt ${attemptIndex + 1}`);
    if (effect.status === "FINISHED") {
      state.completed.set(attemptIndex, await readFinishedBrowserAttempt(controlStore, artifactStore, runId, effect, attemptId, policyHash, recipeHash, flagPattern, recipe));
      continue;
    }
    if (effect.status === "STARTED") {
      const sessionId = effect.sessionId;
      const handoff = matchingHandoffs.find((candidate) => sessionIdFromResourceId(candidate.resourceId) === sessionId);
      if (!sessionId || !handoff) throw new Error(`Browser replay attempt ${attemptIndex + 1} is STARTED without an exact broker handoff`);
      state.inFlight.set(attemptIndex, { effect, handoff });
      continue;
    }
    if (effect.status === "PROPOSED") {
      state.proposed.set(attemptIndex, effect);
      continue;
    }
    throw new Error(`Browser replay attempt ${attemptIndex + 1} is ${effect.status}; external result is ambiguous`);
  }
  if (state.inFlight.size > 1) throw new Error(`Browser verification request ${verificationRequestId} has multiple in-flight attempts`);
  const seen = new Set<number>([...state.completed.keys(), ...state.inFlight.keys(), ...state.proposed.keys()]);
  for (const index of seen) {
    for (let prior = 0; prior < index; prior += 1) {
      if (!seen.has(prior)) throw new Error(`Browser verification request ${verificationRequestId} is missing attempt ${prior + 1}`);
    }
  }
  return state;
}

async function readFinishedBrowserAttempt(
  controlStore: ControlStore,
  artifactStore: ArtifactStore,
  runId: string,
  effect: Effect,
  attemptId: string,
  policyHash: string,
  recipeHash: string,
  flagPattern: RegExp,
  recipe: BrowserWebExploitStep[],
): Promise<BrowserAttempt> {
  if (!effect.artifactId || !effect.sessionId) throw new Error(`Browser replay Effect ${effect.id} has no durable result binding`);
  const snapshot = await controlStore.snapshot(runId);
  const resultArtifact = snapshot.artifacts[effect.artifactId];
  if (!resultArtifact || resultArtifact.origin.registeredBy !== "verifier" || resultArtifact.sourceEffectId !== effect.id) throw new Error(`Browser replay Effect ${effect.id} has no verifier-owned result Artifact`);
  const stored = JSON.parse(await artifactStore.readText(runId, resultArtifact)) as Partial<RawEffectResult>;
  if (typeof stored.stdout !== "string" || typeof stored.stderr !== "string" || (typeof stored.exitCode !== "number" && stored.exitCode !== null) || typeof stored.durationMs !== "number") throw new Error(`Browser replay Effect ${effect.id} has an invalid result Artifact`);
  const envelope = parseVerifierOutcomeEnvelope(JSON.parse(stored.stdout), { replay: true });
  if (envelope.runId !== runId || envelope.generation !== snapshot.generation || envelope.requestKey !== effect.args.verificationKey || envelope.policyHash !== policyHash || envelope.recipeHash !== recipeHash || envelope.kind !== "browser") throw new Error(`Browser replay Effect ${effect.id} result does not match its durable request`);
  const descriptor = envelope.attempts.find((attempt) => attempt.id === attemptId);
  if (!descriptor || (descriptor.status !== "PASSED" && descriptor.status !== "FAILED" && descriptor.status !== "UNKNOWN")) throw new Error(`Browser replay Effect ${effect.id} result is missing its attempt`);
  const artifactIds = [...envelope.transcriptArtifactIds];
  const requests: BrowserReplayRequest[] = [];
  let candidate: string | undefined;
  let candidateArtifactId: string | undefined;
  for (const artifactId of artifactIds) {
    const artifact = snapshot.artifacts[artifactId];
    if (!artifact || artifact.generation !== snapshot.generation) throw new Error(`Browser replay Effect ${effect.id} references a stale response Artifact`);
    const exchange = JSON.parse(await artifactStore.readText(runId, artifact)) as Partial<BrowserExchangeArtifact>;
    if (exchange.schemaVersion !== 1 || exchange.kind !== "browser_exchange" || !exchange.request || !exchange.response || typeof exchange.response.content !== "string" || typeof exchange.stateHash !== "string") throw new Error(`Browser replay Effect ${effect.id} references an invalid browser exchange Artifact`);
    const action = exchange.request.action;
    const path = typeof exchange.request.url === "string" ? browserPath(exchange.request.url, action) : `browser:${action}`;
    requests.push({ action, path, ...(typeof exchange.response.status === "number" ? { status: exchange.response.status } : {}), artifactId, stateHash: exchange.stateHash });
    const match = exchange.response.content.match(flagPattern)?.[0];
    if (match) {
      candidate = match;
      candidateArtifactId = artifactId;
    }
  }
  const success = descriptor.status === "PASSED";
  if (success && !candidate) throw new Error(`Browser replay Effect ${effect.id} passed without a policy-matching candidate`);
  if (candidate && recipeInputsContain(recipe, candidate)) throw new Error(`Browser replay Effect ${effect.id} contains a candidate reflected from recipe input`);
  return {
    attemptId,
    sessionId: effect.sessionId,
    artifactIds,
    requests,
    success,
    ...(candidate ? { candidate } : {}),
    ...(candidateArtifactId ? { candidateArtifactId } : {}),
    summary: descriptor.summary,
  };
}

function browserPath(url: string, action: BrowserActionKind): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return `browser:${action}`;
  }
}

function sessionIdFromResourceId(resourceId: string): string | undefined {
  return resourceId.startsWith("session:") ? resourceId.slice("session:".length) : undefined;
}
