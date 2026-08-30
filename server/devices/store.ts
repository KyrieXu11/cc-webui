// 设备与本地 MCP 配置的**耐久事实**。在线状态不在这儿 —— 那是 registry.ts。
//
// 两张表都以 user_id 为（部分）主键，都带 `REFERENCES users(id) ON DELETE
// CASCADE`，所以删账号会连带删掉它的设备记录和 MCP 配置。这是对的：这两样
// 东西的全部意义就是「这个账号的那台机器」，账号没了它们也就没有含义。
// （对比 file_deletions：那张表故意**不加**外键并冗余存 username，因为它的
// 意义正是**事后**回答「是谁删的」，那时账号可能已经不在了。）
//
// ⚠️ local_mcp_servers 没有任何自动写入路径（决策 16：v1 手工配、不做管理
// 界面）。所以读侧必须把「一行都没有」当成正常情况 —— 那表示这个账号没有
// 本地 MCP server，不是错误。第一个家人账号连上来时这张表一定是空的。

import { getDb, transact } from "../db.ts";
import { SERVER_NAME_RE, type LocalMcpServerSpec } from "./protocol.ts";

export type DeviceRecord = {
  userId: string;
  deviceId: string;
  label: string;
  platform: string;
  clientVersion: string;
  lastSeenMs: number;
  createdAt: number;
};

/**
 * 记下（或更新）某账号的设备。
 *
 * ⚠️ 主键是 user_id，所以这是一次真正的「换机」：同一个账号从另一台机器连上来，
 * 旧行被覆盖，device_id 变了、created_at 保持首次注册的时间。
 * 决策 5「一账号一设备」的**并发**那一半靠这个主键（不是靠应用层 check-then-
 * insert，那正是当初逼着整个仓库上 SQLite 的那类竞态）；「拒绝第二条连接」
 * 那一半在 registry.ts，因为它管的是在线，不是耐久。
 */
export function upsertDevice(
  d: Omit<DeviceRecord, "createdAt">,
  now = Date.now(),
): void {
  getDb()
    .prepare(
      `INSERT INTO devices(user_id, device_id, label, platform, client_version, last_seen_ms, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         device_id      = excluded.device_id,
         label          = excluded.label,
         platform       = excluded.platform,
         client_version = excluded.client_version,
         last_seen_ms   = excluded.last_seen_ms`,
    )
    .run(
      d.userId,
      d.deviceId,
      d.label,
      d.platform,
      d.clientVersion,
      d.lastSeenMs,
      now,
    );
}

export function getDevice(userId: string): DeviceRecord | null {
  const row = getDb()
    .prepare(
      `SELECT user_id AS userId, device_id AS deviceId, label, platform,
              client_version AS clientVersion, last_seen_ms AS lastSeenMs,
              created_at AS createdAt
         FROM devices WHERE user_id = ?`,
    )
    .get(userId) as DeviceRecord | undefined;
  return row ?? null;
}

/**
 * 心跳落盘。**只**更新 last_seen_ms —— 它回答「这台机器上次出现是什么时候」，
 * 在设备离线时仍然有意义，和「现在是否连着」是两个不同的问题（后者只在内存里）。
 */
export function touchDevice(userId: string, now = Date.now()): void {
  getDb()
    .prepare("UPDATE devices SET last_seen_ms = ? WHERE user_id = ?")
    .run(now, userId);
}

export function removeDevice(userId: string): void {
  getDb().prepare("DELETE FROM devices WHERE user_id = ?").run(userId);
}

// ─── 本地 MCP 配置 ───────────────────────────────────────────────────────────

type SpecRow = { name: string; spec: string };

/**
 * 某账号该在自己机器上起哪些 MCP server。
 *
 * ⚠️ 这里的 try/catch 不是防御性编程的仪式：spec 是手工 INSERT 进去的 JSON
 * TEXT（决策 16 没有写入路径来保证它合法），一条坏行不该让这个账号的**所有**
 * 本地工具消失。坏行跳过 + 打一行日志 —— 静默跳过的话，配错了以后现场只能
 * 看到「工具没出现」，查不到任何线索。
 * （session-store.ts:473 那个 JSON.parse 先例没做这层，别学它。）
 */
export function listLocalMcpServers(userId: string): LocalMcpServerSpec[] {
  const rows = getDb()
    .prepare(
      `SELECT name, spec FROM local_mcp_servers
        WHERE user_id = ? AND enabled = 1
        ORDER BY name`,
    )
    .all(userId) as SpecRow[];

  const out: LocalMcpServerSpec[] = [];
  for (const r of rows) {
    if (!SERVER_NAME_RE.test(r.name)) {
      console.warn(
        `[devices] skipping local MCP server with illegal name ${JSON.stringify(r.name)} (user=${userId})`,
      );
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.spec);
    } catch (err) {
      console.warn(
        `[devices] local MCP server ${r.name} (user=${userId}) has unparseable spec:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(
        `[devices] local MCP server ${r.name} (user=${userId}) spec is not an object`,
      );
      continue;
    }
    // name 以列为准，不信 spec 里可能存在的同名字段 —— 列才是主键的一部分。
    out.push({ ...(parsed as Omit<LocalMcpServerSpec, "name">), name: r.name });
  }
  return out;
}

/**
 * 整表替换某账号的配置。照 auth/users.ts 的 setAllowedPaths 写法（DELETE +
 * 循环 INSERT，整个包在 transact 里）。
 *
 * v1 没有任何 HTTP 路由调它（决策 16：手工配），它存在是为了让「手工配」不必
 * 手写 SQL —— 以及为了让将来的管理界面有个现成的收口。
 */
export function setLocalMcpServers(
  userId: string,
  servers: LocalMcpServerSpec[],
): void {
  // 名字先全部校验完再动库：一半写进去一半被拒是最难查的状态。
  for (const s of servers) {
    if (!SERVER_NAME_RE.test(s.name.trim())) {
      throw new Error(`illegal local MCP server name: ${JSON.stringify(s.name)}`);
    }
  }
  transact(() => {
    const db = getDb();
    db.prepare("DELETE FROM local_mcp_servers WHERE user_id = ?").run(userId);
    const ins = db.prepare(
      `INSERT INTO local_mcp_servers(user_id, name, spec, enabled)
            VALUES (?, ?, ?, 1)`,
    );
    for (const s of servers) {
      const { name: _dropped, ...rest } = s;
      ins.run(userId, s.name.trim(), JSON.stringify(rest));
    }
  });
}
