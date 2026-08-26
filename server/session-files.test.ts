// 「本对话文件」registry。纯脚本风格（top-level await + node:assert），照
// server/groups/*.test.ts 的样子写。
//
// ⚠️ 碰索引就要设 CC_WEBUI_DB，否则读写你真实的 ~/.cc-webui/cc-webui.db。
import assert from "node:assert";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-webui-sf-"));
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");

const {
  scanTouched,
  recordSessionFiles,
  listSessionFiles,
  forgetSessionFiles,
  pruneMissing,
  relabelSessionFiles,
} = await import("./session-files.ts");

const cwd = path.join(tmp, "proj");
await fsp.mkdir(cwd, { recursive: true });

const write = async (rel: string, body: string) => {
  const full = path.join(cwd, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, body);
  return full;
};

// ── 扫描：mtime 门槛就是「这个 turn 碰过」的判定 ──────────────────────────────

const old = await write("old.md", "before");
// 把它的 mtime 推回一小时前，模拟上一个 turn 的产物。
const hourAgo = new Date(Date.now() - 3600_000);
await fsp.utimes(old, hourAgo, hourAgo);

const turnStart = Date.now();
// mtime 粒度：确保新文件的 mtime 严格不小于 turnStart。
await new Promise((r) => setTimeout(r, 10));
const fresh = await write("plan.md", "written by this turn");
const nested = await write("sub/deep.txt", "bash 重定向写的");

const r1 = await scanTouched(cwd, turnStart);
assert.equal(r1.kind, "scanned");
const touched = r1.kind === "scanned" ? r1.touched.map((f) => f.path).sort() : [];
assert.deepEqual(
  touched,
  [fresh, nested].sort(),
  "只有 mtime >= turnStart 的文件算这个 turn 碰过"
);
assert.ok(!touched.includes(old), "上一个 turn 的产物不该重复登记");

// 跳过表：node_modules 里的东西再新也不算产出。
await write("node_modules/pkg/index.js", "noise");
await write(".git/objects/ab/cdef", "noise");
const r2 = await scanTouched(cwd, turnStart);
const paths2 = r2.kind === "scanned" ? r2.touched.map((f) => f.path) : [];
assert.ok(
  !paths2.some((p) => p.includes("node_modules") || p.includes(".git")),
  "跳过表里的目录不进 registry"
);

// 不存在的 cwd 不该抛——turn 已经成功了，取件台的登记失败不许影响它。
const r3 = await scanTouched(path.join(tmp, "nope"), turnStart);
assert.equal(r3.kind, "scanned");
assert.equal(r3.kind === "scanned" ? r3.touched.length : -1, 0);

// ── 存储：first_seen 不随改动漂移 ─────────────────────────────────────────────

const SID = "11111111-1111-1111-1111-111111111111";
recordSessionFiles(SID, r1.kind === "scanned" ? r1.touched : []);
let rows = listSessionFiles(SID);
assert.equal(rows.length, 2);
const firstSeen = rows.find((r) => r.path === fresh)!.firstSeenMs;

// 同一个文件再被改一次：last_touched 前进，first_seen 不动。
await new Promise((r) => setTimeout(r, 10));
await fsp.writeFile(fresh, "改了第二遍");
const r4 = await scanTouched(cwd, turnStart);
recordSessionFiles(SID, r4.kind === "scanned" ? r4.touched : []);
rows = listSessionFiles(SID);
assert.equal(rows.length, 2, "重复登记不产生新行");
const again = rows.find((r) => r.path === fresh)!;
assert.equal(again.firstSeenMs, firstSeen, "first_seen 只在插入时写");
assert.ok(again.lastTouchedMs > firstSeen - 1, "last_touched 跟着 mtime 走");

// 排序：最近改动的在最前面。
assert.equal(rows[0].path, fresh, "按 last_touched 倒序");

// ── prune：磁盘上没了的行要清掉 ──────────────────────────────────────────────

await fsp.rm(nested);
const pruned = await pruneMissing(SID);
assert.equal(pruned, 1);
assert.deepEqual(
  listSessionFiles(SID).map((r) => r.path),
  [fresh],
  "取件台不列不存在的文件"
);

// ── relabel：首个 turn 的 id 会被 CLI 换掉 ───────────────────────────────────
//
// 这条是这张表最容易出事的地方：不跟着改名，第一个 turn 的文件就永远挂在一个
// 死 id 下面，谁都查不出来。

const NEW_SID = "22222222-2222-2222-2222-222222222222";
relabelSessionFiles(SID, NEW_SID);
assert.equal(listSessionFiles(SID).length, 0, "旧 id 下不留残行");
assert.deepEqual(
  listSessionFiles(NEW_SID).map((r) => r.path),
  [fresh],
  "文件跟着新 id 走"
);

// 新旧 id 下都已有同一路径时，relabel 不许抛（主键冲突会让整条 relabel 链断掉，
// 那比丢一行贵得多）。
recordSessionFiles(SID, [
  { path: fresh, firstSeenMs: 1, lastTouchedMs: 1, size: 1, mtimeMs: 1 },
]);
relabelSessionFiles(SID, NEW_SID);
assert.equal(listSessionFiles(SID).length, 0);
assert.equal(listSessionFiles(NEW_SID).length, 1, "冲突时合成一行，不抛");

// 空参数与同名 relabel 是 no-op，不是错误。
relabelSessionFiles("", NEW_SID);
relabelSessionFiles(NEW_SID, NEW_SID);
assert.equal(listSessionFiles(NEW_SID).length, 1);

// ── 手动移除 ────────────────────────────────────────────────────────────────

forgetSessionFiles(NEW_SID, [fresh]);
assert.equal(listSessionFiles(NEW_SID).length, 0);

await fsp.rm(tmp, { recursive: true, force: true });
console.log("session-files.test.ts: all assertions passed");
