import assert from "node:assert/strict";
import test from "node:test";
import { currentModelLabel, isConversationInFlight, projectCacheUsage } from "../src/conversation-projection.js";

test("current model label prefers the next-turn conversation model", () => {
  assert.equal(currentModelLabel("gpt-next", "gpt-previous", "runtime"), "gpt-next");
  assert.equal(currentModelLabel(undefined, "gpt-previous", "runtime"), "gpt-previous");
});

test("server-owned active state survives a conversation component remount", () => {
  assert.equal(isConversationInFlight("running", false), true);
  assert.equal(isConversationInFlight("stopping", false), true);
  assert.equal(isConversationInFlight("paused", false), true);
  assert.equal(isConversationInFlight(undefined, false), false);
});

test("cache hit rate excludes cache writes from the input denominator", () => {
  assert.deepEqual(projectCacheUsage({ input: 25, cacheRead: 75, cacheWrite: 40 }), {
    uncachedInput: 25,
    cacheRead: 75,
    cacheWrite: 40,
    inputBasis: 100,
    hitRate: 0.75,
  });
});
