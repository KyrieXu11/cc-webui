// 移动文件。走真实的 app.request()，所以两头的白名单（源和目标）都被真的执行到。
//
// 最要紧的一条是 **④ 同名不覆盖**：`fs.rename` 在 POSIX 上会静默覆盖同名文件，
// 而这块地没有回收站也没有版本，覆盖 = 不可恢复。所以那一条不是断「回了 failed」，
// 是断「目标文件的内容一个字节都没变」。

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const tmp = path.join(os.tmpdir(), `cc-webui-move-test-${Date.now()}`);
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CC_WEBUI_COOKIE_SECRET_FILE = path.join(tmp, "cookie-secret");
process.env.CC_WEBUI_GROUPS_DIR = path.join(tmp, "groups");
process.env.CC_WEBUI_SESSION_INDEX = path.join(tmp, "sessions.json");
process.env.CODEX_SESSIONS_DIR = path.join(tmp, "codex-empty");
process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR = path.join(tmp, "claude-projects");
process.env.CC_WEBUI_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CC_WEBUI_DOTENV = path.join(tmp, "empty.env");

const mine = path.join(tmp, "mine");
const box = path.join(mine, "box");
const theirs = path.join(tmp, "theirs");
await fs.mkdir(box, { recursive: true });
await fs.mkdir(theirs, { recursive: true });
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
    allowedPaths: [`${mine}/**`],
  });
  const move = (paths: string[], dest: string) =>
    app.request("/api/files/move", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=${issueSession(alice.id)}`,
      },
      body: JSON.stringify({ paths, dest }),
    });
  const read = (p: string) => fs.readFile(p, "utf8").catch(() => null);

  // ── 1. 正常移动：磁盘上真的换了位置，registry 那行跟着走 ────────────────
  //
  // registry 不跟着走的话，取件台会一直列着一个已经不在那儿的路径。
  {
    const src = path.join(mine, "plan.md");
    await fs.writeFile(src, "hello");
    const session = randomUUID();
    recordSessionFiles(session, [
      { path: src, firstSeenMs: 1, lastTouchedMs: 2, size: 5, mtimeMs: 2 },
    ]);

    const res = await move([src], box);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { moved: unknown[]; failed: unknown[] };
    assert.equal(body.moved.length, 1);
    assert.equal(body.failed.length, 0);
    assert.equal(await read(src), null, "原位置不该还在");
    assert.equal(await read(path.join(box, "plan.md")), "hello");
    assert.deepEqual(
      listSessionFiles(session).map((f) => f.path),
      [path.join(box, "plan.md")],
      "registry 里的路径要跟着改"
    );
  }

  // ── 2. 目标在白名单外：整条 403，源文件纹丝不动 ─────────────────────────
  {
    const src = path.join(mine, "keep.md");
    await fs.writeFile(src, "keep");
    const res = await move([src], theirs);
    assert.equal(res.status, 403);
    assert.equal(await read(src), "keep", "被拒了就不许动");
    assert.equal(await read(path.join(theirs, "keep.md")), null);
  }

  // ── 3. 源在白名单外：那一条 failed，文件不动 ────────────────────────────
  {
    const outside = path.join(theirs, "secret.md");
    await fs.writeFile(outside, "secret");
    const res = await move([outside], box);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { moved: unknown[]; failed: { error: string }[] };
    assert.equal(body.moved.length, 0);
    assert.match(body.failed[0].error, /不在你可访问/);
    assert.equal(await read(outside), "secret");
  }

  // ── 4. 同名：拒，且目标文件**内容不变**（rename 本来会静默覆盖） ────────
  {
    const src = path.join(mine, "plan.md");
    await fs.writeFile(src, "NEW");
    // box/plan.md 是第 1 步搬进去的那份，内容 "hello"
    const res = await move([src], box);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { moved: unknown[]; failed: { error: string }[] };
    assert.equal(body.moved.length, 0);
    assert.match(body.failed[0].error, /已经有/);
    assert.equal(await read(path.join(box, "plan.md")), "hello", "绝不能被覆盖");
    assert.equal(await read(src), "NEW", "源也要留着");
  }

  // ── 5. 已经在目标目录里：拒（不是「成功但什么也没发生」） ───────────────
  {
    const res = await move([path.join(box, "plan.md")], box);
    const body = (await res.json()) as { failed: { error: string }[] };
    assert.match(body.failed[0].error, /已经在这个目录/);
  }

  // ── 6. 把文件夹移进它自己里面：拒 ───────────────────────────────────────
  //
  // rename 多数平台会回 EINVAL，但「移动完东西不见了」是这个操作最吓人的失败方式，
  // 所以自己先挡一道、给一句人话。
  {
    const res = await move([box], path.join(box, "deeper"));
    // 目标目录不存在 → 404；先建出来再试真正的自嵌套。
    assert.equal(res.status, 404);
    await fs.mkdir(path.join(box, "deeper"));
    const res2 = await move([box], path.join(box, "deeper"));
    const body = (await res2.json()) as { failed: { error: string }[] };
    assert.match(body.failed[0].error, /自己里面/);
    assert.equal(await read(path.join(box, "plan.md")), "hello", "原地不动");
  }

  console.log("files-move.test.ts ok");
} finally {
  closeDb();
  await fs.rm(tmp, { recursive: true, force: true });
}
