// 管理员给账号设默认模型 / effort（docs/user-permissions.md 决策 45-47）。
//
// 走真实的 app.request()：policy（只有管理员能改）+ 校验 + 存储 + /me 下发
// 一起过。浏览器那一半（「每一版只套用一次」）在 src/lib/user-defaults.test.ts。

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = path.join(os.tmpdir(), `cc-webui-admin-defaults-test-${Date.now()}`);
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

const { closeDb } = await import("./db.ts");
const { createApp } = await import("./app.ts");
const { createUser, deleteUser, getUserDefaults } = await import("./auth/users.ts");
const { issueSession, SESSION_COOKIE } = await import("./auth/session.ts");

try {
  const app = createApp();
  const cookie = (id: string) => ({ cookie: `${SESSION_COOKIE}=${issueSession(id)}` });
  const admin = createUser({
    username: "root",
    password: "x",
    role: "admin",
    allowedPaths: ["**"],
  });
  const member = createUser({
    username: "member",
    password: "pw",
    role: "user",
    allowedPaths: [],
  });

  const patch = (who: string, target: string, body: unknown) =>
    app.request(`/api/admin/users/${target}`, {
      method: "PATCH",
      headers: { ...cookie(who), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const me = async (who: string) =>
    (await app.request("/api/auth/me", { headers: cookie(who) })).json();
  const defaultsOf = async (who: string) => (await me(who)).defaults;

  // ── 1. 没设 → null ────────────────────────────────────────────────────────
  assert.equal(await defaultsOf(member.id), null, "nothing set yet");

  // ── 2. 设上：/me、管理列表、登录响应都带着它，且有版本号 ──────────────────
  let res = await patch(admin.id, member.id, {
    defaults: { model: "claude-opus-5", effort: "medium" },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.defaults.model, "claude-opus-5", "PATCH echoes it");

  const d1 = await defaultsOf(member.id);
  assert.equal(d1.model, "claude-opus-5");
  assert.equal(d1.effort, "medium");
  assert.equal(typeof d1.updatedAt, "number", "the browser keys on this");

  const list = await (
    await app.request("/api/admin/users", { headers: cookie(admin.id) })
  ).json();
  const row = list.users.find((u: { id: string }) => u.id === member.id);
  assert.equal(row.defaults.effort, "medium", "the admin page shows what is saved");

  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "member", password: "pw" }),
  });
  assert.equal(login.status, 200);
  assert.equal(
    (await login.json()).defaults.model,
    "claude-opus-5",
    "a fresh login must apply it without waiting for a reload",
  );

  // ── 3. 再保存（哪怕值一样）版本号也必须往前走 ─────────────────────────────
  //
  // 浏览器靠「和上次套用的版本不一样」决定要不要再套用。版本不动的话，管理员
  // 想把对方拉回默认值时点保存会毫无反应。连着两次保存可能落在同一毫秒里。
  await patch(admin.id, member.id, { defaults: { model: "claude-opus-5", effort: "medium" } });
  const d2 = await defaultsOf(member.id);
  await patch(admin.id, member.id, { defaults: { model: "claude-opus-5", effort: "medium" } });
  const d3 = await defaultsOf(member.id);
  assert.ok(d2.updatedAt > d1.updatedAt, "re-save moves the version");
  assert.ok(d3.updatedAt > d2.updatedAt, "even within one millisecond");

  // ── 4. 校验：只收输入框里真能选到的组合 ───────────────────────────────────
  const rejected: Array<[unknown, string]> = [
    [{ model: "claude-opus-9" }, "unknown model"],
    [{ model: "gpt-5.5" }, "a Codex model is not a Claude default"],
    [{ model: "sonnet", effort: "xhigh" }, "Sonnet has no xhigh"],
    [{ model: "claude-sonnet-4-6", effort: "xhigh" }, "nor does the pinned Sonnet 4.6"],
    [{ effort: "bogus" }, "unknown effort"],
    ["opus", "not an object"],
  ];
  for (const [bad, why] of rejected) {
    const r = await patch(admin.id, member.id, { defaults: bad });
    assert.equal(r.status, 400, why);
  }
  assert.equal(
    (await patch(admin.id, member.id, {
      defaults: { model: "claude-opus-4-8", effort: "xhigh" },
    })).status,
    200,
    "pinned Opus 4.8 does have xhigh — family, not id, decides",
  );

  // ── 5. 校验失败时，同一个请求里的别的改动一个都不能落地 ─────────────────
  res = await patch(admin.id, member.id, { role: "admin", defaults: { model: "nope" } });
  assert.equal(res.status, 400);
  assert.equal((await me(member.id)).user.role, "user", "role change must not half-apply");

  // ── 6. 只设一项；"" 等于没设 ─────────────────────────────────────────────
  await patch(admin.id, member.id, { defaults: { model: null, effort: "high" } });
  let d = await defaultsOf(member.id);
  assert.equal(d.model, null);
  assert.equal(d.effort, "high");

  await patch(admin.id, member.id, { defaults: { model: "", effort: "low" } });
  d = await defaultsOf(member.id);
  assert.equal(d.model, null, "an empty select means not set");

  // ── 7. 两项都清空 → 回到「没设」（删行，只有一种写法） ────────────────────
  await patch(admin.id, member.id, { defaults: { model: null, effort: null } });
  assert.equal(await defaultsOf(member.id), null);

  // ── 8. 普通用户改不了，连自己的也不行 ────────────────────────────────────
  res = await patch(member.id, member.id, { defaults: { model: "haiku" } });
  assert.equal(res.status, 403, "the admin surface stays admin-only");
  assert.equal(await defaultsOf(member.id), null);

  // ── 9. 不带 defaults 的 PATCH 不碰它 ─────────────────────────────────────
  await patch(admin.id, member.id, { defaults: { model: "opus", effort: "medium" } });
  await patch(admin.id, member.id, { password: "pw2" });
  assert.equal((await defaultsOf(member.id)).model, "opus", "a password reset keeps defaults");

  // ── 10. 销号时跟着走 ─────────────────────────────────────────────────────
  deleteUser(member.id);
  assert.equal(getUserDefaults(member.id), null, "ON DELETE CASCADE");
} finally {
  closeDb();
  await fs.rm(tmp, { recursive: true, force: true });
}
