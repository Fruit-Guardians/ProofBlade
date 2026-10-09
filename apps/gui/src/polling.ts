export type PollMode = "background" | "interactive";

/**
 * Whether background polling may run right now.
 *
 * Extracted from the timer callback so the rule is a named, testable predicate
 * rather than an inline early return. A detail poll costs a full payload per
 * tick, and nobody is looking at a hidden tab, so a hidden document must not
 * schedule that work at all.
 *
 * Only `"visible"` permits polling. `"prerender"` is suppressed too: a
 * prerendered page is not being looked at either.
 *
 * @param visibilityState - `document.visibilityState` at the moment of the tick.
 * @returns true when the tick should proceed.
 */
export function isPollingAllowed(visibilityState: DocumentVisibilityState): boolean {
  return visibilityState === "visible";
}

/** A cursor may advance only when every intervening durable event is present. */
export function isContiguousEventUpdate(afterSeq: number, lastSeq: number, eventSeqs: readonly number[]): boolean {
  if (!Number.isInteger(afterSeq) || !Number.isInteger(lastSeq) || lastSeq < afterSeq) return false;
  if (lastSeq === afterSeq) return eventSeqs.length === 0;
  if (eventSeqs.length !== lastSeq - afterSeq) return false;
  return eventSeqs.every((seq, index) => seq === afterSeq + index + 1);
}

/** Periodically refresh heavy telemetry/context even while suffix polling is active. */
export function shouldRefreshFullDetail(now: number, lastRefreshAt: number, intervalMs = 30_000): boolean {
  return !Number.isFinite(lastRefreshAt) || lastRefreshAt <= 0 || now - lastRefreshAt >= intervalMs;
}

export class SingleFlightPoller {
  private running: Promise<void> | undefined;
  private rerunRequested = false;

  public constructor(private readonly task: (mode: PollMode) => Promise<void>) {}

  public async poll(rerunIfBusy = true): Promise<boolean> {
    if (this.running) {
      if (!rerunIfBusy) return false;
      this.rerunRequested = true;
      await this.running;
      return false;
    }
    this.running = this.drain(rerunIfBusy ? "interactive" : "background").finally(() => { this.running = undefined; });
    await this.running;
    return true;
  }

  private async drain(initialMode: PollMode): Promise<void> {
    let mode = initialMode;
    let failure: { value: unknown } | undefined;
    do {
      this.rerunRequested = false;
      try {
        await this.task(mode);
        failure = undefined;
      } catch (error) {
        failure = { value: error };
      }
      mode = "interactive";
    } while (this.rerunRequested);
    if (failure) throw failure.value;
  }
}
