import type { ControlStore } from "../control/control-store.js";
import { id } from "../domain/utils.js";
import type { PwnSession } from "../pwn/pwn-session.js";
import { decodeBase64Strict, appendByte } from "../pwn/bytes.js";
import { compileSafeFlagPattern } from "../pwn/pattern.js";

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
  /** Bytes to send. In utf8 (default) `send` is the literal text; in base64 it
   * is base64 of the exact bytes, so a stage can replay 0x00/0xff/packed
   * addresses/ROP chains — otherwise a fresh-session reproduce could not send
   * the same payload pwn_send delivered and would falsely fail. */
  send?: string;
  encoding?: "utf8" | "base64";
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
  /** Present when a trusted verifier bound the attempt to a Completion. */
  completionId?: string;
  candidateHash?: string;
  /** Observed stage records, never verifier evidence or a success claim. */
  domainRecordIds?: string[];
}

/** Internal verifier result which retains the bounded transcript for attestation. */
export interface PwnReproduceExecution extends PwnReproduceOutcome {
  sessionId: string;
  transcript: string;
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
    onSessionOpened?: (session: PwnSession) => Promise<void>,
  ): Promise<PwnReproduceOutcome> {
    const execution = await this.reproduceCaptured(runId, recipe, openSession, onSessionOpened);
    const { sessionId: _sessionId, transcript: _transcript, ...outcome } = execution;
    return outcome;
  }

  /**
   * Execute a recipe and retain the bounded session transcript for the trusted
   * verifier. The public model-facing path deliberately strips this field so a
   * verifier receipt is not confused with ordinary tool output.
   */
  public async reproduceCaptured(
    runId: string,
    recipe: ExploitRecipe,
    openSession: () => Promise<PwnSession>,
    onSessionOpened?: (session: PwnSession) => Promise<void>,
  ): Promise<PwnReproduceExecution> {
    validateRecipe(recipe);
    const flagPattern = compileSafeFlagPattern(recipe.flagPattern);
    const stages: StageResult[] = [];
    let shellConfirmed = false;
    let flag: string | undefined;
    const session = await openSession();
    try {
      await onSessionOpened?.(session);
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
    const evidenceId = id("LOCAL-PWN");

    return {
      reproduced,
      shellConfirmed,
      ...(flag !== undefined ? { flag } : {}),
      stages,
      evidenceId,
      sessionId: session.sessionId,
      transcript: session.log.slice(-65_536),
    };
  }
}

function validateRecipe(recipe: ExploitRecipe): void {
  if (!Array.isArray(recipe.stages) || recipe.stages.length < 1 || recipe.stages.length > 64) throw new Error("Pwn reproduction requires 1-64 stages");
  if (typeof recipe.flagPath !== "string" || recipe.flagPath.length === 0 || recipe.flagPath.length > 512) throw new Error("Pwn reproduction flag path is invalid");
  if (typeof recipe.flagPattern !== "string" || recipe.flagPattern.length === 0 || recipe.flagPattern.length > 256) throw new Error("Pwn reproduction flag pattern is invalid");
  for (const [index, stage] of recipe.stages.entries()) {
    if (!stage || typeof stage.name !== "string" || stage.name.trim().length === 0 || stage.name.length > 160 || /[\u0000\r\n]/.test(stage.name)) throw new Error(`Pwn reproduction stage ${index} name is invalid`);
    if (stage.send !== undefined && (typeof stage.send !== "string" || stage.send.length > 131_072)) throw new Error(`Pwn reproduction stage ${index} payload is too large`);
    if (stage.expect !== undefined && (typeof stage.expect !== "string" || stage.expect.length > 512 || /[\u0000\r\n]/.test(stage.expect))) throw new Error(`Pwn reproduction stage ${index} anchor is invalid`);
    if (stage.maxReads !== undefined && (!Number.isInteger(stage.maxReads) || stage.maxReads < 1 || stage.maxReads > 64)) throw new Error(`Pwn reproduction stage ${index} read budget is invalid`);
    if (stage.encoding !== undefined && stage.encoding !== "utf8" && stage.encoding !== "base64") throw new Error(`Pwn reproduction stage ${index} encoding is invalid`);
  }
}

async function runStage(session: PwnSession, stage: ExploitStage): Promise<StageResult> {
  try {
    let sent: Awaited<ReturnType<PwnSession["send"]>> | undefined;
    if (stage.send !== undefined) {
      if (stage.encoding === "base64") {
        // Replay the exact bytes; append LF as a byte in line mode so 0x00/0xff
        // survive rather than being corrupted by a string newline round-trip.
        const bytes = decodeBase64Strict(stage.send);
        sent = await session.send(stage.line ? appendByte(bytes, 0x0a) : bytes);
      } else {
        sent = stage.line ? await session.sendLine(stage.send) : await session.send(stage.send);
      }
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
