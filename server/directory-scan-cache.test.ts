import assert from "node:assert/strict";
import { DirectoryScanCache } from "./directory-scan-cache.ts";

let now = 0;
const calls: string[] = [];
const cache = new DirectoryScanCache(async (root) => {
  calls.push(root);
  return [`${root}/${calls.length}`];
}, 30, 2, () => now);

assert.deepEqual(await cache.get("/a"), ["/a/1"]);
assert.deepEqual(await cache.get("/a"), ["/a/1"]);
assert.equal(calls.length, 1, "warm roots do not walk again");
now = 30;
assert.deepEqual(await cache.get("/a"), ["/a/2"], "TTL boundary expires");
assert.deepEqual(await cache.get("/a", true), ["/a/3"], "explicit refresh bypasses TTL");
await cache.get("/b");
await cache.get("/a"); // Touch a so b is least recently used.
await cache.get("/c");
assert.equal(calls.length, 5);
await cache.get("/b");
assert.equal(calls.length, 6, "bounded LRU evicts b, not recently used a");

let finish!: (dirs: string[]) => void;
let coldCalls = 0;
const cold = new DirectoryScanCache(() => {
  coldCalls++;
  return new Promise<string[]>((resolve) => { finish = resolve; });
});
const requests = [cold.get("/slow"), cold.get("/slow"), cold.get("/slow", true)];
await Promise.resolve();
assert.equal(coldCalls, 1, "concurrent and forced requests share one walk");
finish(["/slow/project"]);
assert.deepEqual(await Promise.all(requests), Array(3).fill(["/slow/project"]));

let attempts = 0;
const flaky = new DirectoryScanCache(async () => {
  if (++attempts === 1) throw new Error("temporary failure");
  return ["/recovered"];
});
await assert.rejects(flaky.get("/root"), /temporary failure/);
assert.deepEqual(await flaky.get("/root"), ["/recovered"], "failure does not poison pending/cache");

// TTL starts at completion, not when a long filesystem walk starts.
let finishLong!: (dirs: string[]) => void;
const long = new DirectoryScanCache(() => new Promise((resolve) => { finishLong = resolve; }), 30, 2, () => now);
const longRequest = long.get("/long");
await Promise.resolve();
now = 100;
finishLong(["/long/done"]);
await longRequest;
now = 129;
assert.deepEqual(await long.get("/long"), ["/long/done"]);
console.log("directory-scan-cache.test.ts ✓");
