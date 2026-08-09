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

test("timer ticks resolve immediately without accumulating waiters or trailing refreshes", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const poller = new SingleFlightPoller(async () => {
    calls += 1;
    await new Promise<void>((resolve) => { release = resolve; });
  });

  const first = poller.poll(false);
  await waitFor(() => release !== undefined);
  const skipped = await Promise.race([
    Promise.all(Array.from({ length: 100 }, () => poller.poll(false))),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("busy timer ticks waited for the active request")), 100)),
  ]);
  assert.deepEqual(skipped, Array.from({ length: 100 }, () => false));
  assert.equal(calls, 1);
  release?.();

  assert.equal(await first, true);
  assert.equal(calls, 1);
});

test("[contract:interactive-refresh-clears-stale-error] only a successful interactive refresh clears an old request error", async () => {
  let shouldFail = true;
  let error: string | undefined;
  let releaseBackground: (() => void) | undefined;
  const modes: string[] = [];
  const poller = new SingleFlightPoller(async (mode) => {
    modes.push(mode);
    try {
      if (shouldFail) throw new Error("temporary detail failure");
      if (mode === "background") await new Promise<void>((resolve) => { releaseBackground = resolve; });
      if (mode === "interactive") error = undefined;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  });

  await poller.poll(false);
  assert.equal(error, "temporary detail failure");
  shouldFail = false;
  const background = poller.poll(false);
  await waitFor(() => releaseBackground !== undefined);
  const interactive = poller.poll();
  assert.equal(error, "temporary detail failure");
  releaseBackground?.();
  await Promise.all([background, interactive]);
  assert.equal(error, undefined);
  assert.deepEqual(modes, ["background", "background", "interactive"]);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for polling state");
}
