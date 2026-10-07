import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-webui-fs-scan-"));
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CC_WEBUI_COOKIE_SECRET_FILE = path.join(tmp, "cookie-secret");
process.env.CC_WEBUI_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CC_WEBUI_GROUPS_DIR = path.join(tmp, "groups");
process.env.CC_WEBUI_SESSION_INDEX = path.join(tmp, "sessions.json");
process.env.CODEX_SESSIONS_DIR = path.join(tmp, "codex-empty");
process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR = path.join(tmp, "claude-empty");
process.env.CC_WEBUI_DOTENV = path.join(tmp, "empty.env");
await fs.writeFile(process.env.CC_WEBUI_DOTENV, "");

const { closeDb } = await import("./db.ts");
const { createApp } = await import("./app.ts");
const { createUser, setAllowedPaths } = await import("./auth/users.ts");
const { issueSession, SESSION_COOKIE } = await import("./auth/session.ts");
const { recordOpenedProject } = await import("./opened-projects.ts");
const root = path.join(tmp, "projects");
for (const sub of ["alpha/deep/third/fourth", "beta", "node_modules/ignored", ".hidden/ignored"]) {
  await fs.mkdir(path.join(root, sub), { recursive: true });
}
await fs.symlink(root, path.join(root, "loop"));
const canonical = await fs.realpath(root); // /tmp is a symlink on macOS.

try {
  const app = createApp();
  const alice = createUser({ username: "alice", password: "x", role: "admin", allowedPaths: [`${root}/**`] });
  // Same literal root/cache key, different glob. Never cache Alice's response.
  const bob = createUser({ username: "bob", password: "x", role: "user", allowedPaths: [`${root}/a*/**`] });
  const request = (id: string, route: string) => app.request(`/api/fs/${route}`, {
    headers: { cookie: `${SESSION_COOKIE}=${issueSession(id)}` },
  });
  const scan = async (id: string, refresh = false): Promise<string[]> => {
    const res = await request(id, `scan${refresh ? "?refresh=1" : ""}`);
    assert.equal(res.status, 200);
    return (await res.json()).dirs;
  };

  const dirs = await scan(alice.id);
  assert(dirs.includes(canonical));
  assert(dirs.includes(`${canonical}/alpha/deep/third`));
  assert(!dirs.includes(`${canonical}/alpha/deep/third/fourth`), "depth bound retained");
  assert(dirs.includes(`${canonical}/loop`), "directory symlink remains selectable");
  assert(!dirs.some((d) => d.includes("/loop/")), "symlink loop never recursed");
  assert(!dirs.some((d) => d.includes("node_modules") || d.includes(".hidden")));
  const bobDirs = await scan(bob.id);
  assert(bobDirs.includes(`${canonical}/alpha`));
  assert(!bobDirs.includes(`${canonical}/beta`), "other actor cannot see warm-cache unauthorised paths");

  await fs.mkdir(path.join(root, "new-project"));
  assert(!(await scan(alice.id)).includes(`${canonical}/new-project`), "warm scan is reused");
  assert((await scan(alice.id, true)).includes(`${canonical}/new-project`), "explicit refresh discovers a new folder");

  recordOpenedProject(path.join(root, "alpha"), alice.id, 2);
  recordOpenedProject(path.join(root, "beta"), alice.id, 1);
  // Keep same cache key while narrowing the whitelist.
  setAllowedPaths(alice.id, [`${root}/a*/**`]);
  assert(!(await scan(alice.id)).includes(`${canonical}/beta`), "revoked grants do not survive in cache");
  const recents = (await (await request(alice.id, "recents")).json()).recents;
  assert.deepEqual(recents.map((r: { path: string }) => r.path), [path.join(root, "alpha")]);
  assert.deepEqual((await (await request(bob.id, "recents")).json()).recents, [], "recents remain account-scoped");

  setAllowedPaths(alice.id, []);
  assert.deepEqual(await scan(alice.id), [], "even admins need a current folder grant");
  assert.deepEqual((await (await request(alice.id, "recents")).json()).recents, []);
  assert.equal((await app.request("/api/fs/scan")).status, 401);
  console.log("fs-scan.test.ts ✓");
} finally {
  closeDb();
  await fs.rm(tmp, { recursive: true, force: true });
}
