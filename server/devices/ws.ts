// 设备 WebSocket 端点。挂在 node http.Server 的 `upgrade` 事件上。
//
// ⚠️⚠️ 这是全仓**唯一**一条既不走 Hono、也不走 authMiddleware 的入站通道。
// 后果必须记清楚：
//   - policy.ts 那张声明式授权表管不到它（它不在 app.routes 里）；
//   - policy.test.ts 的覆盖率断言**看不见它** —— 这里忘了验 cookie，不会有
//     任何测试变红，fail-closed 那层保护也不存在；
//   - 因此本文件自带 ws.test.ts，专门钉住「无 cookie / 伪造签名一律拒绝」。
//     那个测试是这条通道唯一的安全网，别删。
//
// ⚠️ 路径是 `/ws/device`，**故意不放在 `/api/mcp/` 下面**：AGENTS.md 的部署一节
// 要求反代把 `/api/mcp/*` 一律 404（那些路由拿到 token 就等于一个 shell）。
// 放进去的话家人的客户端永远连不上，而现场只能看到一个 404。
//
// ⚠️ 反代（nginx）那侧这条 location 需要：
//     proxy_set_header Upgrade $http_upgrade;
//     proxy_set_header Connection "upgrade";
//     proxy_read_timeout 1h;        # 默认 60s 会把长连接切掉
//
// ⚠️ 开发期（npm run dev）前端在 8787、API 在 8788，而 vite 的代理**没有开
// `ws: true`**，所以走 8787 的 WebSocket 会失败。开发时让客户端直连 8788。

import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { identifyCookieHeader } from "../auth/identify.ts";
import { getUserById } from "../auth/users.ts";
import * as registry from "./registry.ts";
import { listLocalMcpServers, touchDevice, upsertDevice } from "./store.ts";
import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type ServerFrame,
} from "./protocol.ts";

export const DEVICE_WS_PATH = "/ws/device";

/** 每条消息的上限。MCP 的 tool_result 可能不小，但 4MB 之外多半是出事了。 */
const MAX_PAYLOAD = 4 * 1024 * 1024;

function refuse(socket: Duplex, status: number, reason: string): void {
  // 直接 destroy 的话客户端只知道「连不上」，查不出是鉴权还是网络。
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function send(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(frame));
}

export type DeviceWsHandle = {
  /**
   * 返回是否接管了这次 upgrade。
   *
   * ⚠️ 返回值不是装饰。`server.on("upgrade", …)` 一旦注册，node **就不再**对
   * 无人处理的 upgrade 请求执行默认的「销毁 socket」—— 于是打到任何其它路径的
   * upgrade 会留下一条既无响应、也不 close、也没有超时的 TCP 连接，一个端口
   * 扫描器就能把 fd 攒满。调用方必须按返回值把没人认领的连接关掉。
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): void;
};

export function createDeviceWs(): DeviceWsHandle {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  function handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): boolean {
    // url 在 upgrade 事件里一定是路径（不含 host），但仍然可能带查询串。
    const path = (req.url ?? "").split("?")[0];
    if (path !== DEVICE_WS_PATH) return false; // 不是给我们的

    // ── 鉴权。这一段没有任何测试之外的兜底，改动前先读文件头 ──────────────
    const user = identifyCookieHeader(req.headers.cookie);
    if (!user) {
      refuse(socket, 401, "Unauthorized");
      return true; // 认领了，也已经关掉了
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      attach(ws, user.id);
    });
    return true;
  }

  function attach(ws: WebSocket, userId: string): void {
    // admit 成功后拿到的、代表**这条连接**的 token。close/error 时必须带着它去
    // drop，否则一条半死连接的迟到 close 会把后来重连上的那条踢掉 ——
    // 见 registry.ts 的 Conn.connToken 注释。
    let connToken: string | null = null;

    // hello 迟迟不来就断开：一条没握手的连接会一直占着「一账号一设备」的名额吗？
    // 不会 —— admit 是在收到 hello 时才做的。但它会占着一个 socket 和一个定时器，
    // 而且这种连接多半是探测流量。
    const helloDeadline = setTimeout(() => {
      if (!connToken) {
        send(ws, { t: "bye", reason: "no hello frame" });
        ws.close();
      }
    }, 10_000);
    helloDeadline.unref?.();

    ws.on("message", (raw) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(raw)) as ClientFrame;
      } catch {
        // 解析不了的帧直接丢。回错误会给一条已经不同步的连接更多机会说话。
        return;
      }
      registry.touch(userId);

      if (frame.t === "hello") {
        if (connToken) return; // 重复 hello 忽略，不重置状态
        const result = registry.admit({
          userId,
          hello: frame,
          transport: {
            send: (f) => send(ws, f),
            close: (reason) => {
              send(ws, { t: "bye", reason });
              ws.close();
            },
          },
          // 心跳时重验：cookie 是无状态 HMAC，没有服务端吊销。见 protocol.ts
          // 的 HEARTBEAT_MS 注释。账号被删 / 被停用 → getUserById 返回 null。
          revalidate: () => getUserById(userId) !== null,
        });
        if (!result.ok) {
          send(ws, { t: "bye", reason: result.reason });
          ws.close();
          return;
        }
        connToken = result.connToken;
        clearTimeout(helloDeadline);

        const user = getUserById(userId);
        upsertDevice({
          userId,
          deviceId: frame.deviceId,
          label: frame.label,
          platform: frame.platform,
          clientVersion: frame.clientVersion,
          lastSeenMs: Date.now(),
        });
        send(ws, {
          t: "welcome",
          protocol: PROTOCOL_VERSION,
          username: user?.username ?? "",
        });
        // 配置下发（决策 16）。一行都没有是正常的 —— 那表示这个账号还没配
        // 本地 MCP server，客户端会回一个空的 ready。
        registry.pushConfig(userId, listLocalMcpServers(userId));
        console.log(
          `[devices] ${user?.username ?? userId} connected: ${frame.label || frame.deviceId} (${frame.platform}, client ${frame.clientVersion})`,
        );
        return;
      }

      // hello 之前的任何其它帧都不认 —— 否则一条没握手的连接可以往 registry 里写东西。
      if (!connToken) return;

      switch (frame.t) {
        case "ready":
          registry.setReady(userId, frame.servers);
          break;
        case "rpc-result":
          registry.settle(userId, frame.id, { ok: true, payload: frame.payload });
          break;
        case "rpc-error":
          registry.settle(userId, frame.id, {
            ok: false,
            message: frame.message,
          });
          break;
        case "paused":
          registry.setPaused(userId, frame.paused);
          break;
        case "pong":
          // touch() 已经在上面做过了，pong 本身不需要额外处理。
          touchDevice(userId);
          break;
      }
    });

    const bye = (why: string) => {
      clearTimeout(helloDeadline);
      if (connToken) registry.drop(userId, why, connToken);
    };
    ws.on("close", () => bye("device disconnected"));
    ws.on("error", (err) => {
      console.warn(`[devices] socket error for ${userId}:`, err.message);
      bye("socket error");
    });
  }

  return {
    handleUpgrade,
    close: () => wss.close(),
  };
}
