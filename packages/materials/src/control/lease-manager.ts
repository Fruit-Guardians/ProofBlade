import type { Lane, Lease } from "../domain/types.js";
import type { ControlStore } from "./control-store.js";

export class LeaseManager {
  public constructor(private readonly controlStore: ControlStore) {}

  public async acquire(runId: string, resourceKey: string, ownerLane: Lane, ttlMs: number): Promise<Lease> {
    const snapshot = await this.controlStore.snapshot(runId);
    const existing = snapshot.leases[resourceKey];
    const now = Date.now();
    if (existing && Date.parse(existing.expiresAt) > now) throw new Error(`Resource is leased by ${existing.ownerLane}: ${resourceKey}`);
    if (existing) await this.controlStore.dispatch(runId, { type: "lease_released", resourceKey, lane: "main" });
    const timestamp = new Date(now).toISOString();
    const lease: Lease = {
      resourceKey,
      ownerLane,
      generation: (existing?.generation ?? 0) + 1,
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    await this.controlStore.dispatch(runId, { type: "lease_acquired", lease, lane: ownerLane });
    return lease;
  }

  public async heartbeat(runId: string, lease: Lease, ttlMs: number): Promise<Lease> {
    const now = Date.now();
    const updated = { ...lease, heartbeatAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString() };
    await this.controlStore.dispatch(runId, {
      type: "lease_heartbeat",
      resourceKey: lease.resourceKey,
      ownerLane: lease.ownerLane,
      generation: lease.generation,
      heartbeatAt: updated.heartbeatAt,
      expiresAt: updated.expiresAt,
      lane: lease.ownerLane,
    });
    return updated;
  }

  public async release(runId: string, lease: Lease): Promise<void> {
    const current = (await this.controlStore.snapshot(runId)).leases[lease.resourceKey];
    if (!current) return;
    if (current.ownerLane !== lease.ownerLane || current.generation !== lease.generation) throw new Error(`Lease ownership mismatch: ${lease.resourceKey}`);
    await this.controlStore.dispatch(runId, { type: "lease_released", resourceKey: lease.resourceKey, lane: lease.ownerLane });
  }
}
