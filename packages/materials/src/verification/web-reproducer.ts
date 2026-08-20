import type { ControlStore } from "../control/control-store.js";
import { id } from "../domain/utils.js";
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
  flagPattern: string;
}

export class WebReproducer {
  public constructor(private readonly controlStore: ControlStore) {}

  public async reproduce(runId: string, recipe: WebExploitRecipe, createCleanSession: () => Promise<HttpSessionBackend>, signal?: AbortSignal): Promise<{ reproduced: boolean; flag?: string; evidenceId: string; artifactId?: string }> {
    if (recipe.steps.length < 1 || recipe.steps.length > 64) throw new Error("Web reproduction requires 1-64 steps");
    const flagPattern = compileFlagPattern(recipe.flagPattern);
    const session = await createCleanSession();
    let last: Awaited<ReturnType<HttpSessionBackend["request"]>> | undefined;
    try {
      for (const step of recipe.steps) {
        last = await session.request(step.path, { method: step.method, headers: step.headers, body: step.body }, signal);
        if (step.expectStatus !== undefined && last.status !== step.expectStatus) return await this.record(runId, false, last.artifactId, `Expected HTTP ${step.expectStatus}, got ${last.status}.`);
        if (step.expectPattern && !compileBoundedPattern(step.expectPattern, "step").test(last.body.slice(-65_536))) return await this.record(runId, false, last.artifactId, `Response did not match step expectation for ${step.path}.`);
      }
      const flag = last?.body.match(flagPattern)?.[0];
      return await this.record(runId, Boolean(flag), last?.artifactId, flag ? "Clean HTTP session reproduced the flag from the final response." : "Final clean-session response contained no flag.", flag);
    } finally {
      await session.close("web-reproduction-complete");
    }
  }

  private async record(runId: string, reproduced: boolean, artifactId: string | undefined, summary: string, flag?: string): Promise<{ reproduced: boolean; flag?: string; evidenceId: string; artifactId?: string }> {
    const snapshot = await this.controlStore.snapshot(runId);
    const evidenceId = id("EV");
    await this.controlStore.dispatch(runId, { type: "evidence", evidence: { id: evidenceId, kind: reproduced ? "reproduction" : "negative", summary, tags: ["web", "reproduction"], source: { tool: "web_reproduce", artifactId, generation: snapshot.generation }, confidence: reproduced ? 1 : 0.8, supports: [], refutes: [] }, lane: "verifier" });
    return { reproduced, flag, evidenceId, artifactId };
  }
}

function compileFlagPattern(pattern: string): RegExp {
  return compileBoundedPattern(pattern, "flag");
}

function compileBoundedPattern(pattern: string, label: string): RegExp {
  if (!pattern || pattern.length > 256 || /\([^)]*[+*][^)]*\)[+*]|\((?:[^|()]|\([^)]*\))*\|(?:[^|()]|\([^)]*\))*\)[+*]/.test(pattern)) throw new Error(`Unsafe web ${label} pattern`);
  return new RegExp(pattern);
}
