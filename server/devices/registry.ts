// 在线设备的注册表 —— 纯内存，是「哪台机器现在连着」的**唯一真相**。
// 耐久事实（上次出现、配置）在 store.ts，落库的只有那些。
//
// ⚠️ 这个模块**故意不 import `ws`，也不 import auth**。它只认一个 Transport
// 接口（send / close）和一个 revalidate 回调。理由有两条：
//   1. 最难测的两条路径 —— 「turn 跑一半设备掉线」和「RPC 超时」—— 不起真 socket
//      就能测。起真 socket 的测试要占端口，而这个仓库的 20 个测试文件是**并行**跑的
//      （实测 442% CPU），固定端口会随机撞车。
//   2. server/app.ts 有「零 import 期副作用」的硬约束（policy.test.ts 会 import 它
//      4 次），把 WebSocketServer 关在 ws.ts 里，这个模块就能被任何人安全 import。
//
// ⚠️ 定时器一律 .unref()。实测（Node v24.11.0）：一个没 unref 的 setInterval
// 会让 `npm test` **永久挂住** —— runner 不 kill、不报错、不超时。

import { randomUUID } from "node:crypto";
import {
  DEAD_AFTER_MS,
  HEARTBEAT_MS,
  PROTOCOL_VERSION,
  RPC_TIMEOUT_MS,
  type HelloFrame,
  type ServerFrame,
} from "./protocol.ts";

/** 注册表眼里的一条连接。真实现是 WebSocket，测试里是个假的。 */
export type Transport = {
  send(frame: ServerFrame): void;
  /** 送一帧 bye 再关。reason 会出现在客户端的托盘状态里。 */
  close(reason: string): void;
};

type Pending = {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  server: string;
};

type Conn = {
  userId: string;
  /**
   * 这条**连接**的身份（不是设备的、也不是账号的）。
   *
   * ⚠️ 存在的唯一理由：`drop` 只按 userId 索引，而一条半死的 TCP 的 close 事件
   * 可能在几分钟后才到。时序是这样的 ——
   *   ① 心跳判死 A，drop(A)，A 的 socket 收到 close 请求但对端已经不通；
   *   ② 家人的机器醒来，客户端重连成 B，admit(B) 成功；
   *   ③ A 的 close 事件这时才终于触发 → 如果按 userId 无条件 drop，**B 被删掉**，
   *      而 B 的 socket 还开着 —— 服务端以为没人连，客户端以为连着，谁也不会重连。
   * 所以 ws.ts 拿着自己这条连接的 token 来 drop，token 对不上就什么都不做。
   * Windows 机器睡眠/唤醒正好是这条路径的高频场景，不是边缘情况。
   */
  connToken: string;
  deviceId: string;
  label: string;
  platform: string;
  clientVersion: string;
  connectedAt: number;
  lastSeenMs: number;
  /** 托盘「⏸ 暂停本机工具」（决策 8）。暂停期间对上层等同于设备不存在。 */
  paused: boolean;
  /**
   * 设备回报 spawn 成功的 server 名。null = 还没收到 ready。
   * ⚠️ null 和空集合是**不同**的：前者是「还不知道」，后者是「确定一个都没有」。
   * 起 turn 的探测把两者都当作「没有本地工具」，但日志要能分清。
   */
  ready: Set<string> | null;
  transport: Transport;
  pending: Map<string, Pending>;
  /**
   * 心跳时重验身份。返回 false = 这个账号已经不能用了（登出、改密码、删号）。
   *
   * ⚠️ 这个回调不是可有可无的。session cookie 是无状态 HMAC，没有服务端 session
   * 表，因此**没有实时吊销**（server/auth/session.ts 头部注释）。一条只在握手时
   * 验过一次的 WS 会一直活到 30 天 TTL 到期 —— 决策 14 说的「登出即断连」在
   * 服务端一侧完全不成立，除非在这里重验。
   */
  revalidate: () => boolean;
};

const conns = new Map<string, Conn>();
let heartbeat: NodeJS.Timeout | null = null;

/** 上层看到的在线设备。 */
export type LiveDevice = {
  userId: string;
  deviceId: string;
  label: string;
  platform: string;
  clientVersion: string;
  connectedAt: number;
  paused: boolean;
  /** spawn 成功的本地 MCP server 名。还没 ready 时是空数组。 */
  servers: string[];
};

function toLive(c: Conn): LiveDevice {
  return {
    userId: c.userId,
    deviceId: c.deviceId,
    label: c.label,
    platform: c.platform,
    clientVersion: c.clientVersion,
    connectedAt: c.connectedAt,
    paused: c.paused,
    servers: c.ready ? [...c.ready] : [],
  };
}

export type AdmitResult =
  | { ok: true; device: LiveDevice; connToken: string }
  | { ok: false; reason: string };

/**
 * 接纳一条连接。
 *
 * 决策 5「一账号一设备」的**在线**那一半就在这里：已经有连接时**拒绝新的**，
 * 而不是踢掉旧的。理由写在设计文档里 —— 「我在楼上跑着，你在楼下一开就把我
 * 断了」在只有家人用的场景里是个真实会发生的恼人事故。
 *
 * ⚠️ 这里不做鉴权。调用方（ws.ts）必须已经在 upgrade 时验过 cookie 并拿到了
 * userId。这个模块拿到 userId 就当它是真的。
 */
export function admit(opts: {
  userId: string;
  hello: HelloFrame;
  transport: Transport;
  revalidate: () => boolean;
  now?: number;
}): AdmitResult {
  const { userId, hello, transport, revalidate } = opts;
  const now = opts.now ?? Date.now();

  if (hello.protocol !== PROTOCOL_VERSION) {
    // 静默降级会让「为什么这个工具没出现」变成查不动的问题，所以说清楚两边的版本。
    return {
      ok: false,
      reason: `protocol mismatch: client speaks v${hello.protocol}, server speaks v${PROTOCOL_VERSION} — update the desktop client`,
    };
  }

  const existing = conns.get(userId);
  if (existing) {
    return {
      ok: false,
      reason: `another device is already connected for this account (${existing.label || existing.deviceId})`,
    };
  }

  const connToken = randomUUID();
  const conn: Conn = {
    userId,
    connToken,
    deviceId: hello.deviceId,
    label: hello.label,
    platform: hello.platform,
    clientVersion: hello.clientVersion,
    connectedAt: now,
    lastSeenMs: now,
    paused: false,
    ready: null,
    transport,
    pending: new Map(),
    revalidate,
  };
  conns.set(userId, conn);
  ensureHeartbeat();
  return { ok: true, device: toLive(conn), connToken };
}

/**
 * 断开一条连接并**立即**拒掉它所有挂起的调用（决策 11）。
 *
 * ⚠️ 「立即」是刻意的，不是偷懒。等重连会让那条 SSE 流长时间没动静，而
 * 模型对「工具报错」的处理能力远强于对「工具卡住」。而且家人的 Windows 机器
 * 睡眠是**高频**场景，不是边缘情况。
 *
 * ⚠️ `connToken` 传了就必须对得上，否则这次 drop 被忽略。**任何由某条具体连接
 * 的事件触发的 drop（close / error）都必须传它** —— 理由见 Conn.connToken 的注释。
 * 不传 = 无条件踢掉当前那条，只有心跳和测试重置该这么做。
 */
export function drop(userId: string, reason: string, connToken?: string): void {
  const conn = conns.get(userId);
  if (!conn) return;
  if (connToken !== undefined && conn.connToken !== connToken) return;
  conns.delete(userId);
  for (const [, p] of conn.pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  conn.pending.clear();
  try {
    conn.transport.close(reason);
  } catch {
    // socket 已经死了才走到这，关不上不是错误。
  }
  if (conns.size === 0) stopHeartbeat();
}

/** 现在连着的设备（可能处于暂停态）。 */
export function connectedDevice(userId: string): LiveDevice | undefined {
  const c = conns.get(userId);
  return c ? toLive(c) : undefined;
}

/**
 * 起 turn 时的探测（决策 9）：这个账号**现在**有几只可用的手。
 *
 * 暂停中、或还没 ready 的设备一律当不存在 —— 装配了工具却调不通，比一开始
 * 就告诉模型「你没有这只手」糟得多。
 */
export function availableServers(userId: string): string[] {
  const c = conns.get(userId);
  if (!c || c.paused || !c.ready) return [];
  return [...c.ready];
}

/** 收到 ready 帧：记下哪些 server 真的起来了。 */
export function setReady(
  userId: string,
  servers: Array<{ name: string; ok: boolean; error?: string }>,
): void {
  const c = conns.get(userId);
  if (!c) return;
  c.ready = new Set(servers.filter((s) => s.ok).map((s) => s.name));
  for (const s of servers) {
    if (!s.ok) {
      console.warn(
        `[devices] ${userId}: local MCP server ${s.name} failed to start: ${s.error ?? "(no reason given)"}`,
      );
    }
  }
}

export function setPaused(userId: string, paused: boolean): void {
  const c = conns.get(userId);
  if (c) c.paused = paused;
}

/** 任何一帧到达都算活着。 */
export function touch(userId: string, now = Date.now()): void {
  const c = conns.get(userId);
  if (c) c.lastSeenMs = now;
}

/** 把配置下发给设备，让它去 spawn。 */
export function pushConfig(userId: string, servers: unknown[]): void {
  const c = conns.get(userId);
  if (!c) return;
  c.ready = null;
  c.transport.send({
    t: "config",
    servers: servers as never,
  });
}

/**
 * 转发一帧 JSON-RPC 给设备上的某个本地 MCP server。
 *
 * expectsReply=false 是 JSON-RPC notification：发出去就完事，不登记 pending。
 * 登记了的话，notification 永远等不到应答，5 分钟后才超时 —— 而 MCP 握手里
 * 的 `notifications/initialized` 每个 turn 都会来一次，等于每个 turn 泄漏一个
 * 定时器和一个永远 pending 的 promise。
 */
export function callDevice(opts: {
  userId: string;
  server: string;
  payload: unknown;
  expectsReply: boolean;
  timeoutMs?: number;
}): Promise<unknown> {
  const { userId, server, payload, expectsReply } = opts;
  const c = conns.get(userId);
  if (!c) return Promise.reject(new Error("no device connected"));
  if (c.paused) {
    return Promise.reject(new Error("local tools are paused on the device"));
  }

  const id = randomUUID();
  if (!expectsReply) {
    c.transport.send({ t: "rpc", id, server, expectsReply: false, payload });
    return Promise.resolve(undefined);
  }

  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      c.pending.delete(id);
      reject(
        new Error(
          `device did not answer within ${Math.round((opts.timeoutMs ?? RPC_TIMEOUT_MS) / 1000)}s`,
        ),
      );
    }, opts.timeoutMs ?? RPC_TIMEOUT_MS);
    // 超时定时器不该把进程钉在事件循环上 —— 尤其在测试里。
    timer.unref?.();
    c.pending.set(id, { resolve, reject, timer, server });
    try {
      c.transport.send({ t: "rpc", id, server, expectsReply: true, payload });
    } catch (err) {
      clearTimeout(timer);
      c.pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** 设备回了应答。未知 id 静默丢弃（超时后迟到的应答会走到这）。 */
export function settle(
  userId: string,
  id: string,
  outcome: { ok: true; payload: unknown } | { ok: false; message: string },
): void {
  const c = conns.get(userId);
  const p = c?.pending.get(id);
  if (!c || !p) return;
  clearTimeout(p.timer);
  c.pending.delete(id);
  if (outcome.ok) p.resolve(outcome.payload);
  else p.reject(new Error(outcome.message));
}

// ─── 心跳 ────────────────────────────────────────────────────────────────────

function ensureHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => tick(), HEARTBEAT_MS);
  // ⚠️ 见文件头：不 unref 的 interval 会让 `npm test` 永久挂住。
  heartbeat.unref?.();
}

function stopHeartbeat(): void {
  if (!heartbeat) return;
  clearInterval(heartbeat);
  heartbeat = null;
}

/**
 * 一次心跳：判死、重验身份、发 ping。导出是为了让测试能手动驱动它，
 * 不用真的等 30 秒。
 */
export function tick(now = Date.now()): void {
  for (const [userId, c] of [...conns]) {
    if (now - c.lastSeenMs > DEAD_AFTER_MS) {
      drop(userId, "heartbeat timeout");
      continue;
    }
    let alive = false;
    try {
      alive = c.revalidate();
    } catch (err) {
      // 重验自己炸了要当成「不能用」，不能当成「放行」—— fail-closed 是全仓纪律。
      console.error(`[devices] revalidate threw for ${userId}:`, err);
    }
    if (!alive) {
      drop(userId, "session no longer valid — sign in again");
      continue;
    }
    try {
      c.transport.send({ t: "ping", id: randomUUID() });
    } catch {
      drop(userId, "send failed");
    }
  }
}

/** 仅供测试：清空所有状态并停掉心跳。 */
export function resetForTests(): void {
  for (const userId of [...conns.keys()]) drop(userId, "test reset");
  stopHeartbeat();
}
