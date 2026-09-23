// 共享的安全网。
//
// 这个功能的全部风险都压在一句话上：**读得到 ≠ 删得掉**。它不是靠某个 handler
// 里的 if，而是靠 policy.ts 里「哪条路由标了 access: 'reader'」这张表 —— 这类
// 判断没有测试就会在下一次有人顺手给 DELETE 加个 reader 的时候悄悄塌掉。
//
// 所以这里全部走真实的 app.request()：policy 表 + 中间件 + store 一起过。

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const tmp = path.join(os.tmpdir(), `cc-webui-sharing-test-${Date.now()}`);
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CC_WEBUI_COOKIE_SECRET_FILE = path.join(tmp, "cookie-secret");
process.env.CC_WEBUI_GROUPS_DIR = path.join(tmp, "groups");
process.env.CC_WEBUI_SESSION_INDEX = path.join(tmp, "sessions.json");
process.env.CODEX_SESSIONS_DIR = path.join(tmp, "codex-empty");
process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR = path.join(tmp, "claude-projects");
process.env.CC_WEBUI_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CC_WEBUI_DOTENV = path.join(tmp, "empty.env");
await fs.mkdir(tmp, { recursive: true });
await fs.writeFile(path.join(tmp, "empty.env"), "");

const { closeDb } = await import("../db.ts");
const { createApp } = await import("../app.ts");
const { createUser, deleteUser } = await import("./users.ts");
const { recordOwner, ownerOf, canAccessResource } = await import("./ownership.ts");
const { isSharedWith, resourceIdsSharedWith, setShares, sharesOf } =
  await import("./sharing.ts");
const { visibilityFor } = await import("./scope.ts");
const { issueSession, SESSION_COOKIE } = await import("./session.ts");

try {
  const app = createApp();
  const cookie = (id: string) => ({ cookie: `${SESSION_COOKIE}=${issueSession(id)}` });
  const owner = createUser({
    username: "owner",
    password: "x",
    role: "user",
    allowedPaths: [path.join(tmp, "work") + "/**"],
  });
  const reader = createUser({
    username: "reader",
    password: "x",
    role: "user",
    allowedPaths: [path.join(tmp, "work") + "/**"],
  });
  const stranger = createUser({
    username: "stranger",
    password: "x",
    role: "user",
    allowedPaths: [],
  });
  const admin = createUser({
    username: "root",
    password: "x",
    role: "admin",
    allowedPaths: ["**"],
  });

  const sid = randomUUID();
  recordOwner(sid, "claude", owner.id);

  // ── 1. 共享之前：读者和陌生人都看不到 ────────────────────────────────────
  //
  // 200 vs 404 在这条路由上正好是中间件的边界：handler 自己 catch 掉一切，
  // 连不存在的会话都回 200 + {messages: []}。所以 404 只可能来自 owns 检查。
  const read = (who: { id: string }) =>
    app.request(`/api/sessions/${sid}/messages`, { headers: cookie(who.id) });

  assert.equal((await read(owner)).status, 200, "owner reads");
  assert.equal((await read(admin)).status, 200, "admin bypass (decision 11)");
  assert.equal((await read(reader)).status, 404, "not shared yet");
  assert.equal((await read(stranger)).status, 404, "never shared");

  // ── 2. 共享 ──────────────────────────────────────────────────────────────
  const put = (who: { id: string }, userIds: string[]) =>
    app.request(`/api/sessions/${sid}/shares`, {
      method: "PUT",
      headers: { ...cookie(who.id), "content-type": "application/json" },
      body: JSON.stringify({ userIds }),
    });

  // ⚠️ **发起共享是管理员动作（决策 41）。** 连 owner 自己都不行 —— 普通用户能
  // 共享给的对象只有管理员（对方本来就全看得见）或另一个普通用户，后者是在管理员
  // 背后重新分配可见性。这里刻意用会话的 owner 来验：连他都被拒，才说明这道闸是
  // 按角色而不是按归属开的。
  assert.equal((await put(owner, [reader.id])).status, 403, "⚠️ 普通用户不能发起共享");
  assert.equal((await put(reader, [reader.id])).status, 403);
  assert.equal(sharesOf(sid).length, 0, "被拒的请求什么也没写进去");

  const shared = await put(admin, [reader.id]);
  assert.equal(shared.status, 200, "管理员可以");
  assert.deepEqual(
    (await shared.json()).shares.map((s: { username: string }) => s.username),
    ["reader"],
  );

  // GET 要连 owner 一起回：对话框只拿得到一个 sessionId，靠它才知道收件人列表里
  // 该划掉谁、转交确认该怎么措辞。
  assert.equal(
    (await app.request(`/api/sessions/${sid}/shares`, { headers: cookie(owner.id) })).status,
    403,
    "共享名单连 owner 都看不到 —— 三条路由是同一道闸",
  );
  const panel = await app.request(`/api/sessions/${sid}/shares`, {
    headers: cookie(admin.id),
  });
  assert.equal(panel.status, 200);
  const panelBody = await panel.json();
  assert.equal(panelBody.owner.username, "owner");
  assert.deepEqual(
    panelBody.shares.map((r: { username: string }) => r.username),
    ["reader"],
  );

  assert.equal((await read(reader)).status, 200, "the share opens the door");
  assert.equal((await read(stranger)).status, 404, "and only for the named user");

  // ── 3. ⚠️ 读得到 ≠ 删得掉 ────────────────────────────────────────────────
  //
  // 这一条是整个功能的核心不变量。DELETE 是真的 unlink 掉 CLI 自己的 jsonl，
  // 没有回收站。它必须留在 access 缺省的那一级上。
  const del = await app.request(`/api/sessions/${sid}?provider=claude`, {
    method: "DELETE",
    headers: cookie(reader.id),
  });
  assert.equal(del.status, 404, "⚠️ a reader must NOT be able to delete");

  // 同理，读者不能替自己转手。403（角色闸）而不是 404（归属闸）—— 决策 41 之后
  // 命中的是前者，两者都拒，但码不一样。
  assert.equal((await put(reader, [stranger.id])).status, 403, "a reader cannot re-share");
  assert.equal(
    (
      await app.request(`/api/sessions/${sid}/transfer`, {
        method: "POST",
        headers: { ...cookie(reader.id), "content-type": "application/json" },
        body: JSON.stringify({ userId: reader.id }),
      })
    ).status,
    403,
    "a reader cannot transfer ownership to themselves",
  );
  assert.deepEqual(
    sharesOf(sid).map((s) => s.username),
    ["reader"],
    "and none of those attempts changed anything",
  );

  // ── 4. 续聊：POST /api/chat 的 resume id 现在有归属检查 ───────────────────
  //
  // 这条路由在共享之前**根本没有 owns 规则**：body.sessionId 直通 CLI 的
  // `resume:`，谁知道 id 谁就能接着聊，路径白名单是唯一的阻碍——而两个账号
  // 指向同一个目录时它天然对得上。
  //
  // 不真的起 turn：故意送一个白名单外的 cwd。中间件先查 owns 再查 paths，
  // 所以 404 = 被归属挡下，403 = 归属放行、路径挡下。两者正好把边界分开。
  const chat = (who: { id: string }, sessionId: string) =>
    app.request("/api/chat", {
      method: "POST",
      headers: { ...cookie(who.id), "content-type": "application/json" },
      body: JSON.stringify({ sessionId, prompt: "hi", cwd: "/etc" }),
    });

  assert.equal((await chat(stranger, sid)).status, 404, "⚠️ 不能续别人的会话");
  assert.equal(
    (await chat(reader, sid)).status,
    403,
    "被共享者过了归属这一关（挡下它的是路径白名单，不是所有权）",
  );
  assert.equal((await chat(owner, sid)).status, 403, "owner 同理");

  // 新会话（没有 sessionId）不受影响 —— owns 是 optional 的。
  assert.equal(
    (await chat(stranger, "")).status,
    403,
    "a fresh chat still only meets the path check",
  );

  // ── 5. 取消共享 ──────────────────────────────────────────────────────────
  assert.equal((await put(admin, [])).status, 200);
  assert.equal((await read(reader)).status, 404, "unshared closes it again");
  assert.equal(resourceIdsSharedWith(reader.id).size, 0);

  // ── 6. 纯函数层的性质 ────────────────────────────────────────────────────
  setShares({
    resourceId: sid,
    kind: "claude",
    userIds: [reader.id, owner.id, "no-such-user"],
    sharedBy: owner.id,
    ownerId: owner.id,
  });
  assert.deepEqual(
    sharesOf(sid).map((s) => s.username),
    ["reader"],
    "owner 自己和不存在的账号都被过滤掉",
  );

  assert.ok(visibilityFor(reader)(sid), "共享的会话进得了列表");
  assert.ok(!visibilityFor(stranger)(sid));
  assert.ok(canAccessResource(reader, sid, "reader"));
  assert.ok(!canAccessResource(reader, sid), "缺省是 owner 级，共享不算数");

  // ── 7. 删号会把共享一起带走（ON DELETE CASCADE）────────────────────────────
  const doomed = createUser({ username: "doomed", password: "x", role: "user" });
  setShares({
    resourceId: sid,
    kind: "claude",
    userIds: [reader.id, doomed.id],
    sharedBy: owner.id,
    ownerId: owner.id,
  });
  assert.equal(sharesOf(sid).length, 2);
  deleteUser(doomed.id);
  assert.deepEqual(
    sharesOf(sid).map((s) => s.username),
    ["reader"],
    "悬空的共享行会变成幽灵权限，必须跟着账号一起消失",
  );

  // ── 8. 转交 ──────────────────────────────────────────────────────────────
  assert.equal(
    (
      await app.request(`/api/sessions/${sid}/transfer`, {
        method: "POST",
        headers: { ...cookie(owner.id), "content-type": "application/json" },
        body: JSON.stringify({ userId: reader.id }),
      })
    ).status,
    403,
    "⚠️ owner 也不能自己把会话转手出去",
  );
  const transfer = await app.request(`/api/sessions/${sid}/transfer`, {
    method: "POST",
    headers: { ...cookie(admin.id), "content-type": "application/json" },
    body: JSON.stringify({ userId: reader.id }),
  });
  assert.equal(transfer.status, 200);
  assert.equal(ownerOf(sid), reader.id, "owner 真的换了");
  assert.equal(
    sharesOf(sid).length,
    0,
    "新 owner 名下那条共享是死数据，转交时清掉",
  );
  assert.equal((await read(reader)).status, 200, "新 owner 读得到");
  assert.equal((await read(owner)).status, 404, "⚠️ 转出去就是真的转出去了");
  assert.equal((await read(admin)).status, 200, "管理员照旧（决策 11）");

  // 未知账号不能成为 owner，否则会造出一条谁也够不着的孤儿记录。
  const bogus = await app.request(`/api/sessions/${sid}/transfer`, {
    method: "POST",
    headers: { ...cookie(admin.id), "content-type": "application/json" },
    body: JSON.stringify({ userId: "nope" }),
  });
  assert.equal(bogus.status, 400);
  assert.equal(ownerOf(sid), reader.id);

  // ── 8b. 列表标注 —— 前端就是靠这几个字段决定显示什么 ───────────────────────
  //
  // `mine` / `sharedBy` / `sharedCount` 是 GET /api/sessions 的契约。改名或漏掉
  // 一个，侧边栏的共享入口和「谁共享给我的」标记会**静默消失**，不会有任何报错。
  const projects = path.join(tmp, "claude-projects", "-tmp-work");
  await fs.mkdir(projects, { recursive: true });
  const listed = randomUUID();
  await fs.writeFile(
    path.join(projects, `${listed}.jsonl`),
    JSON.stringify({
      type: "user",
      cwd: path.join(tmp, "work"),
      sessionId: listed,
      message: { role: "user", content: "hello" },
    }) + "\n",
  );
  recordOwner(listed, "claude", owner.id);
  setShares({
    resourceId: listed,
    kind: "claude",
    userIds: [reader.id],
    sharedBy: owner.id,
    ownerId: owner.id,
  });

  const rowFor = async (who: { id: string }) => {
    const res = await app.request("/api/sessions?provider=claude&limit=50", {
      headers: cookie(who.id),
    });
    assert.equal(res.status, 200);
    const rows = (await res.json()).sessions as Array<Record<string, unknown>>;
    return rows.find((r) => r.sessionId === listed);
  };

  const asOwner = await rowFor(owner);
  assert.ok(asOwner, "owner 的列表里有它");
  assert.equal(asOwner.mine, true);
  assert.equal(asOwner.ownerName, "owner");
  assert.equal(asOwner.sharedCount, 1, "owner 一眼看得见自己共享出去了");
  assert.equal(asOwner.sharedBy, undefined, "不是别人共享给他的");

  const asReader = await rowFor(reader);
  assert.ok(asReader, "被共享者的列表里也有它");
  assert.equal(asReader.mine, false, "但不是他的");
  assert.equal(asReader.sharedBy, "owner", "UI 靠这个说「由 owner 共享」");

  assert.equal(await rowFor(stranger), undefined, "陌生人的列表里没有");
  assert.ok(await rowFor(admin), "管理员看得到（决策 11）");

  // ── 9. 用户目录：管理员拿得到，且只有 id/username/role ────────────────────
  assert.equal(
    (await app.request("/api/auth/directory", { headers: cookie(reader.id) })).status,
    403,
    "选人列表跟着决策 41 一起收成 admin —— 普通用户不发起共享，就没理由看账号清单",
  );
  const dir = await app.request("/api/auth/directory", { headers: cookie(admin.id) });
  assert.equal(dir.status, 200);
  const roster = (await dir.json()).users as Array<Record<string, unknown>>;
  assert.ok(roster.some((u) => u.username === "owner"));
  assert.deepEqual(
    [...new Set(roster.flatMap((u) => Object.keys(u)))].sort(),
    ["id", "role", "username"],
    "目录里不能漏出密码哈希或白名单",
  );
  assert.equal(
    (await app.request("/api/auth/directory")).status,
    401,
    "但匿名拿不到",
  );

  console.log("sharing.test.ts: all assertions passed");
} finally {
  closeDb();
  for (const k of [
    "CC_WEBUI_DB",
    "CC_WEBUI_COOKIE_SECRET_FILE",
    "CC_WEBUI_GROUPS_DIR",
    "CC_WEBUI_SESSION_INDEX",
    "CODEX_SESSIONS_DIR",
    "CC_WEBUI_CLAUDE_PROJECTS_DIR",
    "CC_WEBUI_WORKSPACES_DIR",
    "CC_WEBUI_DOTENV",
  ]) {
    delete process.env[k];
  }
  await fs.rm(tmp, { recursive: true, force: true });
}
