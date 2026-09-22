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
