// `/api/mcp/local/:server` —— CLI ↔ 家人机器的 MCP 中继。
//
// 三段链路里的中间那一跳：
//   claude CLI --HTTP--> 这条路由 --WS--> 桌面客户端 --stdio--> 本地 MCP server
//
// ⚠️ 为什么这里**不用** McpServer / WebStandardStreamableHTTPServerTransport
// （其它三条 MCP 路由都用）：那套东西的用途是「在本进程里实现一个 MCP server」，
// 要先把工具一个个 register 上去。而这条路由**没有任何自己的工具** —— 工具在
// 家人的机器上，工具清单只有设备知道。用 SDK 的话得先向设备 tools/list、再动态
// 造一个 McpServer 把结果 register 一遍，等于把 JSON-RPC 解包再重新打包，
// 而且 serveMcp 的 `make` 是同步签名（mcp-bash-route.ts:547），塞不进一次 await。
//
// 所以这里是**纯 JSON-RPC 透传**：请求体原样发给设备，设备的应答原样回给 CLI。
// 这也正是设计文档决策 3「WS 只透传 MCP JSON-RPC」的字面意思。
//
// ⚠️ 鉴权和其它三条 MCP 路由同构：per-turn bearer token → McpSessionContext →
// ownerId。**解析不出 ownerId 一律拒**（fail-closed 是全仓纪律，
// mcp-bash-route.ts:397-401 是范本）。设计文档原来写的是把 token 放在路径里，
// 那和现状不符 —— 现有三条路由全部用 Authorization: Bearer，McpServerSpec 也
// 已经有 bearerToken 字段，所以这里跟现状走。

import { Hono } from "hono";
import { extractBearerToken, getMcpSessionContext } from "./mcp-context.ts";
import * as registry from "./devices/registry.ts";
import { SERVER_NAME_RE } from "./devices/protocol.ts";

const route = new Hono();

type JsonRpcId = string | number | null;
type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

/**
 * 「设备不可用」要回给模型的东西。
 *
 * ⚠️ tools/call 和其它方法**故意分开处理**：
 *   - tools/call 回一个 result + isError:true —— 这是 MCP 里「工具执行失败」的
 *     标准形状，模型见得最多、处理得最好，会自己决定放弃还是改用服务端工具。
 *   - 其它方法（initialize / tools/list）回 JSON-RPC error —— 那些是协议层失败，
 *     模型根本看不到，CLI 会把这个 MCP server 标成不可用。
 * 混用的话，一个 initialize 失败会被当成「工具返回了错误文本」，模型会一直重试。
 */
function unavailable(msg: JsonRpcMessage, reason: string) {
  const id = msg.id ?? null;
  if (msg.method === "tools/call") {
    return {
      jsonrpc: "2.0" as const,
      id,
      result: {
        content: [
          {
            type: "text",
            text: `本机工具不可用：${reason}。这台设备上的工具这一轮都用不了；如果这件事能在服务器上做，就改用服务端的工具，否则告诉用户。`,
          },
        ],
        isError: true,
      },
    };
  }
  return rpcError(id, -32001, `device unavailable: ${reason}`);
}

route.all("/local/:server", async (c) => {
  const token = extractBearerToken(c.req.header("authorization"));
  const ctx = getMcpSessionContext(token);
  if (!ctx) return c.json({ error: "unauthorized" }, 401);

  // fail-closed：token 背后没有可解析的账号，就没有「哪台设备」可言。
  const ownerId = ctx.ownerId;
  if (!ownerId) return c.json({ error: "no account for this turn" }, 403);

  const server = c.req.param("server");
  if (!SERVER_NAME_RE.test(server)) {
    return c.json({ error: "bad server name" }, 400);
  }

  const method = c.req.method;
  // MCP 的 Streamable HTTP 允许服务端不提供 GET 的 SSE 流，此时必须回 405。
  // 我们不中继设备主动发起的通知（v1 用不到，而且那需要一条按 turn 存活的 SSE）。
  if (method !== "POST") {
    return c.json({ error: "method not allowed" }, 405);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, "parse error"), 200);
  }

  if (Array.isArray(body)) {
    // MCP 2025-06-18 起去掉了 JSON-RPC 批处理。明确拒掉比装作支持强。
    return c.json(
      rpcError(null, -32600, "JSON-RPC batching is not supported"),
      200,
    );
  }
  if (!body || typeof body !== "object") {
    return c.json(rpcError(null, -32600, "invalid request"), 200);
  }

  const msg = body as JsonRpcMessage;
  // 有 id 才是 request；没有 id 的是 notification（比如握手里的
  // notifications/initialized），MCP 要求回 202 且**不能**有响应体。
  const expectsReply = msg.id !== undefined && msg.id !== null;

  const live = registry.availableServers(ownerId);
  if (!live.includes(server)) {
    const dev = registry.connectedDevice(ownerId);
    const reason = !dev
      ? "没有设备连接"
      : dev.paused
        ? "用户在托盘里暂停了本机工具"
        : `设备上没有名为 ${server} 的 MCP server（它可能启动失败了）`;
    if (!expectsReply) return c.body(null, 202);
    return c.json(unavailable(msg, reason), 200);
  }

  try {
    const payload = await registry.callDevice({
      userId: ownerId,
      server,
      payload: body,
      expectsReply,
    });
    if (!expectsReply) return c.body(null, 202);
    return c.json(payload as never, 200);
  } catch (err) {
    // 掉线 / 超时 / 子进程死了都走到这。决策 11：立即回错误，不等重连。
    const reason = err instanceof Error ? err.message : String(err);
    if (!expectsReply) return c.body(null, 202);
    return c.json(unavailable(msg, reason), 200);
  }
});

export { route as mcpLocalRoute };
