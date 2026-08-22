// Admin-only management API. Every route here is `auth: "admin"` in
// server/auth/policy.ts, so the middleware rejects a plain user before any
// handler runs.

import { Hono } from "hono";
import {
  createUser,
  deleteUser,
  getAllowedPaths,
  getUserById,
  listUsers,
  setAllowedPaths,
  setPassword,
  setRole,
  type Role,
} from "./auth/users.ts";
import { claimUnowned, resourceIdsOwnedBy } from "./auth/ownership.ts";
import { listAllOpenedProjects } from "./opened-projects.ts";
import {
  listSenderMappings,
  mapSender,
  unmapSender,
} from "./auth/feishu-senders.ts";
import { currentUser } from "./auth/middleware.ts";

const adminRoutes = new Hono();

function isRole(v: unknown): v is Role {
  return v === "admin" || v === "user";
}

function asPatterns(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

// How many admins remain if `excludingId` were removed or demoted. Guards below
// use it so the last admin cannot lock everyone out — there is no password
// reset channel on a single-machine deployment, so that mistake is permanent
// short of editing the database by hand.
function otherAdminCount(excludingId: string): number {
  return listUsers().filter((u) => u.role === "admin" && u.id !== excludingId)
    .length;
}

adminRoutes.get("/users", (c) => {
  const users = listUsers().map((u) => ({
    ...u,
    allowedPaths: getAllowedPaths(u.id),
    ownedResources: resourceIdsOwnedBy(u.id).size,
  }));
  return c.json({ users });
});

adminRoutes.post("/users", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const role: Role = isRole(body.role) ? body.role : "user";
  if (!username || !password) {
    return c.json({ error: "username and password required" }, 400);
  }
  try {
    const user = createUser({
      username,
      password,
      role,
      // Default-closed: a new account may open nothing until an admin says so.
      allowedPaths: asPatterns(body.allowedPaths) ?? [],
    });
    return c.json({ user });
  } catch (err) {
    if (/UNIQUE|constraint/i.test(String(err))) {
      return c.json({ error: "username already exists" }, 409);
    }
    throw err;
  }
});

adminRoutes.patch("/users/:id", async (c) => {
  const id = c.req.param("id");
  const target = getUserById(id);
  if (!target) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));

  if (isRole(body.role) && body.role !== target.role) {
    if (target.role === "admin" && otherAdminCount(id) === 0) {
      return c.json({ error: "cannot demote the last admin" }, 409);
    }
    setRole(id, body.role);
  }
  if (typeof body.password === "string" && body.password) {
    setPassword(id, body.password);
  }
  const patterns = asPatterns(body.allowedPaths);
  if (patterns) setAllowedPaths(id, patterns);

  return c.json({
    user: { ...getUserById(id)!, allowedPaths: getAllowedPaths(id) },
  });
});

adminRoutes.delete("/users/:id", (c) => {
  const id = c.req.param("id");
  const target = getUserById(id);
  if (!target) return c.json({ error: "not found" }, 404);
  const me = currentUser(c);
  if (me?.id === id) {
    return c.json({ error: "cannot delete your own account" }, 409);
  }
  if (target.role === "admin" && otherAdminCount(id) === 0) {
    return c.json({ error: "cannot delete the last admin" }, 409);
  }
  // allowed_paths, ownership and feishu_senders cascade. The user's sessions
  // and groups therefore become UNOWNED, which makes them admin-only rather
  // than deleting them (decision 10) — the transcripts are still on disk.
  deleteUser(id);
  return c.json({ ok: true });
});

// Claim every unowned row for the calling admin. Idempotent; exists because
// the first-admin seed only runs once, and data can go unowned again whenever a
// user is deleted.
adminRoutes.post("/claim-unowned", (c) => {
  const me = currentUser(c)!;
  return c.json({ claimed: claimUnowned(me.id) });
});

adminRoutes.get("/opened-projects", (c) => {
  const byId = new Map(listUsers().map((u) => [u.id, u.username]));
  const records = listAllOpenedProjects().map((r) => ({
    ...r,
    // "" is the unowned bucket: rows imported from the old shared
    // recents.json, from before anyone had an account.
    username: r.userId ? (byId.get(r.userId) ?? "(deleted)") : "(unowned)",
  }));
  return c.json({ records });
});

adminRoutes.get("/feishu-senders", (c) => {
  const byId = new Map(listUsers().map((u) => [u.id, u.username]));
  return c.json({
    mappings: listSenderMappings().map((m) => ({
      ...m,
      username: byId.get(m.userId) ?? "(deleted)",
    })),
  });
});

adminRoutes.put("/feishu-senders", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const openId = typeof body.openId === "string" ? body.openId.trim() : "";
  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!openId) return c.json({ error: "openId required" }, 400);
  if (!userId) {
    return c.json({ ok: unmapSender(openId) });
  }
  if (!getUserById(userId)) return c.json({ error: "unknown user" }, 400);
  mapSender(openId, userId);
  return c.json({ ok: true });
});

export { adminRoutes };
