import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beginDirectoryRefresh, createDirectoryLoader, directoryNeedsRead, failDirectoryRefresh, type DirectorySnapshot } from "./directory-refresh.ts";
import { DirectoryReadError, listTree, type TreeEntry } from "./fs.ts";

const entries: TreeEntry[] = [{ path: "/a/child", name: "child", type: "dir" }];
const old: DirectorySnapshot = { path: "/a", revision: 0, entries, error: null };
assert.strictEqual(beginDirectoryRefresh(old, "/a").entries, entries, "refresh retains the same visible list until replacement is ready");
assert.equal(beginDirectoryRefresh(old, "/b").entries, null, "switching projects never shows the old project's directory data");
assert.equal(directoryNeedsRead(old, "/a", 0), false);
assert.equal(directoryNeedsRead(old, "/a", 1), true, "a closed folder's next expansion reads the new revision");
assert.equal(directoryNeedsRead(old, "/b", 0), true);
assert.strictEqual(failDirectoryRefresh(old, "/a", "offline", 500).entries, entries);
for (const status of [401, 403, 404]) assert.equal(failDirectoryRefresh(old, "/a", "denied", status).entries, null);
assert.equal(failDirectoryRefresh(old, "/b", "offline").entries, null);

let active = 0, maximum = 0;
const started: string[] = [];
const held = new Map<string, () => void>();
const loader = createDirectoryLoader(async (path, signal) => {
  active++; maximum = Math.max(maximum, active); started.push(path);
  try { await new Promise<void>((resolve, reject) => {
    held.set(path, resolve);
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }); return entries; } finally { active--; }
});
const controllers = Array.from({ length: 8 }, () => new AbortController());
const requests = controllers.map((controller, i) => loader(`/${i}`, controller.signal).catch(error => error));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
await flush(); assert.equal(active, 4); assert.equal(maximum, 4);
controllers[7].abort(); assert.equal((await requests[7]).name, "AbortError");
assert(!started.includes("/7"), "cancelled queued folders never cause a network read");
controllers[0].abort(); await flush(); assert.equal((await requests[0]).name, "AbortError");
assert(started.includes("/4"));
for (const path of ["/1", "/2", "/3", "/4"]) held.get(path)!();
await flush();
for (const path of ["/5", "/6"]) held.get(path)!();
await Promise.all(requests); assert.equal(active, 0); assert.equal(maximum, 4);
assert.throws(() => createDirectoryLoader(async () => [], 0));

const originalFetch = globalThis.fetch;
try {
  let requestOptions: RequestInit | undefined;
  globalThis.fetch = (async (url, options) => {
    assert(String(url).includes("path=%2Fproject%2F%E5%B7%A5%E5%85%B7")); requestOptions = options;
    return new Response(JSON.stringify({ entries }), { status: 200 });
  }) as typeof fetch;
  const controller = new AbortController();
  assert.deepEqual(await listTree("/project/工具", { signal: controller.signal }), entries);
  assert.equal(requestOptions?.signal, controller.signal); assert.equal(requestOptions?.cache, "no-store");
  globalThis.fetch = (async () => new Response('{}', { status: 403 })) as typeof fetch;
  await assert.rejects(() => listTree("/a"), error => error instanceof DirectoryReadError && error.status === 403);
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
  await assert.rejects(() => listTree("/a"), /响应格式错误/);
} finally { globalThis.fetch = originalFetch; }

const explorer = readFileSync(new URL("../components/FileExplorer.tsx", import.meta.url), "utf8");
const hook = readFileSync(new URL("./useDirectoryEntries.ts", import.meta.url), "utf8");
assert.doesNotMatch(explorer, /key=\{seq\}|setRootEntries\(null\)/);
assert.match(explorer, /key=\{cwd\}/, "only project changes recreate the tree scope");
assert.match(explorer, /useDirectoryEntries\(entry.path, revision, open\)/);
assert.match(hook, /if \(!controller.signal.aborted\) setSnapshot/, "late results are ignored even if the fetch implementation ignores cancellation");
assert.match(hook, /return \(\) => controller.abort\(\)/);
console.log("File tree refresh: preserved snapshots, lazy invalidation, project scope, errors, cancellation and four-request limit verified");
