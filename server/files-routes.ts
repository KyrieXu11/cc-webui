// 取件台的读侧：列出「本对话文件」。设计见 docs/file-manager.md。
//
// 两道过滤，缺一不可：
//   ① 会话归属（visibilityFor）—— 不然任何账号换个 sessionId 就能列出别人的产出。
//      policy 表里声明成 handlerScoped，因为这层收窄在处理器里做。
//   ② 路径白名单 —— agent 有完整 shell，它可能往 /tmp、~/Downloads、别人的
//      工作区里写；registry 照实记下了，但列表里**直接过滤掉**当前账号碰不了的
//      路径（决策 6）。既省掉「列了个点不开的东西」的困惑，也不把「agent 写到
//      哪儿了」漏给别的账号。

import { Hono } from "hono";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { currentUser } from "./auth/middleware.ts";
import { visibilityFor } from "./auth/scope.ts";
import { getAllowedPaths } from "./auth/users.ts";
import { assertCanOpen } from "./auth/paths.ts";
import { listSessionFiles } from "./session-files.ts";

const filesRoute = new Hono();

// 临时文件名要带序号：同一个进程里两次并发保存拿同名临时文件会互相踩。
let tmpSeq = 0;

export type FileRow = {
  path: string;
  name: string;
  dir: string;
  size: number;
  mtimeMs: number;
  firstSeenMs: number;
};

filesRoute.get("/", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ files: [] });

  const user = currentUser(c)!;
  if (!visibilityFor(user)(sessionId)) {
    // 不是 403：会话存在与否本身就不该泄漏。空列表和"没有这条会话"长得一样。
    return c.json({ files: [] });
  }

  const patterns = getAllowedPaths(user.id);
  const rows = listSessionFiles(sessionId);
  const files: FileRow[] = [];
  for (const r of rows) {
    try {
      await assertCanOpen(r.path, patterns);
    } catch {
      continue;
    }
    files.push({
      path: r.path,
      name: path.basename(r.path),
      dir: path.dirname(r.path),
      size: r.size,
      mtimeMs: r.mtimeMs,
      firstSeenMs: r.firstSeenMs,
    });
  }
  return c.json({ files });
});

// 保存文本文件。乐观锁：调用方必须带上打开时看到的 mtimeMs+size，不匹配就 409。
//
// 为什么需要它：turn 与 HTTP 连接解耦，turn 在后台跑，用户完全可能一边看 agent
// 写 01-计划.md 一边自己打开它改。没有这道比对，后写的静默赢，人写半小时的东西
// 凭空消失且无从察觉（决策 12）。
//
// ⚠️ 路径白名单由 policy 表声明（paths: body.path），中间件已经查过。这里不重复查，
// 但**用的必须是同一个值**——所以取 body.path 原样，不做任何拼接。
//
// ⚠️ 写盘用「同目录临时文件 + rename」：直写会在中途崩溃时留下半个文件，而这块地
// 没有 git 也没有回收站。同目录是必须的，跨设备 rename 会 EXDEV。
filesRoute.put("/content", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    path?: string;
    content?: string;
    ifMatch?: { mtimeMs?: number; size?: number };
  };
  const target = body.path;
  if (!target || typeof body.content !== "string") {
    return c.json({ error: "path 与 content 必填" }, 400);
  }

  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    return c.json({ error: "文件不存在" }, 404);
  }
  if (!stat.isFile()) return c.json({ error: "不是文件" }, 400);

  const want = body.ifMatch;
  if (!want || typeof want.mtimeMs !== "number") {
    return c.json({ error: "缺少 ifMatch —— 保存必须带上打开时的版本" }, 428);
  }
  // mtimeMs 在某些文件系统上会丢精度，所以给 1ms 容差；size 是第二把锁。
  const changed =
    Math.abs(stat.mtimeMs - want.mtimeMs) > 1 ||
    (typeof want.size === "number" && stat.size !== want.size);
  if (changed) {
    return c.json(
      {
        error: "conflict",
        detail: "这个文件在你编辑期间被改过（很可能是 agent），请重新打开再改",
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      },
      409
    );
  }

  const tmp = `${target}.cc-webui-tmp-${process.pid}-${++tmpSeq}`;
  try {
    await fsp.writeFile(tmp, body.content, "utf-8");
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500
    );
  }
  const after = await fsp.stat(target);
  return c.json({ ok: true, mtimeMs: after.mtimeMs, size: after.size });
});

export { filesRoute };
