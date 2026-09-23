// Who owns a session / thread / group.
//
// Kept in its own table rather than as a field inside the session files,
// because those files belong to the Claude and Codex CLIs — and the Claude tree
// is shared with the user's own terminal sessions.

import { getDb, transact } from "../db.ts";
import { dropShare, isSharedWith } from "./sharing.ts";

export type ResourceKind = "claude" | "codex" | "group";

export function recordOwner(
  resourceId: string,
  kind: ResourceKind,
  userId: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO ownership(resource_id, kind, user_id, created_at)
            VALUES (?, ?, ?, ?)
       ON CONFLICT(resource_id) DO NOTHING`,
    )
    .run(resourceId, kind, userId, Date.now());
}

export function ownerOf(resourceId: string): string | null {
  const row = getDb()
    .prepare("SELECT user_id AS userId FROM ownership WHERE resource_id = ?")
    .get(resourceId) as { userId?: string } | undefined;
  return row?.userId ?? null;
}

export function resourceIdsOwnedBy(
  userId: string,
  kind?: ResourceKind,
): Set<string> {
  const rows = (
    kind
      ? getDb()
          .prepare(
            "SELECT resource_id AS id FROM ownership WHERE user_id = ? AND kind = ?",
          )
          .all(userId, kind)
      : getDb()
          .prepare("SELECT resource_id AS id FROM ownership WHERE user_id = ?")
          .all(userId)
  ) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

// 两级：`owner` = 能改能删，`reader` = 只能读（owner ∪ 被共享者）。
//
// ⚠️ 缺省是 `owner`，也就是**严格**的那一级。新路由不写 access 就落在严格侧,
// 和整张 policy 表 fail-closed 的取向一致 —— 反过来（缺省宽松、危险的路由记得
// 收紧）正是 policy.ts 文件头说的那种失败模式。
export type AccessLevel = "owner" | "reader";

// An UNOWNED resource is visible to admins only (decision 10): the orphans
// include the machine owner's own terminal sessions, which should not show up
// in a colleague's list.
export function canAccessResource(
  user: { id: string; role: "admin" | "user" },
  resourceId: string,
  level: AccessLevel = "owner",
): boolean {
  if (user.role === "admin") return true; // decision 11
  if (ownerOf(resourceId) === user.id) return true;
  return level === "reader" && isSharedWith(resourceId, user.id);
}

// 换 owner。和 recordOwner 是两件事：那个是 `ON CONFLICT DO NOTHING`（"第一个
// 声明的人赢"，因为它跑在每个 turn 里，不能被后来者改写），这个是显式的转交动作。
//
// 顺手删掉新 owner 名下的共享行：他现在直接拥有这条资源，那行共享既是死数据，
// 又会让共享面板显示成「已共享给自己」。
export function transferOwner(
  resourceId: string,
  kind: ResourceKind,
  userId: string,
): void {
  transact(() => {
    getDb()
      .prepare(
        `INSERT INTO ownership(resource_id, kind, user_id, created_at)
              VALUES (?, ?, ?, ?)
         ON CONFLICT(resource_id) DO UPDATE SET user_id = excluded.user_id`,
      )
      .run(resourceId, kind, userId, Date.now());
    dropShare(resourceId, userId);
  });
}

// 一次查询取回整张归属表。
//
// 会话列表最多要标注 SEARCH_WINDOW(1000) 条，而 `IN (…)` 在 SQLite 上有 999 个
// 参数的上限 —— 与其分批，不如整表拿：这张表一条会话一行，量级和用户建过的会话
// 总数相同（本机是两位数）。真到了需要分页的规模，改这一个函数就够。
export function ownerMap(): Map<string, string> {
  const rows = getDb()
    .prepare("SELECT resource_id AS id, user_id AS userId FROM ownership")
    .all() as Array<{ id: string; userId: string }>;
  return new Map(rows.map((r) => [r.id, r.userId]));
}

export function kindOf(resourceId: string): ResourceKind | null {
  const row = getDb()
    .prepare("SELECT kind FROM ownership WHERE resource_id = ?")
    .get(resourceId) as { kind?: ResourceKind } | undefined;
  return row?.kind ?? null;
}

// Re-key when a provider hands back a different id than we asked for (Claude
// issues its own session id on the first turn).
export function relabelOwner(oldId: string, newId: string): void {
  if (!oldId || oldId === newId) return;
  const owner = ownerOf(oldId);
  if (!owner) return;
  const db = getDb();
  const kindRow = db
    .prepare("SELECT kind FROM ownership WHERE resource_id = ?")
    .get(oldId) as { kind?: ResourceKind } | undefined;
  if (!kindRow?.kind) return;
  recordOwner(newId, kindRow.kind, owner);
}

// Claim everything that has no owner yet (decision 15: existing data belongs to
// the first admin). Called once when that admin is seeded, and available as an
// explicit admin action afterwards.
//
// Claude session files are deliberately NOT enumerated: an unowned resource is
// already admin-visible (decision 10), so writing a row for each of the
// hundreds of jsonl files under ~/.claude/projects would change nothing that
// anyone can observe. Groups and Codex sessions are claimed because they are
// already rows in this database — cheap, and it makes the admin page show real
// counts instead of zero.
export function claimUnowned(userId: string): {
  projects: number;
  groups: number;
  codexSessions: number;
} {
  const db = getDb();
  return transact(() => {
    // The primary key is (user_id, path), so a path the admin already has must
    // be replaced rather than inserted twice.
    const projects = Number(
      db
        .prepare(
          "UPDATE OR REPLACE opened_projects SET user_id = ? WHERE user_id = ''",
        )
        .run(userId).changes,
    );

    const claim = (table: string, idCol: string, kind: ResourceKind) => {
      const rows = db
        .prepare(
          `SELECT ${idCol} AS id FROM ${table}
            WHERE ${idCol} NOT IN (SELECT resource_id FROM ownership)`,
        )
        .all() as Array<{ id: string }>;
      for (const r of rows) recordOwner(r.id, kind, userId);
      return rows.length;
    };

    return {
      projects,
      groups: claim("groups_index", "gid", "group"),
      codexSessions: claim("codex_sessions", "session_id", "codex"),
    };
  });
}
