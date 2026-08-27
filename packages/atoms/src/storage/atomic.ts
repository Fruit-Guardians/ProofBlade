import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { KeyedOperationQueue } from "./operation-queue.js";

const writes = new KeyedOperationQueue();
const RENAME_RETRY_LIMIT = 5;
const RENAME_RETRY_BASE_MS = 20;

/**
 * Write content through a synced temporary file followed by an atomic rename.
 * @invariant This provides one-file replacement, not a multi-file transaction.
 */
export async function atomicWriteFile(path: string, content: string | Uint8Array): Promise<void> {
  await writes.run(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content);
      const handle = await open(temporary, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      let renameAttempt = 0;
      while (true) {
        try {
          await rename(temporary, path);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (renameAttempt >= RENAME_RETRY_LIMIT || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
          const delayMs = Math.min(RENAME_RETRY_BASE_MS * 2 ** renameAttempt, 320);
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          renameAttempt += 1;
        }
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  });
}

/**
 * Append UTF-8 content and sync the file before returning.
 * @invariant Append ordering across independent processes is outside this helper's contract.
 */
export async function durableAppendFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
