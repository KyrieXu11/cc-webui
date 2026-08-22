// Feishu open_id → cc-webui user.
//
// An unmapped sender is refused (decision 4). That is also what closes the
// documented "anyone in the group can @ the bot and it runs" hole — the bot
// used to act for whoever spoke.

import { getDb } from "../db.ts";

export function userForSender(openId: string): string | null {
  const row = getDb()
    .prepare("SELECT user_id AS userId FROM feishu_senders WHERE open_id = ?")
    .get(openId) as { userId?: string } | undefined;
  return row?.userId ?? null;
}

export function listSenderMappings(): Array<{ openId: string; userId: string }> {
  return getDb()
    .prepare(
      "SELECT open_id AS openId, user_id AS userId FROM feishu_senders ORDER BY open_id",
    )
    .all() as Array<{ openId: string; userId: string }>;
}

export function mapSender(openId: string, userId: string): void {
  getDb()
    .prepare(
      `INSERT INTO feishu_senders(open_id, user_id) VALUES (?, ?)
       ON CONFLICT(open_id) DO UPDATE SET user_id = excluded.user_id`,
    )
    .run(openId, userId);
}

export function unmapSender(openId: string): boolean {
  const res = getDb()
    .prepare("DELETE FROM feishu_senders WHERE open_id = ?")
    .run(openId);
  return Number(res.changes) > 0;
}
