// 删空文件夹（用户 2026-09-23：「现在的空文件夹也不能删除」）。
//
// 走**真实的** app.request()：目录白名单是这条路由的主要护栏，得一起测到。
//
// 这里钉住的是「只开放空文件夹」的边界，每一条都是以后容易被「顺手放宽」的：
// · 非空 → 拒，里面的东西一个都不能少（永远不是 rm -r）；
// · 只装着一个空子文件夹也算非空（rmdir 不递归，这正是想要的）；
// · 只剩 .DS_Store 算空（Finder 塞的，用户眼里就是空的）；别的隐藏文件不算；
// · 白名单规则的根目录本身不删（界面上它不是一行，只有手拼的请求能摸到）。

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = path.join(os.tmpdir(), `cc-webui-delete-dir-test-${Date.now()}`);
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CC_WEBUI_COOKIE_SECRET_FILE = path.join(tmp, "cookie-secret");
process.env.CC_WEBUI_GROUPS_DIR = path.join(tmp, "groups");
process.env.CC_WEBUI_SESSION_INDEX = path.join(tmp, "sessions.json");
process.env.CODEX_SESSIONS_DIR = path.join(tmp, "codex-empty");
process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR = path.join(tmp, "claude-projects");
process.env.CC_WEBUI_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CC_WEBUI_DOTENV = path.join(tmp, "empty.env");

const mine = path.join(tmp, "mine");
const theirs = path.join(tmp, "theirs");
await fs.mkdir(mine, { recursive: true });
await fs.mkdir(theirs, { recursive: true });
await fs.writeFile(path.join(tmp, "empty.env"), "");

const { closeDb } = await import("./db.ts");
const { createApp } = await import("./app.ts");
const { createUser } = await import("./auth/users.ts");
const { issueSession, SESSION_COOKIE } = await import("./auth/session.ts");
const { listDeletions } = await import("./session-files.ts");

const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

try {
  const app = createApp();
  // `mine` 本身在白名单里（「含子树」写法，根也算），这样才测得到根目录那条护栏。
  const alice = createUser({
    username: "alice",
    password: "x",
    role: "user",
    allowedPaths: [mine],
  });
  const del = async (...paths: string[]) => {
    const res = await app.request("/api/files/delete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=${issueSession(alice.id)}`,
      },
      body: JSON.stringify({ paths }),
    });
    assert.equal(res.status, 200);
    return (await res.json()) as {
      deleted: string[];
      failed: { path: string; error: string }[];
    };
  };

  // ── 1. 空文件夹：删掉，并且留痕 ──────────────────────────────────────────
  const empty = path.join(mine, "空的");
  await fs.mkdir(empty);
  let r = await del(empty);
  assert.deepEqual(r.deleted, [empty]);
  assert.equal(await exists(empty), false, "empty folder is gone");
  const trail = listDeletions();
  assert.equal(trail.length, 1, "a folder deletion is on the trail like a file's");
  assert.equal(trail[0].path, path.join(await fs.realpath(mine), "空的"));

  // ── 2. 非空：拒，一个字节都不能少 ────────────────────────────────────────
  const full = path.join(mine, "有东西");
  await fs.mkdir(full);
  await fs.writeFile(path.join(full, "a.md"), "keep");
  r = await del(full);
  assert.deepEqual(r.deleted, []);
  assert.match(r.failed[0].error, /不是空的/, "the reason says why");
  assert.equal(await exists(path.join(full, "a.md")), true, "never recursive");

  // ── 3. 只装着一个空子文件夹：也算非空（rmdir 不递归） ───────────────────
  const nested = path.join(mine, "套娃");
  await fs.mkdir(path.join(nested, "里面"), { recursive: true });
  r = await del(nested);
  assert.deepEqual(r.deleted, []);
  assert.equal(await exists(path.join(nested, "里面")), true);

  // ── 4. 只剩 .DS_Store：算空；别的隐藏文件不算 ───────────────────────────
  const finder = path.join(mine, "开过Finder");
  await fs.mkdir(finder);
  await fs.writeFile(path.join(finder, ".DS_Store"), "junk");
  r = await del(finder);
  assert.deepEqual(r.deleted, [finder], "a Finder-only .DS_Store does not make it non-empty");
  assert.equal(await exists(finder), false);

  const repo = path.join(mine, "像个仓库");
  await fs.mkdir(path.join(repo, ".git"), { recursive: true });
  r = await del(repo);
  assert.deepEqual(r.deleted, [], "any other hidden entry is real content");
  assert.equal(await exists(path.join(repo, ".git")), true);

  // ── 5. 白名单根目录本身：哪怕是空的也不删 ───────────────────────────────
  const rootAlone = path.join(tmp, "lonely");
  await fs.mkdir(rootAlone);
  const bob = createUser({
    username: "bob",
    password: "x",
    role: "user",
    allowedPaths: [rootAlone],
  });
  const res = await app.request("/api/files/delete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${issueSession(bob.id)}`,
    },
    body: JSON.stringify({ paths: [rootAlone] }),
  });
  const body = (await res.json()) as { deleted: string[]; failed: { error: string }[] };
  assert.deepEqual(body.deleted, [], "an allowed-path root is the account's footing");
  assert.match(body.failed[0].error, /根目录/);
  assert.equal(await exists(rootAlone), true);

  // ── 6. 白名单外的空文件夹：照旧拒 ────────────────────────────────────────
  const outside = path.join(theirs, "空");
  await fs.mkdir(outside);
  r = await del(outside);
  assert.deepEqual(r.deleted, []);
  assert.equal(await exists(outside), true);

  // ── 7. 文件照常能删，和文件夹混在一批里也行 ─────────────────────────────
  const f = path.join(mine, "x.txt");
  const d = path.join(mine, "又一个空的");
  await fs.writeFile(f, "x");
  await fs.mkdir(d);
  r = await del(f, d);
  assert.deepEqual(r.deleted.sort(), [d, f].sort());
  assert.equal(await exists(f), false);
  assert.equal(await exists(d), false);
} finally {
  closeDb();
  await fs.rm(tmp, { recursive: true, force: true });
}
