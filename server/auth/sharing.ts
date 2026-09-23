// 会话共享：owner 之外，还有谁能读到这条资源。
//
// 和 ownership.ts 的分工：那边回答「归谁」（一个资源恰好一个 owner），这边回答
// 「还给谁看过」（任意多人）。
//
// ⚠️ **共享只给读，不给管。** 能不能删、能不能改配置，永远只看 ownership。
// 这个区分落在 server/auth/policy.ts 的 `OwnsSpec.access` 上：缺省 `"owner"`，
// 只有显式写了 `access: "reader"` 的路由才会来问这张表。新加路由默认落在严格的
// 那一侧，这是刻意的 —— 和整个 policy 表 fail-closed 的取向一致。

import { getDb, transact } from "../db.ts";
import type { ResourceKind } from "./ownership.ts";
import { listUsers } from "./users.ts";

export type ShareRow = {
  userId: string;
  username: string;
  sharedBy: string;
  createdAt: number;
};

// 谁能读到 resourceId（不含 owner，也不含管理员的全局 bypass）。
export function isSharedWith(resourceId: string, userId: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 AS ok FROM shares WHERE resource_id = ? AND user_id = ?")
    .get(resourceId, userId) as { ok?: number } | undefined;
  return !!row?.ok;
}

// 一次查询，给 visibilityFor 用 —— 和 resourceIdsOwnedBy 同样的形状。
export function resourceIdsSharedWith(userId: string): Set<string> {
  const rows = getDb()
    .prepare("SELECT resource_id AS id FROM shares WHERE user_id = ?")
    .all(userId) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

// resourceId → 共享者的 user id。列表侧拿它渲染「由 X 共享」。
export function sharedByFor(userId: string): Map<string, string> {
  const rows = getDb()
    .prepare("SELECT resource_id AS id, shared_by AS by FROM shares WHERE user_id = ?")
    .all(userId) as Array<{ id: string; by: string }>;
  return new Map(rows.map((r) => [r.id, r.by]));
}

// 这条资源当前共享给了谁。username 是 join 出来的：这里和 file_deletions 不同，
// 它回答的是**现在**的状态，账号没了这条共享也会被 CASCADE 带走。
export function sharesOf(resourceId: string): ShareRow[] {
  const rows = getDb()
    .prepare(
      `SELECT s.user_id AS userId, u.username AS username,
              s.shared_by AS sharedBy, s.created_at AS createdAt
         FROM shares s JOIN users u ON u.id = s.user_id
        WHERE s.resource_id = ?
        ORDER BY u.username`,
    )
    .all(resourceId) as ShareRow[];
  return rows;
}

// 整份名单替换，而不是逐条 add/remove：UI 是一组复选框，"提交我勾选的这些人"
// 是它唯一的动作。逐条接口会逼前端自己算差集，然后在两次请求之间留一个中间态。
//
// ownerId 会被过滤掉：给 owner 自己发一条共享是死数据，而且会让「取消共享」看起来
// 像是能把 owner 踢出自己的会话。
export function setShares(opts: {
  resourceId: string;
  kind: ResourceKind;
  userIds: readonly string[];
  sharedBy: string;
  ownerId?: string | null;
}): ShareRow[] {
  const known = new Set(listUsers().map((u) => u.id));
  const wanted = new Set(
    opts.userIds.filter((id) => known.has(id) && id !== opts.ownerId),
  );
  const db = getDb();
  transact(() => {
    db.prepare("DELETE FROM shares WHERE resource_id = ?").run(opts.resourceId);
    const insert = db.prepare(
      `INSERT INTO shares(resource_id, user_id, kind, shared_by, created_at)
            VALUES (?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    for (const id of wanted) {
      insert.run(opts.resourceId, id, opts.kind, opts.sharedBy, now);
    }
  });
  return sharesOf(opts.resourceId);
}

// resourceId → 被共享给了几个人。列表侧拿它给「已共享出去」的会话打标 ——
// 不然 owner 只能靠逐个打开对话框才知道哪些共享过，而"我到底把什么给出去了"
// 正是这个功能最该一眼看见的事。
export function shareCounts(): Map<string, number> {
  const rows = getDb()
    .prepare("SELECT resource_id AS id, COUNT(*) AS n FROM shares GROUP BY resource_id")
    .all() as Array<{ id: string; n: number }>;
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

export function clearShares(resourceId: string): void {
  getDb().prepare("DELETE FROM shares WHERE resource_id = ?").run(resourceId);
}

export function dropShare(resourceId: string, userId: string): void {
  getDb()
    .prepare("DELETE FROM shares WHERE resource_id = ? AND user_id = ?")
    .run(resourceId, userId);
}
