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
import { projectMemoryRoute } from "./project-memory-routes.ts";
import { mcpMemoryRoute } from "./mcp-memory-route.ts";
import { memoryRoute } from "./memory-routes.ts";
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
  app.route("/api/memory", memoryRoute);
  app.route("/api/project-memory", projectMemoryRoute);
  app.route("/api/mcp", mcpMemoryRoute);
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
    // ⚠️ **故意不把 fullscreen 委派给跨源 iframe。** 这一条是「PPT 放映按一下 Esc
    // 就退出」的全部实现，别当成安全加固删掉：
    //   · Fullscreen API 的 Esc 是**浏览器吞掉**的，页面收不到那次 keydown ⇒ 只要
    //     ONLYOFFICE 进了浏览器全屏，第一下 Esc 只能退全屏，放映还开着（它自己的
    //     快捷键文档原话：第一下退全屏、第二下才退放映）。
    //   · 而 ONLYOFFICE 的放映器**从不自动进全屏**（DocumentPreview.js 的 show()
    //     里没有 requestFullscreen，唯一入口是那颗 ⛶ 按钮），并且
    //     `setMode()` 里写着 `!document.fullscreenEnabled` 就把那颗按钮整个藏掉。
    //   ⇒ 把 fullscreen 收回 self，iframe 里那颗按钮自动消失，放映永远在页面内跑，
    //     Esc 直达放映器，一下就回编辑视图。
    //
    // `self` 那一半是留给**我们自己的元素**的（同源的 PDF iframe 也在这一档里），
    // 右侧格那颗「放映」就吃这一半：它把整个文档栏 requestFullscreen，ONLYOFFICE 在
    // 一块全屏的画布里跑，而 iframe 自己依然进不了全屏、⛶ 依然不出现。
    // ⚠️ 代价是放映那一档 Esc 要按两下（第一下退我们的全屏、第二下退放映器），
    //    这是**知情选择**——用户 2026-09-20 的原话是「放映没有全屏啊」。不想付这个
    //    代价就用「最大化」+ 浏览器自己的 F11 / ⌃⌘F，那两个不是 Fullscreen API、
    //    不吃 Esc，仍然是一下。
    app.use("/*", async (c, next) => {
      await next();
      if ((c.res.headers.get("content-type") ?? "").includes("text/html")) {
        c.header("Permissions-Policy", "fullscreen=(self)");
      }
    });

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
