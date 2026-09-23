// 「哪条在途 turn」这个查找，attach 和 cancel 共用。
//
// 它值得单独钉住，是因为它出过一次真实事故（用户 2026-09-10 报的）：
// clientTurnId 存在浏览器 localStorage 里，**全局只有一条**，所以「A 的 turn id
// 配 B 的会话 id」是家常便饭；老写法是 `bySession(a) ?? byTurn(b)`，两者不一致时
// 静默返回 A —— 表现就是「打开的是 B，界面上流的是 A 的内容」，来回切还会因为
// attach 重放 buffer 而重复、错位。
//
// 这里不起 turn、不碰 CLI：查找本身是纯函数，喂两张假表就够了。

import assert from "node:assert/strict";
import { pickInFlight } from "./chat.ts";

type Fake = { sessionId: string | undefined; tag: string };

const A: Fake = { sessionId: "sess-A", tag: "A" };
const B: Fake = { sessionId: "sess-B", tag: "B" };
// 全新会话头几秒：CLI 还没吐 session_id。
const FRESH: Fake = { sessionId: undefined, tag: "fresh" };

const sessions = new Map<string, Fake>([
  ["sess-A", A],
  ["sess-B", B],
]);
const turns = new Map<string, Fake>([
  ["turn-A", A],
  ["turn-B", B],
  ["turn-fresh", FRESH],
]);
const pick = (args: { sessionId?: string; clientTurnId?: string }) =>
  pickInFlight(args, (k) => sessions.get(k), (k) => turns.get(k));

// ── 1. 正常：按会话查得到 ────────────────────────────────────────────────
assert.equal(pick({ sessionId: "sess-A" }), A);

// ── 2. 全新会话：只有 clientTurnId，这条路径必须留着 ─────────────────────
assert.equal(pick({ clientTurnId: "turn-fresh" }), FRESH);
assert.equal(pick({ clientTurnId: "turn-A" }), A);

// ── 3. 【回归】两个 key 指向不同的 turn → 当没找到，**绝不返回另一条** ───
//
// 这就是串台那次的形状：界面停在 B，localStorage 里还留着 A 的 turn id。
assert.equal(pick({ sessionId: "sess-B", clientTurnId: "turn-A" }), B, "B 自己在跑就返回 B");
sessions.delete("sess-B"); // B 没有在途 turn（更常见的情形）
assert.equal(
  pick({ sessionId: "sess-B", clientTurnId: "turn-A" }),
  undefined,
  "B 不在跑就该是「没有」，不能退回 A 的流"
);
sessions.set("sess-B", B);

// ── 4. 还没拿到 session id 的 turn，也不能配给一个具体的会话 ─────────────
//
// 调用方明确问的是 sess-B；一条连 id 都还没有的 turn 显然不是它。
assert.equal(pick({ sessionId: "sess-B", clientTurnId: "turn-fresh" }), B);
sessions.delete("sess-B");
assert.equal(pick({ sessionId: "sess-B", clientTurnId: "turn-fresh" }), undefined);
sessions.set("sess-B", B);

// ── 5. 什么都没给 / 查不到 ───────────────────────────────────────────────
assert.equal(pick({}), undefined);
assert.equal(pick({ sessionId: "nope" }), undefined);
assert.equal(pick({ clientTurnId: "nope" }), undefined);

console.log("chat-inflight.test.ts ok");
