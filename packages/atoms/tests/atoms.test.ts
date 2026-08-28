import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWriteFile, canonicalJson, FileLockTimeoutError, KeyedOperationQueue, sha256, type ToolAtom, withFileLock } from "../src/index.js";

test("atoms are deterministic and independently usable", async () => {
  const tool: ToolAtom = { name: "read", description: "read data", parameters: { type: "object" } };
  assert.equal(tool.name, "read");
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(sha256("proofblade").length, 64);

  const queue = new KeyedOperationQueue();
  const order: number[] = [];
  await Promise.all([1, 2, 3].map((value) => queue.run("stream", async () => { order.push(value); })));
  assert.deepEqual(order, [1, 2, 3]);
});

test("file lock serializes operations and releases after failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-file-lock-"));
  const lockPath = join(root, "run", ".control.lock");
  const order: string[] = [];
  let firstEntered!: () => void;
  const firstEnteredSignal = new Promise<void>((resolve) => { firstEntered = resolve; });
  try {
    const first = withFileLock(lockPath, async () => {
      order.push("first-start");
      firstEntered();
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first-end");
    });
    await firstEnteredSignal;
    const second = withFileLock(lockPath, async () => { order.push("second"); });
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first-start", "first-end", "second"]);
    await assert.rejects(
      withFileLock(lockPath, async () => { throw new Error("operation failed"); }),
      /operation failed/,
    );
    assert.equal(await readFile(lockPath, "utf8").catch(() => undefined), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic writes serialize same-path replacements for Windows-safe concurrency", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-atomic-write-"));
  const path = join(root, "projection.json");
  try {
    await Promise.all(Array.from({ length: 64 }, (_, index) => atomicWriteFile(path, JSON.stringify({ index }))));
    const final = JSON.parse(await readFile(path, "utf8")) as { index: number };
    assert.ok(Number.isInteger(final.index));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file lock reclaims a stale lock only after its owner is gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-file-lock-stale-"));
  const lockPath = join(root, ".control.lock");
  try {
    const old = Date.now() - 10_000;
    await writeFile(lockPath, JSON.stringify({ token: "stale", pid: 999_999_999, acquiredAt: old }));
    await utimes(lockPath, old / 1_000, old / 1_000);
    const result = await withFileLock(lockPath, async () => "recovered", { staleMs: 1, timeoutMs: 100, retryMs: 1 });
    assert.equal(result, "recovered");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file lock recovers a torn stale owner record", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-file-lock-torn-"));
  const lockPath = join(root, ".control.lock");
  try {
    const old = Date.now() - 10_000;
    await writeFile(lockPath, "{\"token\":\"torn\"");
    await utimes(lockPath, old / 1_000, old / 1_000);
    assert.equal(await withFileLock(lockPath, async () => true, { staleMs: 1, timeoutMs: 100, retryMs: 1 }), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file lock reports a live owner timeout instead of stealing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-file-lock-timeout-"));
  const lockPath = join(root, ".control.lock");
  let acquired!: () => void;
  const acquiredSignal = new Promise<void>((resolve) => { acquired = resolve; });
  let release!: () => void;
  const held = withFileLock(lockPath, async () => {
    acquired();
    await new Promise<void>((resolve) => { release = resolve; });
  });
  try {
    await acquiredSignal;
    await assert.rejects(
      withFileLock(lockPath, async () => undefined, { timeoutMs: 10, retryMs: 1, staleMs: 1 }),
      (error: unknown) => error instanceof FileLockTimeoutError,
    );
  } finally {
    release();
    await held;
    await rm(root, { recursive: true, force: true });
  }
});

test("file lock waits behind an active stale-reclaim claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-file-lock-reclaim-claim-"));
  const lockPath = join(root, ".control.lock");
  const claimPath = `${lockPath}.reclaim-test`;
  try {
    const old = Date.now() - 10_000;
    await writeFile(lockPath, JSON.stringify({ token: "stale", pid: 999_999_999, acquiredAt: old }));
    await utimes(lockPath, old / 1_000, old / 1_000);
    await mkdir(claimPath);
    await writeFile(`${claimPath}/owner`, JSON.stringify({ token: "reclaimer", targetToken: "stale", pid: process.pid, claimedAt: Date.now() }));
    await assert.rejects(
      withFileLock(lockPath, async () => "must-not-enter", { staleMs: 1, timeoutMs: 10, retryMs: 1 }),
      (error: unknown) => error instanceof FileLockTimeoutError,
    );
    assert.match(await readFile(lockPath, "utf8"), /stale/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
