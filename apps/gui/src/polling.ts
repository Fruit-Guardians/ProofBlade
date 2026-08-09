export class SingleFlightPoller {
  private running: Promise<void> | undefined;
  private rerunRequested = false;

  public constructor(private readonly task: () => Promise<void>) {}

  public async poll(rerunIfBusy = true): Promise<boolean> {
    if (this.running) {
      if (rerunIfBusy) this.rerunRequested = true;
      await this.running;
      return false;
    }
    this.running = this.drain().finally(() => { this.running = undefined; });
    await this.running;
    return true;
  }

  private async drain(): Promise<void> {
    do {
      this.rerunRequested = false;
      await this.task();
    } while (this.rerunRequested);
  }
}
