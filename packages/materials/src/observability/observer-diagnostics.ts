/**
 * Bounded in-process diagnostics for observation-path failures.
 *
 * The observation path is deliberately best-effort: a failing observer must not
 * turn a completed tool call into a failed one, so the catches around it swallow
 * the error. Swallowing silently is a different decision from swallowing
 * quietly, though, and the difference matters — a control-store outage on this
 * path used to leave no trace at all, so "no observations recorded" looked the
 * same as "nothing needed observing".
 *
 * This records the failure without changing the tool result and without adding a
 * durable write to the hot path: samples stay in memory and the caller decides
 * whether to surface them at a safe point. That keeps the two concerns separate
 * — the tool result is protected here, and visibility is the caller's choice.
 */

import { redactSecrets } from "../domain/utils.js";

/** One observed failure on the observation path. */
export interface ObserverFailureSample {
  /** Which observation step failed. */
  readonly stage: "artifact-observation" | "artifact-annotation" | "telemetry-flush";
  /** Error message, truncated and redacted by `record()`. */
  readonly message: string;
  /** The run the failure belongs to. */
  readonly runId: string;
  /** Monotonic-free sequence, so consumers can order without a clock. */
  readonly sequence: number;
}

/** Default retained samples and message bound. */
export const DEFAULT_OBSERVER_FAILURE_LIMIT = 32;
const MAX_MESSAGE_CHARS = 400;

/**
 * A bounded, memory-only log of observation-path failures.
 *
 * Not thread-safe and not shared across lanes by design: a lane owns one, the
 * same way it owns its timing recorder.
 */
export class ObserverDiagnostics {
  readonly #limit: number;
  #samples: ObserverFailureSample[] = [];
  #total = 0;
  #sequence = 0;

  /**
   * @param limit - maximum retained samples; the total count keeps rising past it.
   */
  public constructor(limit: number = DEFAULT_OBSERVER_FAILURE_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("ObserverDiagnostics limit must be a positive integer");
    this.#limit = limit;
  }

  /**
   * Record one failure. Never throws: this is called from a catch block whose
   * whole purpose is to keep a failure from reaching the tool result, so it must
   * not become a new failure path itself.
   *
   * @param stage - which observation step failed.
   * @param runId - the run it belongs to.
   * @param error - the thrown value.
   */
  public record(stage: ObserverFailureSample["stage"], runId: string, error: unknown): void {
    // The count is incremented before the message is derived, and the message
    // derivation is itself guarded: an error whose own `toString` throws must not
    // be able to suppress the record of its own failure.
    this.#total += 1;
    this.#sequence += 1;
    let message: string;
    try {
      // Redaction happens here, not at the call site: this is called from catch
      // blocks all over the observation path, and none of them redact. Error
      // messages on this path carry artifact paths, command fragments and
      // provider URLs, so whatever a future consumer does with a sample, the
      // text it holds has already been through the same filter as an Artifact.
      const raw = redactSecrets(error instanceof Error ? error.message : String(error));
      message = raw.length > MAX_MESSAGE_CHARS ? `${raw.slice(0, MAX_MESSAGE_CHARS)}…` : raw;
    } catch {
      message = "unprintable observation failure";
    }
    if (message.length === 0) message = "empty observation failure message";
    try {
      this.#samples.push({ stage, runId, message, sequence: this.#sequence });
      while (this.#samples.length > this.#limit) this.#samples.shift();
    } catch {
      // Intentionally inert. See the method doc.
    }
  }

  /** Retained samples, oldest first. */
  public failures(): readonly ObserverFailureSample[] {
    return this.#samples;
  }

  /** Every failure ever recorded, including evicted ones. */
  public total(): number {
    return this.#total;
  }

  /** Drop the retained samples without resetting the lifetime total. */
  public clear(): void {
    this.#samples = [];
  }
}
