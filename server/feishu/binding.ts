// Feishu chat → cc-webui group bindings. Backed by SQLite (see server/db.ts);
// the previous ~/.cc-webui/feishu/bindings.json is imported once at startup.
//
// Keyed by chat_id alone, deliberately: in a Feishu group both @claude and
// @codex must resolve to the SAME gid so they can see each other's replies.
// A per-bot key would give each bot its own group inside one chat.
//
// The functions stay async even though SQLite here is synchronous — callers in
// handler.ts await them, and keeping the shape means this swap touches no
// call sites.

import { getDb } from "../db.ts";

export async function getBinding(chatId: string): Promise<string | undefined> {
  const row = getDb()
    .prepare("SELECT gid FROM feishu_bindings WHERE chat_id = ?")
    .get(chatId) as { gid?: string } | undefined;
  return row?.gid;
}

export async function setBinding(chatId: string, gid: string): Promise<void> {
  getDb()
    .prepare(
      `INSERT INTO feishu_bindings(chat_id, gid, updated_at)
            VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE
            SET gid = excluded.gid, updated_at = excluded.updated_at`,
    )
    .run(chatId, gid, Date.now());
}

export async function removeBinding(chatId: string): Promise<boolean> {
  const res = getDb()
    .prepare("DELETE FROM feishu_bindings WHERE chat_id = ?")
    .run(chatId);
  return Number(res.changes) > 0;
}
