// 决策 12 的安全网：**bypass 只给管理员**。
//
// 为什么值得一个测试：bypass 不是「少弹几张卡」，它是唯一一个让 CLI 连
// canUseTool 都不调的 mode —— 权限卡不弹，`auto` 那个安全分类器也不跑
// （实测：分类器只在「需要确认」时才回到 host，bypass 下这条路整个不存在）。
// 而这条规则**不在 policy.ts 那张表里**（它看的是 body 里的一个值，不是路由），
// 所以 policy.test.ts 覆盖不到它：忘了这个 if，没有任何测试会变红。
//
// 走真实 app.request()：中间件 + handler 一起过。

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = path.join(os.tmpdir(), `cc-webui-bypass-test-${Date.now()}`);
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CC_WEBUI_COOKIE_SECRET_FILE = path.join(tmp, "cookie-secret");
process.env.CC_WEBUI_GROUPS_DIR = path.join(tmp, "groups");
process.env.CC_WEBUI_SESSION_INDEX = path.join(tmp, "sessions.json");
process.env.CODEX_SESSIONS_DIR = path.join(tmp, "codex-empty");
process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR = path.join(tmp, "claude-projects");
process.env.CC_WEBUI_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CC_WEBUI_DOTENV = path.join(tmp, "empty.env");
process.env.CC_WEBUI_GROUPS_ENABLED = "1"; // 群聊那两条路由要挂上才测得到
const work = path.join(tmp, "work");
await fs.mkdir(work, { recursive: true });
await fs.writeFile(path.join(tmp, "empty.env"), "");

const { closeDb } = await import("../db.ts");
const { createApp } = await import("../app.ts");
const { createUser } = await import("./users.ts");
const { issueSession, SESSION_COOKIE } = await import("./session.ts");
const { usesBypass } = await import("../groups/config.ts");

try {
  const app = createApp();
  const cookie = (id: string) => ({ cookie: `${SESSION_COOKIE}=${issueSession(id)}` });
  const user = createUser({
    username: "plain",
    password: "x",
    role: "user",
    allowedPaths: [work + "/**"],
  });
  const admin = createUser({
    username: "root",
    password: "x",
    role: "admin",
    allowedPaths: ["**"],
  });

  const chat = (id: string, permissionMode: string) =>
    app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookie(id) },
      body: JSON.stringify({ prompt: "hi", cwd: work, permissionMode }),
    });

  // ── 1. 普通账号点 bypass：403，且理由说得出口 ────────────────────────────
  //
  // cwd 给的是他白名单里的目录，所以 403 只可能来自 mode 检查——不是路径中间件。
  {
    const res = await chat(user.id, "bypassPermissions");
    assert.equal(res.status, 403, "普通账号必须被拒");
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail), /管理员/, "403 要说清是为什么，不是一句 forbidden");
  }

  // ⚠️ 这里**故意不**测「管理员发 bypass 会 200」：那条路径真的会去 spawn 一个
  // claude 子进程。管理员那一侧交给下面的群聊路由验，它不 spawn 任何东西。

  // ── 2. 大小写/别名不算数：只有精确值触发，其它值走各自的既有逻辑 ────────
  //
  // ALLOWED_MODES 之外的字符串会被丢成 undefined（＝ CLI 默认），所以
  // "BYPASSPERMISSIONS" 不该被当成 bypass 放行，也不该被当成 bypass 拒绝——
  // 它应该根本不是一个 mode。这一条钉的是「别为了保险改成 toLowerCase 匹配」。
  assert.equal(usesBypass([{ mode: "BYPASSPERMISSIONS" } as never]), false);
  assert.equal(usesBypass([{ mode: "bypassPermissions" } as never]), true);
  assert.equal(usesBypass([{ mode: "auto" } as never, { mode: "default" } as never]), false);

  // ── 3. 群聊 config：普通账号改不出 bypass，管理员可以 ────────────────────
  const mk = async (ownerId: string) => {
    const res = await app.request("/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookie(ownerId) },
      body: JSON.stringify({ title: "t", cwd: work }),
    });
    assert.equal(res.status, 200);
    return ((await res.json()) as { id: string }).id;
  };
  const patch = (id: string, who: string, mode: string) =>
    app.request(`/api/groups/${id}/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...cookie(who) },
      body: JSON.stringify({
        // pipeline 要跟着一起改，否则 validateConfig 先炸（长度必须一致）。
        participants: [{ id: "claude", model: "opus", mode, skills: [], mcpServers: [] }],
        pipeline: ["claude"],
      }),
    });

  const own = await mk(user.id);
  assert.equal((await patch(own, user.id, "bypassPermissions")).status, 403);
  // 控制组：同一个 PATCH 换个 mode 就过得去，证明 403 不是别的原因。
  assert.equal((await patch(own, user.id, "auto")).status, 200);

  const mine = await mk(admin.id);
  assert.equal((await patch(mine, admin.id, "bypassPermissions")).status, 200);

  console.log("bypass-mode.test.ts ok");
} finally {
  closeDb();
  await fs.rm(tmp, { recursive: true, force: true });
}
