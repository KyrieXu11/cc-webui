import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadDotEnvOnce } from "./env.ts";
import { importLegacyJson } from "./import-legacy-json.ts";
import { startFeishuChannels } from "./feishu/index.ts";
import { countUsers, seedAdminFromEnv } from "./auth/users.ts";
import { groupsEnabled } from "./features.ts";

// .env first: it carries CC_WEBUI_ADMIN and the Feishu credentials, and
// everything below reads config.
loadDotEnvOnce();

// Move the flat JSON stores into SQLite before anything serves a request, so
// no handler can observe a half-migrated state.
await importLegacyJson();

// Seed the first admin if CC_WEBUI_ADMIN is set and that account is absent.
seedAdminFromEnv();

// Connect the Feishu bots. An explicit call, not an import side effect — see
// server/feishu/index.ts.
const bots = startFeishuChannels();

const isProd = process.env.NODE_ENV === "production";
const app = createApp({ serveDist: isProd });

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
  const users = countUsers();
  console.log(
    users === 0
      ? "[cc-webui] auth: no users yet — set CC_WEBUI_ADMIN=user:pass and restart, " +
          "otherwise nothing can log in"
      : `[cc-webui] auth: enforcing, ${users} user(s)`,
  );
  if (bots > 0) {
    console.log(`[cc-webui] feishu: ${bots} bot(s) connected`);
  }
});
