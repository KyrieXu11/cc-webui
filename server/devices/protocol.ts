// 服务端 ↔ 桌面客户端的 WebSocket 线协议。
//
// 这个文件是**两边共享的契约**：服务端 import 它，Electron 客户端也 import 它
// （相对路径跨目录 import，见 desktop/ 的 tsconfig）。改这里就是改协议，
// 必须同步 bump PROTOCOL_VERSION，否则老客户端会用新语义解释旧字段。
//
// ⚠️ 为什么 WS 上跑的不是 MCP 而是一层信封（决策 3 说「纯透传 MCP JSON-RPC」）：
// 透传的是 **payload**，但一条 WS 上驮着 N 个本地 MCP server（browser / fs /
// transfer …）外加控制流（配置下发、心跳、暂停开关），所以必须有个信封告诉对面
// 「这一帧是给谁的」。信封之内的 `payload` 一个字节都不改。
//
// ⚠️ 为什么不用 MCP 自己的 transport 把这条 WS 包成 MCP 连接：MCP 规范里**没有**
// WebSocket transport（CLI 只认 stdio / sse / http，已核实 2.1.250）。CLI 那一跳
// 必须是 HTTP，而服务端→设备这一跳是我们自己的协议，没有理由去凑一个不存在的标准。

/**
 * 线协议版本。客户端在 hello 里报自己的，服务端不匹配就拒绝连接并说明原因 ——
 * 静默降级会让「为什么这个工具没出现」变成一个查不动的问题。
 */
export const PROTOCOL_VERSION = 1;

/** 一个本地 MCP server 的启动规格。服务端下发，客户端照单 spawn。 */
export type LocalMcpServerSpec = {
  /**
   * server 名。会成为 CLI 那侧的 MCP server 名（`local-<name>`），进而决定
   * 工具全名 `mcp__local-<name>__<tool>`。
   * ⚠️ 只允许 [a-z0-9-]：它要进 URL path、进 CLI 的 --mcp-config key、
   * 还要进模型看到的工具名，任何一处转义都会变成排查噩梦。
   */
  name: string;
  /** 可执行文件。空 = 用客户端内置的 Electron Node（ELECTRON_RUN_AS_NODE=1，决策 23）。 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

// ─── 客户端 → 服务端 ─────────────────────────────────────────────────────────

/** 连上来的第一帧。服务端在收到它之前不认这条连接。 */
export type HelloFrame = {
  t: "hello";
  protocol: number;
  /**
   * 设备自己生成并持久化的 id（客户端首次启动时 randomUUID，之后存本地）。
   * 它不参与鉴权 —— 鉴权是 upgrade 时的 cookie —— 只用来在日志和 UI 上区分
   * 「还是那台机器」和「换了一台」。
   */
  deviceId: string;
  /** 给人看的名字，通常是机器名。 */
  label: string;
  /** "win32" / "darwin" / … */
  platform: string;
  clientVersion: string;
};

/** spawn 结果回报。服务端据此决定给 CLI 装配哪些 `local-*` 条目。 */
export type ReadyFrame = {
  t: "ready";
  servers: Array<{ name: string; ok: boolean; error?: string }>;
};

/** 一次 JSON-RPC 调用的应答。`payload` 是设备侧 MCP server 的原样输出。 */
export type RpcResultFrame = {
  t: "rpc-result";
  id: string;
  payload: unknown;
};

/**
 * 传输层失败（子进程没起来 / 已经死了 / 写不进去），**不是** MCP 层的 isError。
 * 服务端会把它翻译成一个 JSON-RPC error 回给 CLI。
 */
export type RpcErrorFrame = {
  t: "rpc-error";
  id: string;
  message: string;
};

/** 托盘「⏸ 暂停本机工具」（决策 8）。暂停期间服务端当这台设备不存在。 */
export type PausedFrame = {
  t: "paused";
  paused: boolean;
};

export type PongFrame = { t: "pong"; id: string };

export type ClientFrame =
  | HelloFrame
  | ReadyFrame
  | RpcResultFrame
  | RpcErrorFrame
  | PausedFrame
  | PongFrame;

// ─── 服务端 → 客户端 ─────────────────────────────────────────────────────────

/** 握手被接受。客户端收到它之前不该 spawn 任何东西。 */
export type WelcomeFrame = {
  t: "welcome";
  protocol: number;
  /** 服务端认出来的账号，纯粹给客户端显示用（"已连接为 xxx"）。 */
  username: string;
};

/** 配置下发（决策 16）。客户端照单 spawn，然后回 ready。 */
export type ConfigFrame = {
  t: "config";
  servers: LocalMcpServerSpec[];
};

/** 转发一帧 JSON-RPC 给某个本地 MCP server。`payload` 原样透传。 */
export type RpcFrame = {
  t: "rpc";
  /** 应答要带回同一个 id。通知（JSON-RPC notification）没有应答，id 仍然要有，用于日志。 */
  id: string;
  /** 目标本地 server 名（LocalMcpServerSpec.name）。 */
  server: string;
  /** 是否期待应答。false = JSON-RPC notification，客户端不要回 rpc-result。 */
  expectsReply: boolean;
  payload: unknown;
};

export type PingFrame = { t: "ping"; id: string };

/** 服务端主动断开前的最后一帧，带上人能读懂的原因。 */
export type ByeFrame = {
  t: "bye";
  reason: string;
};

export type ServerFrame =
  | WelcomeFrame
  | ConfigFrame
  | RpcFrame
  | PingFrame
  | ByeFrame;

// ─── 常量 ────────────────────────────────────────────────────────────────────

/**
 * 心跳间隔。每次 ping 同时做两件事：探活，**以及重验 cookie**。
 *
 * ⚠️ 重验不是可选的。session cookie 是无状态 HMAC，没有服务端 session 表，
 * 因此没有实时吊销（server/auth/session.ts 头部注释）。一条只在握手时验过一次
 * 的 WS 会活过登出、活过改密码 —— 决策 14 说的「登出即断连」在服务端一侧
 * 完全不成立，除非在这里重验。
 */
export const HEARTBEAT_MS = 30_000;

/** 连续这么久没收到任何帧就判死。给两个心跳周期的余量。 */
export const DEAD_AFTER_MS = HEARTBEAT_MS * 2 + 5_000;

/**
 * 单次 RPC 的上限。超时按「设备无响应」处理，回一个 JSON-RPC error。
 *
 * ⚠️ 这个值大得离谱是**有意的**：它兜的是「设备卡住了」，不是「这个工具很慢」。
 * 慢工具（扫码登录那种要等人拿手机的）正确的做法是决策 10 的异步任务模式 ——
 * 工具立刻返回 task_id，模型再轮询。靠调大这个超时去撑长任务会让 SSE 那条流
 * 长时间没动静，和刚修好的 thinking 空屏是同一类体验坑。
 */
export const RPC_TIMEOUT_MS = 5 * 60_000;

/** server name 的字面约束，见 LocalMcpServerSpec.name 的注释。 */
export const SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * CLI 那侧看到的 MCP server 名前缀。`local-browser` → 工具叫
 * `mcp__local-browser__navigate`。前缀是给模型看的：它必须一眼能分出
 * 「这只手在服务器上」还是「这只手在用户的电脑上」。
 */
export const LOCAL_PREFIX = "local-";
