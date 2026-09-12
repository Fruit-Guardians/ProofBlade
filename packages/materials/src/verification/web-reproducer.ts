import type { ControlStore } from "../control/control-store.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import type { BrowserActionKind, BrowserSelector, DomainRecordInput, Evidence } from "../domain/types.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { RawEffectResult } from "../domain/types.js";
import type { VerifierReplayHandle, VerifierReplayInput } from "../effects/effect-journal.js";
import type { HttpSessionBackend } from "../web/http-session.js";
import { beginVerificationRequest, readDurableVerificationResult } from "./verification-key.js";
import { serializeVerifierOutcomeEnvelope } from "./outcome-envelope.js";

export interface HttpWebExploitStep {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  expectStatus?: number;
  expectPattern?: string;
}

export interface BrowserWebExploitStep {
  /** Omitted is a backwards-compatible navigation action. */
  action?: BrowserActionKind;
  path?: string;
  selector?: BrowserSelector;
  value?: string;
  wait_ms?: number;
  expectStatus?: number;
  expectPattern?: string;
}

export interface HttpWebExploitRecipe {
  transport?: "http";
  steps: HttpWebExploitStep[];
}

export interface BrowserWebExploitRecipe {
  transport: "browser";
  steps: BrowserWebExploitStep[];
}

export type WebExploitRecipe = HttpWebExploitRecipe | BrowserWebExploitRecipe;
/** @deprecated Use HttpWebExploitStep or BrowserWebExploitStep explicitly. */
export type WebExploitStep = HttpWebExploitStep;

export interface WebVerifierPort {
  prepareReplay?(input: VerifierReplayInput): Promise<VerifierReplayHandle>;
  startReplay?(effectId: string, sessionId: string, externalId?: string): Promise<void>;
  finishReplay?(effectId: string, result: RawEffectResult): Promise<{ effectId: string; artifactId: string }>;
  executeEffect(input: {
    completionId: string;
    candidateHash: string;
    candidateArtifactId: string;
    attemptId: string;
    sessionId: string;
    cwd: string;
    payload: string;
  }, signal?: AbortSignal): Promise<{ effectId: string; artifactId: string }>;
  recordEvidence(runId: string, evidence: Omit<Evidence, "createdSeq" | "provenance">): Promise<void>;
  recordDomainRecords(runId: string, records: DomainRecordInput[]): Promise<void>;
  finalize(runId: string, completionId: string, accepted: boolean, evidenceIds: string[]): Promise<void>;
}

interface WebReplayRequest {
  method: string;
  path: string;
  status: number;
  artifactId: string;
  stateHash: string;
}

interface WebAttempt {
  attemptId: string;
  sessionId: string;
  artifactIds: string[];
  requests: WebReplayRequest[];
  success: boolean;
  candidate?: string;
  candidateArtifactId?: string;
  summary: string;
}

export class WebReproducer {
  public constructor(
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
    /** Trusted verifier-side adapter; model lanes never receive its raw ports. */
    private readonly verifier: WebVerifierPort,
  ) {}

  public async reproduce(runId: string, recipe: HttpWebExploitRecipe, createCleanSession: () => Promise<HttpSessionBackend>, signal?: AbortSignal): Promise<{ reproduced: boolean; flag?: string; evidenceId: string; artifactId?: string }> {
    if (recipe.steps.length < 1 || recipe.steps.length > 64) throw new Error("Web reproduction requires 1-64 steps");
    if (recipe.steps.some((step) => typeof step.path !== "string" || step.path.length === 0 || step.path.length > 2_048)) throw new Error("HTTP reproduction requires bounded paths");
    const before = await this.controlStore.snapshot(runId);
    const policy = before.task.verification.web;
    if (!policy?.flag_pattern) throw new Error("Web reproduction requires an immutable task verification policy");
    if (policy.transport === "browser") throw new Error("HTTP reproduction cannot run under a browser Web verification policy");
    const flagPattern = compileFlagPattern(policy.flag_pattern);
    const request = await beginVerificationRequest(this.controlStore, runId, {
      kind: "web",
      policyHash: sha256(canonicalJson(policy)),
      recipeHash: sha256(canonicalJson(recipe)),
    });
    if (!request.created) {
      const durable = await readDurableVerificationResult(this.controlStore, runId, request.request);
      if (durable) {
        const snapshot = await this.controlStore.snapshot(runId);
        const candidateArtifact = snapshot.artifacts[durable.completion.artifactId];
        if (!candidateArtifact) throw new Error(`Durable Web verification candidate is missing: ${durable.completion.artifactId}`);
        const candidate = await this.artifactStore.readText(runId, candidateArtifact);
        if (!durable.evidenceId) throw new Error("Durable Web verification has no Evidence");
        return {
          reproduced: durable.completion.status === "ACCEPTED",
          ...(durable.completion.status === "ACCEPTED" ? { flag: candidate } : {}),
          evidenceId: durable.evidenceId,
          artifactId: durable.completion.artifactId,
        };
      }
      throw new Error(`Web verification request ${request.request.id} requires durable recovery; refusing to open another clean session`);
    }
    const requiredAttempts = Math.max(1, before.task.verification.required_reproductions);
    const policyHash = sha256(canonicalJson(policy));
    const attempts: WebAttempt[] = [];
    for (let attempt = 0; attempt < requiredAttempts; attempt += 1) {
      const attemptId = sha256(`${runId}:${request.request.id}:web:${attempt + 1}`);
      const replay = this.verifier.prepareReplay ? await this.verifier.prepareReplay({
        verificationRequestId: request.request.id,
        verificationKey: request.request.key,
        kind: "web",
        policyHash,
        recipeHash: request.request.recipeHash,
        attemptId,
        cwd: before.task.scope.allowed_workspace,
        recoveryInput: { content: JSON.stringify({ schemaVersion: 1, kind: "web", steps: recipe.steps }), filename: `web-replay-${attemptId}.json`, mime: "application/json", sensitivity: "secret" },
      }) : undefined;
      const session = await createCleanSession();
      const opened = (await this.controlStore.snapshot(runId)).sessions[session.sessionId];
      if (!opened || opened.runId !== runId || opened.kind !== "http" || opened.status !== "OPEN" || opened.ownerLane !== "verifier" || opened.generation !== before.generation || Object.hasOwn(before.sessions, session.sessionId) || !session.isPristine()) {
        await session.close("reproducer rejected non-clean session").catch(() => undefined);
        throw new Error("Web reproduction requires a new pristine verifier HTTP session in the current run");
      }
      if (replay && this.verifier.startReplay) await this.verifier.startReplay(replay.effectId, session.sessionId);
      const artifactIds: string[] = [];
      const requests: WebReplayRequest[] = [];
      let candidate: string | undefined;
      let candidateArtifactId: string | undefined;
      let success = true;
      let summary = "Clean-session responses contained no flag.";
      let replayResult: RawEffectResult = { stdout: "", stderr: "replay interrupted", exitCode: null, durationMs: 0, externalId: session.sessionId };
      try {
        for (const step of recipe.steps) {
          const response = await session.request(step.path, { method: step.method, headers: step.headers, body: step.body }, signal);
          artifactIds.push(response.artifactId);
          requests.push({ method: (step.method ?? "GET").toUpperCase(), path: step.path, status: response.status, artifactId: response.artifactId, stateHash: response.stateHash });
          if (step.expectStatus !== undefined && response.status !== step.expectStatus) {
            success = false;
            summary = `Expected HTTP ${step.expectStatus}, got ${response.status}.`;
            break;
          }
          if (step.expectPattern && !compileBoundedPattern(step.expectPattern, "step").test(response.body.slice(-65_536))) {
            success = false;
            summary = `Response did not match step expectation for ${step.path}.`;
            break;
          }
          const match = response.body.match(flagPattern)?.[0];
          if (match) {
            candidate = match;
            candidateArtifactId = response.artifactId;
          }
        }
        if (success && candidate && recipeInputsContain(recipe, candidate)) {
          success = false;
          summary = "The candidate appeared in the replay recipe input; refusing to treat a reflected literal as reproduction.";
        } else if (success && candidate) {
          summary = "Clean HTTP session reproduced the flag from a response in this chain.";
        }
        const accepted = success && Boolean(candidate);
        replayResult = {
          stdout: serializeVerifierOutcomeEnvelope({
            schemaVersion: 1,
            requestKey: request.request.key,
            runId,
            generation: before.generation,
            kind: "web",
            policyHash,
            recipeHash: request.request.recipeHash,
            externalId: session.sessionId,
            externalStatus: "CONFIRMED",
            attempts: [{ id: attemptId, phase: "web_replay", status: accepted ? "PASSED" : "FAILED", externalId: session.sessionId, summary: accepted ? "HTTP replay produced a policy-matching candidate." : "HTTP replay did not produce a policy-matching candidate." }],
            transcriptArtifactIds: artifactIds,
            stageSummary: { reproduced: accepted, requestCount: requests.length, artifactCount: artifactIds.length },
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
        const message = error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512);
        replayResult = {
          stdout: serializeVerifierOutcomeEnvelope({
            schemaVersion: 1,
            requestKey: request.request.key,
            runId,
            generation: before.generation,
            kind: "web",
            policyHash,
            recipeHash: request.request.recipeHash,
            externalId: session.sessionId,
            externalStatus: "UNKNOWN",
            attempts: [{ id: attemptId, phase: "web_replay", status: "UNKNOWN", externalId: session.sessionId, summary: "HTTP replay ended with an unknown external result." }],
            transcriptArtifactIds: artifactIds,
            stageSummary: { reproduced: false, requestCount: requests.length, artifactCount: artifactIds.length },
            evidenceIds: [],
            terminal: false,
            failureReason: message,
          }, { replay: true }),
          stderr: message,
          exitCode: null,
          durationMs: 0,
          externalId: session.sessionId,
        };
        throw error;
      } finally {
        await session.close("web-reproduction-complete");
        if (replay && this.verifier.finishReplay) await this.verifier.finishReplay(replay.effectId, replayResult);
      }
      if (!attempts.at(-1)!.success) break;
    }
    const candidate = attempts.find((attempt) => attempt.candidate)?.candidate;
    const candidateArtifactId = attempts.find((attempt) => attempt.candidateArtifactId)?.candidateArtifactId;
    const reproduced = attempts.length === requiredAttempts && attempts.every((attempt) => attempt.success && attempt.candidate === candidate);
    const summary = reproduced
      ? "Clean verifier HTTP sessions reproduced the flag consistently."
      : attempts.find((attempt) => !attempt.success)?.summary ?? "Clean-session reproductions did not agree on a flag.";
    return await this.record(runId, reproduced, attempts, summary, candidate, before.task.scope.allowed_workspace, signal, candidateArtifactId, request.request.key);
  }

  private async record(runId: string, reproduced: boolean, attempts: WebAttempt[], summary: string, flag: string | undefined, cwd: string, signal?: AbortSignal, primaryResponseArtifactId?: string, verificationKey?: string): Promise<{ reproduced: boolean; flag?: string; evidenceId: string; artifactId?: string }> {
    const snapshot = await this.controlStore.snapshot(runId);
    const evidenceId = id("EV");
    const completionId = id("C");
    const artifactIds = attempts.flatMap((attempt) => attempt.artifactIds);
    const candidate = flag ?? `__NO_WEB_FLAG__:${sha256(canonicalJson({ runId, artifactIds, summary })).slice(0, 24)}`;
    const candidateHash = sha256(candidate);
    const candidateArtifact = await this.artifactStore.putText(runId, candidate, {
      filename: `web-candidate-${completionId}.txt`,
      mime: "text/plain",
      sensitivity: "result_candidate",
      semantic: { name: "Web reproduction candidate", summary: `Candidate sha256=${candidateHash}.`, tags: ["web", "verification", "candidate"], role: "result", relatedIds: [], annotatedBy: "harness" },
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
        payload: JSON.stringify({ accepted: reproduced, candidateHash, responseArtifactIds: attempt.artifactIds }),
      }, signal);
      effects.push(effect);
      const effectArtifactIds = [...new Set([effect.artifactId, ...attempt.artifactIds])];
      await this.verifier.recordEvidence(runId, {
        id: attemptEvidenceId,
        kind: reproduced ? "reproduction" : "negative",
        summary,
        tags: ["web", "reproduction", "clean-session"],
        source: { tool: "web_reproduce", effectId: effect.effectId, artifactId: effect.artifactId, artifactIds: effectArtifactIds, generation: snapshot.generation },
        confidence: reproduced ? 1 : 0.8,
        supports: reproduced ? [completionId] : [],
        refutes: reproduced ? [] : [completionId],
      });
      evidenceIds.push(attemptEvidenceId);
    }
    await this.verifier.finalize(runId, completionId, reproduced, evidenceIds);
    if (["web", "mixed", "unknown"].includes(snapshot.task.target_kind)) {
      await this.verifier.recordDomainRecords(runId, buildReplayDomainRecords(snapshot.generation, completionId, attempts, evidenceIds, effects, reproduced));
    }
    return { reproduced, ...(reproduced && flag ? { flag } : {}), evidenceId, ...(primaryResponseArtifactId ? { artifactId: primaryResponseArtifactId } : {}) };
  }
}

function buildReplayDomainRecords(
  generation: number,
  completionId: string,
  attempts: WebAttempt[],
  evidenceIds: string[],
  effects: Array<{ effectId: string; artifactId: string }>,
  reproduced: boolean,
): DomainRecordInput[] {
  const records: DomainRecordInput[] = [];
  for (const [attemptIndex, attempt] of attempts.entries()) {
    const requestRecordIds = attempt.requests.map((_request, requestIndex) => `WEB-REPLAY-${generation}-${completionId}-${attemptIndex}-${requestIndex}`);
    for (const [requestIndex, request] of attempt.requests.entries()) {
      records.push({
        id: requestRecordIds[requestIndex]!,
        kind: "web_request",
        summary: `Verifier replay ${request.method} ${request.path} returned ${request.status}.`,
        artifactIds: [request.artifactId],
        evidenceIds: [evidenceIds[attemptIndex]!],
        method: request.method,
        path: request.path,
        status: request.status,
        sessionId: attempt.sessionId,
        stateHash: request.stateHash,
      });
    }
    const effect = effects[attemptIndex];
    const chainArtifacts = [...new Set([...(effect ? [effect.artifactId] : []), ...attempt.artifactIds])].slice(0, 32);
    records.push({
      id: `WEB-REPLAY-CHAIN-${generation}-${completionId}-${attemptIndex}`,
      kind: "web_exploit_chain",
      summary: attempt.summary,
      artifactIds: chainArtifacts,
      evidenceIds: [evidenceIds[attemptIndex]!],
      ...(effect ? { effectId: effect.effectId } : {}),
      stepRecordIds: requestRecordIds,
      status: reproduced && attempt.success ? "reproduced" : "observed",
    });
  }
  return records;
}

function recipeInputsContain(recipe: HttpWebExploitRecipe, candidate: string): boolean {
  const needle = candidate.toLowerCase();
  return recipe.steps.some((step) => [step.path, step.method ?? "", step.body ?? "", ...Object.entries(step.headers ?? {}).flat()].some((value) => value.toLowerCase().includes(needle)));
}

export function compileFlagPattern(pattern: string): RegExp {
  return compileBoundedPattern(pattern, "flag");
}

export function compileBoundedPattern(pattern: string, label: string): RegExp {
  if (!pattern || pattern.length > 256 || /^\.\*\$?$/.test(pattern.trim()) || /^\^\.\*\$?$/.test(pattern.trim()) || !/[A-Za-z0-9]/.test(pattern) || /\([^)]*[+*][^)]*\)[+*]|\((?:[^|()]|\([^)]*\))*\|(?:[^|()]|\([^)]*\))*\)[+*]/.test(pattern)) throw new Error(`Unsafe web ${label} pattern`);
  return new RegExp(pattern);
}
