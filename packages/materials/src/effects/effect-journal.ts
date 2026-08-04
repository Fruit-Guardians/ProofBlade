import type { EffectRequest, RawEffectResult, ReplayPolicy, RunSnapshot } from "../domain/types.js";
import { id } from "../domain/utils.js";
import { ControlStore, createEffectInput } from "../control/control-store.js";
import { ArtifactStore } from "./artifact-store.js";
import type { SandboxPort } from "../sandbox/fixture.js";

export type EffectFaultPoint = "after_proposed" | "after_started" | "after_execute" | "after_artifact";
export type EffectFaultInjector = (point: EffectFaultPoint, effectId: string) => void | Promise<void>;

export class EffectJournal {
  public constructor(
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
    private readonly sandbox: SandboxPort,
    private readonly injectFault?: EffectFaultInjector,
  ) {}

  public async execute(runId: string, input: Omit<EffectRequest, "id" | "idempotencyKey"> & { replayPolicy?: ReplayPolicy }): Promise<{ effectId: string; result: RawEffectResult; artifactId: string }> {
    const snapshot = await this.controlStore.snapshot(runId);
    const { effectId, idempotencyKey } = createEffectInput(runId, input.operation, input.args, input.replayPolicy ?? "pure", snapshot.generation);
    const existing = Object.values(snapshot.effects).find((effect) => effect.idempotencyKey === idempotencyKey);
    if (existing?.status === "FINISHED" && existing.artifactId) {
      const artifact = snapshot.artifacts[existing.artifactId];
      if (artifact) return { effectId: existing.id, result: { stdout: "", stderr: "replayed from artifact", exitCode: 0, durationMs: 0 }, artifactId: artifact.id };
    }
    const effect = {
      id: effectId,
      idempotencyKey,
      replayPolicy: input.replayPolicy ?? "pure",
      operation: input.operation,
      args: input.args,
      command: input.command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      status: "PROPOSED" as const,
      createdSeq: 0,
    };
    await this.controlStore.dispatch(runId, { type: "effect_proposed", effect, lane: "executor" });
    await this.injectFault?.("after_proposed", effectId);
    await this.controlStore.dispatch(runId, { type: "effect_started", effectId, lane: "executor" });
    await this.injectFault?.("after_started", effectId);
    let result: RawEffectResult;
    try {
      result = await this.sandbox.execute({ ...input, id: effectId, idempotencyKey }, new AbortController().signal);
    } catch (error) {
      result = { stdout: "", stderr: String(error), exitCode: null, durationMs: 0 };
    }
    await this.injectFault?.("after_execute", effectId);
    return await this.finish(runId, effectId, input.operation, input.args, result);
  }

  public async reconcile(runId: string): Promise<string[]> {
    const snapshot = await this.controlStore.snapshot(runId);
    const reconciled: string[] = [];
    for (const effect of Object.values(snapshot.effects)) {
      if (effect.status !== "STARTED" && effect.status !== "PROPOSED") continue;
      if (effect.status === "PROPOSED") {
        await this.controlStore.dispatch(runId, { type: "effect_started", effectId: effect.id, lane: "executor" });
      }
      const completedArtifact = Object.values(snapshot.artifacts).find((artifact) => artifact.sourceEffectId === effect.id);
      if (completedArtifact) {
        const stored = JSON.parse(await this.artifactStore.readText(runId, completedArtifact)) as RawEffectResult;
        const outcome = stored.exitCode === 0 ? "success" : stored.exitCode === null ? "timeout" : "error";
        await this.controlStore.dispatch(runId, { type: "effect_finished", effectId: effect.id, outcome, artifactId: completedArtifact.id, externalId: stored.externalId, lane: "executor" });
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
        await this.finish(runId, effect.id, effect.operation, effect.args, rerun);
      } else {
        await this.controlStore.dispatch(runId, { type: "effect_reconciled", effectId: effect.id, outcome: result.outcome, lane: "executor" });
      }
      reconciled.push(effect.id);
    }
    return reconciled;
  }

  private async finish(runId: string, effectId: string, operation: string, args: Record<string, unknown>, result: RawEffectResult): Promise<{ effectId: string; result: RawEffectResult; artifactId: string }> {
    const artifact = await this.artifactStore.putText(runId, JSON.stringify({ ...result, operation, args }, null, 2), {
      mime: "application/json",
      sourceEffectId: effectId,
      filename: `${operation}-${effectId}.json`,
      sensitivity: /(?:PB|FLAG)\{[^}\r\n]+\}/.test(`${result.stdout}\n${result.stderr}`) ? "flag_candidate" : "public",
    });
    await this.injectFault?.("after_artifact", effectId);
    const outcome = result.exitCode === 0 ? "success" : result.exitCode === null ? "timeout" : "error";
    await this.controlStore.dispatch(runId, { type: "effect_finished", effectId, outcome, artifactId: artifact.id, externalId: result.externalId, lane: "executor" });
    return { effectId, result, artifactId: artifact.id };
  }
}
