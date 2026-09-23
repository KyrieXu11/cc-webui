// 新建文件夹。走**真实的** app.request()，所以目录白名单（policy.ts 的
// "POST /api/files/mkdir" + 中间件）也一起被测到 —— files-routes.test.ts 那边用的是
// 假身份中间件，测不到这一层，而这条路由是「写」，白名单才是它的主要护栏。
//
// 另外钉住两条和上传**故意不同**的行为：名字不合法就拒（不消毒改名）、重名回 409
// （不加序号）。这两条很容易在以后被人「顺手统一成和上传一样」。

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = path.join(os.tmpdir(), `cc-webui-mkdir-test-${Date.now()}`);
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

try {
  const app = createApp();
  const alice = createUser({
    username: "alice",
    password: "x",
    role: "user",
    allowedPaths: [`${mine}/**`],
  });
  const mkdir = (dir: string, name: string) =>
    app.request("/api/files/mkdir", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=${issueSession(alice.id)}`,
      },
      body: JSON.stringify({ dir, name }),
    });
  const isDir = async (p: string) =>
    await fs
      .stat(p)
      .then((s) => s.isDirectory())
      .catch(() => false);

  // ── 1. 白名单内：真的建出来了 ────────────────────────────────────────────
  {
    const res = await mkdir(mine, "报告");
    assert.equal(res.status, 200);
    assert.equal(await isDir(path.join(mine, "报告")), true, "磁盘上要真的有");
  }

  // ── 2. 白名单外：403，且**什么都没留下** ────────────────────────────────
  //
  // 只断 403 不够：403 之后磁盘上多出一个目录，才是这条路由最坏的失败方式。
  {
    const res = await mkdir(theirs, "x");
    assert.equal(res.status, 403);
    assert.equal(await isDir(path.join(theirs, "x")), false, "被拒了就不许落地");
  }

  // ── 3. 名字带分隔符：拒，不是悄悄改成 a_b ────────────────────────────────
  //
  // 上传那条路由会把 "a/b.png" 消毒成 "a_b.png"（名字来自文件系统，用户没在打字）；
  // 这里名字是用户刚敲的，改掉它等于「点了确定，出来一个不是我要的文件夹」。
  for (const bad of ["a/b", "a\\b", "..", ".", "", "   "]) {
    const res = await mkdir(mine, bad);
    assert.equal(res.status, 400, `"${bad}" 应该被拒`);
    const body = (await res.json()) as { error?: string };
    assert.ok(body.error, "要给出理由");
  }
  assert.equal(await isDir(path.join(mine, "a_b")), false, "不许消毒成别的名字");

  // ── 4. 重名：409，且原来那个目录不受影响 ────────────────────────────────
  {
    const res = await mkdir(mine, "报告");
    assert.equal(res.status, 409);
    assert.equal(await isDir(path.join(mine, "报告")), true);
    assert.equal(await isDir(path.join(mine, "报告-1")), false, "不许加序号");
  }

  console.log("files-mkdir.test.ts ok");
} finally {
  closeDb();
  await fs.rm(tmp, { recursive: true, force: true });
}
