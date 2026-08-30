// `/api/mcp/local/:server` —— CLI ↔ 家人机器那一跳的中继路由。
//
// 这个文件钉的是 mcp-local-route.ts 注释里写下的**理由**，不是它的实现细节：
//   - fail-closed 的鉴权（token 有效 ≠ 知道是谁的设备）；
//   - 「设备不可用」时 tools/call 和 initialize/tools/list **形状不同**；
//   - 纯透传：请求体一个字节都不该被改。
//
// ⚠️ 这里不起真 socket。registry 只认一个 `Transport`（send/close），所以设备用
// 一个假的对象就能造出来 —— 这正是 registry.ts 头部注释说的「不 import ws」买到的
// 东西。20 个测试文件是并行跑的，起真 server 抢端口会随机撞车。

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { RpcFrame, ServerFrame } from "./devices/protocol.ts";

// ⚠️ 这条路由今天的 import 图里**没有** db.ts（registry / mcp-context / protocol
// 都不碰 SQLite），但这里仍然把 CC_WEBUI_DB 指到临时目录：哪天有人在实现里加一条
// 「查一下这个 owner 还在不在」，静默写开发者真实的 ~/.cc-webui/cc-webui.db 是
// 不会报错的。同理，下面所有本仓模块一律 **动态 import** —— 静态 import 会被提升
// 到这一行之前执行，隔离就白设了。
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-webui-mcp-local-"));
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");

const { registerMcpSessionContext, unregisterMcpSessionContext } = await import(
  "./mcp-context.ts"
);
const registry = await import("./devices/registry.ts");
const { PROTOCOL_VERSION } = await import("./devices/protocol.ts");
const { mcpLocalRoute } = await import("./mcp-local-route.ts");

const app = new Hono();
app.route("/api/mcp", mcpLocalRoute);

const OWNER = "user-alice";

// ─── 工具 ────────────────────────────────────────────────────────────────────

/** 发过的 token 都记下来，finally 里统一注销（per-turn context 是模块级 Map）。 */
const minted: string[] = [];
function mintToken(ownerId?: string): string {
  const token = randomUUID();
  registerMcpSessionContext({ token, sessionId: `sess-${token}`, ownerId });
  minted.push(token);
  return token;
}

async function call(opts: {
  token?: string;
  server?: string;
  method?: string;
  /** 已序列化的请求体。想测坏 JSON 就直接传字符串。 */
  body?: string;
}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const method = opts.method ?? "POST";
  return app.request(`/api/mcp/local/${opts.server ?? "browser"}`, {
    method,
    headers,
    // GET/HEAD 带 body 会被 undici 直接拒掉，不是路由的问题。
    body: method === "GET" || method === "HEAD" ? undefined : (opts.body ?? "{}"),
  });
}

const rpc = (id: number | string, method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

/** JSON-RPC notification：没有 id。 */
const notify = (method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", method, params });

type FakeDevice = {
  /** 服务端发给设备的每一帧，按顺序。 */
  sent: ServerFrame[];
  rpcFrames: RpcFrame[];
};

/**
 * 造一台在线设备。
 *
 * `servers: undefined` = 连上了但还没回 ready 帧（Conn.ready === null，和「确定
 * 一个都没有」是两件事，见 registry.ts 的注释）。
 */
function connectDevice(opts: {
  userId?: string;
  servers?: string[];
  onRpc?: (frame: RpcFrame) => void;
}): FakeDevice {
  const userId = opts.userId ?? OWNER;
  const dev: FakeDevice = { sent: [], rpcFrames: [] };
  const admitted = registry.admit({
    userId,
    hello: {
      t: "hello",
      protocol: PROTOCOL_VERSION,
      deviceId: "dev-1",
      label: "家里的 Windows",
      platform: "win32",
      clientVersion: "0.0.0",
    },
    transport: {
      send(frame: ServerFrame) {
        dev.sent.push(frame);
        if (frame.t === "rpc") {
          dev.rpcFrames.push(frame);
          opts.onRpc?.(frame);
        }
      },
      close() {
        /* 假 socket，没有要释放的句柄 */
      },
    },
    revalidate: () => true,
  });
  assert.equal(admitted.ok, true, "fake device was not admitted");
  if (opts.servers) {
    registry.setReady(
      userId,
      opts.servers.map((name) => ({ name, ok: true })),
    );
  }
  return dev;
}

/**
 * 给「应该立刻返回」的请求加一条死线。
 *
 * ⚠️ 不加的话，notification 那条断言（不该登记 pending）一旦回归，路由 await 的
 * 就是 registry 那个 **5 分钟**才超时的 promise。房规说测试挂住 20 秒就算泄漏。
 *
 * 实测（把 expectsReply 强制成 true 做回归演练）：因为死线定时器是 unref 的，
 * 事件循环空了 Node 会先一步退出，报 “Detected unsettled top-level await” 并把
 * 文件判失败（96ms，不挂）。所以这条死线是**兜底**——兜的是「还有别的东西钉着
 * 事件循环、Node 不会自己退出」那种情况，那时它给一句读得懂的话。
 */
async function withDeadline<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not return within 2s`)),
          2000,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

try {
  // ── 1. 鉴权：没 token / 坏 token 一律 401 ────────────────────────────────
  {
    const anon = await call({ body: rpc(1, "tools/list") });
    assert.equal(anon.status, 401, "no bearer token must be 401");

    const bogus = await call({
      token: randomUUID(),
      body: rpc(1, "tools/list"),
    });
    assert.equal(bogus.status, 401, "unknown token must be 401");
  }

  // ── 2. ⭐ token 有效但 ctx 里没有 ownerId → 403 ──────────────────────────
  //
  // ownerId 在 McpSessionContext 里是 optional，所以「解析不出账号」是个能真实
  // 发生的状态（起 turn 的一侧忘了填）。它绝不能退化成「随便挑台设备」：这条
  // 路由背后是家人电脑上的 shell。这里故意让一台设备在线，证明 403 不是因为
  // 找不到设备，而是因为不知道该找谁的设备。
  {
    registry.resetForTests();
    const dev = connectDevice({ servers: ["browser"] });
    const res = await call({
      token: mintToken(undefined),
      body: rpc(1, "tools/call", { name: "navigate" }),
    });
    assert.equal(res.status, 403, "a token with no ownerId must be refused");
    assert.equal(
      dev.rpcFrames.length,
      0,
      "an ownerId-less turn reached a device",
    );
    registry.resetForTests();
  }

  // ── 3. server 名不合法 → 400，且**在读 body 之前**就拒 ───────────────────
  //
  // 这个名字会进 URL path、进 CLI 的 --mcp-config key、进模型看到的工具名
  // （protocol.ts SERVER_NAME_RE 的注释），所以校验必须先于一切。
  {
    registry.resetForTests();
    const dev = connectDevice({ servers: ["browser"] });
    const token = mintToken(OWNER);

    const badNames = [
      // Hono 会把路径参数 decodeURIComponent 一次，所以到路由手里就是 `../etc`。
      // 直接写 `..` 没用：URL 构造器会先把它规范化掉，请求根本到不了这条路由。
      { encoded: "%2E%2E%2Fetc", why: "traversal" },
      { encoded: "A_B", why: "uppercase + underscore" },
      { encoded: "-lead", why: "leading dash" },
      { encoded: "a".repeat(33), why: "too long" },
    ];
    for (const { encoded, why } of badNames) {
      const res = await call({
        token,
        server: encoded,
        // 故意发一段坏 JSON：名字合法性若排在解析之后，回的会是 -32700/200
        // 而不是 400，这条断言就是那个顺序的锚。
        body: "{ not json",
      });
      assert.equal(res.status, 400, `bad server name (${why}) must be 400`);
    }
    // 32 个字符仍在 SERVER_NAME_RE 允许的范围内，别把边界收紧成 31。
    const okLen = await call({
      token,
      server: "a".repeat(32),
      body: rpc(1, "tools/list"),
    });
    assert.notEqual(okLen.status, 400, "32-char server name must be accepted");

    assert.equal(
      dev.rpcFrames.length,
      0,
      "a rejected server name still reached the device",
    );
    registry.resetForTests();
  }

  // ── 4. 非 POST → 405 ────────────────────────────────────────────────────
  //
  // MCP 的 Streamable HTTP 允许服务端不提供 GET 的 SSE 流，此时规范要求回 405
  // （回 404 会让 CLI 以为整个 endpoint 不存在）。用合法 token + 合法 server 名，
  // 免得 405 和 401/400 混在一起分不清。
  {
    registry.resetForTests();
    connectDevice({ servers: ["browser"] });
    const token = mintToken(OWNER);
    for (const method of ["GET", "DELETE"]) {
      const res = await call({ token, method });
      assert.equal(res.status, 405, `${method} must be 405`);
    }
    registry.resetForTests();
  }

  // ── 5. 正常透传：进去什么样，到设备就什么样；回来同理 ────────────────────
  {
    registry.resetForTests();
    const request = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "navigate",
        arguments: { url: "https://example.com/a?b=1#c", 中文: "别被改写" },
      },
    };
    const reply = {
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "ok" }] },
    };
    const seen: RpcFrame[] = [];
    connectDevice({
      servers: ["browser", "fs"],
      onRpc: (frame) => {
        seen.push(frame);
        // 设备是同步应答的：registry 在 send() 之前就登记好了 pending，
        // 所以这里 settle 不会打空。
        registry.settle(OWNER, frame.id, { ok: true, payload: reply });
      },
    });
    const res = await call({
      token: mintToken(OWNER),
      server: "browser",
      body: JSON.stringify(request),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), reply, "device reply was rewritten");

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.server, "browser", "frame went to the wrong server");
    assert.equal(seen[0]!.expectsReply, true);
    assert.deepEqual(seen[0]!.payload, request, "request body was rewritten");
    registry.resetForTests();
  }

  // ── 6. notification（没有 id）→ 202、空 body、不登记 pending ─────────────
  //
  // 握手里的 notifications/initialized 每个 turn 都来一次。若它被当成 request
  // 登记 pending，就是每个 turn 泄漏一个定时器 + 一个永远 pending 的 promise
  // （registry.callDevice 的注释）。这里的设备**故意一个字都不回**：能立刻拿到
  // 202 本身就是「没在等应答」的证据。
  {
    registry.resetForTests();
    const dev = connectDevice({ servers: ["browser"] }); // onRpc 缺省 = 不应答
    const res = await withDeadline(
      call({
        token: mintToken(OWNER),
        body: notify("notifications/initialized"),
      }),
      "notification",
    );
    assert.equal(res.status, 202);
    assert.equal(await res.text(), "", "202 must have an empty body");
    assert.equal(dev.rpcFrames.length, 1, "notification never reached device");
    assert.equal(
      dev.rpcFrames[0]!.expectsReply,
      false,
      "notification was forwarded as a request",
    );
    registry.resetForTests();
  }

  // ── 7. ⭐ 设备离线 + tools/call → result{isError:true}，不是 JSON-RPC error ─
  //
  // 这是 MCP 里「工具执行失败」的标准形状，模型见得最多、处理得最好。
  {
    registry.resetForTests(); // 一台设备都没有
    const res = await call({
      token: mintToken(OWNER),
      body: rpc(9, "tools/call", { name: "navigate" }),
    });
    assert.equal(res.status, 200, "HTTP must stay 200");
    const body = (await res.json()) as {
      id?: unknown;
      error?: unknown;
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    assert.equal(body.id, 9, "the reply must carry the request id");
    assert.equal(body.error, undefined, "tools/call must not be a protocol error");
    assert.equal(body.result?.isError, true);
    const text = body.result?.content?.[0]?.text ?? "";
    assert.match(text, /没有设备连接/, `reason not visible in: ${text}`);
  }

  // ── 8. ⭐ 设备离线 + initialize / tools/list → JSON-RPC error -32001 ──────
  //
  // 和上一条**必须分开**：这些是协议层失败，模型根本看不到，CLI 会把这个 MCP
  // server 标成不可用。混成 isError 文本的话，一个 initialize 失败会被模型读成
  // 「工具返回了错误」，于是它会一直重试。
  {
    registry.resetForTests();
    const token = mintToken(OWNER);
    for (const method of ["initialize", "tools/list"]) {
      const res = await call({ token, body: rpc(3, method) });
      assert.equal(res.status, 200, `${method} HTTP status`);
      const body = (await res.json()) as {
        id?: unknown;
        result?: unknown;
        error?: { code?: number; message?: string };
      };
      assert.equal(body.result, undefined, `${method} must not return a result`);
      assert.equal(body.error?.code, -32001, `${method} error code`);
      assert.equal(body.id, 3);
      assert.match(body.error?.message ?? "", /没有设备连接/, method);
    }
  }

  // ── 9. 设备暂停：同样不可用，但原因必须和「没有设备连接」分得开 ───────────
  //
  // 决策 8：托盘那个开关按下后，对上层等同于设备不存在。可读性在这里是功能的
  // 一部分 —— 家人按了暂停，模型该说「你把它关了」，而不是「你没装客户端」。
  {
    registry.resetForTests();
    connectDevice({ servers: ["browser"] });
    registry.setPaused(OWNER, true);
    const res = await call({
      token: mintToken(OWNER),
      body: rpc(11, "tools/call", { name: "navigate" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    assert.equal(body.result?.isError, true);
    const text = body.result?.content?.[0]?.text ?? "";
    assert.match(text, /暂停/, `pause not visible in: ${text}`);
    assert.doesNotMatch(text, /没有设备连接/, "paused was reported as offline");
    registry.resetForTests();
  }

  // ── 10. 设备在线但那个 server 没 ready → 不可用，原因指向启动失败 ─────────
  {
    registry.resetForTests();
    // (a) 回过 ready，但里面没有 browser。
    connectDevice({ servers: ["fs"] });
    const res = await call({
      token: mintToken(OWNER),
      body: rpc(13, "tools/call", { name: "navigate" }),
      server: "browser",
    });
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    assert.equal(body.result?.isError, true);
    const text = body.result?.content?.[0]?.text ?? "";
    assert.match(text, /browser/, text);
    assert.match(text, /启动失败/, `startup failure not visible in: ${text}`);
    assert.doesNotMatch(text, /没有设备连接/, "an online device read as offline");
    registry.resetForTests();

    // (b) 连上了但还没回 ready 帧（ready === null）。走同一条不可用分支 ——
    //     装配了工具却调不通，比一开始就说「你没这只手」糟得多。
    connectDevice({}); // 不发 ready
    const pending = await call({
      token: mintToken(OWNER),
      body: rpc(14, "tools/call", { name: "navigate" }),
    });
    const pendingBody = (await pending.json()) as {
      result?: { isError?: boolean };
    };
    assert.equal(pendingBody.result?.isError, true, "not-yet-ready must be unavailable");
    registry.resetForTests();
  }

  // ── 11. turn 跑一半设备掉线：立即回错误，不等重连（决策 11）─────────────
  //
  // 家人的 Windows 机器睡眠是高频场景。模型对「工具报错」的处理能力远强于对
  // 「工具卡住」。⚠️ 这里 pending 的那个 promise 由路由自己 await 掉了，所以
  // drop() 的 reject 不会变成迟到的 unhandled rejection。
  {
    registry.resetForTests();
    let arrived!: () => void;
    const reachedDevice = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    connectDevice({ servers: ["browser"], onRpc: () => arrived() });
    const inflight = call({
      token: mintToken(OWNER),
      body: rpc(15, "tools/call", { name: "navigate" }),
    });
    await reachedDevice;
    registry.drop(OWNER, "device went to sleep");
    const res = await withDeadline(inflight, "call after device dropped");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    assert.equal(body.result?.isError, true);
    assert.match(body.result?.content?.[0]?.text ?? "", /device went to sleep/);
    registry.resetForTests();
  }

  // ── 12. JSON-RPC 批处理 → -32600（MCP 2025-06-18 起取消了批处理）──────────
  {
    registry.resetForTests();
    connectDevice({ servers: ["browser"] });
    const res = await call({
      token: mintToken(OWNER),
      body: `[${rpc(1, "tools/list")}]`,
    });
    assert.equal(res.status, 200, "a protocol-level refusal still answers 200");
    const body = (await res.json()) as { error?: { code?: number } };
    assert.equal(body.error?.code, -32600);
    registry.resetForTests();
  }

  // ── 13. body 不是合法 JSON → -32700 ─────────────────────────────────────
  {
    registry.resetForTests();
    const res = await call({
      token: mintToken(OWNER),
      body: "{ not json",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { error?: { code?: number } };
    assert.equal(body.error?.code, -32700);
  }
} finally {
  // registry 是模块级单例，心跳是个 interval —— resetForTests 会把它停掉。
  registry.resetForTests();
  for (const token of minted) unregisterMcpSessionContext(token);
  delete process.env.CC_WEBUI_DB;
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log("mcp-local-route.test.ts: all assertions passed");
