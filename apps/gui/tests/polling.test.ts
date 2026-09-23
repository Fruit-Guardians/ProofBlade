import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SingleFlightPoller, isPollingAllowed } from "../src/polling.js";

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

test("[contract:polling-failed-background-retries-interactive] a queued interactive refresh runs after a failed background task", async () => {
  let attempts = 0;
  let release: (() => void) | undefined;
  const modes: string[] = [];
  const poller = new SingleFlightPoller(async (mode) => {
    modes.push(mode);
    attempts += 1;
    if (attempts === 1) {
      await new Promise<void>((resolve) => { release = resolve; });
      throw new Error("background request failed");
    }
  });

  const background = poller.poll(false);
  await waitFor(() => release !== undefined);
  const interactive = poller.poll();
  release?.();

  assert.equal(await background, true);
  assert.equal(await interactive, false);
  assert.equal(attempts, 2);
  assert.deepEqual(modes, ["background", "interactive"]);
});

test("[contract:polling-hidden-document-is-idle] a hidden document permits no polling tick", () => {
  // Item I, first half. Each tick costs a full Run detail payload, so a tab
  // nobody is looking at must not schedule that work.
  assert.equal(isPollingAllowed("visible"), true);
  assert.equal(isPollingAllowed("hidden"), false);
  assert.equal(isPollingAllowed("prerender"), false);
});

test("the background timer enforces the visibility rule through the tested predicate", async () => {
  // The predicate above is only meaningful if the tick actually consults it.
  // App.tsx runs a React component and cannot be mounted here, so this asserts
  // the wiring exists instead of claiming behavioural coverage it does not have:
  // if someone inlines the check again or drops it, this fails and points at the
  // test that should be extended.
  const source = await readFile(join(import.meta.dirname, "..", "src", "App.tsx"), "utf8");
  assert.match(source, /isPollingAllowed\(document\.visibilityState\)/, "the background timer must gate on the visibility predicate");
  assert.doesNotMatch(source, /visibilityState\s*!==\s*"visible"/, "the guard must not be re-inlined, or the predicate stops being the single rule");
});

test("the incremental events endpoint stays available for the chat poll to adopt", async () => {
  // Item I, second half: the server side already supports `afterSeq`, but no
  // client calls it, so every poll still transfers the whole event stream. The
  // client change needs browser verification and is deliberately not made here.
  // This keeps the endpoint from being removed as "unused" while that is pending.
  const source = await readFile(join(import.meta.dirname, "..", "src", "server.ts"), "utf8");
  assert.match(source, /afterSeq/, "the events endpoint must keep supporting incremental reads");
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for polling state");
}
