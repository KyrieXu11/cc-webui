// 端到端：把整条链真的跑一遍。
//
//   app.request(/api/mcp/local/echo)        ← 站在 claude CLI 的位置
//     → mcp-local-route（纯 JSON-RPC 透传）
//       → registry
//         → 真的 WebSocket（listen(0) 的 http.Server + upgrade handler）
//           → desktop/src/ws-client.ts        ← 真的客户端代码
//             → desktop/src/mcp-host.ts
//               → 一个真的 stdio 子进程
//
// 其余测试文件各测一段；只有这个文件能抓到**接缝**上的错 —— 信封 id 和 JSON-RPC
// id 的对照、ready 的时序、cookie 在 upgrade 上到底能不能过。
//
// ⚠️ 这个文件 import 了 desktop/src/*。那两个模块**刻意不 import electron**
// （见它们的文件头），所以这里能直接用，根 tsconfig 也能 typecheck 它们。
// 哪天有人往 ws-client.ts 里加了 electron import，这个测试会第一个炸 —— 那是
// 特性不是缺陷，因为那也意味着客户端的核心逻辑从此无法在 CI 里测。
//
// ⚠️ listen(0)：测试文件是并行跑的，固定端口会随机撞车。

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";

// ── ① env 必须早于任何被测模块求值 ─────────────────────────────────────────
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-webui-e2e-"));
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CC_WEBUI_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CC_WEBUI_COOKIE_SECRET_FILE = path.join(tmp, "cookie-secret");

// ── ② 动态 import ──────────────────────────────────────────────────────────
const { closeDb } = await import("../db.ts");
const { createUser } = await import("../auth/users.ts");
const { issueSession, SESSION_COOKIE } = await import("../auth/session.ts");
const registry = await import("./registry.ts");
const { setLocalMcpServers } = await import("./store.ts");
const { createDeviceWs, DEVICE_WS_PATH } = await import("./ws.ts");
const { mcpLocalRoute } = await import("../mcp-local-route.ts");
const { authRoutes } = await import("../auth-routes.ts");
const { registerMcpSessionContext, unregisterMcpSessionContext } = await import(
  "../mcp-context.ts"
);
const { McpHost } = await import("../../desktop/src/mcp-host.ts");
const { DeviceClient } = await import("../../desktop/src/ws-client.ts");

// 一个最小的 stdio MCP server：换行分隔的 JSON-RPC，把 method 回显回去。
// 真实的 MCP server（playwright 等）在协议层和它一模一样。
const ECHO = path.join(tmp, "echo-server.mjs");
await fs.writeFile(
  ECHO,
  `process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined || msg.id === null) {
      // notification：故意不回，这正是 expectsReply=false 该有的行为
      process.stderr.write("got notification " + msg.method + "\\n");
      continue;
    }
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echoed: msg.method, params: msg.params ?? null } }) + "\\n",
    );
  }
});
`,
  "utf8",
);

let http: ReturnType<typeof createServer> | null = null;
let client: InstanceType<typeof DeviceClient> | null = null;
let host: InstanceType<typeof McpHost> | null = null;
let token: string | null = null;

try {
  // ── 起服务端 ─────────────────────────────────────────────────────────────
  const user = createUser({
    username: "family",
    password: "pw-for-tests",
    role: "user",
  });
  setLocalMcpServers(user.id, [
    { name: "echo", command: process.execPath, args: [ECHO] },
  ]);

  const deviceWs = createDeviceWs();
  http = createServer();
  http.on("upgrade", (req, socket, head) =>
    deviceWs.handleUpgrade(req, socket, head),
  );
  await new Promise<void>((r) => http!.listen(0, "127.0.0.1", () => r()));
  const port = (http.address() as AddressInfo).port;

  const app = new Hono();
  app.route("/api/mcp", mcpLocalRoute);
  app.route("/api/auth", authRoutes);

  // ── 起客户端（真的 desktop/src 代码）─────────────────────────────────────
  const cookie = `${SESSION_COOKIE}=${issueSession(user.id)}`;
  // McpHost 要 onMessage，DeviceClient 要 host —— 互相依赖，用一个可变引用打破。
  let clientRef: InstanceType<typeof DeviceClient> | null = null;
  host = new McpHost({
    defaultCommand: process.execPath,
    onMessage: (server, payload) =>
      clientRef?.handleServerMessage(server, payload),
    onExit: (server) => clientRef?.handleServerExit(server),
  });
  client = new DeviceClient({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: () => cookie,
    deviceId: "device-under-test",
    label: "家里的台式机",
    clientVersion: "0.0.0-test",
    host,
  });
  clientRef = client;
  client.start();

  // 等 ready。轮询而不是固定 sleep —— 固定 sleep 在并行跑的机器上必然 flaky。
  const deadline = Date.now() + 10_000;
  while (registry.availableServers(user.id).length === 0) {
    if (Date.now() > deadline) throw new Error("device never became ready");
    await new Promise((r) => setTimeout(r, 25));
  }

  // ── ③ 断言 ───────────────────────────────────────────────────────────────
  // ── 握手：设备连上来了，配置下发到了，子进程起来了 ──────────────────────
  assert.deepEqual(
    registry.availableServers(user.id),
    ["echo"],
    "服务端应当知道设备上跑着一个叫 echo 的 MCP server",
  );
  const dev = registry.connectedDevice(user.id);
  assert.equal(dev?.deviceId, "device-under-test");
  assert.equal(dev?.label, "家里的台式机");

  token = randomUUID();
  registerMcpSessionContext({
    token,
    sessionId: "s-1",
    ownerId: user.id,
  });
  const rpc = (body: unknown) =>
    app.request("/api/mcp/local/echo", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  // ── 一次完整的往返 ───────────────────────────────────────────────────────
  const res = await rpc({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/list",
    params: { cursor: "abc" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    await res.json(),
    {
      jsonrpc: "2.0",
      id: 7,
      result: { echoed: "tools/list", params: { cursor: "abc" } },
    },
    "设备的应答必须原样回到调用方，id 不能被改写",
  );

  // ── 信封 id ≠ JSON-RPC id：两个不同 id 的调用不能串线 ────────────────────
  // 这条钉的是 ws-client 里那张 `server + rpcId → envelopeId` 对照表。
  const [a, b] = await Promise.all([
    rpc({ jsonrpc: "2.0", id: 1, method: "alpha" }),
    rpc({ jsonrpc: "2.0", id: 2, method: "beta" }),
  ]);
  const [ja, jb] = (await Promise.all([a.json(), b.json()])) as Array<{
    id: number;
    result: { echoed: string };
  }>;
  assert.equal(ja.id, 1);
  assert.equal(ja.result.echoed, "alpha");
  assert.equal(jb.id, 2);
  assert.equal(jb.result.echoed, "beta");

  // ── notification：202、空体、且不会挂起 ──────────────────────────────────
  // echo server 对 notification 故意不回。如果服务端登记了 pending，这里会卡到
  // RPC_TIMEOUT_MS（5 分钟）—— 测试挂住就是回归。
  const note = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(note.status, 202, "JSON-RPC notification 必须回 202");
  assert.equal((await note.text()).length, 0, "202 不能带响应体");

  // ── 暂停（决策 8）：托盘一按，服务端立刻当这台设备不存在 ─────────────────
  client.setPaused(true);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(registry.availableServers(user.id), [], "暂停后没有可用 server");
  const paused = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call" });
  const jp = (await paused.json()) as {
    result?: { isError?: boolean; content?: Array<{ text: string }> };
  };
  assert.equal(paused.status, 200);
  assert.equal(jp.result?.isError, true, "tools/call 要回 isError 的 result，不是 JSON-RPC error");
  assert.ok(
    jp.result?.content?.[0]?.text.includes("暂停"),
    `文案要能看出是用户暂停了，实际收到：${jp.result?.content?.[0]?.text}`,
  );
  // 设备本身还连着 —— 暂停不是断开。
  assert.ok(registry.connectedDevice(user.id), "暂停不应当断开连接");

  client.setPaused(false);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(registry.availableServers(user.id), ["echo"], "恢复后 server 回来");

  // ── 登出即断连（决策 14）────────────────────────────────────────────────
  // ⚠️ 这条必须显式做，不能指望心跳发现：session cookie 是无状态 HMAC，没有
  // 服务端 session 表，clearedSessionCookie() 只让浏览器丢掉自己那份，已建立
  // 的 WS 毫无感知。registry 心跳里的 revalidate 只查 getUserById()，那只抓
  // 得到销号，抓不到登出。
  {
    assert.ok(registry.connectedDevice(user.id), "登出之前设备应当连着");
    const res = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    assert.equal(
      registry.connectedDevice(user.id),
      undefined,
      "登出必须把这个账号的设备断开",
    );
  }
  // 客户端会自己重连（cookie 还有效）——这正是「登出不等于完整吊销」那句话的
  // 具体形态。为了让后面的掉线用例干净，这里先停掉再继续。
  client.stop();
  await new Promise((r) => setTimeout(r, 50));

  // ── 掉线：挂起的调用立即回错（决策 11），不等重连 ────────────────────────
  const gone = Date.now() + 5_000;
  while (registry.connectedDevice(user.id)) {
    if (Date.now() > gone) throw new Error("registry 没有察觉到掉线");
    await new Promise((r) => setTimeout(r, 25));
  }
  const offline = await rpc({ jsonrpc: "2.0", id: 11, method: "tools/call" });
  const jo = (await offline.json()) as {
    result?: { isError?: boolean; content?: Array<{ text: string }> };
  };
  assert.equal(jo.result?.isError, true);
  assert.ok(
    jo.result?.content?.[0]?.text.includes("没有设备连接"),
    "离线和暂停的文案要能区分开",
  );

  // 非 tools/call 的方法在设备不可用时回 JSON-RPC error，不是 isError 的 result。
  // 两者混用的话，一个 initialize 失败会被模型当成「工具返回了错误文本」并一直重试。
  const init = await rpc({ jsonrpc: "2.0", id: 12, method: "initialize" });
  const ji = (await init.json()) as { error?: { code: number } };
  assert.equal(ji.error?.code, -32001, "initialize 失败必须是 JSON-RPC error");

  console.log("e2e.test.ts: all assertions passed");
} finally {
  // ④ 收掉一切还 ref 着事件循环的东西 —— 漏一个 `npm test` 就永久挂住。
  client?.stop();
  await host?.stopAll();
  registry.resetForTests();
  if (token) unregisterMcpSessionContext(token);
  await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
  closeDb();
  delete process.env.CC_WEBUI_DB;
  delete process.env.CC_WEBUI_WORKSPACES_DIR;
  delete process.env.CC_WEBUI_COOKIE_SECRET_FILE;
  await fs.rm(tmp, { recursive: true, force: true });
}
