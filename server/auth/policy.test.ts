import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const tmp = path.join(os.tmpdir(), `cc-webui-policy-test-${Date.now()}`);
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CC_WEBUI_COOKIE_SECRET_FILE = path.join(tmp, "cookie-secret");
process.env.CC_WEBUI_GROUPS_DIR = path.join(tmp, "groups");
process.env.CC_WEBUI_SESSION_INDEX = path.join(tmp, "sessions.json");
process.env.CODEX_SESSIONS_DIR = path.join(tmp, "codex-empty");
process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR = path.join(tmp, "claude-projects");
// Never let this test dial a real bot.
process.env.CC_WEBUI_DOTENV = path.join(tmp, "empty.env");
await fs.mkdir(tmp, { recursive: true });
await fs.writeFile(path.join(tmp, "empty.env"), "");

const { closeDb } = await import("../db.ts");
const { ROUTE_POLICIES, routeKey, policyFor } = await import("./policy.ts");
const { createUser } = await import("./users.ts");
const { recordOwner } = await import("./ownership.ts");
const { issueSession, SESSION_COOKIE } = await import("./session.ts");
const { extractParams } = await import("./middleware.ts");

type RouteRow = { method: string; path: string };
const routesOf = (app: unknown): RouteRow[] =>
  ((app as { routes?: RouteRow[] }).routes ?? []).map((r) => ({
    method: r.method,
    path: r.path,
  }));

try {
  // ── the coverage guarantee ───────────────────────────────────────────────
  //
  // Hono's own route list is the source of truth, so this cannot be satisfied
  // by editing a hand-maintained list of routes.

  process.env.CC_WEBUI_GROUPS_ENABLED = "1";
  const { createApp } = await import("../app.ts");
  const appWithGroups = createApp();
  delete process.env.CC_WEBUI_GROUPS_ENABLED;

  const catchAlls = routesOf(appWithGroups).filter((r) => r.path === "/*");
  assert.equal(
    catchAlls.length,
    1,
    "the only '/*' route should be the auth middleware itself — a real API route " +
      "registered as '/*' would slip past the policy lookup",
  );

  const realRoutes = routesOf(appWithGroups).filter((r) => r.path !== "/*");
  assert.ok(realRoutes.length >= 40, `expected the full route table, saw ${realRoutes.length}`);

  const uncovered = realRoutes.filter((r) => !policyFor(r.method, r.path));
  assert.deepEqual(
    uncovered,
    [],
    "every route needs an entry in server/auth/policy.ts — the middleware " +
      "refuses uncovered routes, so this is a build-time reminder, not a nicety",
  );

  // And the other direction: a policy for a route that no longer exists is
  // dead weight that hides real drift.
  const live = new Set(
    realRoutes.flatMap((r) => [routeKey(r.method, r.path), routeKey("ALL", r.path)]),
  );
  const stale = Object.keys(ROUTE_POLICIES).filter((k) => !live.has(k));
  assert.deepEqual(stale, [], "stale policy entries");

  // Group routes must be covered even though they are conditionally mounted.
  const withoutGroups = routesOf(createApp()).filter((r) => r.path !== "/*");
  assert.ok(
    withoutGroups.length < realRoutes.length,
    "groups should be absent when the flag is off",
  );
  assert.ok(
    !withoutGroups.some((r) => r.path.startsWith("/api/groups")),
    "no group route may be mounted with the flag off",
  );

  // Nothing under /api may be public except the auth entry points and MCP.
  const publicApi = realRoutes.filter(
    (r) => r.path.startsWith("/api/") && policyFor(r.method, r.path)?.auth === "public",
  );
  assert.deepEqual(
    publicApi.map((r) => r.path).sort(),
    [
      "/api/auth/login",
      "/api/auth/logout",
      "/api/auth/me",
      "/api/mcp/bash",
      "/api/mcp/lark",
      "/api/mcp/schedule",
    ],
    "the public surface must stay exactly this",
  );

  // Every non-public route needs SOME resource discipline, or an explicit note
  // saying why not. This is what stops "auth: user" alone from looking like a
  // finished job on a route that takes an id.
  const undisciplined = realRoutes.filter((r) => {
    const p = policyFor(r.method, r.path)!;
    if (p.auth === "public") return false;
    return !p.owns && !p.paths && !p.handlerScoped && !p.note;
  });
  assert.deepEqual(undisciplined, [], "needs owns / paths / handlerScoped / note");

  // ── param extraction (c.req.param() is empty in a "/*" middleware) ───────

  assert.deepEqual(extractParams("/api/groups/:gid/stream", "/api/groups/abc/stream"), {
    gid: "abc",
  });
  assert.deepEqual(extractParams("/api/sessions/:id", "/api/sessions/x-1"), { id: "x-1" });
  assert.deepEqual(extractParams("/api/meta", "/api/meta"), {});
  // Percent-encoding is decoded — which is exactly how a traversal arrives.
  assert.deepEqual(extractParams("/api/groups/:gid", "/api/groups/%2e%2e%2f%2e%2e"), {
    gid: "../..",
  });

  // ── enforcement, end to end through the real app ─────────────────────────

  process.env.CC_WEBUI_GROUPS_ENABLED = "1";
  const app = createApp();
  delete process.env.CC_WEBUI_GROUPS_ENABLED;

  const admin = createUser({ username: "root", password: "x", role: "admin", allowedPaths: ["**"] });
  const plain = createUser({ username: "alice", password: "x", role: "user", allowedPaths: [] });
  const cookie = (id: string) => ({ cookie: `${SESSION_COOKIE}=${issueSession(id)}` });

  // Anonymous is refused everywhere except the public surface.
  assert.equal((await app.request("/api/meta")).status, 401);
  assert.equal((await app.request("/api/fs/home")).status, 401);
  assert.equal((await app.request("/api/auth/me")).status, 200, "public");

  // A forged cookie is anonymous.
  assert.equal(
    (await app.request("/api/meta", { headers: { cookie: `${SESSION_COOKIE}=a.b.c` } })).status,
    401,
  );

  // Authenticated but no whitelist → the path check refuses.
  const denied = await app.request("/api/fs/read?path=/etc/hosts", {
    headers: cookie(plain.id),
  });
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /path not allowed/);

  // The admin's ["**"] lets the same request through to the handler.
  assert.notEqual(
    (await app.request("/api/fs/read?path=/etc/hosts", { headers: cookie(admin.id) })).status,
    403,
    "admin whitelist is ['**']",
  );

  // Someone else's resource is a 404, not a 403 — existence is information.
  // Use a group that really exists, so "the middleware let me through" is
  // distinguishable from "the handler could not find it".
  const { createGroup } = await import("../groups/lifecycle.ts");
  const realGid = await createGroup({ title: "owned by admin", cwd: tmp });
  recordOwner(realGid, "group", admin.id);

  const asOwner = await app.request(`/api/groups/${realGid}`, {
    headers: cookie(admin.id),
  });
  assert.equal(asOwner.status, 200, "the owner reaches the handler");
  assert.equal((await asOwner.json()).config.id, realGid);

  const asStranger = await app.request(`/api/groups/${realGid}`, {
    headers: cookie(plain.id),
  });
  assert.equal(asStranger.status, 404, "a stranger must not learn it exists");
  assert.deepEqual(await asStranger.json(), { error: "not found" });

  // Unowned resources are invisible to a plain user (decision 10).
  assert.equal(
    (await app.request(`/api/groups/${randomUUID()}`, { headers: cookie(plain.id) })).status,
    404,
  );

  // ⚠️ The traversal that reached fs.rm(recursive) on $HOME. The format guard
  // runs BEFORE the admin ownership bypass, so even an admin gets a 400.
  for (const who of [plain, admin]) {
    const res = await app.request("/api/groups/%2e%2e%2f%2e%2e", {
      method: "DELETE",
      headers: cookie(who.id),
    });
    assert.equal(res.status, 400, `malformed gid must be refused for ${who.username}`);
    assert.match((await res.json()).error, /malformed/);
  }

  // ── fail-closed: an unclassified route is refused, not waved through ─────

  const { Hono } = await import("hono");
  const { authMiddleware } = await import("./middleware.ts");
  const bare = new Hono();
  bare.use("/*", authMiddleware());
  bare.get("/api/brand-new-route", (c) => c.text("LEAKED"));
  const unclassified = await bare.request("/api/brand-new-route", {
    headers: cookie(admin.id),
  });
  assert.equal(unclassified.status, 403, "a route with no policy must be refused");
  assert.notEqual(await unclassified.text(), "LEAKED");

  console.log("policy.test.ts: all assertions passed");
} finally {
  closeDb();
  for (const k of [
    "CC_WEBUI_DB",
    "CC_WEBUI_COOKIE_SECRET_FILE",
    "CC_WEBUI_GROUPS_DIR",
    "CC_WEBUI_SESSION_INDEX",
    "CODEX_SESSIONS_DIR",
    "CC_WEBUI_CLAUDE_PROJECTS_DIR",
    "CC_WEBUI_DOTENV",
    "CC_WEBUI_GROUPS_ENABLED",
  ]) {
    delete process.env[k];
  }
  await fs.rm(tmp, { recursive: true, force: true });
}
