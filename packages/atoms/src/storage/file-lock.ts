import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface FileLockOptions {
  timeoutMs?: number;
  retryMs?: number;
  staleMs?: number;
}

export class FileLockTimeoutError extends Error {
  public constructor(public readonly lockPath: string, timeoutMs: number) {
    super(`Timed out waiting for file lock ${lockPath} after ${timeoutMs}ms`);
    this.name = "FileLockTimeoutError";
  }
}

interface FileLockOwner {
  token: string;
  pid: number;
  acquiredAt: number;
}

interface ReclaimClaim {
  token: string;
  targetToken?: string;
  pid: number;
  claimedAt: number;
}

interface LockSnapshot {
  raw: string;
  owner?: FileLockOwner;
  stat: Stats;
}

const DEFAULT_OPTIONS: Required<FileLockOptions> = {
  timeoutMs: 10_000,
  retryMs: 25,
  staleMs: 60_000,
};

/**
 * Serialize mutations that may be issued by more than one Node process.
 *
 * The lock is deliberately a small create-exclusive file rather than an
 * in-memory mutex.  The owner PID is only used to reclaim a lock left by a
 * crashed process after the stale threshold; a live owner is never removed.
 */
export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const owner = await acquireFileLock(lockPath, resolved);
  try {
    return await operation();
  } finally {
    await releaseFileLock(lockPath, owner.token);
  }
}

async function acquireFileLock(lockPath: string, options: Required<FileLockOptions>): Promise<FileLockOwner> {
  await mkdir(dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  const owner: FileLockOwner = { token: randomUUID(), pid: process.pid, acquiredAt: startedAt };
  while (true) {
    if (await hasActiveReclaimClaim(lockPath, options)) {
      if (Date.now() - startedAt >= options.timeoutMs) throw new FileLockTimeoutError(lockPath, options.timeoutMs);
      await delay(options.retryMs);
      continue;
    }
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      // A stale reclaimer can remove the predecessor and publish its claim
      // just before this create-exclusive open succeeds.  Do not enter the
      // critical section while that claim is active; release only the lock
      // instance we just created, then retry.
      if (await hasActiveReclaimClaim(lockPath, options)) {
        await removeOwnedLock(lockPath, owner.token);
        continue;
      }
      return owner;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await reclaimStaleLock(lockPath, options.staleMs)) continue;
      if (Date.now() - startedAt >= options.timeoutMs) throw new FileLockTimeoutError(lockPath, options.timeoutMs);
      await delay(options.retryMs);
    }
  }
}

async function reclaimStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  const initial = await readLockSnapshot(lockPath);
  if (!initial || !isStaleSnapshot(initial, staleMs)) return false;
  if (initial.owner && isProcessAlive(initial.owner.pid)) return false;
  const claimPath = reclaimClaimPath(lockPath);
  const claim: ReclaimClaim = { token: randomUUID(), ...(initial.owner?.token ? { targetToken: initial.owner.token } : {}), pid: process.pid, claimedAt: Date.now() };
  if (!await acquireReclaimClaim(claimPath, claim)) return false;
  try {
    const current = await readLockSnapshot(lockPath);
    if (!current || !sameLockSnapshot(initial, current) || !isStaleSnapshot(current, staleMs) || (current.owner && isProcessAlive(current.owner.pid))) return false;
    // While the claim directory exists, an acquirer may not enter a newly
    // created lock.  Removing this exact path is therefore safe: any
    // successor lock is created only after the old path is gone and the claim
    // has been released.
    await rm(lockPath, { force: true });
    return true;
  } finally {
    await releaseReclaimClaim(claimPath, claim.token);
  }
}

async function hasActiveReclaimClaim(lockPath: string, options: Required<FileLockOptions>): Promise<boolean> {
  const claims = await reclaimClaimPaths(lockPath);
  for (const claimPath of claims) {
    const claim = await readReclaimClaim(claimPath);
    const mtimeMs = await claimMtime(claimPath);
    if (claim && (isProcessAlive(claim.pid) || !isStaleClaim(claim, mtimeMs, options.staleMs))) return true;
    if (!await reclaimStaleClaim(claimPath, options.staleMs) && await pathExists(claimPath)) return true;
  }
  return false;
}

async function acquireReclaimClaim(claimPath: string, claim: ReclaimClaim): Promise<boolean> {
  try {
    await mkdir(claimPath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
  try {
    await openClaimOwner(claimPath, claim);
    return true;
  } catch (error) {
    await rm(claimPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function openClaimOwner(claimPath: string, claim: ReclaimClaim): Promise<void> {
  const handle = await open(`${claimPath}/owner`, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(claim)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function releaseReclaimClaim(claimPath: string, token: string): Promise<void> {
  try {
    const current = JSON.parse(await readFile(`${claimPath}/owner`, "utf8")) as Partial<ReclaimClaim>;
    if (current.token !== token) return;
    await rm(claimPath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function reclaimStaleClaim(claimPath: string, staleMs: number): Promise<boolean> {
  const claim = await readReclaimClaim(claimPath);
  const mtimeMs = await claimMtime(claimPath);
  if ((claim && (isProcessAlive(claim.pid) || !isStaleClaim(claim, mtimeMs, staleMs))) || (!claim && Date.now() - mtimeMs < staleMs)) return false;
  const ownerPath = `${claimPath}/owner`;
  const tombstone = `${ownerPath}.reclaim-${randomUUID()}`;
  try {
    await rename(ownerPath, tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rm(tombstone, { force: true });
  try {
    await rm(claimPath, { recursive: false, force: true });
    return true;
  } catch {
    return false;
  }
}

async function readLockSnapshot(lockPath: string): Promise<LockSnapshot | undefined> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const lockStat = await stat(lockPath);
    let owner: FileLockOwner | undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<FileLockOwner>;
      if (Number.isInteger(parsed.pid) && typeof parsed.token === "string" && Number.isFinite(parsed.acquiredAt)) owner = parsed as FileLockOwner;
    } catch {
      // Torn metadata is reclaimable once the file itself is stale.
    }
    return { raw, owner, stat: lockStat };
  } catch {
    return undefined;
  }
}

function isStaleSnapshot(snapshot: LockSnapshot, staleMs: number): boolean {
  return Date.now() - Math.max(snapshot.owner?.acquiredAt ?? 0, snapshot.stat.mtimeMs) >= staleMs;
}

function sameLockSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
  if (left.raw !== right.raw) return false;
  if (left.stat.dev !== 0 && right.stat.dev !== 0 && left.stat.ino !== 0 && right.stat.ino !== 0) return left.stat.dev === right.stat.dev && left.stat.ino === right.stat.ino;
  return left.stat.size === right.stat.size && left.stat.mtimeMs === right.stat.mtimeMs;
}

function isStaleClaim(claim: ReclaimClaim, mtimeMs: number, staleMs: number): boolean {
  return Date.now() - Math.max(claim.claimedAt, mtimeMs) >= staleMs;
}

async function readReclaimClaim(claimPath: string): Promise<ReclaimClaim | undefined> {
  try {
    const parsed = JSON.parse(await readFile(`${claimPath}/owner`, "utf8")) as Partial<ReclaimClaim>;
    if (!typeofSafeClaim(parsed)) return undefined;
    return parsed as ReclaimClaim;
  } catch {
    return undefined;
  }
}

async function claimMtime(claimPath: string): Promise<number> {
  try { return (await stat(claimPath)).mtimeMs; } catch { return 0; }
}

function typeofSafeClaim(value: Partial<ReclaimClaim>): boolean {
  return typeof value.token === "string" && Number.isInteger(value.pid) && Number.isFinite(value.claimedAt);
}

function reclaimClaimPath(lockPath: string): string {
  return join(dirname(lockPath), `${basename(lockPath)}.reclaim-${randomUUID()}`);
}

async function reclaimClaimPaths(lockPath: string): Promise<string[]> {
  const prefix = `${basename(lockPath)}.reclaim-`;
  try {
    return (await readdir(dirname(lockPath), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => join(dirname(lockPath), entry.name));
  } catch {
    return [];
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function removeOwnedLock(lockPath: string, token: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as Partial<FileLockOwner>;
    if (owner.token === token) await rm(lockPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function releaseFileLock(lockPath: string, token: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as Partial<FileLockOwner>;
    if (owner.token !== token) return;
    await rm(lockPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
