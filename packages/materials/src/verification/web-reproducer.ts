import type { ControlStore } from "../control/control-store.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import type { Evidence } from "../domain/types.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { HttpSessionBackend } from "../web/http-session.js";

export interface WebExploitStep {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  expectStatus?: number;
  expectPattern?: string;
}

export interface WebExploitRecipe {
  steps: WebExploitStep[];
}

export interface WebVerifierPort {
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
  finalize(runId: string, completionId: string, accepted: boolean, evidenceIds: string[]): Promise<void>;
}

interface WebAttempt {
  sessionId: string;
  artifactIds: string[];
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

  public async reproduce(runId: string, recipe: WebExploitRecipe, createCleanSession: () => Promise<HttpSessionBackend>, signal?: AbortSignal): Promise<{ reproduced: boolean; flag?: string; evidenceId: string; artifactId?: string }> {
    if (recipe.steps.length < 1 || recipe.steps.length > 64) throw new Error("Web reproduction requires 1-64 steps");
    const before = await this.controlStore.snapshot(runId);
    const policy = before.task.verification.web;
    if (!policy?.flag_pattern) throw new Error("Web reproduction requires an immutable task verification policy");
    const flagPattern = compileFlagPattern(policy.flag_pattern);
    const requiredAttempts = Math.max(1, before.task.verification.required_reproductions);
    const attempts: WebAttempt[] = [];
    for (let attempt = 0; attempt < requiredAttempts; attempt += 1) {
      const session = await createCleanSession();
      const opened = (await this.controlStore.snapshot(runId)).sessions[session.sessionId];
      if (!opened || opened.runId !== runId || opened.kind !== "http" || opened.status !== "OPEN" || opened.ownerLane !== "verifier" || opened.generation !== before.generation || Object.hasOwn(before.sessions, session.sessionId) || !session.isPristine()) {
        await session.close("reproducer rejected non-clean session").catch(() => undefined);
        throw new Error("Web reproduction requires a new pristine verifier HTTP session in the current run");
      }
      const artifactIds: string[] = [];
      let candidate: string | undefined;
      let candidateArtifactId: string | undefined;
      let success = true;
      let summary = "Clean-session responses contained no flag.";
      try {
        for (const step of recipe.steps) {
          const response = await session.request(step.path, { method: step.method, headers: step.headers, body: step.body }, signal);
          artifactIds.push(response.artifactId);
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
        attempts.push({ sessionId: session.sessionId, artifactIds, success: success && Boolean(candidate), ...(candidate ? { candidate } : {}), ...(candidateArtifactId ? { candidateArtifactId } : {}), summary });
      } finally {
        await session.close("web-reproduction-complete");
      }
      if (!attempts.at(-1)!.success) break;
    }
    const candidate = attempts.find((attempt) => attempt.candidate)?.candidate;
    const candidateArtifactId = attempts.find((attempt) => attempt.candidateArtifactId)?.candidateArtifactId;
    const reproduced = attempts.length === requiredAttempts && attempts.every((attempt) => attempt.success && attempt.candidate === candidate);
    const summary = reproduced
      ? "Clean verifier HTTP sessions reproduced the flag consistently."
      : attempts.find((attempt) => !attempt.success)?.summary ?? "Clean-session reproductions did not agree on a flag.";
    return await this.record(runId, reproduced, attempts, summary, candidate, before.task.scope.allowed_workspace, signal, candidateArtifactId);
  }

  private async record(runId: string, reproduced: boolean, attempts: WebAttempt[], summary: string, flag: string | undefined, cwd: string, signal?: AbortSignal, primaryResponseArtifactId?: string): Promise<{ reproduced: boolean; flag?: string; evidenceId: string; artifactId?: string }> {
    const snapshot = await this.controlStore.snapshot(runId);
    const evidenceId = id("EV");
    const completionId = id("C");
    const artifactIds = attempts.flatMap((attempt) => attempt.artifactIds);
    const candidate = flag ?? `__NO_WEB_FLAG__:${sha256(canonicalJson({ runId, artifactIds, summary })).slice(0, 24)}`;
    const candidateHash = sha256(candidate);
    const candidateArtifact = await this.artifactStore.putText(runId, candidate, {
      filename: `web-candidate-${completionId}.txt`,
      mime: "text/plain",
      sensitivity: "flag_candidate",
      semantic: { name: "Web reproduction candidate", summary: `Candidate sha256=${candidateHash}.`, tags: ["web", "verification", "candidate"], role: "result", relatedIds: [], annotatedBy: "harness" },
    });
    await this.controlStore.dispatch(runId, {
      type: "completion_proposed",
      completion: { id: completionId, purpose: "harness_verification", candidateHash, artifactId: candidateArtifact.id },
      lane: "main",
    });
    const evidenceIds: string[] = [];
    for (const [index, attempt] of attempts.entries()) {
      const attemptEvidenceId = index === 0 ? evidenceId : id("EV");
      const attemptId = sha256(`${runId}:${completionId}:${snapshot.generation}:${attempt.sessionId}:${candidateHash}`);
      const effect = await this.verifier.executeEffect({
        completionId,
        candidateHash,
        candidateArtifactId: candidateArtifact.id,
        attemptId,
        sessionId: attempt.sessionId,
        cwd,
        payload: JSON.stringify({ accepted: reproduced, candidateHash, responseArtifactIds: attempt.artifactIds }),
      }, signal);
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
    return { reproduced, ...(reproduced && flag ? { flag } : {}), evidenceId, ...(primaryResponseArtifactId ? { artifactId: primaryResponseArtifactId } : {}) };
  }
}

function recipeInputsContain(recipe: WebExploitRecipe, candidate: string): boolean {
  const needle = candidate.toLowerCase();
  return recipe.steps.some((step) => [step.path, step.method ?? "", step.body ?? "", ...Object.entries(step.headers ?? {}).flat()].some((value) => value.toLowerCase().includes(needle)));
}

function compileFlagPattern(pattern: string): RegExp {
  return compileBoundedPattern(pattern, "flag");
}

function compileBoundedPattern(pattern: string, label: string): RegExp {
  if (!pattern || pattern.length > 256 || /^\.\*\$?$/.test(pattern.trim()) || /^\^\.\*\$?$/.test(pattern.trim()) || !/[A-Za-z0-9]/.test(pattern) || /\([^)]*[+*][^)]*\)[+*]|\((?:[^|()]|\([^)]*\))*\|(?:[^|()]|\([^)]*\))*\)[+*]/.test(pattern)) throw new Error(`Unsafe web ${label} pattern`);
  return new RegExp(pattern);
}
