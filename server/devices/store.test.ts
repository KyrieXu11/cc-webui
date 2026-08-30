// server/devices/store.ts 的测试。钉的是 store.ts 注释里写下的那些决策：
// 「一账号一设备」在 schema 层（主键 = user_id）、账号没了设备记录也该没、
// 以及本地 MCP 配置读侧的容错（决策 16 手工配 → 库里什么脏数据都可能有）。

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// ⚠️ 并行跑 20+ 个测试文件，tmp 目录用 mkdtemp 拿唯一名，别用时间戳后缀。
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-webui-devices-store-"));
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
// ⚠️ createUser() 会往工作区根 mkdir；不改这个就是往开发者真实的 ~/.cc-webui 里写。
process.env.CC_WEBUI_WORKSPACES_DIR = path.join(tmp, "workspaces");

// ⚠️ 必须是动态 import：静态 import 会被提升到上面那几行赋值之前，
// 于是 dbPath() 读到的是真实的 ~/.cc-webui/cc-webui.db —— 而且**不报错**。
const { getDb, closeDb } = await import("../db.ts");
const { createUser, deleteUser } = await import("../auth/users.ts");
const { SERVER_NAME_RE } = await import("./protocol.ts");
const {
  upsertDevice,
  getDevice,
  touchDevice,
  removeDevice,
  listLocalMcpServers,
  setLocalMcpServers,
} = await import("./store.ts");

/** 直接写 local_mcp_servers —— 决策 16 说这张表本来就是手工 INSERT 的，
 *  读侧的容错只能用「手工写进去的脏行」来测，setLocalMcpServers 会先挡掉。 */
function rawInsertSpec(
  userId: string,
  name: string,
  spec: string,
  enabled = 1,
): void {
  getDb()
    .prepare(
      "INSERT INTO local_mcp_servers(user_id, name, spec, enabled) VALUES (?, ?, ?, ?)",
    )
    .run(userId, name, spec, enabled);
}

function clearSpecs(userId: string): void {
  getDb().prepare("DELETE FROM local_mcp_servers WHERE user_id = ?").run(userId);
}

function countRows(table: "devices" | "local_mcp_servers", userId?: string) {
  const sql =
    userId === undefined
      ? `SELECT COUNT(*) AS n FROM ${table}`
      : `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`;
  const stmt = getDb().prepare(sql);
  const row = (userId === undefined ? stmt.get() : stmt.get(userId)) as {
    n: number | bigint;
  };
  return Number(row.n);
}

/** 暂存 console.warn、收集调用、finally 里恢复。 */
function captureWarnings<T>(fn: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = real;
  }
}

try {
  const alice = createUser({ username: "alice", password: "pw-alice", role: "user" });
  const bob = createUser({ username: "bob", password: "pw-bob", role: "user" });

  // ── 1. 迁移 5 的两张表存在，且 devices 的主键是 user_id ──────────────────
  //
  // 这是决策 5「一账号一设备」在 schema 层的表达。放在库里而不是应用层，
  // 正是为了让两个并发连接之间不存在 check-then-insert 的窗口。
  type ColumnInfo = { name: string; pk: number | bigint; notnull: number | bigint };
  const deviceCols = getDb()
    .prepare("PRAGMA table_info(devices)")
    .all() as ColumnInfo[];
  assert.ok(deviceCols.length > 0, "迁移 5 没建出 devices 表");
  assert.deepEqual(
    deviceCols.filter((c) => Number(c.pk) > 0).map((c) => c.name),
    ["user_id"],
    "devices 的主键必须是 user_id（不是 device_id）——决策 5",
  );

  const specCols = getDb()
    .prepare("PRAGMA table_info(local_mcp_servers)")
    .all() as ColumnInfo[];
  assert.ok(specCols.length > 0, "迁移 5 没建出 local_mcp_servers 表");
  assert.deepEqual(
    specCols
      .filter((c) => Number(c.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((c) => c.name),
    ["user_id", "name"],
    "local_mcp_servers 的主键是 (user_id, name)：一个账号的同名 server 只有一条",
  );

  // 行为侧的同一条：同一个账号第二次 upsert 是**更新**，不是新增一行。
  upsertDevice(
    {
      userId: alice.id,
      deviceId: "dev-old",
      label: "老台式机",
      platform: "win32",
      clientVersion: "0.1.0",
      lastSeenMs: 1_000,
    },
    5_000,
  );
  assert.equal(countRows("devices", alice.id), 1);

  upsertDevice(
    {
      userId: alice.id,
      deviceId: "dev-new",
      label: "新笔记本",
      platform: "darwin",
      clientVersion: "0.2.0",
      lastSeenMs: 2_000,
    },
    9_999,
  );
  assert.equal(
    countRows("devices", alice.id),
    1,
    "换机不该留下第二行 —— 主键是 user_id",
  );

  // ── 2. 换机：created_at 保持首次注册，其余字段全换 ────────────────────────
  const swapped = getDevice(alice.id);
  assert.ok(swapped);
  assert.equal(swapped.deviceId, "dev-new");
  assert.equal(swapped.label, "新笔记本");
  assert.equal(swapped.platform, "darwin");
  assert.equal(swapped.clientVersion, "0.2.0");
  assert.equal(swapped.lastSeenMs, 2_000, "换机时 last_seen_ms 要更新");
  assert.equal(
    swapped.createdAt,
    5_000,
    "created_at 保持首次注册的时间：ON CONFLICT 分支故意不写它",
  );

  // 另一个账号有自己的一行 —— 主键是 user_id，不是全局唯一设备。
  upsertDevice(
    {
      userId: bob.id,
      deviceId: "dev-bob",
      label: "bob-pc",
      platform: "win32",
      clientVersion: "0.2.0",
      lastSeenMs: 3_000,
    },
    3_000,
  );
  assert.equal(countRows("devices"), 2);

  assert.equal(getDevice("no-such-user"), null);

  // 外键是真的开着的（getDb() 里 PRAGMA foreign_keys = ON）：
  // 没有对应账号就写不进设备行。
  assert.throws(
    () =>
      upsertDevice({
        userId: "ghost-user",
        deviceId: "d",
        label: "",
        platform: "",
        clientVersion: "",
        lastSeenMs: 1,
      }),
    /FOREIGN KEY|constraint/i,
  );

  // ── 4. touchDevice 只动 last_seen_ms ─────────────────────────────────────
  //
  // 心跳回答的是「这台机器上次出现是什么时候」，不该顺手改设备身份或名字 ——
  // 那两样只有握手（hello → upsertDevice）才有资格改。
  touchDevice(alice.id, 77_777);
  const touched = getDevice(alice.id);
  assert.ok(touched);
  assert.equal(touched.lastSeenMs, 77_777);
  assert.equal(touched.deviceId, "dev-new", "touchDevice 不该动 device_id");
  assert.equal(touched.label, "新笔记本", "touchDevice 不该动 label");
  assert.equal(touched.platform, "darwin");
  assert.equal(touched.clientVersion, "0.2.0");
  assert.equal(touched.createdAt, 5_000);

  // 不存在的账号 touch 一下是 no-op，不抛（心跳路径不该因为账号刚被删就炸）。
  touchDevice("no-such-user", 1);
  assert.equal(countRows("devices"), 2);

  // ── 5. listLocalMcpServers 的容错 ────────────────────────────────────────

  // 一行都没有 = 正常状态（决策 16 没有自动写入路径，第一个家人账号连上来时
  // 这张表一定是空的），返回空数组而不是抛。
  // ⚠️ 不用 assert.deepEqual(x, [])：那个签名会把 x 就地窄化成 never[]。
  assert.equal(listLocalMcpServers(alice.id).length, 0);

  // 坏 JSON 的那一行被跳过，其它行照常返回 —— 一条坏行不该让这个账号的
  // 所有本地工具消失。同时必须留下一行日志，否则现场只能看到「工具没出现」。
  rawInsertSpec(alice.id, "aaa-good", JSON.stringify({ command: "node", args: ["a.js"] }));
  rawInsertSpec(alice.id, "bbb-broken", "{not json");
  rawInsertSpec(alice.id, "ccc-good", JSON.stringify({ command: "python" }));
  {
    const { value, warnings } = captureWarnings(() => listLocalMcpServers(alice.id));
    assert.deepEqual(
      value.map((s) => s.name),
      ["aaa-good", "ccc-good"],
      "坏行跳过，其它行照常返回",
    );
    assert.equal(warnings.length, 1, "坏行必须打且只打一行日志");
    assert.match(warnings[0], /bbb-broken/);
    assert.match(warnings[0], /unparseable/);
    assert.deepEqual(value[0], { command: "node", args: ["a.js"], name: "aaa-good" });
  }
  clearSpecs(alice.id);

  // spec 是合法 JSON 但顶层不是对象（数组 / 字符串 / null）→ 跳过。
  // 数组这一条尤其重要：typeof [] === "object"，只判 typeof 会让 {...[]} 出去。
  rawInsertSpec(alice.id, "arr", JSON.stringify([{ command: "node" }]));
  rawInsertSpec(alice.id, "str", JSON.stringify("node index.js"));
  rawInsertSpec(alice.id, "nul", "null");
  rawInsertSpec(alice.id, "ok", JSON.stringify({ command: "node" }));
  {
    const { value, warnings } = captureWarnings(() => listLocalMcpServers(alice.id));
    assert.deepEqual(value.map((s) => s.name), ["ok"]);
    assert.equal(warnings.length, 3);
    for (const w of warnings) assert.match(w, /not an object/);
  }
  clearSpecs(alice.id);

  // 名字不合法 → 跳过。它会进 URL path、进 --mcp-config 的 key、
  // 还会进模型看到的工具名 mcp__local-<name>__<tool>，转义一次就没法排查了。
  assert.equal(SERVER_NAME_RE.test("A_b"), false);
  assert.equal(SERVER_NAME_RE.test("has/slash"), false);
  rawInsertSpec(alice.id, "A_b", JSON.stringify({ command: "node" }));
  rawInsertSpec(alice.id, "has/slash", JSON.stringify({ command: "node" }));
  rawInsertSpec(alice.id, "-leading", JSON.stringify({ command: "node" }));
  rawInsertSpec(alice.id, "fine", JSON.stringify({ command: "node" }));
  {
    const { value, warnings } = captureWarnings(() => listLocalMcpServers(alice.id));
    assert.deepEqual(value.map((s) => s.name), ["fine"]);
    assert.equal(warnings.length, 3);
    for (const w of warnings) assert.match(w, /illegal name/);
  }
  clearSpecs(alice.id);

  // enabled = 0 的行不返回（关掉一个 server 不用删行）。
  rawInsertSpec(alice.id, "on", JSON.stringify({ command: "node" }), 1);
  rawInsertSpec(alice.id, "off", JSON.stringify({ command: "node" }), 0);
  {
    const { value, warnings } = captureWarnings(() => listLocalMcpServers(alice.id));
    assert.deepEqual(value.map((s) => s.name), ["on"]);
    assert.equal(warnings.length, 0, "被禁用的行是正常状态，不该打日志");
  }
  clearSpecs(alice.id);

  // name 以**列**为准：列才是主键的一部分，spec 里那个同名字段不算数。
  // （否则一个手抄错的 spec 能让两行 server 同名，工具名直接撞车。）
  rawInsertSpec(
    alice.id,
    "browser",
    JSON.stringify({ name: "imposter", command: "node", args: ["b.js"] }),
  );
  {
    const only = listLocalMcpServers(alice.id);
    assert.equal(only.length, 1);
    assert.equal(only[0].name, "browser");
    assert.equal(only[0].command, "node");
  }
  clearSpecs(alice.id);

  // 账号之间互不可见。
  setLocalMcpServers(bob.id, [{ name: "bob-only", command: "node" }]);
  assert.equal(listLocalMcpServers(alice.id).length, 0);
  assert.deepEqual(listLocalMcpServers(bob.id).map((s) => s.name), ["bob-only"]);

  // ── 6. setLocalMcpServers 是整表替换，且校验先于写入 ─────────────────────
  setLocalMcpServers(alice.id, [
    { name: "one", command: "node" },
    { name: "two", command: "node" },
    { name: "three", command: "node" },
  ]);
  assert.equal(countRows("local_mcp_servers", alice.id), 3);

  setLocalMcpServers(alice.id, [
    { name: "four", command: "node", args: ["--x"], env: { A: "1" }, cwd: "/tmp" },
    { name: "five" },
  ]);
  assert.equal(
    countRows("local_mcp_servers", alice.id),
    2,
    "整表替换：先 DELETE 再 INSERT，不是 5 条",
  );
  assert.deepEqual(listLocalMcpServers(alice.id).map((s) => s.name), ["five", "four"]);
  assert.deepEqual(listLocalMcpServers(alice.id)[1], {
    name: "four",
    command: "node",
    args: ["--x"],
    env: { A: "1" },
    cwd: "/tmp",
  });

  // 批里有一个非法名字 → **整批**都不写。校验在 transact 之前，
  // 所以连 DELETE 都没发生 —— 一半写进去一半被拒是最难查的状态。
  assert.throws(
    () =>
      setLocalMcpServers(alice.id, [
        { name: "six", command: "node" },
        { name: "Bad Name", command: "node" },
      ]),
    /illegal local MCP server name/,
  );
  assert.deepEqual(
    listLocalMcpServers(alice.id).map((s) => s.name),
    ["five", "four"],
    "被拒的那一批一个字节都不该落库（包括不该把旧的删掉）",
  );

  // bob 的配置没被 alice 的整表替换波及（DELETE 带 user_id 条件）。
  assert.deepEqual(listLocalMcpServers(bob.id).map((s) => s.name), ["bob-only"]);

  // 空数组 = 清空，这是合法输入（不是「跳过」）。
  setLocalMcpServers(alice.id, []);
  assert.equal(countRows("local_mcp_servers", alice.id), 0);
  setLocalMcpServers(alice.id, [{ name: "seven", command: "node" }]);

  // ── 3. 外键级联：账号没了，设备记录和本地 MCP 配置也就没有含义了 ─────────
  assert.equal(countRows("devices", alice.id), 1);
  assert.equal(countRows("local_mcp_servers", alice.id), 1);

  assert.equal(deleteUser(alice.id), true);
  assert.equal(
    countRows("devices", alice.id),
    0,
    "ON DELETE CASCADE 没生效（PRAGMA foreign_keys 被关了？）",
  );
  assert.equal(countRows("local_mcp_servers", alice.id), 0);
  assert.equal(getDevice(alice.id), null);
  assert.equal(listLocalMcpServers(alice.id).length, 0);

  // 只删了 alice 的：bob 两张表的行都还在。
  assert.equal(countRows("devices", bob.id), 1);
  assert.equal(countRows("local_mcp_servers", bob.id), 1);

  // removeDevice 只删设备行，不碰 MCP 配置（拔掉一台机器 ≠ 丢掉这个账号
  // 该起哪些 server 的配置，下一台机器连上来还要照着它下发）。
  removeDevice(bob.id);
  assert.equal(getDevice(bob.id), null);
  assert.equal(countRows("local_mcp_servers", bob.id), 1);
  removeDevice(bob.id); // 再删一次是 no-op，不抛

  console.log("store.test.ts: all assertions passed");
} finally {
  closeDb();
  delete process.env.CC_WEBUI_DB;
  delete process.env.CC_WEBUI_WORKSPACES_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
}
