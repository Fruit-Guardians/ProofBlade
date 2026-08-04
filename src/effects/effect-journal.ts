import type { EffectRequest, RawEffectResult, ReplayPolicy, RunSnapshot } from "../domain/types.js";
import { id } from "../domain/utils.js";
import { ControlStore, createEffectInput } from "../control/control-store.js";
import { ArtifactStore } from "./artifact-store.js";
import type { SandboxPort } from "../sandbox/fixture.js";

export class EffectJournal {
  public constructor(
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
    private readonly sandbox: SandboxPort,
  ) {}

  public async execute(runId: string, input: Omit<EffectRequest, "id" | "idempotencyKey"> & { replayPolicy?: ReplayPolicy }): Promise<{ effectId: string; result: RawEffectResult; artifactId: string }> {
    const snapshot = await this.controlStore.snapshot(runId);
    const { effectId, idempotencyKey } = createEffectInput(runId, input.tool, input.args, input.replayPolicy ?? "pure", snapshot.generation);
    const existing = Object.values(snapshot.effects).find((effect) => effect.idempotencyKey === idempotencyKey);
    if (existing?.status === "FINISHED" && existing.artifactId) {
      const artifact = snapshot.artifacts[existing.artifactId];
      if (artifact) return { effectId: existing.id, result: { stdout: "", stderr: "replayed from artifact", exitCode: 0, durationMs: 0 }, artifactId: artifact.id };
    }
    const effect = {
      id: effectId,
      idempotencyKey,
      replayPolicy: input.replayPolicy ?? "pure",
      tool: input.tool,
      args: input.args,
      status: "PROPOSED" as const,
      createdSeq: 0,
    };
    await this.controlStore.dispatch(runId, { type: "effect_proposed", effect, lane: "executor" });
    await this.controlStore.dispatch(runId, { type: "effect_started", effectId, lane: "executor" });
    let result: RawEffectResult;
    try {
      result = await this.sandbox.execute({ ...input, id: effectId, idempotencyKey }, new AbortController().signal);
    } catch (error) {
      result = { stdout: "", stderr: String(error), exitCode: null, durationMs: 0 };
    }
    const artifact = await this.artifactStore.putText(runId, JSON.stringify({ ...result, tool: input.tool, args: input.args }, null, 2), {
      mime: "application/json",
      sourceEffectId: effectId,
      filename: `${input.tool}-${effectId}.json`,
    });
    const outcome = result.exitCode === 0 ? "success" : result.exitCode === null ? "timeout" : "error";
    await this.controlStore.dispatch(runId, { type: "effect_finished", effectId, outcome, artifactId: artifact.id, externalId: result.externalId, lane: "executor" });
    return { effectId, result, artifactId: artifact.id };
  }

  public async reconcile(runId: string): Promise<string[]> {
    const snapshot = await this.controlStore.snapshot(runId);
    const reconciled: string[] = [];
    for (const effect of Object.values(snapshot.effects)) {
      if (effect.status !== "STARTED") continue;
      const result = await this.sandbox.reconcile(effect);
      await this.controlStore.dispatch(runId, { type: "effect_reconciled", effectId: effect.id, outcome: result.outcome, lane: "executor" });
      reconciled.push(effect.id);
    }
    return reconciled;
  }
}
