// Which cc-webui user a turn runs as.
//
// An HTTP request carries a login cookie, so `currentUser(c)` answers this.
// Turns that start OUTSIDE a request do not: a Feishu message carries an
// open_id, not an account. Those turns still reach the bash / lark MCP tools —
// the one capability surface that bypasses the route middleware entirely — so
// they need an identity too, and it has to be resolved in ONE place instead of
// defaulted at each call site (a per-call-site default is how "forgot to pass
// it" silently becomes "ran as admin").

import { ownerOf } from "./ownership.ts";
import { listUsers, type User } from "./users.ts";

// listUsers() is ORDER BY created_at, so the first admin is the seeded one —
// the machine's owner (decisions 7 & 15).
export function serviceAdmin(): User | null {
  return listUsers().find((u) => u.role === "admin") ?? null;
}

// A group turn runs as the group's OWNER, not as whoever poked it: an admin
// running a turn inside a colleague's group gets the colleague's guardrails,
// which is the conservative direction. An unowned group belongs to the machine
// owner (decision 10) — and since nothing on the Feishu path ever creates an
// owned group, that is also what makes Feishu run as the admin.
export function actorForResource(resourceId: string): string | undefined {
  return ownerOf(resourceId) ?? serviceAdmin()?.id;
}
