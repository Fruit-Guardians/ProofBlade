/** Serialize asynchronous operations by key while allowing different keys to progress independently. */
export class KeyedOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Run one operation after the previous operation for the same key settles.
   * @invariant A rejected operation does not poison the next operation in the key queue.
   */
  public async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate, () => gate);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
