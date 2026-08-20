import type { ControlStore } from "../control/control-store.js";
import { id } from "../domain/utils.js";
import type { PwnSession } from "../pwn/pwn-session.js";

/**
 * A structured exploit recipe.  The reproducer accepts this, NOT a natural-
 * language "it should work": the model may propose a recipe but cannot declare
 * a shell.  Each stage sends bytes and optionally waits for an anchor; the two
 * closing barriers (shell probe + flag extraction from the live session) are
 * the only path to a candidate.  This is the CTF-shaped barrier PentAGI's ReAct
 * loop lacks.
 */
export interface ExploitStage {
  name: string;
  /** Bytes to send. A string is sent as-is; use `line: true` to append LF. */
  send?: string;
  line?: boolean;
  /** Anchor that must appear after this stage; absence fails the stage. */
  expect?: string;
  maxReads?: number;
}

export interface ExploitRecipe {
  stages: ExploitStage[];
  /** Path read for the flag in the live shell, e.g. "/flag" or "flag.txt". */
  flagPath: string;
  /** Pattern the extracted flag must match, e.g. /flag\{[^}]+\}/. */
  flagPattern: string;
}

export interface StageResult { name: string; ok: boolean; detail?: string }

export interface PwnReproduceOutcome {
  reproduced: boolean;
  shellConfirmed: boolean;
  flag?: string;
  stages: StageResult[];
  evidenceId: string;
}

/**
 * Runs an exploit recipe against a FRESH session and only reports success when
 * a real shell echoes a unique marker AND the flag is read from that same live
 * session (not from a recipe literal).  EOF/exit before either barrier is a
 * failure that produces `negative` evidence, so the loop replans instead of
 * blind-submitting a guessed flag.
 */
export class PwnReproducer {
  public constructor(private readonly control: ControlStore) {}

  public async reproduce(
    runId: string,
    recipe: ExploitRecipe,
    openSession: () => Promise<PwnSession>,
  ): Promise<PwnReproduceOutcome> {
    const flagPattern = compilePattern(recipe.flagPattern);
    const stages: StageResult[] = [];
    let shellConfirmed = false;
    let flag: string | undefined;
    const session = await openSession();
    try {
      for (const stage of recipe.stages) {
        const result = await runStage(session, stage);
        stages.push(result);
        if (!result.ok) break;
      }
      const allStagesOk = stages.length === recipe.stages.length && stages.every((s) => s.ok);
      if (allStagesOk) {
        const probe = await session.shellProbe();
        shellConfirmed = probe.ok;
        stages.push({ name: "shell_probe", ok: probe.ok, detail: probe.ok ? probe.marker : "no shell marker echoed" });
        if (probe.ok) {
          const read = await session.readFlag(recipe.flagPath, flagPattern);
          flag = read.flag;
          stages.push({ name: "flag_extract", ok: Boolean(read.flag), detail: read.flag ? "flag read from live session" : "flag pattern not found on the wire" });
        }
      }
    } finally {
      await session.close("reproduce complete").catch(() => undefined);
    }

    const reproduced = shellConfirmed && flag !== undefined;
    const evidenceId = id("EV");
    await this.control.dispatch(runId, {
      type: "evidence",
      evidence: {
        id: evidenceId,
        kind: reproduced ? "reproduction" : "negative",
        summary: reproduced
          ? `Independent pwn reproduce succeeded: shell marker + flag extracted from a fresh session.`
          : `Independent pwn reproduce failed at ${firstFailure(stages)}.`,
        tags: ["pwn", "reproduce"],
        source: { tool: "pwn_reproduce" },
        confidence: 1,
        supports: [],
        refutes: [],
      },
      lane: "verifier",
    });

    return { reproduced, shellConfirmed, ...(flag !== undefined ? { flag } : {}), stages, evidenceId };
  }
}

async function runStage(session: PwnSession, stage: ExploitStage): Promise<StageResult> {
  try {
    let sent: Awaited<ReturnType<PwnSession["sendLine"]>> | undefined;
    if (stage.send !== undefined) {
      sent = stage.line ? await session.sendLine(stage.send) : await session.send(stage.send);
    }
    if (stage.expect !== undefined) {
      // The send above may already carry the anchor in its own echo delta; only
      // read further if it has not appeared yet, so an immediate echo is not lost.
      const already = sent?.data.includes(stage.expect) ?? false;
      if (!already) {
        const recv = await session.recvUntil(stage.expect, stage.maxReads ? { maxReads: stage.maxReads } : {});
        if (recv.exited) return { name: stage.name, ok: false, detail: "process exited before anchor" };
        if (!recv.matched) return { name: stage.name, ok: false, detail: `anchor not seen: ${stage.expect}` };
      } else if (sent?.exited) {
        return { name: stage.name, ok: false, detail: "process exited before anchor" };
      }
    }
    return { name: stage.name, ok: true };
  } catch (error) {
    return { name: stage.name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function firstFailure(stages: StageResult[]): string {
  const failed = stages.find((stage) => !stage.ok);
  return failed ? `${failed.name}${failed.detail ? ` (${failed.detail})` : ""}` : "an unknown stage";
}

function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new Error(`Invalid flag pattern: ${pattern}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
