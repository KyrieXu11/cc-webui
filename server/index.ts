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

const app = new Hono();

app.route("/api", chat);
app.route("/api/codex", codexChat);
app.route("/api/fs", fsRoute);
app.route("/api/sessions", sessionsRoute);
app.route("/api/upload", uploadRoute);
app.route("/api/permission", permissionRoute);
app.route("/api/meta", metaRoute);
app.route("/api/bash/tasks", bashTasksRoute);

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
});
