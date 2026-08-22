import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { chat } from "./chat.ts";
import { codexChat } from "./codex-chat.ts";
import { fsRoute } from "./fs.ts";
import { sessionsRoute } from "./sessions.ts";
import { uploadRoute } from "./upload.ts";
import { metaRoute } from "./meta.ts";
import { permissionRoute } from "./permission.ts";
import { bashTasksRoute } from "./bash-tasks.ts";
import { mcpBashRoute } from "./mcp-bash-route.ts";
import { groups } from "./groups.ts";
import { feishu } from "./feishu/index.ts";
import { groupsEnabled } from "./features.ts";
import { importLegacyJson } from "./import-legacy-json.ts";
import { loadDotEnvOnce } from "./env.ts";
import { authRoutes } from "./auth-routes.ts";
import { countUsers, seedAdminFromEnv } from "./auth/users.ts";

const app = new Hono();

app.route("/api/auth", authRoutes);
app.route("/api", chat);
app.route("/api/codex", codexChat);
// Group chat is opt-in (CC_WEBUI_GROUPS_ENABLED). The web group UI is the only
// consumer of this route — Feishu drives the session engine through direct
// imports — so leaving it unmounted removes the whole web group surface.
if (groupsEnabled()) {
  app.route("/api/groups", groups);
}
app.route("/api/fs", fsRoute);
app.route("/api/sessions", sessionsRoute);
app.route("/api/upload", uploadRoute);
app.route("/api/permission", permissionRoute);
app.route("/api/meta", metaRoute);
app.route("/api/bash/tasks", bashTasksRoute);
app.route("/api/mcp", mcpBashRoute);
app.route("/feishu", feishu);

// .env first: it carries CC_WEBUI_ADMIN and the Feishu credentials, and
// everything below reads config.
loadDotEnvOnce();

// Move the flat JSON stores into SQLite before anything serves a request, so
// no handler can observe a half-migrated state.
await importLegacyJson();

// Seed the first admin if CC_WEBUI_ADMIN is set and that account is absent.
seedAdminFromEnv();

const isProd = process.env.NODE_ENV === "production";
if (isProd) {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("/*", async (c) => {
    const html = await (await import("node:fs/promises")).readFile(
      "./dist/index.html",
      "utf-8"
    );
    return c.html(html);
  });
}

const port = Number(process.env.PORT) || 8787;
const viteDevPort = Number(process.env.VITE_DEV_PORT) || 8787;
// Bind explicitly to IPv4 loopback by default. Without `hostname`, Node's
// listen() binds to `::` on dual-stack systems, which can mismatch with
// clients that resolve `localhost` to `127.0.0.1` (or vice versa). Set
// CC_WEBUI_HOST=0.0.0.0 to expose on LAN.
const host = process.env.CC_WEBUI_HOST ?? "127.0.0.1";

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  const url = isProd
    ? `http://${host}:${info.port}`
    : `http://${host}:${info.port} (api only; web on vite http://${host}:${viteDevPort})`;
  console.log(`[cc-webui] ${isProd ? "serving" : "api"} at ${url}`);
  console.log(
    groupsEnabled()
      ? "[cc-webui] groups: enabled"
      : "[cc-webui] groups: disabled (set CC_WEBUI_GROUPS_ENABLED=1 to enable)",
  );
  // Authentication is not enforced yet — the primitives exist, the middleware
  // that rejects anonymous requests lands with the route-by-route
  // authorization pass. Say so plainly rather than letting the presence of a
  // login endpoint imply the API is protected.
  const users = countUsers();
  console.log(
    users === 0
      ? "[cc-webui] auth: no users yet (set CC_WEBUI_ADMIN=user:pass to seed an admin) — API is OPEN"
      : `[cc-webui] auth: ${users} user(s); enforcement NOT yet enabled — API is OPEN`,
  );
});
