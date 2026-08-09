export class BoundedLruCache<TKey, TValue> {
  private readonly entries = new Map<TKey, { value: TValue; weight: number }>();
  private totalWeight = 0;

  public constructor(
    private readonly capacity: number,
    private readonly maxWeight = Number.POSITIVE_INFINITY,
    private readonly weigh: (value: TValue) => number = () => 1,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("LRU cache capacity must be a positive integer");
    if (!(maxWeight > 0) || Number.isNaN(maxWeight)) throw new Error("LRU cache max weight must be positive");
  }

  public get size(): number {
    return this.entries.size;
  }

  public get weight(): number {
    return this.totalWeight;
  }

  public get(key: TKey): TValue | undefined {
    if (!this.entries.has(key)) return undefined;
    const entry = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, entry as { value: TValue; weight: number });
    return entry?.value;
  }

  public set(key: TKey, value: TValue): boolean {
    const weight = this.weigh(value);
    if (!Number.isFinite(weight) || weight < 0) throw new Error("LRU cache entry weight must be finite and non-negative");
    this.delete(key);
    if (weight > this.maxWeight) return false;
    this.entries.set(key, { value, weight });
    this.totalWeight += weight;
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
    while (this.totalWeight > this.maxWeight) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
    return true;
  }

  public clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
  }

  private delete(key: TKey): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalWeight -= entry.weight;
  }
}
