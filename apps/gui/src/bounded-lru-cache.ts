export class BoundedLruCache<TKey, TValue> {
  private readonly entries = new Map<TKey, TValue>();

  public constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("LRU cache capacity must be a positive integer");
  }

  public get size(): number {
    return this.entries.size;
  }

  public get(key: TKey): TValue | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, value as TValue);
    return value;
  }

  public set(key: TKey, value: TValue): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  public clear(): void {
    this.entries.clear();
  }
}
