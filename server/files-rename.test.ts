// 重命名。和 move 同源的两条护栏，但成因不同，所以单独钉：
//   · **同目录换名字也可能越界** —— 白名单是 glob，`mine/*.md` 下把 a.md 改成
//     a.txt 就掉出去了。所以源和「改完之后」各查一次。
//   · `fs.rename` 会静默覆盖同名文件 → 撞名一律拒，断的是「对方内容没变」。
// 再加一条 move 那边没有的：**改目录名时，registry 里它底下每一行都要跟着改**
// （前缀替换），否则取件台会列一堆已经不存在的路径。

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const tmp = path.join(os.tmpdir(), `cc-webui-rename-test-${Date.now()}`);
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CC_WEBUI_COOKIE_SECRET_FILE = path.join(tmp, "cookie-secret");
process.env.CC_WEBUI_GROUPS_DIR = path.join(tmp, "groups");
process.env.CC_WEBUI_SESSION_INDEX = path.join(tmp, "sessions.json");
process.env.CODEX_SESSIONS_DIR = path.join(tmp, "codex-empty");
process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR = path.join(tmp, "claude-projects");
process.env.CC_WEBUI_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CC_WEBUI_DOTENV = path.join(tmp, "empty.env");

const mine = path.join(tmp, "mine");
const only = path.join(tmp, "only"); // 白名单只允许这里的 *.md
await fs.mkdir(mine, { recursive: true });
await fs.mkdir(only, { recursive: true });
await fs.writeFile(path.join(tmp, "empty.env"), "");

const { closeDb } = await import("./db.ts");
const { createApp } = await import("./app.ts");
const { createUser } = await import("./auth/users.ts");
const { issueSession, SESSION_COOKIE } = await import("./auth/session.ts");
const { recordSessionFiles, listSessionFiles } = await import("./session-files.ts");

try {
  const app = createApp();
  const alice = createUser({
    username: "alice",
    password: "x",
    role: "user",
    allowedPaths: [`${mine}/**`, `${only}/*.md`],
  });
  const rename = (p: string, name: string) =>
    app.request("/api/files/rename", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=${issueSession(alice.id)}`,
      },
      body: JSON.stringify({ path: p, name }),
    });
  const read = (p: string) => fs.readFile(p, "utf8").catch(() => null);

  // ── 1. 普通改名 ─────────────────────────────────────────────────────────
  {
    const src = path.join(mine, "a.md");
    await fs.writeFile(src, "A");
    const res = await rename(src, "b.md");
    assert.equal(res.status, 200);
    assert.equal(await read(src), null);
    assert.equal(await read(path.join(mine, "b.md")), "A");
  }

  // ── 2. 名字没变：当成功，不报错 ─────────────────────────────────────────
  //
  // 在输入框里直接回车是很正常的手势，为它弹一句错误只会让人以为做错了什么。
  {
    const res = await rename(path.join(mine, "b.md"), "b.md");
    assert.equal(res.status, 200);
    assert.equal(await read(path.join(mine, "b.md")), "A");
  }

  // ── 3. 撞名：拒，且**对方的内容一个字节都没变** ─────────────────────────
  {
    const other = path.join(mine, "c.md");
    await fs.writeFile(other, "C");
    const res = await rename(path.join(mine, "b.md"), "c.md");
    assert.equal(res.status, 409);
    assert.equal(await read(other), "C", "绝不能被覆盖");
    assert.equal(await read(path.join(mine, "b.md")), "A", "源也要留着");
  }

  // ── 4. 改完之后掉出白名单：拒 ───────────────────────────────────────────
  //
  // 这条是 move 那边没有的形状：源和目标在**同一个目录**里，但 glob 只放行 *.md。
  {
    const src = path.join(only, "note.md");
    await fs.writeFile(src, "N");
    const res = await rename(src, "note.txt");
    assert.equal(res.status, 403);
    assert.equal(await read(src), "N", "被拒了就不许动");
    assert.equal(await read(path.join(only, "note.txt")), null);
  }

  // ── 5. 名字不合法：拒（和新建文件夹同一套规矩） ─────────────────────────
  for (const bad of ["a/b", "..", "", "   "]) {
    assert.equal((await rename(path.join(mine, "c.md"), bad)).status, 400, bad);
  }

  // ── 6. 改目录名：registry 里它**底下**每一行都要跟着改 ──────────────────
  {
    const dir = path.join(mine, "box");
    await fs.mkdir(dir);
    const inner = path.join(dir, "deep.md");
    await fs.writeFile(inner, "D");
    const session = randomUUID();
    recordSessionFiles(session, [
      { path: inner, firstSeenMs: 1, lastTouchedMs: 2, size: 1, mtimeMs: 2 },
    ]);

    assert.equal((await rename(dir, "crate")).status, 200);
    assert.equal(await read(path.join(mine, "crate", "deep.md")), "D");
    assert.deepEqual(
      listSessionFiles(session).map((f) => f.path),
      [path.join(mine, "crate", "deep.md")],
      "目录改名后，registry 里子文件的路径也要跟着走"
    );
  }

  console.log("files-rename.test.ts ok");
} finally {
  closeDb();
  await fs.rm(tmp, { recursive: true, force: true });
}
