/**
 * Small lifecycle primitive for resources owned by a Run or one of its
 * children. A Scope is deliberately independent from the event store: the
 * owner can record lifecycle facts around it without making disposal itself a
 * second source of truth.
 */
export interface Disposable {
  dispose(): Promise<void> | void;
}

export type DisposeFailure = { resource: string; error: unknown };

export class Scope implements Disposable {
  private readonly resources: Array<{ name: string; dispose: () => Promise<void> | void }> = [];
  private readonly children: Scope[] = [];
  private disposed = false;
  private disposing?: Promise<void>;

  public constructor(public readonly id: string, private readonly parent?: Scope) {
    if (parent) parent.children.push(this);
  }

  public child(id: string): Scope {
    if (this.disposed) throw new Error(`Scope ${this.id} is already disposed`);
    return new Scope(id, this);
  }

  public use<T extends Disposable>(resource: T, name = resource.constructor?.name || "resource"): T {
    return this.add(name, () => resource.dispose()) && resource;
  }

  public add(name: string, dispose: () => Promise<void> | void): true {
    if (this.disposed) throw new Error(`Scope ${this.id} is already disposed`);
    this.resources.push({ name, dispose });
    return true;
  }

  public get isDisposed(): boolean {
    return this.disposed;
  }

  public async dispose(): Promise<void> {
    if (this.disposing) return await this.disposing;
    this.disposing = this.disposeOnce();
    return await this.disposing;
  }

  private async disposeOnce(): Promise<void> {
    const failures: DisposeFailure[] = [];
    for (const child of [...this.children].reverse()) {
      try {
        await child.dispose();
      } catch (error) {
        failures.push({ resource: `scope:${child.id}`, error });
      }
    }
    for (const resource of [...this.resources].reverse()) {
      try {
        await resource.dispose();
      } catch (error) {
        failures.push({ resource: resource.name, error });
      }
    }
    this.disposed = true;
    this.children.length = 0;
    this.resources.length = 0;
    if (failures.length > 0) {
      throw new AggregateError(failures.map((failure) => failure.error), `Scope ${this.id} disposal had ${failures.length} failure(s)`);
    }
  }
}
