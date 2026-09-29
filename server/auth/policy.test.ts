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
// Otherwise createUser() mkdirs into the developer's real ~/.cc-webui.
process.env.CC_WEBUI_WORKSPACES_DIR = path.join(tmp, "workspaces");
// Never let this test dial a real bot.
process.env.CC_WEBUI_DOTENV = path.join(tmp, "empty.env");
await fs.mkdir(tmp, { recursive: true });
await fs.writeFile(path.join(tmp, "empty.env"), "");

const { closeDb } = await import("../db.ts");
const { ROUTE_POLICIES, routeKey, policyFor } = await import("./policy.ts");
const { createUser, getAllowedPaths, setAllowedPaths, deleteUser } =
  await import("./users.ts");
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

  // Nothing under /api may be public except the auth entry points, MCP, and the
  // two ONLYOFFICE container-side endpoints.
  //
  // The office pair is public for the same reason MCP is: the caller is not a
  // browser and carries no cookie. A DocumentServer container fetches the file
  // and posts the edit back, authenticating with a signed ticket in the query
  // string (server/office.ts) — plus, on the callback, a JWT inside the body.
  // Both legs run over host.docker.internal to the loopback and never traverse
  // nginx, so the reverse proxy should 404 them exactly like /api/mcp/*.
  //
  // /api/mcp/local/:server is the desktop-client relay (docs/desktop-client.md).
  // Same shape as the other three: a per-turn bearer token, callable only by the
  // local CLI child process, and it fails closed when the token has no ownerId.
  //
  // ⚠️ NOT on this list, deliberately: the desktop installer download
  // (/api/client/download/:file) is auth:"user" — the client's main process
  // downloads it with the session cookie it already holds (decision 27).
  // And the device WebSocket is not a Hono route at all, so it can never appear
  // here — which is exactly why server/devices/ws.test.ts exists.
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
      "/api/mcp/local/:server",
      "/api/mcp/memory",
      "/api/mcp/schedule",
      "/api/office/callback",
      "/api/office/download",
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

  // ── admin surface is admin-only ──────────────────────────────────────────

  assert.equal((await app.request("/api/admin/users")).status, 401, "anonymous");
  assert.equal(
    (await app.request("/api/admin/users", { headers: cookie(plain.id) })).status,
    403,
    "a plain user must not reach the admin API",
  );
  const adminList = await app.request("/api/admin/users", { headers: cookie(admin.id) });
  assert.equal(adminList.status, 200);
  assert.ok(
    (await adminList.json()).users.some((u: { username: string }) => u.username === "alice"),
  );

  // The last admin cannot be demoted or deleted — there is no password reset
  // channel here, so locking everyone out would be permanent.
  const demote = await app.request(`/api/admin/users/${admin.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...cookie(admin.id) },
    body: JSON.stringify({ role: "user" }),
  });
  assert.equal(demote.status, 409);
  assert.match((await demote.json()).error, /last admin/);

  const selfDelete = await app.request(`/api/admin/users/${admin.id}`, {
    method: "DELETE",
    headers: cookie(admin.id),
  });
  assert.equal(selfDelete.status, 409);
  assert.match((await selfDelete.json()).error, /own account/);

  // A new account is default-closed.
  const created = await app.request("/api/admin/users", {
    method: "POST",
    headers: { "content-type": "application/json", ...cookie(admin.id) },
    body: JSON.stringify({ username: "carol", password: "pw" }),
  });
  assert.equal(created.status, 200);
  const carolId = (await created.json()).user.id;
  const carolRow = (await (
    await app.request("/api/admin/users", { headers: cookie(admin.id) })
  ).json()).users.find((u: { id: string }) => u.id === carolId);
  assert.deepEqual(carolRow.allowedPaths, [], "new users may open nothing");
  assert.equal(carolRow.role, "user");

  // Duplicate usernames are refused rather than silently overwriting.
  assert.equal(
    (
      await app.request("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json", ...cookie(admin.id) },
        body: JSON.stringify({ username: "carol", password: "pw" }),
      })
    ).status,
    409,
  );

  // ── the handlerScoped declarations are not hollow ────────────────────────
  //
  // Every list endpoint marked handlerScoped in policy.ts used to return
  // everything to everybody. These assertions are what makes that declaration
  // mean something.

  const { getDb: db2 } = await import("../db.ts");
  const { recordOpenedProject } = await import("../opened-projects.ts");

  // Two codex sessions, one per user.
  db2()
    .prepare("INSERT INTO codex_sessions(session_id, summary, last_modified) VALUES (?,?,?)")
    .run("11111111-1111-4111-8111-111111111111", "alice thread", 10);
  db2()
    .prepare("INSERT INTO codex_sessions(session_id, summary, last_modified) VALUES (?,?,?)")
    .run("22222222-2222-4222-8222-222222222222", "bob thread", 20);
  recordOwner("11111111-1111-4111-8111-111111111111", "codex", plain.id);
  const bob = createUser({ username: "bob", password: "x", role: "user" });
  recordOwner("22222222-2222-4222-8222-222222222222", "codex", bob.id);

  const sessionsFor = async (id: string) =>
    (
      await (
        await app.request("/api/sessions?limit=50&provider=codex", {
          headers: cookie(id),
        })
      ).json()
    ).sessions.map((x: { sessionId: string }) => x.sessionId);

  assert.deepEqual(await sessionsFor(plain.id), [
    "11111111-1111-4111-8111-111111111111",
  ]);
  assert.deepEqual(await sessionsFor(bob.id), [
    "22222222-2222-4222-8222-222222222222",
  ]);
  // The admin sees both (decision 11).
  assert.equal((await sessionsFor(admin.id)).length, 2);

  // Groups: realGid is the admin's, so neither plain user may list it.
  const groupsFor = async (id: string) =>
    (
      await (await app.request("/api/groups", { headers: cookie(id) })).json()
    ).groups.map((g: { id: string }) => g.id);
  assert.deepEqual(await groupsFor(plain.id), []);
  assert.ok((await groupsFor(admin.id)).includes(realGid));

  // Recents are per-user, not one shared list.
  recordOpenedProject("/alice/only", plain.id, 5);
  recordOpenedProject("/bob/only", bob.id, 6);
  const recentsFor = async (id: string) =>
    (
      await (await app.request("/api/fs/recents", { headers: cookie(id) })).json()
    ).recents.map((r: { path: string }) => r.path);
  assert.deepEqual(await recentsFor(plain.id), ["/alice/only"]);
  assert.deepEqual(await recentsFor(bob.id), ["/bob/only"]);

  // ── a permission prompt may only be answered by its owner ────────────────

  const { awaitPermission, resolvePermission } = await import("../permission.ts");
  const ac = new AbortController();
  const pendingId = randomUUID();
  const answered = awaitPermission(pendingId, ac.signal, { ownerId: plain.id });

  // Another user cannot resolve it, and cannot tell "not mine" from "no such id".
  assert.equal(resolvePermission(pendingId, { behavior: "allow" }, { userId: bob.id }), false);
  assert.equal(
    resolvePermission(randomUUID(), { behavior: "allow" }, { userId: plain.id }),
    false,
  );
  // The owner can.
  assert.equal(
    resolvePermission(pendingId, { behavior: "allow" }, { userId: plain.id }),
    true,
  );
  assert.deepEqual(await answered, { behavior: "allow" });

  // AskUserQuestion answers ride the same route: the tool's own input schema
  // has an `answers` field "collected by the permission component", and without
  // it the CLI returns "The user did not answer the questions."
  const askId = randomUUID();
  const asked = awaitPermission(askId, ac.signal, { ownerId: plain.id });
  const posted = await app.request(`/api/permission/${askId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...cookie(plain.id) },
    body: JSON.stringify({
      behavior: "allow",
      answers: { "喜欢红还是蓝？": "蓝", bogus: 42 },
    }),
  });
  assert.equal(posted.status, 200);
  // Non-string values are dropped rather than passed through to the CLI.
  assert.deepEqual(await asked, {
    behavior: "allow",
    answers: { "喜欢红还是蓝？": "蓝" },
  });

  // Admins can answer anyone's, consistent with decision 11.
  const adminId2 = randomUUID();
  const answered2 = awaitPermission(adminId2, ac.signal, { ownerId: plain.id });
  assert.equal(
    resolvePermission(adminId2, { behavior: "deny", message: "no" }, {
      userId: admin.id,
      isAdmin: true,
    }),
    true,
  );
  assert.deepEqual(await answered2, { behavior: "deny", message: "no" });

  // A group prompt is answerable by gid — that is how a Feishu card click,
  // which carries a chat rather than an account, is authorised.
  const gidPromptId = randomUUID();
  const answered3 = awaitPermission(gidPromptId, ac.signal, { gid: "g-abc" });
  assert.equal(
    resolvePermission(gidPromptId, { behavior: "allow" }, { gid: "g-other" }),
    false,
    "a click in a different chat must not resolve it",
  );
  assert.equal(
    resolvePermission(gidPromptId, { behavior: "allow" }, { gid: "g-abc" }),
    true,
  );
  await answered3;

  // ── bash tasks are attributed through their session ──────────────────────

  const { canSeeTaskSession, taskSessionOwner } = await import("./scope.ts");
  recordOwner("33333333-3333-4333-8333-333333333333", "claude", plain.id);
  assert.equal(taskSessionOwner("33333333-3333-4333-8333-333333333333"), plain.id);
  // Group scope is "gid:agentId", so ownership hangs off the part before ":".
  recordOwner("g-owned", "group", bob.id);
  assert.equal(taskSessionOwner("g-owned:claude"), bob.id);
  assert.equal(canSeeTaskSession(bob, "g-owned:codex"), true);
  assert.equal(canSeeTaskSession(plain, "g-owned:codex"), false);
  // A task with no session cannot be attributed, so only admins see it.
  assert.equal(canSeeTaskSession(plain, undefined), false);
  assert.equal(canSeeTaskSession(admin, undefined), true);

  // ── an empty whitelist means an empty whitelist ──────────────────────────
  //
  // `paths: [{ key: "cwd", optional: true }]` used to mean "no cwd in the body
  // → no check", while chat.ts fell back to CC_WEBUI_CWD || process.cwd(). So
  // an account allowed NOTHING could still start a turn, in the server's own
  // checkout. The spec's `fallback` makes the middleware check the value the
  // handler will actually use.

  for (const route of ["/api/chat", "/api/groups"]) {
    const res = await app.request(route, {
      method: "POST",
      headers: { "content-type": "application/json", ...cookie(plain.id) },
      body: JSON.stringify({ prompt: "hi" }),
    });
    assert.equal(res.status, 403, route);
    assert.match((await res.json()).detail ?? "", /outside the folders/, route);
  }

  // ── Codex requires an explicit admin grant (supersedes decision 14) ────────────────────────────────────
  //
  // `codex exec` has no --ask-for-approval, so on that side every mode is
  // unrestricted writes. The UI hides the picker, but the UI is not the gate.
  const codexTurn = await app.request("/api/codex/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...cookie(plain.id) },
    body: JSON.stringify({ prompt: "hi", cwd: tmp }),
  });
  assert.equal(codexTurn.status, 403);
  // The provider grant must be what refused, not the path check — otherwise
  // whitelisting a folder would quietly hand the account a Codex agent.
  assert.equal((await codexTurn.json()).error, "provider_not_allowed");

  // ── 工作区：建号时发一块地，服务端管着它那条 pattern ────────────────────

  const wsRoot = process.env.CC_WEBUI_WORKSPACES_DIR!;

  const createUserVia = (body: Record<string, unknown>) =>
    app.request("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookie(admin.id) },
      body: JSON.stringify(body),
    });
  const rowFor = async (username: string) =>
    (
      await (
        await app.request("/api/admin/users", { headers: cookie(admin.id) })
      ).json()
    ).users.find((u: { username: string }) => u.username === username);

  assert.equal((await createUserVia({ username: "dave", password: "pw" })).status, 200);
  const dave = await rowFor("dave");
  const daveDir = path.join(wsRoot, "dave");
  assert.ok((await fs.stat(daveDir)).isDirectory(), "workspace directory");
  // The scan realpaths what it returns, and on macOS /var is a symlink.
  const realDaveDir = await fs.realpath(daveDir);
  // Reported apart from the textarea's contents (decision 27).
  assert.deepEqual(dave.allowedPaths, []);
  assert.equal(dave.workspace.dir, daveDir);
  assert.equal(dave.workspace.pattern, path.join(daveDir, "**"));
  // ...and it really is in the whitelist, not just in the response shape.
  assert.ok(getAllowedPaths(dave.id).includes(dave.workspace.pattern));
  // Seeded into recents (decision 23) so the home screen is not empty.
  assert.ok(
    (await (await app.request("/api/fs/recents", { headers: cookie(dave.id) })).json())
      .recents.some((r: { path: string }) => r.path === daveDir),
  );

  // walkDirs skips dot-directories and the workspace lives under ~/.cc-webui,
  // so /api/fs/scan has to add it back — otherwise an account whose only grant
  // IS its workspace opens the picker and sees an empty list.
  const scanned = (
    await (await app.request("/api/fs/scan", { headers: cookie(dave.id) })).json()
  ).dirs as string[];
  assert.ok(
    scanned.some((d) => d === daveDir || d === realDaveDir),
    `workspace missing from the picker: ${JSON.stringify(scanned)}`,
  );

  // Saving the textarea must not drop the managed row (decision 26).
  await app.request(`/api/admin/users/${dave.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...cookie(admin.id) },
    body: JSON.stringify({ allowedPaths: ["/srv/shared/**"] }),
  });
  // Order is not meaningful — the set is what matters.
  assert.deepEqual(getAllowedPaths(dave.id).sort(), [
    "/srv/shared/**",
    dave.workspace.pattern,
  ].sort());

  // Removing it is an explicit action, and leaves the directory alone.
  await app.request(`/api/admin/users/${dave.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...cookie(admin.id) },
    body: JSON.stringify({ removeWorkspace: true }),
  });
  assert.deepEqual(getAllowedPaths(dave.id), ["/srv/shared/**"]);
  assert.ok((await fs.stat(daveDir)).isDirectory(), "directory survives removal");

  // A name whose directory already exists is refused rather than inherited
  // (decision 25) — that directory may hold the previous holder's files.
  const reuse = await createUserVia({ username: "dave2", password: "pw" });
  assert.equal(reuse.status, 200);
  deleteUser((await rowFor("dave2")).id);
  const again = await createUserVia({ username: "dave2", password: "pw" });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, "workspace exists");

  // A username that cannot be a directory name is refused up front.
  const bad = await createUserVia({ username: "Bad Name", password: "pw" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "invalid username");
  // ...and the account is not created as a side effect.
  assert.equal(await rowFor("Bad Name"), undefined);

  // Admins get no workspace even if asked (decision 24).
  assert.equal(
    (await createUserVia({ username: "root2", password: "pw", role: "admin", workspace: true }))
      .status,
    200,
  );
  assert.equal((await rowFor("root2")).workspace, null);

  // Demotion narrows the whitelist to the workspace (decision 29) — otherwise
  // the role change leaves `**` in place and means nothing on disk.
  const root2 = await rowFor("root2");
  setAllowedPaths(root2.id, ["**"]);
  await app.request(`/api/admin/users/${root2.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...cookie(admin.id) },
    body: JSON.stringify({ role: "user" }),
  });
  assert.deepEqual(getAllowedPaths(root2.id), [path.join(wsRoot, "root2", "**")]);
  assert.ok((await fs.stat(path.join(wsRoot, "root2"))).isDirectory());

  // ── deleting a session: a colleague may not unlink your terminal history ──
  //
  // ~/.claude/projects is SHARED with the machine owner's own terminal
  // `claude`, and the web UI lists whatever it finds there. Those files are
  // unowned (decision 5b), so the ownership check is the only thing between a
  // colleague's delete button and a transcript cc-webui never created.

  const projRoot = process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR!;
  const slugDir = path.join(projRoot, "-Users-someone-proj");
  await fs.mkdir(slugDir, { recursive: true });

  const del = (id: string, who: string) =>
    app.request(`/api/sessions/${id}`, {
      method: "DELETE",
      headers: cookie(who),
    });

  const terminalSession = randomUUID();
  const terminalFile = path.join(slugDir, `${terminalSession}.jsonl`);
  await fs.writeFile(terminalFile, '{"type":"user","content":"typed in a terminal"}\n');

  assert.equal((await del(terminalSession, plain.id)).status, 404);
  // The route answers {ok:true} whether or not a file went away, so the file
  // itself is the assertion that matters.
  await fs.access(terminalFile);

  // Their own session is theirs to delete.
  const ownSession = randomUUID();
  const ownFile = path.join(slugDir, `${ownSession}.jsonl`);
  await fs.writeFile(ownFile, "{}\n");
  recordOwner(ownSession, "claude", plain.id);
  assert.equal((await del(ownSession, plain.id)).status, 200);
  await assert.rejects(fs.access(ownFile));

  // The admin still can delete the orphan: that is the machine owner deleting
  // their own history, deliberately left possible (decisions 5b & 15).
  assert.equal((await del(terminalSession, admin.id)).status, 200);
  await assert.rejects(fs.access(terminalFile));

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

  // ── the serveDist branch is part of the route table too ──────────────────
  //
  // Regression (2026-08-27): the production app mounts a static handler plus a
  // fallback, and a fallback written as `app.all("/api/*", …)` **took down the
  // whole API**. targetRoute() reads the LAST non-"/*" entry of
  // c.req.matchedRoutes, so a route registered after the real ones matches
  // every /api/* request; having no policy entry, fail-closed answered 403 for
  // everything. It escaped this file because the coverage block above builds
  // createApp() with no options — i.e. never the shape production runs.
  process.env.CC_WEBUI_GROUPS_ENABLED = "1";
  const prod = createApp({ serveDist: true });
  delete process.env.CC_WEBUI_GROUPS_ENABLED;

  const prodUncovered = routesOf(prod)
    .filter((r) => r.path !== "/*")
    .filter((r) => !policyFor(r.method, r.path));
  assert.deepEqual(
    prodUncovered,
    [],
    "serveDist must not register any route of its own — use app.notFound()",
  );

  // And the behaviour that fallback exists for: an unknown /api path answers
  // JSON, not index.html. A stale backend serving HTML to fetch().json() shows
  // up as `Unexpected token '<'`, which names neither the route nor the cause.
  const ghost = await prod.request("/api/no-such-thing", { headers: cookie(admin.id) });
  assert.equal(ghost.status, 404);
  assert.match((await ghost.json()).error, /no such API route/);

  assert.equal((await prod.request("/api/meta", { headers: cookie(admin.id) })).status, 200);

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
    "CC_WEBUI_WORKSPACES_DIR",
    "CC_WEBUI_DOTENV",
    "CC_WEBUI_GROUPS_ENABLED",
  ]) {
    delete process.env[k];
  }
  await fs.rm(tmp, { recursive: true, force: true });
}
