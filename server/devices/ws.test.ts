// 设备 WebSocket 的安全网。
//
// ⚠️⚠️ 这个文件不是「又一个单测」，它是 `/ws/device` 这条通道**唯一**的鉴权测试。
// 设备 WS 挂在 node http.Server 的 `upgrade` 事件上（server/index.ts:72），在 Hono
// 拿到请求之前就被截走，所以：
//   - 它不在 `app.routes` 里 → server/auth/policy.ts 那张声明式授权表管不到它；
//   - policy.test.ts 的「每条路由都必须有 policy 条目」覆盖率断言**看不见它**；
//   - authMiddleware 的 fail-closed（没条目就 403）在这条路径上根本不存在。
// 结论：ws.ts 里那段手写的 cookie 校验删掉，全仓不会有第二个测试变红。所以下面
// 前三个用例（无 cookie / 伪造签名 / 账号已删）是当成安全测试写的，别删、别放宽。
//
// ⚠️ 房规两条，踩过的坑：
//   1. 端口一律 `listen(0)`。这个仓库的测试文件是**并行**跑的，写死端口会随机撞车。
//   2. 每个「应该被拒」的用例都要真的等到 close / error / HTTP 响应事件，不能
//      `await setTimeout`。定时器一律 unref，finally 里所有 WebSocket terminate()，
//      否则 `npm test` 会永久挂住（runner 不 kill、不报错、不超时）。

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";
import type { ClientFrame, ServerFrame } from "./protocol.ts";

// mkdtemp 而不是时间戳后缀：并行跑的两个文件可能落在同一毫秒。
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-webui-devices-ws-"));
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CC_WEBUI_COOKIE_SECRET_FILE = path.join(tmp, "cookie-secret");
// 否则 createUser() 会往开发者真实的 ~/.cc-webui 里 mkdir。
process.env.CC_WEBUI_WORKSPACES_DIR = path.join(tmp, "workspaces");

// ⚠️ 必须是动态 import：静态 import 会被提升到上面那几行 env 赋值之前执行，
// 结果是**静默**读写开发者真实的 ~/.cc-webui/cc-webui.db，不报错。
const { closeDb } = await import("../db.ts");
const { createUser, deleteUser } = await import("../auth/users.ts");
const { issueSession, SESSION_COOKIE } = await import("../auth/session.ts");
const { getDevice, upsertDevice } = await import("./store.ts");
const registry = await import("./registry.ts");
const { PROTOCOL_VERSION } = await import("./protocol.ts");
const { createDeviceWs, DEVICE_WS_PATH } = await import("./ws.ts");

// ─── 起一台真 server ─────────────────────────────────────────────────────────

const deviceWs = createDeviceWs();
const httpServer = createServer((_req, res) => {
  res.statusCode = 426;
  res.end();
});
// ⚠️ **这一段必须和 server/index.ts 的 upgrade 监听器保持同构。**
// 一旦注册了 'upgrade' 监听器，node 自己「没人处理就 destroy socket」的默认行为
// 就关掉了 —— 没人认领的 upgrade 会留下一条既无响应、也不 close、也没有超时的
// TCP 连接（2026-08-30 由变异测试发现并修复：handleUpgrade 从 void 改成返回
// boolean，调用方按它决定要不要关）。
// 这里照抄生产写法，所以「路径不对」这条用例测的是真实链路，而不是测试自己
// 造的一个兜底；同时它也不必再靠 setTimeout 去断言「没被接管」，并行跑不会 flaky。
httpServer.on("upgrade", (req, socket, head) => {
  if (deviceWs.handleUpgrade(req, socket, head)) return;
  const s = socket as Socket;
  s.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  s.destroy();
});
await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const port = (httpServer.address() as AddressInfo).port;

// ─── 客户端小工具 ────────────────────────────────────────────────────────────

type Client = {
  ws: WebSocket;
  send(frame: ClientFrame): void;
  /** 下一帧（已到达的先出队）。超时 reject —— 挂住的测试比失败的测试难查得多。 */
  next(timeoutMs?: number): Promise<ServerFrame>;
  closed: Promise<void>;
};

/** 一次连接尝试的结果。三种可能：握手成功 / 被一个 HTTP 响应拒绝 / 传输层报错。 */
type Attempt = {
  kind: "open" | "http" | "error";
  status: number | null;
  error: string | null;
  client: Client | null;
};

const allClients: Client[] = [];

function connect(opts: { cookie?: string; path?: string } = {}): Promise<Attempt> {
  const url = `ws://127.0.0.1:${port}${opts.path ?? DEVICE_WS_PATH}`;
  const ws = new WebSocket(url, opts.cookie ? { headers: { cookie: opts.cookie } } : {});

  const frames: ServerFrame[] = [];
  const waiters: Array<(f: ServerFrame) => void> = [];
  // message 监听器必须在 open 之前就挂上：welcome 紧跟着握手就来，晚挂会丢帧。
  ws.on("message", (raw) => {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(String(raw)) as ServerFrame;
    } catch {
      return;
    }
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });

  let markClosed = (): void => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  ws.on("close", () => markClosed());

  const client: Client = {
    ws,
    send: (frame) => ws.send(JSON.stringify(frame)),
    next: (timeoutMs = 5_000) => {
      const buffered = frames.shift();
      if (buffered) return Promise.resolve(buffered);
      return new Promise<ServerFrame>((resolve, reject) => {
        const waiter = (f: ServerFrame): void => {
          clearTimeout(timer);
          resolve(f);
        };
        const timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`timed out waiting for a server frame on ${url}`));
        }, timeoutMs);
        timer.unref?.();
        waiters.push(waiter);
      });
    },
    closed,
  };
  allClients.push(client);

  return new Promise<Attempt>((resolve) => {
    let settled = false;
    const settle = (a: Attempt): void => {
      if (settled) return;
      settled = true;
      resolve(a);
    };
    ws.on("open", () => settle({ kind: "open", status: null, error: null, client }));
    // ⚠️ 有这个监听器时 ws 就**不**自己 abort 了（websocket.js:917），拿到的是
    // 服务端真写回来的那条 HTTP 响应 —— 也就是 refuse() 的 401。清理留给 finally。
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      settle({ kind: "http", status: res.statusCode ?? 0, error: null, client: null });
    });
    // ⚠️ error 监听器必须**永远**在：WebSocket 是 EventEmitter，没有 'error'
    // 监听的 error 事件会被 Node 抛成未捕获异常，把整个测试文件判失败 ——
    // 包括 finally 里 terminate() 必然触发的那一个。
    ws.on("error", (err) => settle({ kind: "error", status: null, error: err.message, client: null }));
    ws.on("close", () => settle({ kind: "error", status: null, error: "closed before open", client: null }));
  });
}

function expectFrame<T extends ServerFrame["t"]>(
  frame: ServerFrame,
  t: T,
): Extract<ServerFrame, { t: T }> {
  assert.equal(frame.t, t, `expected a "${t}" frame, got ${JSON.stringify(frame)}`);
  return frame as Extract<ServerFrame, { t: T }>;
}

/** 轮询到条件成立。用来等「服务端那侧也处理完了」这种没有事件可听的状态。 */
async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((r) => {
      const t = setTimeout(r, 5);
      t.unref?.();
    });
  }
}

function hello(deviceId: string, protocol = PROTOCOL_VERSION): ClientFrame {
  return {
    t: "hello",
    protocol,
    deviceId,
    label: `label-${deviceId}`,
    platform: "win32",
    clientVersion: "0.0.1-test",
  };
}

try {
  const user = createUser({ username: "familypc", password: "pw-12345", role: "user" });
  const cookie = `${SESSION_COOKIE}=${issueSession(user.id)}`;

  // ── 1. 无 cookie → 401，绝不 open ────────────────────────────────────────
  //
  // 这是这条通道最容易悄悄退化的一条：ws.ts 里删掉那个 `if (!user)`，全仓只有
  // 这一行会红。
  {
    const res = await connect();
    assert.equal(res.kind, "http", `anonymous upgrade must be refused, got ${res.kind}`);
    assert.equal(res.status, 401);
    assert.equal(registry.connectedDevice(user.id), undefined);
  }

  // ── 2. 签名被篡改的 cookie → 401 ────────────────────────────────────────
  //
  // 只改末尾几个 hex：payload（userId + 过期时间）原封不动，被拒的唯一理由只能是
  // HMAC 对不上。换句话说这条钉的是「真的验了签名」，而不是「解析出 userId 就放行」。
  {
    const token = issueSession(user.id);
    const flipped = token.slice(0, -4) + (token.endsWith("0000") ? "1111" : "0000");
    assert.notEqual(flipped, token);
    const res = await connect({ cookie: `${SESSION_COOKIE}=${flipped}` });
    assert.equal(res.kind, "http", `forged signature must be refused, got ${res.kind}`);
    assert.equal(res.status, 401);
    assert.equal(registry.connectedDevice(user.id), undefined);
  }

  // ── 3. cookie 合法但账号已被删 → 401 ────────────────────────────────────
  //
  // session cookie 是无状态 HMAC，没有服务端 session 表（server/auth/session.ts
  // 文件头），所以一张签发过的 cookie 会比账号活得久：readSession 照样返回
  // userId，只有 getUserById 能发现账号没了。identifyCookieHeader 把这两步合在
  // 一起正是为了这个 —— 少走一步就等于给已删账号发通行证。
  {
    const ghost = createUser({ username: "ghost", password: "pw-12345", role: "user" });
    const ghostCookie = `${SESSION_COOKIE}=${issueSession(ghost.id)}`;
    assert.equal(deleteUser(ghost.id), true);

    const res = await connect({ cookie: ghostCookie });
    assert.equal(res.kind, "http", `cookie for a deleted account must be refused, got ${res.kind}`);
    assert.equal(res.status, 401);
    assert.equal(registry.connectedDevice(ghost.id), undefined);
  }

  // ── 4. 合法 cookie + 正确路径 → welcome，紧跟一帧 config ─────────────────
  {
    registry.resetForTests();
    const res = await connect({ cookie });
    assert.equal(res.kind, "open", `valid cookie must be admitted, got ${res.kind} ${res.error ?? res.status}`);
    const c = res.client;
    assert.ok(c);

    c.send(hello("device-happy"));
    const welcome = expectFrame(await c.next(), "welcome");
    assert.equal(welcome.protocol, PROTOCOL_VERSION);
    // username 是给客户端显示「已连接为 xxx」用的，所以它必须是服务端认出来的
    // 那个账号，而不是客户端自报的任何东西。
    assert.equal(welcome.username, "familypc");

    // 决策 16：admit 之后立刻下发配置。这个账号一条 local_mcp_servers 都没有，
    // 于是是一帧空 config —— 「一行都没有」是正常情况，不是错误。
    const config = expectFrame(await c.next(), "config");
    assert.equal(config.servers.length, 0);

    const live = registry.connectedDevice(user.id);
    assert.ok(live);
    assert.equal(live.deviceId, "device-happy");
    assert.equal(live.label, "label-device-happy");
    assert.equal(live.platform, "win32");
    assert.equal(live.clientVersion, "0.0.1-test");
    // ready 帧还没来 → 一只可用的手都没有。null（还不知道）和空集（确定没有）
    // 在 registry 里是两回事，但对上层探测都是「没有本地工具」。
    assert.equal(registry.availableServers(user.id).length, 0);

    // 耐久那一半：admit 时 upsertDevice 落库。在线状态**不**落库（见 db.ts 迁移 5）。
    const row = getDevice(user.id);
    assert.ok(row);
    assert.equal(row.deviceId, "device-happy");
    assert.equal(row.clientVersion, "0.0.1-test");

    c.ws.terminate();
    await until(() => registry.connectedDevice(user.id) === undefined, "server-side drop");
  }

  // ── 5. 路径不对 → 这个 handler 不接管 ───────────────────────────────────
  //
  // 带的是**合法** cookie，所以被拒的唯一理由只能是路径。400 来自上面那个测试
  // 专属兜底：它只在 handleUpgrade 一个字节都没写、也没 destroy 时才触发。
  //
  // ⚠️ 路径是 `/ws/device` 而不是 `/api/mcp/...`：AGENTS.md 的部署一节要求反代把
  // `/api/mcp/*` 一律 404，放进去的话家人的客户端永远连不上。这条断言顺带把常量钉住。
  {
    registry.resetForTests();
    assert.equal(DEVICE_WS_PATH, "/ws/device");

    const res = await connect({ cookie, path: "/ws/nope" });
    assert.equal(res.kind, "http", `a foreign path must not be upgraded, got ${res.kind}`);
    assert.equal(res.status, 400);
    assert.equal(registry.connectedDevice(user.id), undefined);
  }

  // ── 6. hello 之前的帧不许污染任何状态 ───────────────────────────────────
  //
  // 一条还没握手的连接不该能写内存注册表，也不该能写库。
  //
  // ⚠️ 断言前需要一个**屏障**：ready / pong 都是单向帧，没有应答可等，发完直接
  // 断言等于赌服务端已经处理完了（并行跑时必 flaky）。这里用「随后一帧版本不
  // 匹配的 hello」当屏障 —— 它一定会换回一帧 bye，而同一个 message 处理器按到达
  // 顺序跑，所以 bye 到手就证明前面两帧已经被处理过（而不是还没轮到）。
  //
  // ⚠️ 光断言 connectedDevice 是不够的，那条断言**抓不到**「`if (!admitted)
  // return` 被删掉」这个变异：今天所有帧落到的 registry 函数（setReady / touch /
  // setPaused / settle）在没有 conn 时都是 no-op，删了守卫照样是 undefined。
  // 真正能观察到的越权写是 pong 那条分支 —— 它调 touchDevice()，直接 UPDATE
  // devices.last_seen_ms。所以下面先把 last_seen_ms 按成一个标志值再验它没动。
  {
    registry.resetForTests();
    const before = getDevice(user.id);
    assert.ok(before, "case 4 should have left a device row to guard here");
    upsertDevice({ ...before, lastSeenMs: 1 });

    const res = await connect({ cookie });
    assert.equal(res.kind, "open");
    const c = res.client;
    assert.ok(c);

    c.send({ t: "ready", servers: [{ name: "browser", ok: true }] });
    c.send({ t: "pong", id: "not-a-real-ping" });
    c.send(hello("device-jumpy", PROTOCOL_VERSION + 1));
    expectFrame(await c.next(), "bye");

    assert.equal(
      registry.connectedDevice(user.id),
      undefined,
      "a pre-hello frame must not create a registry entry",
    );
    assert.equal(registry.availableServers(user.id).length, 0);
    assert.equal(
      getDevice(user.id)?.lastSeenMs,
      1,
      "a pre-hello pong must not be able to write to the devices table",
    );

    c.ws.terminate();
    await c.closed;
  }

  // ── 7. 协议版本不匹配 → bye（说清两边版本）+ 断开 ───────────────────────
  //
  // 静默降级会把「为什么这个工具没出现」变成查不动的问题，所以 reason 里必须能
  // 看出是版本问题、而且两边的版本号都在。
  {
    registry.resetForTests();
    const res = await connect({ cookie });
    assert.equal(res.kind, "open");
    const c = res.client;
    assert.ok(c);

    c.send(hello("device-old", PROTOCOL_VERSION + 1));
    const bye = expectFrame(await c.next(), "bye");
    assert.match(bye.reason, /protocol/i);
    assert.match(bye.reason, new RegExp(`v${PROTOCOL_VERSION + 1}`));
    assert.match(bye.reason, new RegExp(`v${PROTOCOL_VERSION}\\b`));

    // 说完就真的关，不是留一条僵尸连接。
    await c.closed;
    assert.equal(registry.connectedDevice(user.id), undefined);
  }

  // ── 8. 第二台设备被拒，而**第一台仍然活着** ─────────────────────────────
  //
  // 决策 5「一账号一设备」在线那一半：已经有连接时拒绝新的，而不是踢掉旧的。
  // 「我在楼上跑着，你在楼下一开就把我断了」在只有家人用的场景里是真会发生的事故。
  // 所以这条用例的重点其实是后半句 —— 第一条连接必须毫发无伤。
  {
    registry.resetForTests();
    const first = await connect({ cookie });
    assert.equal(first.kind, "open");
    const a = first.client;
    assert.ok(a);
    a.send(hello("device-a"));
    expectFrame(await a.next(), "welcome");
    expectFrame(await a.next(), "config");

    const second = await connect({ cookie });
    // 注意：第二条**握手是成功的**（cookie 合法），拒绝发生在 hello 那一层。
    assert.equal(second.kind, "open", "the same cookie must still pass the upgrade check");
    const b = second.client;
    assert.ok(b);
    b.send(hello("device-b"));
    const bye = expectFrame(await b.next(), "bye");
    assert.match(bye.reason, /already connected/i);
    // reason 要指得出是哪台机器占着位子，否则用户只能看到「连不上」。
    assert.match(bye.reason, /label-device-a/);
    await b.closed;

    // 第一条还在：readyState 只说明 socket 没断，所以再从服务端推一帧过去，
    // 证明它在 registry 里的 transport 也还接着。
    assert.equal(a.ws.readyState, WebSocket.OPEN);
    registry.pushConfig(user.id, []);
    expectFrame(await a.next(), "config");

    const live = registry.connectedDevice(user.id);
    assert.ok(live);
    assert.equal(live.deviceId, "device-a", "the incumbent must keep the slot");

    a.ws.terminate();
    await until(() => registry.connectedDevice(user.id) === undefined, "server-side drop");
  }

  console.log("ws.test.ts: all assertions passed");
} finally {
  // ⚠️ 顺序有讲究：先把客户端全 terminate（每个都挂着 error 监听器，abortHandshake
  // 在 nextTick 抛的那个 error 有人接），再关 server，最后关库、清 env、删 tmp。
  // 漏掉任何一个 ref 着事件循环的句柄，`npm test` 会永久挂住而不是失败。
  for (const c of allClients) c.ws.terminate();
  registry.resetForTests();
  deviceWs.close();
  httpServer.closeAllConnections?.();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  closeDb();
  for (const k of [
    "CC_WEBUI_DB",
    "CC_WEBUI_COOKIE_SECRET_FILE",
    "CC_WEBUI_WORKSPACES_DIR",
  ]) {
    delete process.env[k];
  }
  await fsp.rm(tmp, { recursive: true, force: true });
}
