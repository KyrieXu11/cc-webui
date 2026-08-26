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
  app.route("/feishu", feishu);

  if (opts.serveDist) {
    app.use("/*", serveStatic({ root: "./dist" }));
    app.get("/*", async (c) => {
      const html = await (await import("node:fs/promises")).readFile(
        "./dist/index.html",
        "utf-8",
      );
      return c.html(html);
    });
  }

  return app;
}
