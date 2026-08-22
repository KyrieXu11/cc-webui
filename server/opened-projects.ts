// "Projects this user has opened" — replaces ~/.cc-webui/recents.json.
//
// The old file was ONE shared array capped at 20 entries. With several users
// that is not merely a privacy problem: one person opening a few projects
// evicts everyone else's list. The cap now lives at read time (LIMIT), not in
// the stored data.
//
// `userId` is "" until the permissions module lands; see docs/user-permissions.md.

import { getDb } from "./db.ts";

export type OpenedProject = { path: string; lastUsed: number };

export const DEFAULT_RECENTS_LIMIT = 20;

export function listOpenedProjects(
  userId = "",
  limit = DEFAULT_RECENTS_LIMIT,
): OpenedProject[] {
  return (
    getDb()
      .prepare(
        `SELECT path, last_used AS lastUsed
           FROM opened_projects
          WHERE user_id = ?
          ORDER BY last_used DESC
          LIMIT ?`,
      )
      .all(userId, limit) as OpenedProject[]
  );
}

// One atomic UPSERT, so two turns recording the same path cannot lose one
// another's timestamp the way the old read-modify-write file did.
export function recordOpenedProject(
  path: string,
  userId = "",
  now = Date.now(),
): void {
  getDb()
    .prepare(
      `INSERT INTO opened_projects(user_id, path, last_used)
            VALUES (?, ?, ?)
       ON CONFLICT(user_id, path) DO UPDATE SET last_used = excluded.last_used`,
    )
    .run(userId, path, now);
}

export function removeOpenedProject(path: string, userId = ""): void {
  getDb()
    .prepare("DELETE FROM opened_projects WHERE user_id = ? AND path = ?")
    .run(userId, path);
}
