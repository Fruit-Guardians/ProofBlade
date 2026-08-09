export class SingleFlightPoller {
  private running = false;

  public constructor(private readonly task: () => Promise<void>) {}

  public async poll(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      await this.task();
      return true;
    } finally {
      this.running = false;
    }
  }
}
