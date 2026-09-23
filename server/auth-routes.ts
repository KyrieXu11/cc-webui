// Login / logout / whoami. The only routes that are reachable unauthenticated.

import { Hono } from "hono";
import {
  authenticate,
  getAllowedPaths,
  getUserDefaults,
  listUsers,
} from "./auth/users.ts";
import {
  clearedSessionCookie,
  issueSession,
  sessionCookie,
} from "./auth/session.ts";
import { identifyRequest, isSecureRequest } from "./auth/identify.ts";
import { drop as dropDevice } from "./devices/registry.ts";

const authRoutes = new Hono();

authRoutes.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    return c.json({ error: "username and password required" }, 400);
  }
  const user = authenticate(username, password);
  if (!user) {
    // Deliberately identical for "no such account" and "wrong password".
    return c.json({ error: "invalid credentials" }, 401);
  }
  c.header(
    "set-cookie",
    sessionCookie(issueSession(user.id), isSecureRequest(c)),
  );
  return c.json({
    user,
    allowedPaths: getAllowedPaths(user.id),
    defaults: getUserDefaults(user.id),
  });
});

authRoutes.post("/logout", (c) => {
  // 登出时把这个账号的桌面客户端也断开（docs/desktop-client.md 决策 14）。
  //
  // ⚠️ 必须显式做，不能指望心跳发现。session cookie 是**无状态 HMAC**，没有
  // 服务端 session 表（server/auth/session.ts 头部注释），所以
  // `clearedSessionCookie()` 只是让浏览器丢掉自己那份 —— 已经建立的 WS
  // 毫无感知，会一直活到 30 天 TTL 到期。registry 心跳里的 revalidate 只查
  // `getUserById()`，那只抓得到销号，**抓不到登出**。
  //
  // ⚠️ 这**不等于**完整的吊销：偷到 cookie 的人在别处仍然能重新连上（cookie
  // 本身还有效）。真正的吊销要一张服务端 session 表或 token 版本号，尚未做。
  // 这里兑现的是决策 14 承诺里能兑现的那一半：**这个人自己点了登出，他的机器
  // 就不再听命于服务端**。
  const user = identifyRequest(c);
  if (user) dropDevice(user.id, "signed out");
  c.header("set-cookie", clearedSessionCookie());
  return c.json({ ok: true });
});

// 200 with `user: null` rather than 401 — "nobody is logged in" is the normal
// first-load state, not an error the frontend should have to catch.
authRoutes.get("/me", (c) => {
  const user = identifyRequest(c);
  if (!user) return c.json({ user: null });
  // `defaults` rides along here rather than on its own route: it is "this
  // account's settings", and the browser already asks this on every load.
  return c.json({
    user,
    allowedPaths: getAllowedPaths(user.id),
    defaults: getUserDefaults(user.id),
  });
});

// 「共享给谁」的选人列表。**只有 id + username + role**，没有密码哈希、没有
// 白名单、没有 created_at —— 管理页面那份（GET /api/admin/users）才带那些，
// 这条是给普通用户用的，故意瘦。
//
// 为什么不复用管理接口：普通用户也能共享自己名下的会话，而他连不上 admin 面。
authRoutes.get("/directory", (c) => {
  const users = listUsers().map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
  }));
  return c.json({ users });
});

export { authRoutes };
