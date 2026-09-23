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

const exists = async (p: string) => {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
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

// ── POST /delete：真删 + 留痕 + 白名单逐个查 ────────────────────────────────

const { listDeletions } = await import("./session-files.ts");

const post = async (user: unknown, url: string, body: unknown) => {
  const res = await appFor(user).request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const doomed = path.join(mine, "doomed.md");
await fsp.writeFile(doomed, "删我");
const del = await post(alice, "/api/files/delete", {
  paths: [doomed, outsideFile],
  sessionId: ALICE_SESSION,
});
assert.equal(del.status, 200);
assert.deepEqual(del.body.deleted, [doomed], "白名单内的删掉了");
assert.equal(
  (del.body.failed as { path: string }[])[0]?.path,
  outsideFile,
  "白名单外的被拒 —— 这条路由的白名单是处理器自己查的，中间件管不了数组"
);
assert.equal(
  await fsp.readFile(outsideFile, "utf8"),
  "outside the whitelist",
  "被拒的那个文件必须完好无损"
);
assert.equal(await exists(doomed), false, "真删，不是移到别处");

// 留痕：这是「不做回收站」的前提。
const trail = listDeletions();
assert.equal(trail.length, 1);
assert.equal(trail[0].username, "alice");
// 留痕记的是**实际 unlink 的那个路径**（规范化过的），不是请求里的字符串 ——
// macOS 上 /var/… 会被 realpath 成 /private/var/…。查事故时要的正是前者。
assert.equal(trail[0].path, path.join(await fsp.realpath(mine), "doomed.md"));
assert.equal(trail[0].sessionId, ALICE_SESSION);

// registry 里的行跟着走，不然列表还会列着它。
assert.equal(
  (await get(alice, ALICE_SESSION)).paths.includes(doomed),
  false,
  "删掉的文件立刻从列表消失，不等下一个 turn 的 prune"
);

// **非空**目录不许删：只开放空文件夹（rmdir，不递归）—— recursive 删目录是这个
// 仓库出过事故的形状。空文件夹那一半在 files-delete-dir.test.ts。
const dirTarget = path.join(mine, "adir");
await fsp.mkdir(dirTarget, { recursive: true });
await fsp.writeFile(path.join(dirTarget, "keep.md"), "keep");
const delDir = await post(alice, "/api/files/delete", { paths: [dirTarget] });
assert.deepEqual(delDir.body.deleted, []);
assert.equal(
  await exists(path.join(dirTarget, "keep.md")),
  true,
  "非空目录里的东西一个都不能少"
);

// 空 paths → 400，不是「什么都没删算成功」。
assert.equal(
  (await post(alice, "/api/files/delete", { paths: [] })).status,
  400
);

// ── POST /upload：不覆盖同名 ─────────────────────────────────────────────────

const upload = async (user: unknown, dir: string, name: string, body: string) => {
  const form = new FormData();
  form.append("files", new File([body], name, { type: "text/plain" }));
  const res = await appFor(user).request(
    `/api/files/upload?dir=${encodeURIComponent(dir)}`,
    { method: "POST", body: form }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const up1 = await upload(alice, mine, "模板.docx", "v1");
assert.equal(up1.status, 200);
assert.equal(await fsp.readFile(path.join(mine, "模板.docx"), "utf8"), "v1");

// 同名再传一次 → 加序号，**不许覆盖**（这块地没有版本控制，顶掉 agent 的产出
// 是不可恢复的）。
const up2 = await upload(alice, mine, "模板.docx", "v2");
assert.equal(up2.status, 200);
assert.equal(
  await fsp.readFile(path.join(mine, "模板.docx"), "utf8"),
  "v1",
  "原文件没被顶掉"
);
assert.equal(await fsp.readFile(path.join(mine, "模板-1.docx"), "utf8"), "v2");

// 文件名里的路径分隔符是异常输入：单位是文件名，不是路径。
const evil = await upload(alice, mine, "../../escaped.txt", "x");
assert.equal(evil.status, 200);
assert.equal(
  await exists(path.join(tmp, "..", "escaped.txt")),
  false,
  "不许逃出目标目录"
);
// "../../escaped.txt" 的三个分隔符各变一个下划线 → ".._.._escaped.txt"
assert.equal(await exists(path.join(mine, ".._.._escaped.txt")), true);

// 不存在的目录 → 404。
assert.equal(
  (await upload(alice, path.join(mine, "nodir"), "a.txt", "x")).status,
  404
);

// ── GET /download：白名单逐个查 + 单个/打包两条路径 ─────────────────────────
//
// ⚠️ 这一段里最重要的是「第二个 path 也被查了」那条。`path` 是可重复的 query，
// 而中间件的 valueFrom 只看第一个值 —— 也就是说这条路由**不可能**靠 policy 表里
// 的 paths 声明保护，一旦有人把处理器里的循环改成只查一个，别人的文件就能被
// `?path=我的&path=别人的` 顺出来。

const download = async (user: unknown, paths: string[]) => {
  const qs = paths.map((p) => `path=${encodeURIComponent(p)}`).join("&");
  return appFor(user).request(`/api/files/download?${qs}`);
};

const one = await download(alice, [okFile]);
assert.equal(one.status, 200);
assert.equal(one.headers.get("content-type"), "application/octet-stream");
assert.match(one.headers.get("content-disposition") ?? "", /^attachment; filename="plan.md"/);
assert.equal(await one.text(), "第一版", "流回来的就是盘上那份");

// 中文名必须走 filename*（只写 filename= 的话浏览器存下来是乱码）。
const cn = await download(alice, [path.join(mine, "模板.docx")]);
assert.equal(cn.status, 200);
assert.equal(
  cn.headers.get("content-disposition"),
  `attachment; filename="__.docx"; filename*=UTF-8''%E6%A8%A1%E6%9D%BF.docx`
);

// `(` `)` 不是 RFC 5987 的 attr-char，而 encodeURIComponent 不转义它们 ——
// 漏了这一步，带括号的中文名在部分浏览器上会被截断（这个仓库里「报告 (最终).md」
// 这种名字很常见）。
await fsp.writeFile(path.join(mine, "报告 (最终).md"), "x");
const parens = await download(alice, [path.join(mine, "报告 (最终).md")]);
assert.equal(
  parens.headers.get("content-disposition"),
  `attachment; filename="__ (__).md"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%28%E6%9C%80%E7%BB%88%29.md`
);

// 白名单外 → 403。
assert.equal((await download(alice, [outsideFile])).status, 403);

// **混一个白名单外的进来 → 整条请求 403**，不是「悄悄少打包一个」：
// 下载少了一个文件是看不见的，用户要到解压之后才发现。
const mixed = await download(alice, [okFile, outsideFile]);
assert.equal(mixed.status, 403, "第二个 path 也要过白名单");

// bob 的白名单覆盖整个 tmp，同一个请求对他就是合法的 —— 说明上面拦掉的确实是
// 白名单，不是别的什么东西顺手挡住了。
assert.equal((await download(bob, [okFile, outsideFile])).status, 200);

// 多个 → zip。
const many = await download(alice, [okFile, path.join(mine, "模板.docx")]);
assert.equal(many.status, 200);
assert.equal(many.headers.get("content-type"), "application/zip");
assert.match(many.headers.get("content-disposition") ?? "", /\.zip"/);
const zipBytes = Buffer.from(await many.arrayBuffer());
assert.equal(zipBytes.subarray(0, 4).toString("hex"), "504b0304", "是个真 zip");
// 结构与 crc 由 zip.test.ts 拿系统 unzip 验，这里只确认条目数对得上。
assert.equal(zipBytes.readUInt16LE(zipBytes.length - 22 + 10), 2);

// 目录 → 400（v1 不做，且树上也选不中）。
assert.equal((await download(alice, [path.join(mine, "adir")])).status, 400);
// 不存在 → 404。
assert.equal((await download(alice, [path.join(mine, "nope.md")])).status, 404);
// 一个都没给 → 400。
assert.equal((await appFor(alice).request("/api/files/download")).status, 400);

closeDb();
await fsp.rm(tmp, { recursive: true, force: true });
console.log("files-routes.test.ts: all assertions passed");
