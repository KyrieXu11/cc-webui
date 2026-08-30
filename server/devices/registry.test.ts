// registry.ts 的测试。
//
// 这个文件之所以能不起 socket、不碰 DB、不碰 env，是因为 registry.ts 刻意只认
// 一个 Transport 接口和一个 revalidate 回调（见它的文件头注释）。所以这里用
// **静态 import** 是安全的：registry 只 import node:crypto 和 protocol.ts，
// 没有任何 import 期副作用，也没有任何 env 依赖。
// ⚠️ 别照抄这一条去写别的测试 —— 凡是会碰 ~/.cc-webui / DB / .env 的模块必须走
// `await import()`，否则静态 import 会被提升到 process.env 赋值之前，静默写开发者
// 的真库（见 server/auth/policy.test.ts 开头的样板）。
//
// ⚠️ registry 是**模块级单例**（一个 Map + 一个 setInterval），所以每组断言之间
// 必须 resetForTests()，finally 里也要再来一次把心跳 interval 收掉。

import assert from "node:assert/strict";
import {
  DEAD_AFTER_MS,
  PROTOCOL_VERSION,
  type HelloFrame,
  type RpcFrame,
  type ServerFrame,
} from "./protocol.ts";
import {
  admit,
  availableServers,
  callDevice,
  connectedDevice,
  drop,
  pushConfig,
  resetForTests,
  setPaused,
  setReady,
  settle,
  tick,
  touch,
} from "./registry.ts";

// ─── 测试替身 ────────────────────────────────────────────────────────────────

/** 假 Transport：把收到的帧堆进数组，把 close 的理由堆进另一个数组。 */
function makeTransport() {
  let broken = false;
  const t = {
    frames: [] as ServerFrame[],
    closed: [] as string[],
    /** 之后所有 send 都抛 —— 模拟 socket 已经死了。 */
    breakSends() {
      broken = true;
    },
    send(frame: ServerFrame) {
      if (broken) throw new Error("socket is gone");
      t.frames.push(frame);
    },
    close(reason: string) {
      t.closed.push(reason);
    },
    /** 只看 rpc 帧，顺带把类型收窄成 RpcFrame。 */
    rpcs(): RpcFrame[] {
      return t.frames.filter((f): f is RpcFrame => f.t === "rpc");
    },
  };
  return t;
}

function makeHello(over: Partial<HelloFrame> = {}): HelloFrame {
  return {
    t: "hello",
    protocol: PROTOCOL_VERSION,
    deviceId: "dev-1",
    label: "客厅的 Windows",
    platform: "win32",
    clientVersion: "0.1.0",
    ...over,
  };
}

/**
 * 让 promise 无论如何都不会变成「迟到的 unhandled rejection」。
 *
 * ⚠️ 这是本文件最容易踩的坑：top-level 跑完之后再冒出来一个没人管的 rejection，
 * Node 会直接崩栈、把整个文件判失败 —— 哪怕所有断言都过了。所以每一个 pending
 * promise 在创建的**同一条语句**里就要挂上处理，不能只 await 其中一个。
 */
function settled<T>(p: Promise<T>): Promise<{ ok: boolean; err?: Error }> {
  return p.then(
    () => ({ ok: true }) as const,
    (err: unknown) => ({
      ok: false,
      err: err instanceof Error ? err : new Error(String(err)),
    }),
  );
}

/**
 * 在任何人替换 globalThis.setTimeout 之前抓住真身。
 *
 * ⚠️ 第 5 组断言靠「数 setTimeout 调用次数」判断有没有登记 pending，会把
 * globalThis.setTimeout 换成一个计数器。within() 自己也要起定时器，不抓这个
 * 引用的话它会把**自己**数进去，那组断言就永远是 1 而不是 0。
 */
const rawSetTimeout: typeof setTimeout = globalThis.setTimeout;

/**
 * 等一个 registry 产出的 promise，但**给它一个上限**。
 *
 * ⚠️ 这个 helper 一次解决两个坑：
 *  1. **保活**：registry 里所有定时器都 .unref() 过（不这么做 `npm test` 会永久
 *     挂住），代价是进程里只剩这些定时器时 Node 会直接退出，我们 await 的东西
 *     永远不会 settle。这里的 guard 定时器**故意不 unref**，把事件循环钉到拿到
 *     结果为止。
 *  2. **快速失败**：真让实现回归了（比如 drop 不再拒挂起调用），裸 await 会让
 *     这个文件永远挂住，而本仓房规说「挂住 = 你泄漏了句柄」—— 于是下一个人会
 *     去找根本不存在的句柄泄漏。有上限就变成一句写着原因的断言失败。
 */
async function within<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = rawSetTimeout(
      () => reject(new Error(`超过 ${DEADLINE_MS}ms 还没等到：${what}`)),
      DEADLINE_MS,
    );
  });
  try {
    // p 赢了 race 就 clearTimeout，guard 永远不会 reject —— 不会有迟到的
    // unhandled rejection。
    return await Promise.race([p, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/** 上限。所有被等的东西要么立刻 settle，要么是个 20ms 的超时，2s 绰绰有余。 */
const DEADLINE_MS = 2_000;

/** 吞掉被测代码故意打的日志，免得测试输出里混进吓人的 warn/error。 */
async function quiet<T>(fn: () => T | Promise<T>): Promise<T> {
  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

const alwaysValid = () => true;

try {
  // ── 1. 一账号一设备（决策 5）：拒绝新的，不是踢掉旧的 ──────────────────────
  {
    const first = makeTransport();
    const second = makeTransport();

    const a = admit({
      userId: "u1",
      hello: makeHello({ deviceId: "dev-first", label: "楼上那台" }),
      transport: first,
      revalidate: alwaysValid,
    });
    assert.equal(a.ok, true);

    const b = admit({
      userId: "u1",
      hello: makeHello({ deviceId: "dev-second", label: "楼下那台" }),
      transport: second,
      revalidate: alwaysValid,
    });
    assert.equal(b.ok, false);
    assert.ok(b.ok === false && b.reason.includes("楼上那台"), b.ok === false ? b.reason : "");

    // 这条是这组断言的**重点**：语义是「拒绝新的」而不是「踢掉旧的」。
    // 设计文档的理由是「我在楼上跑着，你在楼下一开就把我断了」是真实会发生的事故。
    // 所以第一条连接必须**毫发无损**：没被 close、还是注册表里那台、还能收发。
    assert.equal(first.closed.length, 0);
    const live = connectedDevice("u1");
    assert.equal(live?.deviceId, "dev-first");
    assert.equal(live?.label, "楼上那台");

    // 被拒的那条也不该收到任何服务端帧（welcome 由 ws.ts 发，不归 registry 管）。
    assert.equal(second.frames.length, 0);

    // 还能用：调用照样落在第一条连接上。
    const notify = await within(
      callDevice({
        userId: "u1",
        server: "browser",
        payload: { jsonrpc: "2.0", method: "notifications/initialized" },
        expectsReply: false,
      }),
      "第一条连接上的 notification",
    );
    assert.equal(notify, undefined);
    assert.equal(first.rpcs().length, 1);
    assert.equal(second.rpcs().length, 0);
  }
  resetForTests();

  // ── 2. 协议版本不匹配：两个版本号都要出现在 reason 里 ──────────────────────
  {
    const t = makeTransport();
    const r = admit({
      userId: "u1",
      hello: makeHello({ protocol: PROTOCOL_VERSION + 7 }),
      transport: t,
      revalidate: alwaysValid,
    });
    assert.equal(r.ok, false);
    if (r.ok === false) {
      // 静默降级会让「为什么这个工具没出现」变成查不动的问题，所以两边版本都得说。
      assert.ok(r.reason.includes(`v${PROTOCOL_VERSION + 7}`), r.reason);
      assert.ok(r.reason.includes(`v${PROTOCOL_VERSION}`), r.reason);
    }
    // 版本不对就根本没进注册表 —— 不能留下一条半死的连接。
    assert.equal(connectedDevice("u1"), undefined);
    assert.equal(t.frames.length, 0);
  }
  resetForTests();

  // ── 3. 掉线立即拒掉所有挂起调用（决策 11） ────────────────────────────────
  {
    const t = makeTransport();
    assert.equal(
      admit({ userId: "u1", hello: makeHello(), transport: t, revalidate: alwaysValid }).ok,
      true,
    );

    // ⚠️ 三个都要 settled() 包起来。只 await 其中一个，另外两个就会在 top-level
    // 跑完之后变成迟到的 unhandled rejection，把整个文件判失败。
    const calls = [1, 2, 3].map((n) =>
      settled(
        callDevice({
          userId: "u1",
          server: "browser",
          payload: { id: n },
          expectsReply: true,
          timeoutMs: 60_000, // 故意远大于本次测试，证明是 drop 而不是超时干掉它们的
        }),
      ),
    );
    assert.equal(t.rpcs().length, 3);

    drop("u1", "device disconnected");

    const results = await within(Promise.all(calls), "drop 后三个挂起调用全部 settle");
    // 「立即」是刻意的：模型对「工具报错」的处理能力远强于对「工具卡住」，
    // 而家人的 Windows 机器睡眠是高频场景。
    for (const r of results) {
      assert.equal(r.ok, false);
      assert.equal(r.err?.message, "device disconnected");
    }

    assert.deepEqual(t.closed, ["device disconnected"]);
    assert.equal(connectedDevice("u1"), undefined);
    assert.equal(availableServers("u1").length, 0);

    // drop 之后再调就是「没设备」，不是继续排队。
    const after = await within(
      settled(
        callDevice({ userId: "u1", server: "browser", payload: {}, expectsReply: true }),
      ),
      "drop 之后的调用",
    );
    assert.equal(after.ok, false);
    assert.equal(after.err?.message, "no device connected");

    // drop 关不上 socket 不算错误（走到这一步通常是对面已经死了）。
    const t2 = makeTransport();
    admit({ userId: "u2", hello: makeHello(), transport: t2, revalidate: alwaysValid });
    t2.close = () => {
      throw new Error("already closed");
    };
    assert.doesNotThrow(() => drop("u2", "boom"));
    assert.equal(connectedDevice("u2"), undefined);
  }
  resetForTests();

  // ── 4. RPC 超时 ──────────────────────────────────────────────────────────
  {
    const t = makeTransport();
    admit({ userId: "u1", hello: makeHello(), transport: t, revalidate: alwaysValid });

    const r = await within(
      settled(
        callDevice({
          userId: "u1",
          server: "browser",
          payload: {},
          expectsReply: true,
          // 用真的 RPC_TIMEOUT_MS（5 分钟）测这条显然不现实。
          timeoutMs: 20,
        }),
      ),
      "RPC 超时",
    );
    assert.equal(r.ok, false);
    // 消息要带秒数，让人一眼看出是「设备没应答」而不是「工具报了错」。
    // ⚠️ 秒数是 Math.round(ms/1000)，所以亚秒级超时会显示成 "0s" —— 生产里的
    // 5 分钟显示成 "300s"，这里只钉「有个秒数」。
    assert.match(r.err?.message ?? "", /did not answer within \d+s/);

    // 超时后 pending 已经清干净：迟到的应答不会再 resolve 任何东西（见第 10 条）。
    const late = t.rpcs()[0];
    assert.ok(late);
    assert.doesNotThrow(() => settle("u1", late.id, { ok: true, payload: "迟到的应答" }));
  }
  resetForTests();

  // ── 5. notification 不登记 pending ────────────────────────────────────────
  {
    const t = makeTransport();
    admit({ userId: "u1", hello: makeHello(), transport: t, revalidate: alwaysValid });

    // 「有没有登记 pending」唯一可靠的观测点是「有没有起超时定时器」，所以直接
    // 数 setTimeout 的调用次数。
    // ⚠️ 别用 process.getActiveResourcesInfo() 去数 —— 实测（Node v24.11.0）它
    // **看不见 unref 过的 Timeout**，而 registry 里的定时器全都 unref 过，于是
    // 那把尺子恒读 0，「计数没变」什么也证明不了。
    const realSetTimeout = globalThis.setTimeout;
    let timersCreated = 0;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      timersCreated++;
      return realSetTimeout(...args);
    }) as typeof setTimeout;

    let held: Promise<{ ok: boolean; err?: Error }>;
    try {
      const got = await within(
        callDevice({
          userId: "u1",
          server: "browser",
          payload: { jsonrpc: "2.0", method: "notifications/initialized" },
          expectsReply: false,
        }),
        "notification 立刻 resolve",
      );
      // 立刻 resolve 成 undefined，不等任何人应答。
      assert.equal(got, undefined);

      // 这条是重点：MCP 握手里的 notifications/initialized **每个 turn 都会来一次**。
      // 登记成 pending 就是每个 turn 泄漏一个定时器 + 一个永远 pending 的 promise，
      // 而且要等 5 分钟才「超时」。
      assert.equal(timersCreated, 0, "notification 不该起超时定时器");

      // 尺子自检：真登记 pending 的调用**确实**会让计数 +1。没有这一条，
      // 上面那句「计数没变」可能只是因为尺子坏了。
      held = settled(
        callDevice({
          userId: "u1",
          server: "browser",
          payload: {},
          expectsReply: true,
          timeoutMs: 60_000,
        }),
      );
      assert.equal(timersCreated, 1, "expectsReply:true 应该登记一个超时定时器");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    const frame = t.rpcs()[0];
    assert.ok(frame);
    assert.equal(frame.expectsReply, false);
    assert.equal(frame.server, "browser");
    assert.ok(frame.id, "notification 也要有 id，日志靠它对得上");
    assert.deepEqual(frame.payload, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    // 没登记的另一半证据：迟到「应答」找不到任何 pending，静默丢弃。
    assert.doesNotThrow(() => settle("u1", frame.id, { ok: true, payload: "不该有人在等" }));

    drop("u1", "cleanup");
    assert.equal((await within(held, "drop 拒掉那个自检用的挂起调用")).ok, false);
  }
  resetForTests();

  // ── 6. 暂停（决策 8）：暂停 ≠ 断开 ────────────────────────────────────────
  {
    const t = makeTransport();
    admit({ userId: "u1", hello: makeHello(), transport: t, revalidate: alwaysValid });
    setReady("u1", [{ name: "browser", ok: true }, { name: "fs", ok: true }]);
    assert.deepEqual(availableServers("u1").sort(), ["browser", "fs"]);

    setPaused("u1", true);
    // 对上层等同于「这台设备不存在」：装配了工具却调不通，比一开始就说没有更糟。
    assert.equal(availableServers("u1").length, 0);
    const paused = await within(
      settled(
        callDevice({ userId: "u1", server: "browser", payload: {}, expectsReply: true }),
      ),
      "暂停期间的 RPC",
    );
    assert.equal(paused.ok, false);
    assert.match(paused.err?.message ?? "", /paused/);
    // notification 也一样被挡掉，不能偷偷放行。
    const pausedNotify = await within(
      settled(
        callDevice({ userId: "u1", server: "browser", payload: {}, expectsReply: false }),
      ),
      "暂停期间的 notification",
    );
    assert.equal(pausedNotify.ok, false);

    // 但设备**还连着** —— 暂停是托盘上的一个开关，不是断线。UI 要能看到它。
    const live = connectedDevice("u1");
    assert.equal(live?.deviceId, "dev-1");
    assert.equal(live?.paused, true);
    assert.deepEqual(live?.servers.sort(), ["browser", "fs"]);

    setPaused("u1", false);
    assert.deepEqual(availableServers("u1").sort(), ["browser", "fs"]);
    assert.equal(connectedDevice("u1")?.paused, false);
    const resumed = await within(
      callDevice({ userId: "u1", server: "browser", payload: {}, expectsReply: false }),
      "恢复之后的 notification",
    );
    assert.equal(resumed, undefined);
  }
  resetForTests();

  // ── 7. ready 之前没有可用 server；spawn 失败的不算数 ──────────────────────
  {
    const t = makeTransport();
    const r = admit({
      userId: "u1",
      hello: makeHello(),
      transport: t,
      revalidate: alwaysValid,
    });
    assert.equal(r.ok, true);

    // ready === null 是「还不知道」，和「确定一个都没有」不同，但对上层一样：
    // 没 ready 就当没有这只手。
    assert.equal(availableServers("u1").length, 0);
    assert.ok(r.ok === true && r.device.servers.length === 0);
    assert.equal(connectedDevice("u1")?.servers.length, 0);

    await quiet(() =>
      setReady("u1", [
        { name: "browser", ok: true },
        { name: "fs", ok: false, error: "ENOENT" },
        { name: "transfer", ok: true },
      ]),
    );
    // 起失败的 fs 绝不能出现：装配了却调不通是最糟的一种。
    assert.deepEqual(availableServers("u1").sort(), ["browser", "transfer"]);

    // 重新下发配置 = 回到「还不知道」，旧的 ready 集合作废。
    pushConfig("u1", [{ name: "browser" }]);
    assert.equal(availableServers("u1").length, 0);
    const cfg = t.frames.at(-1);
    assert.equal(cfg?.t, "config");

    // 全失败也是合法的 ready：结果是空，但不会抛。
    await quiet(() => setReady("u1", [{ name: "browser", ok: false, error: "boom" }]));
    assert.equal(availableServers("u1").length, 0);
    assert.notEqual(connectedDevice("u1"), undefined);

    // 没连着的账号，这些写操作都必须是安全的 no-op。
    assert.doesNotThrow(() => setReady("nobody", [{ name: "x", ok: true }]));
    assert.doesNotThrow(() => setPaused("nobody", true));
    assert.doesNotThrow(() => pushConfig("nobody", []));
    assert.doesNotThrow(() => touch("nobody"));
    assert.equal(availableServers("nobody").length, 0);
  }
  resetForTests();

  // ── 8. 心跳重验（决策 14）：session cookie 没有实时吊销，只能在这里补 ──────
  {
    const t = makeTransport();
    let valid = true;
    admit({
      userId: "u1",
      hello: makeHello(),
      transport: t,
      revalidate: () => valid,
    });

    // 还有效时：心跳只是发 ping，连接留着。
    tick();
    assert.notEqual(connectedDevice("u1"), undefined);
    assert.ok(t.frames.some((f) => f.t === "ping"));
    assert.equal(t.closed.length, 0);

    // 登出 / 改密码 / 删号之后，重验返回 false。cookie 是无状态 HMAC，
    // 不在这里重验的话这条 WS 会一直活到 30 天 TTL 到期。
    valid = false;
    tick();
    assert.equal(connectedDevice("u1"), undefined);
    assert.equal(t.closed.length, 1);
    assert.match(t.closed[0] ?? "", /session/i);

    // 重验**抛异常**必须也断开：fail-closed 是全仓纪律，不能把「查不出来」当放行。
    const t2 = makeTransport();
    admit({
      userId: "u2",
      hello: makeHello(),
      transport: t2,
      revalidate: () => {
        throw new Error("db is down");
      },
    });
    await quiet(() => tick());
    assert.equal(connectedDevice("u2"), undefined);
    assert.equal(t2.closed.length, 1);
    assert.match(t2.closed[0] ?? "", /session/i);

    // ping 发不出去也算掉线。
    const t3 = makeTransport();
    admit({ userId: "u3", hello: makeHello(), transport: t3, revalidate: alwaysValid });
    t3.breakSends();
    tick();
    assert.equal(connectedDevice("u3"), undefined);
    assert.deepEqual(t3.closed, ["send failed"]);
  }
  resetForTests();

  // ── 9. 心跳判死 ──────────────────────────────────────────────────────────
  {
    const t0 = 1_700_000_000_000;
    const t = makeTransport();
    let revalidated = 0;
    admit({
      userId: "u1",
      hello: makeHello(),
      transport: t,
      revalidate: () => {
        revalidated++;
        return true;
      },
      now: t0,
    });

    // 刚好没到期限：活着。
    tick(t0 + DEAD_AFTER_MS);
    assert.notEqual(connectedDevice("u1"), undefined);

    // 任何一帧到达都算活着 —— touch 把窗口往后推。
    touch("u1", t0 + DEAD_AFTER_MS);
    tick(t0 + DEAD_AFTER_MS + 1);
    assert.notEqual(connectedDevice("u1"), undefined);

    const before = revalidated;
    tick(t0 + DEAD_AFTER_MS * 2 + 2);
    assert.equal(connectedDevice("u1"), undefined);
    assert.deepEqual(t.closed, ["heartbeat timeout"]);
    // 判死先于重验：已经死的连接没必要再去查一次账号。
    assert.equal(revalidated, before);
  }
  resetForTests();

  // ── 10. 迟到的应答不炸 ───────────────────────────────────────────────────
  {
    const t = makeTransport();
    admit({ userId: "u1", hello: makeHello(), transport: t, revalidate: alwaysValid });

    // 完全不认识的 id / 账号：静默丢弃，绝不能抛 —— 这条路径的调用方是
    // ws.ts 的消息循环，抛出去就是整条连接挂掉。
    assert.doesNotThrow(() => settle("u1", "no-such-id", { ok: true, payload: 1 }));
    assert.doesNotThrow(() => settle("u1", "no-such-id", { ok: false, message: "nope" }));
    assert.doesNotThrow(() => settle("nobody", "whatever", { ok: true, payload: 1 }));

    // 正常路径还是要能 settle 的（证明上面不是因为 settle 整个是个空壳）。
    const okCall = settled(
      callDevice({
        userId: "u1",
        server: "browser",
        payload: {},
        expectsReply: true,
        timeoutMs: 60_000,
      }),
    );
    const id1 = t.rpcs().at(-1)?.id;
    assert.ok(id1);
    settle("u1", id1, { ok: true, payload: { hello: "world" } });
    assert.deepEqual(await within(okCall, "settle(ok) 唤醒调用方"), { ok: true });

    // 同一个 id 再来一次（重复应答）也必须静默。
    assert.doesNotThrow(() => settle("u1", id1, { ok: true, payload: "又来一遍" }));

    // 设备回传输层错误 → reject。
    const errCall = settled(
      callDevice({
        userId: "u1",
        server: "browser",
        payload: {},
        expectsReply: true,
        timeoutMs: 60_000,
      }),
    );
    const id2 = t.rpcs().at(-1)?.id;
    assert.ok(id2);
    settle("u1", id2, { ok: false, message: "spawn failed" });
    const errRes = await within(errCall, "settle(error) 唤醒调用方");
    assert.equal(errRes.ok, false);
    assert.equal(errRes.err?.message, "spawn failed");

    // 真正超时之后迟到的应答（第 4 条里的场景，这里再钉一次「drop 之后」）。
    const dropped = settled(
      callDevice({
        userId: "u1",
        server: "browser",
        payload: {},
        expectsReply: true,
        timeoutMs: 60_000,
      }),
    );
    const id3 = t.rpcs().at(-1)?.id;
    assert.ok(id3);
    drop("u1", "device disconnected");
    assert.equal((await within(dropped, "drop 拒掉最后那个挂起调用")).ok, false);
    assert.doesNotThrow(() => settle("u1", id3, { ok: true, payload: "太晚了" }));
  }
  resetForTests();

  // ── 11. connToken：一条半死连接的迟到 close 不能踢掉重连上来的那条 ────────
  //
  // 这是变异测试抓出来的真 bug（2026-08-30 修）。时序：
  //   ① 心跳判死 A → drop(A)，A 的 socket 收到 close 请求但对端已经不通；
  //   ② 家人的机器醒来，客户端重连成 B，admit(B) 成功；
  //   ③ A 的 close 事件这时才终于触发。
  // 如果 ③ 无条件 drop(userId)，B 就被从注册表里删掉，而 B 的 socket 还开着 ——
  // 服务端以为没人连、客户端以为连着，谁也不会重连。Windows 机器睡眠/唤醒
  // 正好是这条路径的高频场景，不是边缘情况。
  {
    const a = makeTransport();
    const b = makeTransport();

    const admitA = admit({
      userId: "u1",
      hello: makeHello({ deviceId: "dev-a", label: "睡着之前那条" }),
      transport: a,
      revalidate: alwaysValid,
    });
    assert.ok(admitA.ok);
    const tokenA = admitA.ok ? admitA.connToken : "";
    assert.ok(tokenA, "admit 必须回一条代表这次连接的 token");

    // ① 心跳判死 A（心跳自己不带 token —— 它踢的就是当前那条）
    drop("u1", "heartbeat timeout");
    assert.equal(connectedDevice("u1"), undefined);

    // ② 重连成 B
    const admitB = admit({
      userId: "u1",
      hello: makeHello({ deviceId: "dev-b", label: "醒来之后那条" }),
      transport: b,
      revalidate: alwaysValid,
    });
    assert.ok(admitB.ok);
    const tokenB = admitB.ok ? admitB.connToken : "";
    assert.notEqual(tokenA, tokenB, "两次 admit 的 token 必须不同");

    // ③ A 的迟到 close —— 带着**自己的** token，所以必须被忽略
    drop("u1", "device disconnected", tokenA);
    assert.equal(
      connectedDevice("u1")?.deviceId,
      "dev-b",
      "迟到的 close 不得踢掉后来重连上的那条连接",
    );
    assert.equal(b.closed.length, 0, "B 的 transport 不该被关");

    // 带对的 token 才真的关
    drop("u1", "device disconnected", tokenB);
    assert.equal(connectedDevice("u1"), undefined);
    assert.deepEqual(b.closed, ["device disconnected"]);
  }
  resetForTests();

  console.log("registry.test.ts: all assertions passed");
} finally {
  // ⚠️ 必须收掉 registry 那个模块级 setInterval。它 unref 过，但留着也没意义。
  resetForTests();
}
