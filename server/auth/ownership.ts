// Who owns a session / thread / group.
//
// Kept in its own table rather than as a field inside the session files,
// because those files belong to the Claude and Codex CLIs — and the Claude tree
// is shared with the user's own terminal sessions.

import { getDb } from "../db.ts";

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

// An UNOWNED resource is visible to admins only (decision 10): the orphans
// include the machine owner's own terminal sessions, which should not show up
// in a colleague's list.
export function canAccessResource(
  user: { id: string; role: "admin" | "user" },
  resourceId: string,
): boolean {
  if (user.role === "admin") return true; // decision 11
  return ownerOf(resourceId) === user.id;
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
