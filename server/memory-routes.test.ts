// 项目记忆（只读）。走真实的 app.request()：policy 表对 cwd 的白名单检查也一起测到。
//
// 钉住的几条都是以后容易被「顺手」放宽的：
// · 只读 —— 这条路由上没有任何写方法（用户 2026-09-23：「注意，不可编辑，只读」）；
// · 能看哪个项目的记忆 = 能不能打开那个项目（白名单外的 cwd 拒）；
// · 读哪些文件由 readdir 决定：目录里指向别处的 symlink 不读，非 .md 不读。

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = path.join(os.tmpdir(), `cc-webui-memory-test-${Date.now()}`);
const projects = path.join(tmp, "claude-projects");
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CC_WEBUI_COOKIE_SECRET_FILE = path.join(tmp, "cookie-secret");
process.env.CC_WEBUI_GROUPS_DIR = path.join(tmp, "groups");
process.env.CC_WEBUI_SESSION_INDEX = path.join(tmp, "sessions.json");
process.env.CODEX_SESSIONS_DIR = path.join(tmp, "codex-empty");
process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR = projects;
process.env.CC_WEBUI_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CC_WEBUI_DOTENV = path.join(tmp, "empty.env");

const mine = path.join(tmp, "mine");
const proj = path.join(mine, "proj");
const bare = path.join(mine, "no-memory-yet");
const theirs = path.join(tmp, "theirs", "proj");
for (const d of [proj, bare, theirs]) await fs.mkdir(d, { recursive: true });
await fs.writeFile(path.join(tmp, "empty.env"), "");

const { closeDb } = await import("./db.ts");
const { createApp } = await import("./app.ts");
const { createUser } = await import("./auth/users.ts");
const { issueSession, SESSION_COOKIE } = await import("./auth/session.ts");
const { projectSlug } = await import("./claude-sessions.ts");

// 记忆目录按 CLI 的规则放：projects/<slug(cwd)>/memory/
const memDir = path.join(projects, projectSlug(await fs.realpath(proj)), "memory");
await fs.mkdir(memDir, { recursive: true });
await fs.writeFile(
  path.join(memDir, "MEMORY.md"),
  "- [讲题三页](ppt-format.md) — 题目→提示→答案\n",
);
await fs.writeFile(
  path.join(memDir, "ppt-format.md"),
  [
    "---",
    "name: ppt-format",
    "description: 讲题固定三页: 题目→提示→答案",
    "metadata: ",
    "  node_type: memory",
    "  type: feedback",
    "  modified: 2026-09-12T00:52:38.741Z",
    "---",
    "",
    "每题都这样。相关 [[other]]。",
  ].join("\n"),
);
await fs.writeFile(path.join(memDir, "no-frontmatter.md"), "就一句话\n");
await fs.writeFile(path.join(memDir, "notes.txt"), "not a memory");
const secret = path.join(tmp, "theirs", "secret.md");
await fs.writeFile(secret, "---\nname: secret\n---\nshould never be served");
await fs.symlink(secret, path.join(memDir, "sneaky.md"));

try {
  const app = createApp();
  const alice = createUser({
    username: "alice",
    password: "x",
    role: "user",
    allowedPaths: [`${mine}/**`],
  });
  const get = (query: string, method = "GET") =>
    app.request(`/api/memory${query}`, {
      method,
      headers: { cookie: `${SESSION_COOKIE}=${issueSession(alice.id)}` },
    });

  // ── 1. 读得到：索引 + 每条的元信息和正文 ────────────────────────────────
  let res = await get(`?cwd=${encodeURIComponent(proj)}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    dir: string;
    index: string;
    memories: Array<{
      file: string;
      name: string;
      description: string;
      type: string;
      modified: string;
      body: string;
    }>;
  };
  assert.match(body.index, /讲题三页/, "MEMORY.md comes back as the index");
  const files = body.memories.map((m) => m.file);
  assert.deepEqual(files, ["no-frontmatter.md", "ppt-format.md"], "only regular .md files, index excluded");
  const ppt = body.memories.find((m) => m.file === "ppt-format.md")!;
  assert.equal(ppt.name, "ppt-format");
  assert.equal(ppt.description, "讲题固定三页: 题目→提示→答案", "a colon inside the value survives");
  assert.equal(ppt.type, "feedback", "nested metadata.type is flattened");
  assert.equal(ppt.modified, "2026-09-12T00:52:38.741Z");
  assert.equal(ppt.body.trim(), "每题都这样。相关 [[other]]。", "frontmatter stripped from the body");
  const plain = body.memories.find((m) => m.file === "no-frontmatter.md")!;
  assert.equal(plain.name, "no-frontmatter", "no frontmatter → name from the file");

  // ── 2. 目录里指向别处的 symlink 不读 ───────────────────────────────────
  assert.ok(!files.includes("sneaky.md"));
  assert.ok(!JSON.stringify(body).includes("should never be served"));

  // ── 3. 还没有记忆的项目：空，不是错 ─────────────────────────────────────
  res = await get(`?cwd=${encodeURIComponent(bare)}`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { dir: null, index: null, memories: [] });

  // ── 4. 白名单外的项目：拒 ───────────────────────────────────────────────
  res = await get(`?cwd=${encodeURIComponent(theirs)}`);
  assert.equal(res.status, 403, "you see a project's memory only if you can open the project");

  // ── 5. 不给 cwd：400 ──────────────────────────────────────────────────
  assert.equal((await get("")).status, 400);

  // ── 6. 只读：没有任何写方法 ─────────────────────────────────────────────
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    res = await get(`?cwd=${encodeURIComponent(proj)}`, method);
    assert.ok(res.status >= 400, `${method} must not exist on /api/memory (got ${res.status})`);
  }
  assert.equal(
    await fs.readFile(path.join(memDir, "ppt-format.md"), "utf8").then((t) => t.includes("每题都这样")),
    true,
    "memory files untouched",
  );
} finally {
  closeDb();
  await fs.rm(tmp, { recursive: true, force: true });
}
