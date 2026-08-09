import assert from "node:assert/strict";
import test from "node:test";
import { SingleFlightPoller } from "../src/polling.js";

test("polling skips overlapping refreshes and resumes after the active refresh settles", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const poller = new SingleFlightPoller(async () => {
    calls += 1;
    await new Promise<void>((resolve) => { release = resolve; });
  });

  const first = poller.poll();
  assert.equal(await poller.poll(), false);
  assert.equal(calls, 1);
  release?.();
  assert.equal(await first, true);

  const third = poller.poll();
  assert.equal(calls, 2);
  release?.();
  assert.equal(await third, true);
});
