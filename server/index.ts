import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { chat } from "./chat.ts";
import { fsRoute } from "./fs.ts";
import { sessionsRoute } from "./sessions.ts";
import { uploadRoute } from "./upload.ts";
import { metaRoute } from "./meta.ts";
import { permissionRoute } from "./permission.ts";

const app = new Hono();

app.route("/api", chat);
app.route("/api/fs", fsRoute);
app.route("/api/sessions", sessionsRoute);
app.route("/api/upload", uploadRoute);
app.route("/api/permission", permissionRoute);
app.route("/api/meta", metaRoute);

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

serve({ fetch: app.fetch, port }, (info) => {
  const url = isProd
    ? `http://localhost:${info.port}`
    : `http://localhost:${info.port} (api only; web on vite http://localhost:5173)`;
  console.log(`[cc-webui] ${isProd ? "serving" : "api"} at ${url}`);
});
