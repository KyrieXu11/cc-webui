// `transfer` MCP server 的端到端测试（决策 18）。
//
// 它跑在**家人的机器上**，通过 HTTP 以那个人的身份访问 cc-webui。所以这个测试
// 起的是真东西：真 HTTP server（listen(0)）、真 authMiddleware、真的
// `POST /api/upload` 和 `GET /api/fs/raw`、真的把 transfer 当子进程 spawn 起来
// 用 stdio 说 JSON-RPC。
//
// ⚠️ **最要紧的一条断言是「白名单拒绝」那条。** transfer 刻意**不自己发明任何
// 权限检查**——下载走 `GET /api/fs/raw`，而 policy.ts 给它声明了
// `paths: [{ from: "query", key: "path" }]`，由 authMiddleware 按**这个账号自己
// 的**目录白名单校验。这个判断只有在真的挂了 authMiddleware 时才成立，所以这里
// 必须挂它，不能用假身份中间件顶替（files-routes.test.ts 头部有同款警告）。
//
// ⚠️ 这里 spawn 的是 .ts 源码（`node --import tsx`），不是 desktop/dist 里那份
// esbuild 产物。测源码的理由：`npm test` 不该依赖一次构建。代价是打包配置本身
// （asarUnpack / bundledDir）测不到——那条只能在真 Windows 上验。

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const tmp = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "cc-webui-xfer-")),
);
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CC_WEBUI_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CC_WEBUI_COOKIE_SECRET_FILE = path.join(tmp, "cookie-secret");
process.env.CC_WEBUI_UPLOAD_DIR = path.join(tmp, "uploads");
process.env.CC_WEBUI_DOTENV = path.join(tmp, "empty.env");
await fs.writeFile(process.env.CC_WEBUI_DOTENV, "");

const { closeDb } = await import("../db.ts");
const { createUser } = await import("../auth/users.ts");
const { issueSession, SESSION_COOKIE } = await import("../auth/session.ts");
const { authMiddleware } = await import("../auth/middleware.ts");
const { uploadRoute } = await import("../upload.ts");
const { fsRoute } = await import("../fs.ts");

type Rpc = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };
type ToolResult = {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
};

let api: ReturnType<typeof serve> | null = null;
let child: ReturnType<typeof spawn> | null = null;

try {
  // ── 服务端：真中间件 + 真路由 ─────────────────────────────────────────────
  // 服务器上「允许这个账号碰」的一块地，以及一块**不允许**碰的。
  const serverAllowed = path.join(tmp, "server-allowed");
  const serverSecret = path.join(tmp, "server-secret");
  await fs.mkdir(serverAllowed, { recursive: true });
  await fs.mkdir(serverSecret, { recursive: true });
  await fs.writeFile(path.join(serverAllowed, "report.md"), "服务端产出的东西");
  await fs.writeFile(path.join(serverSecret, "id_rsa"), "SUPER-SECRET-KEY");

  const user = createUser({
    username: "family",
    password: "pw-for-tests",
    role: "user",
    allowedPaths: [path.join(serverAllowed, "**")],
  });
  const cookie = `${SESSION_COOKIE}=${issueSession(user.id)}`;

  const app = new Hono();
  app.use("/*", authMiddleware());
  app.route("/api/upload", uploadRoute);
  app.route("/api/fs", fsRoute);
  api = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((r) => api!.once("listening", () => r()));
  const port = (api.address() as AddressInfo).port;

  // ── 客户端：把 transfer 当子进程跑起来，用 stdio 说 JSON-RPC ──────────────
  child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(REPO, "desktop/src/servers/transfer.ts")],
    {
      cwd: REPO,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CC_WEBUI_URL: `http://127.0.0.1:${port}`,
        CC_WEBUI_COOKIE: cookie,
      },
    },
  );
  child.stderr!.setEncoding("utf8");
  const stderr: string[] = [];
  child.stderr!.on("data", (c: string) => stderr.push(c));

  // 换行分隔的 JSON-RPC —— MCP 的 stdio transport 就是这个，没有别的框架。
  let buf = "";
  const waiters = new Map<number, (v: any) => void>();
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      const w = m.id !== undefined && waiters.get(m.id);
      if (w) {
        waiters.delete(m.id);
        w(m);
      }
    }
  });

  let nextId = 1;
  const call = (method: string, params?: unknown): Promise<any> => {
    const id = nextId++;
    const msg: Rpc = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      // ⚠️ 必须有 ref 着事件循环的超时：子进程没起来的话这个 promise 永远不 settle，
      // 而 `npm test` 没有超时救你——文件会永久挂住，下一个人来查一个不存在的
      // 「句柄泄漏」。
      const t = setTimeout(
        () =>
          reject(
            new Error(
              `transfer 子进程 15 秒没回 ${method}；stderr: ${stderr.join("").slice(0, 800)}`,
            ),
          ),
        15_000,
      );
      waiters.set(id, (v) => {
        clearTimeout(t);
        resolve(v);
      });
      child!.stdin!.write(JSON.stringify(msg) + "\n");
    });
  };

  // ── 握手 ─────────────────────────────────────────────────────────────────
  const init = await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "transfer-test", version: "0" },
  });
  assert.equal(init.result?.serverInfo?.name, "cc-webui-transfer");
  child.stdin!.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );

  const list = await call("tools/list");
  assert.deepEqual(
    (list.result?.tools ?? []).map((t: { name: string }) => t.name).sort(),
    ["download_from_server", "upload_to_server"],
    "决策 18 说这两个工具是 v1 必备，不是加分项",
  );

  const toolText = (r: any): string =>
    ((r.result as ToolResult)?.content ?? []).map((c) => c.text).join("\n");

  // ── 上传：本机 → 服务端 ───────────────────────────────────────────────────
  const localFile = path.join(tmp, "local", "扫到的案例.txt");
  await fs.mkdir(path.dirname(localFile), { recursive: true });
  await fs.writeFile(localFile, "浏览器在家人机器上抓到的内容");

  const up = await call("tools/call", {
    name: "upload_to_server",
    arguments: { local_path: localFile },
  });
  assert.notEqual(
    (up.result as ToolResult)?.isError,
    true,
    `上传应当成功，实际：${toolText(up)}`,
  );
  const uploadedPath = /：(\/[^\s（]+)/.exec(toolText(up))?.[1];
  assert.ok(uploadedPath, `工具返回里应当有服务端路径，实际：${toolText(up)}`);
  assert.equal(
    await fs.readFile(uploadedPath!, "utf8"),
    "浏览器在家人机器上抓到的内容",
    "文件必须真的落在服务端",
  );

  // 不存在的本机文件要给出能看懂的错，而不是抛。
  const upMissing = await call("tools/call", {
    name: "upload_to_server",
    arguments: { local_path: path.join(tmp, "nope.txt") },
  });
  assert.equal((upMissing.result as ToolResult)?.isError, true);

  // 目录不是文件。
  const upDir = await call("tools/call", {
    name: "upload_to_server",
    arguments: { local_path: tmp },
  });
  assert.equal((upDir.result as ToolResult)?.isError, true);
  assert.match(toolText(upDir), /不是一个文件/);

  // ── 下载：服务端 → 本机 ───────────────────────────────────────────────────
  const target = path.join(tmp, "local", "取回来", "report.md");
  const down = await call("tools/call", {
    name: "download_from_server",
    arguments: {
      server_path: path.join(serverAllowed, "report.md"),
      local_path: target,
    },
  });
  assert.notEqual(
    (down.result as ToolResult)?.isError,
    true,
    `下载应当成功，实际：${toolText(down)}`,
  );
  assert.equal(
    await fs.readFile(target, "utf8"),
    "服务端产出的东西",
    "目标目录不存在时也要能建出来",
  );

  // ── ⭐ 白名单：越界路径必须被**服务端**挡住 ───────────────────────────────
  // transfer 自己不做任何路径检查（那会和服务端那套漂）。这条断言证明「靠
  // authMiddleware」这个判断是成立的——它一旦不成立，家人的 agent 就能用这个
  // 工具把服务器上任何文件搬走。
  const escapeTarget = path.join(tmp, "local", "偷到的.txt");
  const escaped = await call("tools/call", {
    name: "download_from_server",
    arguments: {
      server_path: path.join(serverSecret, "id_rsa"),
      local_path: escapeTarget,
    },
  });
  assert.equal(
    (escaped.result as ToolResult)?.isError,
    true,
    "白名单外的路径必须被拒",
  );
  assert.match(
    toolText(escaped),
    /白名单/,
    "错误文案要说清是白名单拒绝，否则模型只会看到一个 403 然后瞎猜",
  );
  await assert.rejects(
    () => fs.readFile(escapeTarget),
    "被拒的下载绝不能在本机留下文件",
  );

  console.log("transfer.test.ts: all assertions passed");
} finally {
  child?.kill("SIGKILL");
  api?.close();
  closeDb();
  for (const k of [
    "CC_WEBUI_DB",
    "CC_WEBUI_WORKSPACES_DIR",
    "CC_WEBUI_COOKIE_SECRET_FILE",
    "CC_WEBUI_UPLOAD_DIR",
    "CC_WEBUI_DOTENV",
  ]) {
    delete process.env[k];
  }
  await fs.rm(tmp, { recursive: true, force: true });
}
