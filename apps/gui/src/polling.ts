export type PollMode = "background" | "interactive";

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
