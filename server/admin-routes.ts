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
import { recordOpenedProject } from "./opened-projects.ts";
import {
  InvalidUsernameError,
  WorkspaceExistsError,
  assertUsableUsername,
  createWorkspace,
  ensureWorkspace,
  removeEmptyWorkspace,
  workspaceDirFor,
  workspacePatternFor,
  workspacePatternIn,
} from "./auth/workspaces.ts";

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
  const users = listUsers().map((u) => {
    const all = getAllowedPaths(u.id);
    // The workspace row is server-managed, so it is reported separately rather
    // than mixed into the textarea the admin edits (decision 27) — an editor
    // whose content silently reappears after you delete it reads as a bug.
    const managed = workspacePatternIn(u.username, all);
    return {
      ...u,
      allowedPaths: all.filter((p) => p !== managed),
      workspace: managed ? { dir: workspaceDirFor(u.username), pattern: managed } : null,
      ownedResources: resourceIdsOwnedBy(u.id).size,
    };
  });
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
    assertUsableUsername(username);
  } catch (err) {
    if (err instanceof InvalidUsernameError) {
      return c.json({ error: "invalid username", detail: err.message }, 400);
    }
    throw err;
  }

  // A workspace by default, for ordinary accounts only (decision 24): an admin
  // can already open everything, so a folder of their own would be noise.
  // Still default-CLOSED in the sense that matters — the account is handed a
  // brand-new empty directory, never anything that already had content in it.
  const wantWorkspace = role === "user" && body.workspace !== false;

  // Order matters (decision 28). Claim the directory BEFORE the row exists, so
  // a refusal leaves nothing behind; roll the directory back if the insert then
  // fails. The reverse order would leave half-made accounts whenever the disk
  // says no.
  let dir: string | undefined;
  if (wantWorkspace) {
    try {
      dir = await createWorkspace(username);
    } catch (err) {
      if (err instanceof WorkspaceExistsError) {
        return c.json(
          {
            error: "workspace exists",
            // Deliberately not reused silently: the previous holder of this
            // name may have left files in there (decision 25).
            detail: `${err.dir} 已存在（很可能是同名账号删除后留下的）。请换个用户名，或先手动处理这个目录。`,
          },
          409,
        );
      }
      throw err;
    }
  }

  try {
    const manual = asPatterns(body.allowedPaths) ?? [];
    const user = createUser({
      username,
      password,
      role,
      allowedPaths: dir ? [workspacePatternFor(username), ...manual] : manual,
    });
    // Put it in "recent projects" too (decision 23), or a new user still lands
    // on an empty home screen and has to go hunting in the picker.
    if (dir) recordOpenedProject(dir, user.id);
    return c.json({ user });
  } catch (err) {
    if (dir) await removeEmptyWorkspace(dir);
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
    if (body.role === "user") {
      // Demotion narrows the whitelist to just the workspace (decision 29).
      // Otherwise a demoted admin keeps `**` and the role change is cosmetic as
      // far as the filesystem goes. The UI confirms this destroys the old list;
      // promotion deliberately does NOT do the mirror image, because silently
      // WIDENING someone's access is a different kind of surprise.
      const dir = await ensureWorkspace(target.username);
      setAllowedPaths(id, [workspacePatternFor(target.username)]);
      recordOpenedProject(dir, id);
    }
  }
  if (typeof body.password === "string" && body.password) {
    setPassword(id, body.password);
  }

  // The workspace row survives an ordinary whitelist save and is removed only
  // by asking (decision 26) — the admin's textarea carries the manual patterns
  // only, so applying it verbatim would silently revoke the workspace.
  const patterns = asPatterns(body.allowedPaths);
  const removeWorkspace = body.removeWorkspace === true;
  const addWorkspace = body.createWorkspace === true;
  if (patterns || removeWorkspace || addWorkspace) {
    const now = getAllowedPaths(id);
    const managed = workspacePatternIn(target.username, now);
    const manual = (patterns ?? now).filter((p) => p !== managed);
    let keep = managed;
    if (removeWorkspace) keep = null;
    if (addWorkspace) {
      // Restoring what the button above took away. mkdir -p, not the strict
      // create: the directory is this account's own, contents and all.
      await ensureWorkspace(target.username);
      keep = workspacePatternFor(target.username);
      recordOpenedProject(workspaceDirFor(target.username), id);
    }
    setAllowedPaths(id, keep ? [keep, ...manual] : manual);
  }

  const all = getAllowedPaths(id);
  const managed = workspacePatternIn(target.username, all);
  return c.json({
    user: {
      ...getUserById(id)!,
      allowedPaths: all.filter((p) => p !== managed),
      workspace: managed
        ? { dir: workspaceDirFor(target.username), pattern: managed }
        : null,
    },
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
