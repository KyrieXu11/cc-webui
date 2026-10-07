import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadDotEnvOnce } from "./env.ts";
import { importLegacyJson } from "./import-legacy-json.ts";
import { startFeishuChannels } from "./feishu/index.ts";
import { countUsers, seedAdminFromEnv } from "./auth/users.ts";
import { groupsEnabled, projectMemoryEnabled } from "./features.ts";
import { recoverMemoryFiles } from "./project-memory/store.ts";
import { MEMORY_PROMPT_VERSION } from "./project-memory/prompt.ts";
import { createDeviceWs, DEVICE_WS_PATH } from "./devices/ws.ts";
import { claudeExecutor } from "./executors/claude-executor.ts";
import { codexExecutor, CODEX_JSON_FLAG } from "./executors/codex-executor.ts";

// .env first: it carries CC_WEBUI_ADMIN and the Feishu credentials, and
// everything below reads config.
loadDotEnvOnce();
if (projectMemoryEnabled()) await recoverMemoryFiles();

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

// 桌面客户端的 WebSocket 端点（docs/desktop-client.md）。
//
// ⚠️ 它**只能**起在这里，不能起在 app.ts —— 那个文件有「零 import 期副作用」的
// 硬约束（policy.test.ts 会 import 它 4 次，任何 import 期的监听/外连都会在跑
// 测试时真的发生）。
//
// ⚠️ upgrade 事件在 Hono 之前被 node 的 http.Server 截走，所以这条通道**完全
// 绕开 authMiddleware**：没有 policy 条目，policy.test.ts 也看不见它。
// cookie 校验在 server/devices/ws.ts 里手写，钉住它的是 devices/ws.test.ts。
const deviceWs = createDeviceWs();

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  const url = isProd
    ? `http://${host}:${info.port}`
    : `http://${host}:${info.port} (api only; web on vite http://${host}:${viteDevPort})`;
  console.log(`[cc-webui] ${isProd ? "serving" : "api"} at ${url}`);
  console.log(
    groupsEnabled()
      ? "[cc-webui] groups: enabled"
      : "[cc-webui] groups: disabled (set CC_WEBUI_GROUPS_ENABLED=1 to enable)",
  );
  console.log(`[cc-webui] project memory: ${projectMemoryEnabled() ? "enabled" : "disabled"} (prompt=${MEMORY_PROMPT_VERSION})`);
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
  console.log(`[cc-webui] devices: ws endpoint at ${DEVICE_WS_PATH}`);
  // ⚠️ 这两行不是装饰。两个 CLI 的控制协议 / JSON 事件流**没有版本协商、没有
  // 文档**（docs/cli-migration.md「控制协议」「模型」两节），所以 CLI 自动更新
  // 把权限卡、MCP 或事件形状改坏时，日志里这一行是唯一的线索 —— 这正是
  // Executor.describe() 存在的理由。`codex exec --experimental-json` 连
  // `--help` 里都没有，一并打出来。
  void Promise.all([claudeExecutor.describe(), codexExecutor.describe()]).then(
    ([claude, codex]) => {
      console.log(`[cc-webui] claude cli: ${claude.version} (${claude.bin})`);
      console.log(
        `[cc-webui] codex cli: ${codex.version} (${codex.bin}, ${CODEX_JSON_FLAG})`,
      );
    },
  );
});

// 反代那侧这条 location 需要 Upgrade / Connection 头 + 够长的 proxy_read_timeout，
// 否则长连接会被 nginx 默认的 60s 读超时切掉。见 server/devices/ws.ts 文件头。
server.on("upgrade", (req, socket, head) => {
  if (deviceWs.handleUpgrade(req, socket, head)) return;
  // ⚠️ 注册了 'upgrade' 监听器之后，node **不再**销毁无人处理的 upgrade 请求。
  // 不自己关的话，打到任何其它路径的 upgrade 会留下一条既无响应、也不 close、
  // 也没有超时的 TCP 连接 —— 一个端口扫描器就能把 fd 攒满。
  socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  socket.destroy();
});
