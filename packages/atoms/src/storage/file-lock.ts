import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
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
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
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
  let lockStat: Awaited<ReturnType<typeof stat>>;
  try {
    lockStat = await stat(lockPath);
  } catch {
    return false;
  }
  if (Date.now() - lockStat.mtimeMs < staleMs) return false;
  let owner: FileLockOwner;
  try {
    owner = JSON.parse(await readFile(lockPath, "utf8")) as FileLockOwner;
  } catch {
    // A process can die after creating the exclusive file but before its
    // metadata write completes. Once the file itself is stale, there is no
    // owner identity to preserve, so reclaim it conservatively.
    await rm(lockPath, { force: true });
    return true;
  }
  if (!Number.isInteger(owner.pid) || typeof owner.token !== "string" || !Number.isFinite(owner.acquiredAt)) return false;
  if (Date.now() - Math.max(owner.acquiredAt, lockStat.mtimeMs) < staleMs) return false;
  if (isProcessAlive(owner.pid)) return false;
  await rm(lockPath, { force: true });
  return true;
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
