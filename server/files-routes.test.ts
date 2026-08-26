// 取件台的两侧：读（列表的两道过滤）与写（保存的乐观锁）。都是最容易在以后被
// 改坏的地方，所以钉住：
//   ① 别人的会话列不出来（会话归属）
//   ② 白名单外的路径不出现（agent 有 shell，registry 里真的会有这种行）
//   ③ 版本过期的保存被拒，且原文件一个字节都不变
//
// ⚠️ 这里用假身份中间件顶替 authMiddleware，所以 **PUT 的路径白名单没被这个文件
// 测到**——它是 policy 表声明（paths: body.path）+ 中间件执行的，覆盖由
// policy.test.ts 保证「声明存在」。改动写侧时别以为这里替你把白名单也测了。
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Hono } from "hono";
import type { Context, Next } from "hono";

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-webui-files-route-"));
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CC_WEBUI_WORKSPACES_DIR = path.join(tmp, "workspaces");

const mine = path.join(tmp, "mine");
const theirs = path.join(tmp, "theirs");
await fsp.mkdir(mine, { recursive: true });
await fsp.mkdir(theirs, { recursive: true });
const okFile = path.join(mine, "plan.md");
const outsideFile = path.join(theirs, "secret.md");
await fsp.writeFile(okFile, "ok");
await fsp.writeFile(outsideFile, "outside the whitelist");

const { closeDb } = await import("./db.ts");
const { createUser, setAllowedPaths } = await import("./auth/users.ts");
const { recordOwner } = await import("./auth/ownership.ts");
const { recordSessionFiles } = await import("./session-files.ts");
const { filesRoute } = await import("./files-routes.ts");

const alice = createUser({ username: "alice", password: "x", role: "user" });
const bob = createUser({ username: "bob", password: "x", role: "user" });
setAllowedPaths(alice.id, [`${mine}/**`]);
setAllowedPaths(bob.id, [`${tmp}/**`]);

const ALICE_SESSION = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
recordOwner(ALICE_SESSION, "claude", alice.id);

// registry 里同时有一条白名单内、一条白名单外的行 —— agent 用 shell 往别处写
// 完全是正常路径，所以这不是构造的边缘情况。
recordSessionFiles(ALICE_SESSION, [
  { path: okFile, firstSeenMs: 1, lastTouchedMs: 2, size: 2, mtimeMs: 2 },
  { path: outsideFile, firstSeenMs: 1, lastTouchedMs: 3, size: 21, mtimeMs: 3 },
]);

// 用一个假的身份中间件顶替 authMiddleware：这里要测的是处理器自己的收窄，
// 不是 cookie 解析。键与 middleware.ts 的 USER_KEY 一致。
const appFor = (user: unknown) => {
  const app = new Hono();
  app.use("*", async (c: Context, next: Next) => {
    (c as unknown as Record<string, unknown>)["__ccWebuiUser"] = user;
    await next();
  });
  app.route("/api/files", filesRoute);
  return app;
};

const get = async (user: unknown, sessionId?: string) => {
  const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  const res = await appFor(user).request(`/api/files${qs}`);
  const body = (await res.json()) as { files: { path: string }[] };
  return { status: res.status, paths: body.files.map((f) => f.path) };
};

// ── ① 归属 ──────────────────────────────────────────────────────────────────

const asAlice = await get(alice, ALICE_SESSION);
assert.equal(asAlice.status, 200);
assert.deepEqual(asAlice.paths, [okFile], "自己的会话列得出来");

const asBob = await get(bob, ALICE_SESSION);
assert.deepEqual(asBob.paths, [], "别人的会话列不出来");
assert.equal(
  asBob.status,
  200,
  "空列表而不是 403 —— 会话存在与否本身不该泄漏"
);

// ── ② 白名单 ────────────────────────────────────────────────────────────────
//
// bob 的白名单覆盖整个 tmp（含 theirs/），但那条会话不是他的 —— 上面已经验过。
// 这里换成管理员：归属检查对管理员放行，于是唯一还在起作用的就是白名单本身。

const admin = createUser({ username: "root", password: "x", role: "admin" });
setAllowedPaths(admin.id, [`${mine}/**`]);
const asAdmin = await get(admin, ALICE_SESSION);
assert.deepEqual(
  asAdmin.paths,
  [okFile],
  "白名单外的路径过滤掉，即使调用方是管理员（决策 6）"
);

// 管理员把白名单放开到整个 tmp，那条白名单外的行才现身 —— 证明上面拦掉它的
// 确实是白名单，不是别的什么东西顺手挡住了。
setAllowedPaths(admin.id, [`${tmp}/**`]);
const asAdminWide = await get(admin, ALICE_SESSION);
assert.deepEqual(
  asAdminWide.paths.sort(),
  [okFile, outsideFile].sort(),
  "放开白名单后两行都在（说明前一条断言拦的就是白名单）"
);

// ── 边界 ────────────────────────────────────────────────────────────────────

const noSession = await get(alice);
assert.deepEqual(noSession.paths, [], "没有 sessionId 就是空列表，不是错误");

const unknown = await get(alice, "cccccccc-cccc-cccc-cccc-cccccccccccc");
assert.deepEqual(unknown.paths, [], "不存在的会话也是空列表");

// ── PUT /content：乐观锁 ─────────────────────────────────────────────────────
//
// 这是整个取件台唯一会**写**用户文件的地方，而这块地没有 git 也没有回收站，
// 所以「拒绝覆盖」这条路径必须钉死。

const put = async (user: unknown, body: unknown) => {
  const res = await appFor(user).request("/api/files/content", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const st0 = await fsp.stat(okFile);

// 版本对得上 → 落盘。
const okSave = await put(alice, {
  path: okFile,
  content: "第一版",
  ifMatch: { mtimeMs: st0.mtimeMs, size: st0.size },
});
assert.equal(okSave.status, 200);
assert.equal(await fsp.readFile(okFile, "utf8"), "第一版");

// 拿**过期**的版本再存 → 409，且**文件内容一个字节都不许变**。
const stale = await put(alice, {
  path: okFile,
  content: "不该写进去",
  ifMatch: { mtimeMs: st0.mtimeMs, size: st0.size },
});
assert.equal(stale.status, 409);
assert.equal(stale.body.error, "conflict");
assert.equal(
  await fsp.readFile(okFile, "utf8"),
  "第一版",
  "冲突时原文件必须保持 agent 那一版 —— 这是决策 11 的全部意义"
);

// 不带 ifMatch 直接存 → 428，不是「就当没锁」。
const noMatch = await put(alice, { path: okFile, content: "裸写" });
assert.equal(noMatch.status, 428);
assert.equal(await fsp.readFile(okFile, "utf8"), "第一版");

// size 也是一把锁：mtime 相同但大小变了（有些文件系统 mtime 粒度粗）也算冲突。
const st1 = await fsp.stat(okFile);
const sizeOnly = await put(alice, {
  path: okFile,
  content: "x",
  ifMatch: { mtimeMs: st1.mtimeMs, size: st1.size + 1 },
});
assert.equal(sizeOnly.status, 409, "size 不匹配也拦");

// 不存在的文件 → 404（取件台不负责创建）。
const missing = await put(alice, {
  path: path.join(mine, "nope.md"),
  content: "x",
  ifMatch: { mtimeMs: 1, size: 1 },
});
assert.equal(missing.status, 404);

// 原子写：临时文件不许留在目录里（它会被 registry 的扫描当成产出）。
const leftovers = (await fsp.readdir(mine)).filter((n) =>
  n.includes("cc-webui-tmp")
);
assert.deepEqual(leftovers, [], "临时文件必须已经 rename 掉");

closeDb();
await fsp.rm(tmp, { recursive: true, force: true });
console.log("files-routes.test.ts: all assertions passed");
