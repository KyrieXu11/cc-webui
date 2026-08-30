// 决策 19 的**结构性**护栏（docs/desktop-client.md「实施期的修正」§2）。
//
// ⚠️⚠️ 这个文件存在的理由，请先读完再改：
//
// 设计要求「群聊 / 飞书不得使用本地工具」。**这一条不能靠检查 ownerId 实现** ——
// 飞书 turn 的 ownerId 会被 `auth/actor.ts` 的 `actorForResource()` 解析成
// `ownerOf(gid) ?? serviceAdmin()?.id`，也就是**一个真实存在的管理员账号 id**，
// 而那个管理员很可能正好有在线设备。任何「按 ownerId 查设备，飞书特殊处理」的
// 黑名单都会漏，后果是：**飞书群里任何人 @ 一下 bot，就能在家人的电脑上执行代码**
// （飞书至今没有 sender 白名单，见 AGENTS.md）。
//
// 所以实现是结构性的：**只有 server/chat.ts 一处装配 `local-*` 的 mcpServers 条目。**
// 而「只有一处」是一句纪律，纪律会在下一次重构时悄悄失效 —— 这个测试就是把它
// 变成一条会红的断言。
//
// 这是 grep 式的测试，在这个仓库里不常见。它是对的，因为要钉的东西本身就是
// 「哪些文件被允许 import 什么」这种结构性事实，没有别的地方能表达它。

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const files = await walk(SERVER_DIR);

// 装配一条 local-* 条目需要这三样东西里的**至少一样**。任何模块碰了它们，
// 就有能力把本地工具挂到一个 turn 上。
const MARKERS = [
  "localMcpRouteUrl", // URL 构造（codex-mcp-config.ts）
  "availableServers", // 「这个账号现在有哪些本地 server」（devices/registry.ts）
  "LOCAL_PREFIX", // CLI 那侧的 server 名前缀（devices/protocol.ts）
];

// 允许碰的文件，以及**为什么**。加白名单前先问一遍：这个新调用方会不会
// 被飞书或群聊的 turn 走到？会的话，决策 19 就被打破了。
const ALLOWED = new Map<string, string>([
  [
    "chat.ts",
    "唯一的装配点。它只服务网页单聊（POST /api/chat 是 auth:\"user\"），" +
      "runChatTurn 的调用方只有这个路由和同文件里的 wakeup 定时器。",
  ],
  [
    "mcp-local-route.ts",
    "中继路由。它用 availableServers 判断「该设备上有没有这个 server」，" +
      "属于**供给**侧不是装配侧 —— 没有它就没法在设备离线时给出可辨认的错误。",
  ],
  ["codex-mcp-config.ts", "localMcpRouteUrl 的定义处。"],
]);

// devices/ 自己不算 —— 那是实现，不是调用方。
const suspects = files.filter(
  (f) => !path.relative(SERVER_DIR, f).startsWith("devices" + path.sep),
);

const offenders: Array<{ file: string; marker: string }> = [];
for (const f of suspects) {
  const src = await readFile(f, "utf8");
  const rel = path.relative(SERVER_DIR, f);
  if (ALLOWED.has(rel)) continue;
  for (const m of MARKERS) {
    if (src.includes(m)) offenders.push({ file: rel, marker: m });
  }
}

assert.deepEqual(
  offenders,
  [],
  "⚠️ 决策 19：只有 server/chat.ts 允许装配本地工具。\n" +
    "新增的调用方：" +
    offenders.map((o) => `${o.file}（用了 ${o.marker}）`).join("、") +
    "\n如果这个调用方会被**飞书或群聊**的 turn 走到，那么飞书群里任何人 @ 一下 bot " +
    "就能在家人的电脑上执行代码 —— 飞书没有 sender 白名单，而它的 ownerId 是一个" +
    "真实的管理员账号。确认安全后再把文件加进本测试的 ALLOWED 白名单，并写清理由。",
);

// 反向断言：装配点确实还在。上面那条断言在 chat.ts 把整段删掉时是**不会**红的
// （offenders 仍然为空），所以这里正着测一遍。
const chat = await readFile(path.join(SERVER_DIR, "chat.ts"), "utf8");
for (const m of MARKERS) {
  assert.ok(
    chat.includes(m),
    `server/chat.ts 应当仍然是本地工具的装配点，但找不到 ${m}`,
  );
}

// 点名那几个**绝对不能**碰的文件，让意图在测试里也能读出来，
// 而不是只能从「不在白名单里」反推。
for (const f of [
  "groups/claude-runner.ts",
  "groups/codex-runner.ts",
  "groups/orchestrator.ts",
  "codex-chat.ts",
]) {
  const src = await readFile(path.join(SERVER_DIR, f), "utf8").catch(() => "");
  assert.ok(src.length > 0, `${f} 不见了？这个测试的前提变了，去读决策 19`);
  for (const m of MARKERS) {
    assert.ok(
      !src.includes(m),
      `${f} 绝不能碰 ${m} —— 飞书和群聊的 turn 都会走到它`,
    );
  }
}

console.log("local-tools-scope.test.ts: all assertions passed");
