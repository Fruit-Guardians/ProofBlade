import assert from "node:assert/strict";
import test from "node:test";
import { BoundedLruCache } from "../src/bounded-lru-cache.js";

test("bounded LRU cache evicts the least recently used entry and clears all values", () => {
  const cache = new BoundedLruCache<string, object>(2);
  const first = {};
  const second = {};
  const third = {};
  cache.set("first", first);
  cache.set("second", second);

  assert.equal(cache.get("first"), first);
  cache.set("third", third);

  assert.equal(cache.size, 2);
  assert.equal(cache.get("second"), undefined);
  assert.equal(cache.get("first"), first);
  assert.equal(cache.get("third"), third);
  cache.clear();
  assert.equal(cache.size, 0);
});
