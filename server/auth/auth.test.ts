import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = path.join(os.tmpdir(), `cc-webui-auth-test-${Date.now()}`);
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CC_WEBUI_COOKIE_SECRET_FILE = path.join(tmp, "cookie-secret");
await fs.mkdir(tmp, { recursive: true });

const { closeDb } = await import("../db.ts");
const { hashPassword, verifyPassword } = await import("./passwords.ts");
const { issueSession, readSession, parseCookie, sessionCookie, resetSecretCache } =
  await import("./session.ts");
const {
  normalizePath,
  normalizePattern,
  canonicalizePattern,
  matchesAnyPattern,
  assertCanOpen,
  PathNotAllowedError,
} = await import("./paths.ts");
const { claimUnowned, ownerOf, recordOwner, canAccessResource } =
  await import("./ownership.ts");
const {
  createUser,
  authenticate,
  getUserByUsername,
  getUserById,
  listUsers,
  setPassword,
  setRole,
  deleteUser,
  getAllowedPaths,
  setAllowedPaths,
  countUsers,
  seedAdminFromEnv,
} = await import("./users.ts");

try {
  // ── passwords ────────────────────────────────────────────────────────────

  const { hash, salt } = hashPassword("correct horse");
  assert.equal(verifyPassword("correct horse", hash, salt), true);
  assert.equal(verifyPassword("wrong horse", hash, salt), false);
  assert.equal(verifyPassword("correct horse", hash, "other-salt"), false);
  assert.equal(verifyPassword("correct horse", "not-hex-at-all", salt), false);
  assert.equal(verifyPassword("correct horse", "ab", salt), false, "short hash");
  // A fresh salt per call, so identical passwords do not share a hash.
  assert.notEqual(hashPassword("same").hash, hashPassword("same").hash);

  // ── session cookie ───────────────────────────────────────────────────────

  const token = issueSession("user-1");
  assert.equal(readSession(token), "user-1");
  assert.equal(readSession(undefined), null);
  assert.equal(readSession(""), null);
  assert.equal(readSession("garbage"), null);
  assert.equal(readSession("a.b.c"), null, "unsigned");
  // Expired.
  const past = issueSession("user-1", Date.now() - 40 * 24 * 60 * 60 * 1000);
  assert.equal(readSession(past), null, "expired token must be refused");
  // Tampering with either half breaks the signature.
  const [uid, exp, sig] = token.split(".");
  assert.equal(readSession(`user-2.${exp}.${sig}`), null, "swapped user id");
  assert.equal(readSession(`${uid}.${Number(exp) + 1}.${sig}`), null, "extended exp");
  assert.equal(readSession(`${uid}.${exp}.${"0".repeat(sig.length)}`), null);
  // Rotating the secret invalidates everything — the documented way to revoke.
  await fs.rm(path.join(tmp, "cookie-secret"));
  resetSecretCache();
  assert.equal(readSession(token), null, "old cookie dies with the old secret");

  const header = sessionCookie(issueSession("u"), false);
  assert.ok(header.includes("HttpOnly"));
  assert.ok(header.includes("SameSite=Lax"));
  assert.ok(!header.includes("Secure"), "plain http would never send it back");
  assert.ok(sessionCookie(issueSession("u"), true).includes("Secure"));

  assert.equal(parseCookie("a=1; cc_webui_session=xyz; b=2", "cc_webui_session"), "xyz");
  assert.equal(parseCookie(undefined, "cc_webui_session"), undefined);
  assert.equal(parseCookie("other=1", "cc_webui_session"), undefined);

  // ── path whitelist ───────────────────────────────────────────────────────

  const real = path.join(tmp, "projects", "alpha");
  await fs.mkdir(real, { recursive: true });
  const outside = path.join(tmp, "secret");
  await fs.mkdir(outside, { recursive: true });
  const link = path.join(tmp, "projects", "sneaky");
  await fs.symlink(outside, link);

  // realpath resolves an existing path, including through symlinks.
  assert.equal(await normalizePath(real), await fs.realpath(real));
  assert.equal(await normalizePath(link), await fs.realpath(outside));
  // ".." collapses.
  assert.equal(
    await normalizePath(path.join(real, "..", "alpha")),
    await fs.realpath(real),
  );
  // A leaf that does not exist yet still normalises (so "create this project
  // directory" works) while its existing ancestors are still resolved.
  assert.equal(
    await normalizePath(path.join(real, "not-created-yet")),
    path.join(await fs.realpath(real), "not-created-yet"),
  );

  const projects = path.join(tmp, "projects");
  assert.equal(matchesAnyPattern(real, [`${projects}/*`]), true);
  assert.equal(matchesAnyPattern(path.join(real, "deep", "er"), [`${projects}/*`]), false);
  assert.equal(matchesAnyPattern(path.join(real, "deep", "er"), [`${projects}/**`]), true);
  // A bare directory implies its subtree, so entries need not be written twice.
  assert.equal(matchesAnyPattern(real, [projects]), true);
  assert.equal(matchesAnyPattern(projects, [projects]), true);
  // Prefix-only must NOT match: /a/b may not authorise /a/bc.
  assert.equal(matchesAnyPattern(`${projects}-other/x`, [`${projects}/**`]), false);
  assert.equal(matchesAnyPattern(real, []), false, "no patterns = nothing allowed");
  // A bare "**" must mean "anything" — it is the admin's default whitelist.
  // Resolving it against process.cwd() instead of "/" made it match nothing.
  assert.equal(matchesAnyPattern(real, ["**"]), true);
  assert.equal(matchesAnyPattern("/etc/hosts", ["**"]), true);
  // Node's "**" matches zero or more segments, so it covers "/" too. That is
  // the intent for an admin whose whitelist is ["**"].
  assert.equal(matchesAnyPattern("/", ["**"]), true);
  // "~" expands to the home directory.
  assert.equal(matchesAnyPattern(path.join(os.homedir(), "code", "x"), ["~/code/**"]), true);
  assert.equal(matchesAnyPattern("/elsewhere/x", ["~/code/**"]), false);
  // Patterns are normalised, so a ".." inside one cannot smuggle in a parent.
  assert.equal(matchesAnyPattern("/a/b/c", ["/a/x/../b/**"]), true);

  // macOS puts os.tmpdir() under /var, which is a symlink to /private/var — so
  // this only works because assertCanOpen canonicalises the pattern too.
  assert.equal(await assertCanOpen(real, [`${projects}/*`]), await fs.realpath(real));
  assert.equal(
    await canonicalizePattern(`${projects}/*`),
    path.join(await fs.realpath(projects), "*"),
    "the literal prefix resolves, the glob part is left alone",
  );
  assert.equal(
    normalizePattern("**"),
    path.join(path.sep, "**"),
    "a bare glob is rooted at /, not at process.cwd()",
  );
  // A pattern pointing at something not yet created is kept as written.
  assert.equal(
    await canonicalizePattern("/definitely/not/here/**"),
    "/definitely/not/here/**",
  );
  await assert.rejects(
    () => assertCanOpen(outside, [`${projects}/**`]),
    PathNotAllowedError,
  );
  // The symlink escape is caught because normalisation happens first.
  await assert.rejects(
    () => assertCanOpen(link, [`${projects}/**`]),
    PathNotAllowedError,
    "a symlink pointing out of the whitelist must be refused",
  );

  // ── users ────────────────────────────────────────────────────────────────

  assert.equal(countUsers(), 0);
  const admin = createUser({
    username: "root",
    password: "pw-1",
    role: "admin",
    allowedPaths: ["/a/**", " /b "],
  });
  assert.equal(admin.role, "admin");
  assert.deepEqual(getAllowedPaths(admin.id), ["/a/**", "/b"], "trimmed");
  assert.equal(countUsers(), 1);

  const alice = createUser({ username: "alice", password: "pw-2", role: "user" });
  assert.deepEqual(getAllowedPaths(alice.id), [], "a new user may open nothing");

  assert.equal(authenticate("root", "pw-1")?.id, admin.id);
  assert.equal(authenticate("root", "nope"), null);
  assert.equal(authenticate("ghost", "pw-1"), null, "unknown user is also null");

  setPassword(admin.id, "pw-new");
  assert.equal(authenticate("root", "pw-1"), null);
  assert.equal(authenticate("root", "pw-new")?.id, admin.id);

  setRole(alice.id, "admin");
  assert.equal(getUserById(alice.id)?.role, "admin");
  setRole(alice.id, "user");

  setAllowedPaths(alice.id, ["/x/**", "/x/**"]);
  assert.deepEqual(getAllowedPaths(alice.id), ["/x/**"], "duplicates collapse");
  setAllowedPaths(alice.id, []);
  assert.deepEqual(getAllowedPaths(alice.id), [], "replaces, not appends");

  assert.equal(getUserByUsername("root")?.id, admin.id);
  assert.equal(getUserByUsername("nobody"), null);
  assert.deepEqual(listUsers().map((u) => u.username).sort(), ["alice", "root"]);

  // Usernames are unique.
  assert.throws(
    () => createUser({ username: "root", password: "x", role: "user" }),
    /UNIQUE|constraint/i,
  );

  // Deleting a user takes their allowed paths with them (ON DELETE CASCADE).
  setAllowedPaths(alice.id, ["/y/**"]);
  assert.equal(deleteUser(alice.id), true);
  assert.deepEqual(getAllowedPaths(alice.id), []);
  assert.equal(deleteUser(alice.id), false, "second delete reports false");

  // ── admin bootstrap ──────────────────────────────────────────────────────

  assert.equal(seedAdminFromEnv(undefined), null);
  assert.equal(seedAdminFromEnv("   "), null);
  assert.equal(seedAdminFromEnv("no-colon"), null, "malformed spec ignored");
  assert.equal(seedAdminFromEnv("user:"), null, "empty password ignored");
  assert.equal(seedAdminFromEnv(":pass"), null, "empty username ignored");

  const seeded = seedAdminFromEnv("boss:s3cr3t:with:colons");
  assert.ok(seeded);
  assert.equal(seeded!.role, "admin");
  assert.deepEqual(getAllowedPaths(seeded!.id), ["**"], "admin may open anything");
  assert.equal(
    authenticate("boss", "s3cr3t:with:colons")?.id,
    seeded!.id,
    "only the FIRST colon separates — passwords may contain colons",
  );

  // Re-seeding never overwrites, so leaving the variable set is harmless.
  setPassword(seeded!.id, "changed-by-hand");
  assert.equal(seedAdminFromEnv("boss:s3cr3t:with:colons"), null);
  assert.equal(authenticate("boss", "changed-by-hand")?.id, seeded!.id);

  // ── ownership + claiming what predates accounts (decision 15) ────────────

  const owner = createUser({ username: "owner", password: "x", role: "user" });
  const other = createUser({ username: "other", password: "x", role: "user" });
  const boss = getUserByUsername("boss")!; // admin, seeded above

  recordOwner("res-1", "group", owner.id);
  assert.equal(ownerOf("res-1"), owner.id);
  assert.equal(canAccessResource(owner, "res-1"), true);
  assert.equal(canAccessResource(other, "res-1"), false);
  // Admins reach everything (decision 11) — including unowned resources.
  assert.equal(canAccessResource(boss, "res-1"), true);
  assert.equal(canAccessResource(boss, "never-recorded"), true);
  // A plain user may NOT reach an unowned resource: the orphans include the
  // machine owner's own terminal sessions (decision 10).
  assert.equal(canAccessResource(other, "never-recorded"), false);

  // Claiming picks up rows in the DB that no one owns yet. Seed one of each.
  const { getDb } = await import("../db.ts");
  const db = getDb();
  db.prepare(
    "INSERT INTO opened_projects(user_id, path, last_used) VALUES ('', '/legacy', 1)",
  ).run();
  db.prepare(
    `INSERT INTO groups_index(gid, title, cwd, last_ts, participant_summary, last_snippet)
          VALUES ('g-legacy', 't', '/c', 1, 'Claude', '')`,
  ).run();
  db.prepare(
    "INSERT INTO codex_sessions(session_id, last_modified) VALUES ('cx-legacy', 1)",
  ).run();

  const claimed = claimUnowned(boss.id);
  assert.equal(claimed.projects, 1);
  assert.equal(claimed.groups, 1);
  assert.equal(claimed.codexSessions, 1);
  assert.equal(ownerOf("g-legacy"), boss.id);
  assert.equal(ownerOf("cx-legacy"), boss.id);

  // Idempotent, and it must not steal what someone already owns.
  const again = claimUnowned(boss.id);
  assert.deepEqual(again, { projects: 0, groups: 0, codexSessions: 0 });
  assert.equal(ownerOf("res-1"), owner.id, "an owned resource is left alone");

  console.log("auth.test.ts: all assertions passed");
} finally {
  closeDb();
  delete process.env.CC_WEBUI_DB;
  delete process.env.CC_WEBUI_COOKIE_SECRET_FILE;
  await fs.rm(tmp, { recursive: true, force: true });
}
