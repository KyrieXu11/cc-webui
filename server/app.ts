// Builds the Hono app. No listening, no migrations, no outbound connections —
// so tests (notably server/auth/policy.test.ts) can enumerate the route table
// without starting anything.

import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { chat } from "./chat.ts";
import { codexChat } from "./codex-chat.ts";
import { fsRoute } from "./fs.ts";
import { filesRoute } from "./files-routes.ts";
import { officeRoute } from "./office.ts";
import { sessionsRoute } from "./sessions.ts";
import { uploadRoute } from "./upload.ts";
import { metaRoute } from "./meta.ts";
import { permissionRoute } from "./permission.ts";
import { bashTasksRoute } from "./bash-tasks.ts";
import { mcpBashRoute } from "./mcp-bash-route.ts";
import { mcpLocalRoute } from "./mcp-local-route.ts";
import { clientRoute } from "./client-routes.ts";
import { groups } from "./groups.ts";
import { feishu } from "./feishu/index.ts";
import { authRoutes } from "./auth-routes.ts";
import { adminRoutes } from "./admin-routes.ts";
import { groupsEnabled } from "./features.ts";
import { authMiddleware } from "./auth/middleware.ts";

export function createApp(opts: { serveDist?: boolean } = {}): Hono {
  const app = new Hono();

  // Before every route: see server/auth/policy.ts. A route with no policy entry
  // is refused, so adding one without classifying it fails loudly.
  app.use("/*", authMiddleware());

  app.route("/api/auth", authRoutes);
  app.route("/api/admin", adminRoutes);
  app.route("/api", chat);
  app.route("/api/codex", codexChat);
  // Group chat is opt-in. The web group UI is this route's only consumer —
  // Feishu drives the session engine through direct imports — so leaving it
  // unmounted removes the whole web group surface.
  if (groupsEnabled()) {
    app.route("/api/groups", groups);
  }
  app.route("/api/fs", fsRoute);
  app.route("/api/files", filesRoute);
  app.route("/api/office", officeRoute);
  app.route("/api/sessions", sessionsRoute);
  app.route("/api/upload", uploadRoute);
  app.route("/api/permission", permissionRoute);
  app.route("/api/meta", metaRoute);
  app.route("/api/bash/tasks", bashTasksRoute);
  app.route("/api/mcp", mcpBashRoute);
  // 桌面客户端的 MCP 中继（docs/desktop-client.md）。挂在 /api/mcp 前缀下是
  // 有意的：AGENTS.md 部署一节要求反代把 `/api/mcp/*` 一律 404，这条路由和
  // 那三条同性质（拿到 per-turn token 就等于一次远端执行），前缀规则自动覆盖，
  // nginx 一行都不用改。
  //
  // ⚠️ 设备自己的 WebSocket 端点**不在**这里，也不在 /api/mcp 下 —— 它必须能从
  // 公网连上，见 server/devices/ws.ts 的 DEVICE_WS_PATH。
  app.route("/api/mcp", mcpLocalRoute);
  app.route("/api/client", clientRoute);
  app.route("/feishu", feishu);

  if (opts.serveDist) {
    app.use("/*", serveStatic({ root: "./dist" }));

    // 兜底：静态文件没命中、也没有任何路由匹配。
    //
    // ⚠️ **必须用 notFound，不能注册成 `app.all("/api/*")` 路由。** 试过一次当场
    // 把整个 API 打挂：authMiddleware 是按 `c.req.matchedRoutes` 的**最后一条**
    // 非 `/*` 路由查策略的（见 auth/middleware.ts 的 targetRoute），多出来的
    // `ALL /api/*` 注册在所有真路由之后 ⇒ 每个请求都解析成它，而它没有策略条目，
    // fail-closed 于是把**所有** /api/* 一律 403（`no policy for ALL /api/*`）。
    // notFound 不进路由表，没有这个问题。
    //
    // ⚠️ `/api/*` 要回 JSON 404，不能回 index.html。踩过一次（2026-08-27）：
    // 生产进程比 dist/ 老（这里**不**跑 build，而 index.html 是每次请求现读的，
    // 所以前端能先于后端更新一整代），前端调新接口拿回一坨 HTML，屏幕上只有一句
    // `Unexpected token '<', "<!DOCTYPE ..."` —— 和真因（该 kickstart 了）毫无关系。
    app.notFound(async (c) => {
      const pathname = new URL(c.req.url).pathname;
      if (pathname.startsWith("/api/")) {
        return c.json(
          {
            error: `no such API route: ${c.req.method} ${pathname}`,
            hint: "服务端可能是旧版本（生产实例不自动重建/重启）",
          },
          404,
        );
      }
      const html = await (await import("node:fs/promises")).readFile(
        "./dist/index.html",
        "utf-8",
      );
      return c.html(html);
    });
  }

  return app;
}
