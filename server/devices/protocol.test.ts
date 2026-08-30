// 协议契约的自检。
//
// protocol.ts 是**服务端和桌面客户端共享**的文件，里面有几个常量必须和别处
// 手工对齐 —— 手工对齐的东西一定会漂，所以这里用断言钉住。

import assert from "node:assert/strict";
import {
  DEAD_AFTER_MS,
  HEARTBEAT_MS,
  LOCAL_PREFIX,
  PROTOCOL_VERSION,
  RPC_TIMEOUT_MS,
  SERVER_NAME_RE,
  SESSION_COOKIE_NAME,
  localToolServerPrefix,
} from "./protocol.ts";
import { SESSION_COOKIE } from "../auth/session.ts";

// ── cookie 名两处必须一致 ───────────────────────────────────────────────────
// protocol.ts 故意不 import auth/session.ts（那会把 node:crypto、DB、users 表
// 一起拉进桌面客户端），代价就是这个名字写了两遍。改了其中一处而不改另一处的
// 后果是：客户端连不上，而服务端日志里只会看到一个没带 cookie 的 401 —— 从
// 那个现象反推到「常量漂了」非常难。
assert.equal(
  SESSION_COOKIE_NAME,
  SESSION_COOKIE,
  "protocol.ts 的 SESSION_COOKIE_NAME 必须和 auth/session.ts 的 SESSION_COOKIE 相等",
);

// ── 心跳窗口要留出余量 ──────────────────────────────────────────────────────
// DEAD_AFTER_MS 只比 HEARTBEAT_MS 大一点点的话，一次网络抖动就会误杀连接。
assert.ok(
  DEAD_AFTER_MS >= HEARTBEAT_MS * 2,
  "判死窗口至少要给两个心跳周期，否则一次抖动就误杀",
);

// ── RPC 超时兜的是「设备卡住」，不是「工具很慢」 ─────────────────────────────
// 它必须远大于心跳周期：否则设备还没被判死，调用就已经超时了，用户看到的错误
// 会指向工具而不是连接。
assert.ok(
  RPC_TIMEOUT_MS > DEAD_AFTER_MS,
  "RPC 超时必须大于判死窗口，否则错误会指向工具而不是连接",
);

// ── server 名的字面约束 ─────────────────────────────────────────────────────
// 这个名字要进 URL path、进 CLI 的 --mcp-config key、还要进模型看到的工具名
// （mcp__local-<name>__<tool>），任何一处需要转义都会变成排查噩梦。
for (const ok of ["browser", "fs", "transfer", "a", "a-b-c", "x9"]) {
  assert.ok(SERVER_NAME_RE.test(ok), `${ok} 应当合法`);
}
for (const bad of [
  "",
  "-lead",
  "A",
  "a_b",
  "a.b",
  "a/b",
  "../x",
  "a b",
  "x".repeat(33),
]) {
  assert.ok(!SERVER_NAME_RE.test(bad), `${JSON.stringify(bad)} 应当被拒`);
}

// 工具全名拼出来要是模型能一眼分辨的形状。
assert.equal(`mcp__${LOCAL_PREFIX}browser__navigate`, "mcp__local-browser__navigate");

assert.equal(typeof PROTOCOL_VERSION, "number");
assert.ok(PROTOCOL_VERSION >= 1);

// ── 本地工具的 allowance 按 server 放行 ────────────────────────────────────
// 实测：auto 模式对未知 MCP 工具仍然要授权。按工具名缓存的话，一次浏览器会话
// 要点五到八张卡才安静 —— 这条断言钉住「按 server 放行」这个决定。
assert.equal(
  localToolServerPrefix("mcp__local-browser__navigate"),
  "mcp__local-browser__",
);
assert.equal(
  localToolServerPrefix("mcp__local-browser__click"),
  localToolServerPrefix("mcp__local-browser__navigate"),
  "同一个 server 的两个工具必须落到同一个 allowance 键",
);
assert.notEqual(
  localToolServerPrefix("mcp__local-fs__read"),
  localToolServerPrefix("mcp__local-browser__read"),
  "不同 server 之间不能互相放行",
);
// 服务端的工具一律不受影响 —— 它们仍然按工具名放行。
for (const notLocal of [
  "mcp__bash__run",
  "mcp__schedule__wakeup",
  "Read",
  "mcp__localish__x",
  "mcp__local-__x",
  "mcp__local-BROWSER__x",
]) {
  assert.equal(
    localToolServerPrefix(notLocal),
    null,
    `${notLocal} 不该被当成本地工具`,
  );
}

console.log("protocol.test.ts: all assertions passed");
