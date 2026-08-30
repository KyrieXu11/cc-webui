#!/usr/bin/env node
// 人工验证脚本 —— **不在 `npm test` 里**，因为它真的 spawn `claude` CLI
// （本仓库的测试约定明确禁止这么做：claude-executor.test.ts 只测 argv 构造，
// contract.test.ts 头一句就是「Interface-only test: no CLI is spawned」）。
//
// 它验的是 e2e.test.ts **验不到**的那一半：真实的 claude CLI 的 MCP 客户端，
// 到底认不认我们这条中继路由的响应。
//
// 背景：server/mcp-local-route.ts 是**纯 JSON-RPC 透传**，没有用 MCP SDK 的
// WebStandardStreamableHTTPServerTransport（理由见那个文件的头注释）。这意味着
// 我们自己承担了 Streamable HTTP 的契约：请求回 application/json、通知回 202、
// GET 回 405、不发 Mcp-Session-Id。这些**都是按规范推的，没被真实客户端验证过** ——
// 如果哪一条推错了，表现是家人机器上的工具在真机上一个都不出现，而单元测试全绿。
//
// 用法：
//   node scripts/verify-local-mcp.mjs
//
// 它会：起一个临时服务端 → 连一台假设备（跑一个真的、最小的 stdio MCP server）
// → 用真实 CLI 起一个 turn，逼它调用那个工具 → 检查工具是否真的被调到。

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-webui-verify-"));
process.env.CC_WEBUI_DB = path.join(tmp, "verify.db");
process.env.CC_WEBUI_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CC_WEBUI_COOKIE_SECRET_FILE = path.join(tmp, "cookie-secret");

const { closeDb } = await import("../server/db.ts");
const { createUser } = await import("../server/auth/users.ts");
const { issueSession } = await import("../server/auth/session.ts");
const { SESSION_COOKIE_NAME } = await import("../server/devices/protocol.ts");
const registry = await import("../server/devices/registry.ts");
const { setLocalMcpServers } = await import("../server/devices/store.ts");
const { createDeviceWs } = await import("../server/devices/ws.ts");
const { mcpLocalRoute } = await import("../server/mcp-local-route.ts");
const { registerMcpSessionContext } = await import("../server/mcp-context.ts");
const { McpHost } = await import("../desktop/src/mcp-host.ts");
const { DeviceClient } = await import("../desktop/src/ws-client.ts");
const { Hono } = await import("hono");
const { serve } = await import("@hono/node-server");

// ── 一个**真的**最小 MCP server（stdio），会把每次 tools/call 记进一个文件 ──
const MARKER = path.join(tmp, "called.txt");
const MCP_SERVER = path.join(tmp, "mcp-server.mjs");
await fs.writeFile(
  MCP_SERVER,
  `import { appendFileSync } from "node:fs";
const MARKER = ${JSON.stringify(MARKER)};
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");

process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") {
      reply(m.id, {
        protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "verify-echo", version: "0.0.1" },
      });
    } else if (m.method === "tools/list") {
      reply(m.id, {
        tools: [
          {
            name: "family_machine_ping",
            description:
              "Runs on the USER'S OWN COMPUTER. Returns a magic word proving the local device was reached.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      });
    } else if (m.method === "tools/call") {
      appendFileSync(MARKER, m.params?.name + "\\n");
      reply(m.id, { content: [{ type: "text", text: "PONG-FROM-FAMILY-MACHINE" }] });
    } else if (m.id !== undefined && m.id !== null) {
      reply(m.id, {});
    }
  }
});
`,
  "utf8",
);

let httpServer = null;
let apiServer = null;
let client = null;
let host = null;
let failed = false;

const log = (...a) => console.log("[verify]", ...a);

try {
  const user = createUser({
    username: "verifyuser",
    password: "pw-" + randomUUID(),
    role: "admin", // admin 的白名单是 ** —— 这个脚本要跑真 CLI，别被路径护栏挡住
  });
  setLocalMcpServers(user.id, [
    { name: "probe", command: process.execPath, args: [MCP_SERVER] },
  ]);

  // ── 起服务端（真的 HTTP + 真的 WS，端口 0）──────────────────────────────
  const deviceWs = createDeviceWs();
  const app = new Hono();
  app.route("/api/mcp", mcpLocalRoute);
  apiServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => apiServer.once("listening", r));
  const apiPort = apiServer.address().port;

  httpServer = createServer();
  httpServer.on("upgrade", (req, socket, head) => {
    if (deviceWs.handleUpgrade(req, socket, head)) return;
    socket.destroy();
  });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const wsPort = httpServer.address().port;
  log(`api on :${apiPort}, device ws on :${wsPort}`);

  // ── 连一台假设备 ─────────────────────────────────────────────────────────
  let clientRef = null;
  host = new McpHost({
    defaultCommand: process.execPath,
    onMessage: (s, p) => clientRef?.handleServerMessage(s, p),
    onExit: (s) => clientRef?.handleServerExit(s),
  });
  client = new DeviceClient({
    baseUrl: `http://127.0.0.1:${wsPort}`,
    cookie: () => `${SESSION_COOKIE_NAME}=${issueSession(user.id)}`,
    deviceId: "verify-device",
    label: "验证用的假机器",
    clientVersion: "0.0.0",
    host,
  });
  clientRef = client;
  client.start();

  const deadline = Date.now() + 15_000;
  while (registry.availableServers(user.id).length === 0) {
    if (Date.now() > deadline) throw new Error("device never became ready");
    await new Promise((r) => setTimeout(r, 50));
  }
  log("device ready:", registry.availableServers(user.id));

  // ── 用**真实 CLI** 起一个 turn ───────────────────────────────────────────
  const token = randomUUID();
  registerMcpSessionContext({ token, sessionId: "verify", ownerId: user.id });

  const mcpConfig = JSON.stringify({
    mcpServers: {
      "local-probe": {
        type: "http",
        url: `http://127.0.0.1:${apiPort}/api/mcp/local/probe`,
        headers: { authorization: `Bearer ${token}` },
      },
    },
  });

  const args = [
    "-p",
    "Call the mcp__local-probe__family_machine_ping tool exactly once, then reply with only the text it returned. Do not do anything else.",
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    mcpConfig,
    "--strict-mcp-config",
    "--permission-mode",
    "bypassPermissions",
    "--model",
    "haiku",
  ];

  log("spawning real claude CLI…");
  const out = await new Promise((resolve, reject) => {
    const proc = spawn("claude", args, {
      cwd: tmp,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (c) => (stdout += c));
    proc.stderr.on("data", (c) => (stderr += c));
    const kill = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("claude CLI timed out after 180s"));
    }, 180_000);
    proc.on("error", (e) => {
      clearTimeout(kill);
      reject(e);
    });
    proc.on("exit", (code) => {
      clearTimeout(kill);
      resolve({ code, stdout, stderr });
    });
  });

  // ── 判定 ─────────────────────────────────────────────────────────────────
  const calls = await fs.readFile(MARKER, "utf8").catch(() => "");
  const reachedDevice = calls.includes("family_machine_ping");
  const sawResult = out.stdout.includes("PONG-FROM-FAMILY-MACHINE");

  console.log("\n" + "=".repeat(72));
  console.log(`CLI exit code            : ${out.code}`);
  console.log(`工具真的在「设备」上跑了 : ${reachedDevice ? "✅ 是" : "❌ 否"}`);
  console.log(`结果回到了 CLI           : ${sawResult ? "✅ 是" : "❌ 否"}`);
  console.log("=".repeat(72));

  if (!reachedDevice || !sawResult) {
    failed = true;
    console.log("\n--- CLI stderr（前 4000 字）---");
    console.log(out.stderr.slice(0, 4000));
    console.log("\n--- CLI stdout（前 4000 字）---");
    console.log(out.stdout.slice(0, 4000));
    console.log(
      "\n如果工具压根没出现在模型的工具表里，最可能的原因是中继的 Streamable HTTP " +
        "契约推错了（见本文件头注释）。先看 stderr 里有没有 MCP 连接失败的行。",
    );
  } else {
    console.log(
      "\n✅ 整条链在**真实 CLI** 下走通了：CLI → /api/mcp/local/probe → WS → 设备 → stdio 子进程。",
    );
  }
} catch (err) {
  failed = true;
  console.error("[verify] 失败：", err);
} finally {
  client?.stop();
  await host?.stopAll();
  registry.resetForTests();
  await new Promise((r) => (httpServer ? httpServer.close(r) : r()));
  apiServer?.close();
  closeDb();
  await fs.rm(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
