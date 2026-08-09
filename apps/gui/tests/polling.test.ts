import assert from "node:assert/strict";
import test from "node:test";
import { SingleFlightPoller } from "../src/polling.js";

test("[contract:polling-run-switch-single-flight] run switches coalesce behind the active refresh", async () => {
  let selectedRun = "RUN-A";
  let active = 0;
  let peak = 0;
  const calls: string[] = [];
  const releases: Array<() => void> = [];
  const poller = new SingleFlightPoller(async () => {
    active += 1;
    peak = Math.max(peak, active);
    calls.push(selectedRun);
    try {
      await new Promise<void>((resolve) => { releases.push(resolve); });
    } finally {
      active -= 1;
    }
  });

  const first = poller.poll();
  await waitFor(() => releases.length === 1);
  selectedRun = "RUN-B";
  const switched = poller.poll();
  const manual = poller.poll();
  assert.equal(active, 1);
  assert.equal(peak, 1);
  assert.deepEqual(calls, ["RUN-A"]);

  releases.shift()?.();
  await waitFor(() => releases.length === 1);
  assert.equal(active, 1);
  assert.equal(peak, 1);
  assert.deepEqual(calls, ["RUN-A", "RUN-B"]);
  releases.shift()?.();

  assert.equal(await first, true);
  assert.equal(await switched, false);
  assert.equal(await manual, false);
  assert.equal(active, 0);
});

test("timer ticks skip without scheduling continuous trailing refreshes", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const poller = new SingleFlightPoller(async () => {
    calls += 1;
    await new Promise<void>((resolve) => { release = resolve; });
  });

  const first = poller.poll(false);
  const skipped = poller.poll(false);
  release?.();

  assert.equal(await first, true);
  assert.equal(await skipped, false);
  assert.equal(calls, 1);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for polling state");
}
