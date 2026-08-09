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

test("weighted LRU evicts by total weight and rejects an oversized item", () => {
  const cache = new BoundedLruCache<string, string>(3, 10, (value) => value.length);
  assert.equal(cache.set("first", "123456"), true);
  assert.equal(cache.set("second", "1234"), true);
  assert.equal(cache.weight, 10);
  assert.equal(cache.set("large", "12345678901"), false);
  assert.equal(cache.get("large"), undefined);
  assert.equal(cache.weight, 10);
  assert.equal(cache.set("third", "12345"), true);
  assert.equal(cache.get("first"), undefined);
  assert.equal(cache.get("second"), "1234");
  assert.equal(cache.get("third"), "12345");
  assert.equal(cache.weight, 9);
});
