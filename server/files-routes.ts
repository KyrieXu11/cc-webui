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
import {
  forgetSessionFiles,
  listSessionFiles,
  recordDeletion,
} from "./session-files.ts";

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

// 批量删除。**真删，没有回收站**（决策 4 用户定的），所以两件事必须做到：
//   ① 每个路径都过白名单 —— 见下面那段 ⚠️
//   ② 每次删除都留痕 —— 账号可删、文件不可恢复，「谁删的」只能靠这张表回答
//
// ⚠️ 白名单为什么在处理器里查而不在 policy 表里声明：中间件的 valueFrom 只认
// **字符串**字段（`typeof v === "string"`），而这里的 body.paths 是个数组，声明
// `paths: [{from:"body", key:"paths"}]` 会静默取不到值 → 当成"没传" → 400，
// 或者更糟：如果标成 optional 就等于**完全不检查**。所以这条路由在 policy 表里
// 是 handlerScoped，检查在这里逐个做，一个都不能漏。
filesRoute.post("/delete", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    paths?: unknown;
    sessionId?: string;
  };
  const paths = Array.isArray(body.paths)
    ? body.paths.filter((p): p is string => typeof p === "string" && !!p)
    : [];
  if (paths.length === 0) return c.json({ error: "paths 必填" }, 400);

  const user = currentUser(c)!;
  const patterns = getAllowedPaths(user.id);
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";

  const deleted: string[] = [];
  const failed: { path: string; error: string }[] = [];

  for (const raw of paths) {
    let target: string;
    try {
      // 用它返回的规范化路径删，而不是请求里那个字符串：白名单是对规范化后的
      // 路径判定的，拿原字符串去 unlink 等于让 symlink 有机会指向别处。
      target = await assertCanOpen(raw, patterns);
    } catch {
      failed.push({ path: raw, error: "不在你可访问的目录内" });
      continue;
    }
    try {
      const st = await fsp.stat(target);
      if (!st.isFile()) {
        // 目录删除不在 v1 范围内（docs/file-manager.md「v1 不做」），而且
        // recursive 删目录是这个仓库出过事故的形状。
        failed.push({ path: raw, error: "只能删文件" });
        continue;
      }
      await fsp.unlink(target);
      recordDeletion({
        userId: user.id,
        username: user.username,
        sessionId,
        path: target,
        size: st.size,
      });
      console.log(
        `[files] delete by=${user.username} session=${sessionId || "-"} path=${target}`
      );
      deleted.push(raw);
    } catch (err) {
      failed.push({
        path: raw,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // registry 里的行跟着走，否则列表还会列着它，直到下一个 turn 的 prune。
  //
  // ⚠️ **原始路径和规范化路径都要删**：unlink 用的是 assertCanOpen 返回的
  // 规范化路径（macOS 上 /var/… 会变成 /private/var/…），而 registry 里那行是
  // scanTouched 按会话 cwd 走出来的形式——用户开的 cwd 是哪种写法就存哪种。
  // 只删一种，另一种会一直留在列表里直到下一个 turn 的 prune。
  if (sessionId && deleted.length > 0) {
    const canonical = await Promise.all(
      deleted.map((p) => assertCanOpen(p, patterns).catch(() => p))
    );
    forgetSessionFiles(sessionId, [...new Set([...deleted, ...canonical])]);
  }
  return c.json({ deleted, failed });
});

// 上传到「本文件夹」（决策 14）。
//
// ⚠️ 目标目录走 **query** 而不是 body：中间件的 valueFrom 读 body 用的是
// c.req.json()，而这是 multipart —— JSON 解析失败就取不到值，白名单检查会退化成
// 400 或（若标 optional）压根不查。放 query 里，`paths: [{from:"query",key:"dir"}]`
// 就能照常执行。
//
// 与 Composer 那条上传（server/upload.ts，落 /tmp）**刻意不同**：那条是给 agent
// 看的临时文件，故意不污染项目目录；这条是往取件台里放东西。两条并存，不合并。
filesRoute.post("/upload", async (c) => {
  const dir = c.req.query("dir");
  if (!dir) return c.json({ error: "dir 必填" }, 400);
  try {
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) return c.json({ error: "dir 不是目录" }, 400);
  } catch {
    return c.json({ error: "目录不存在" }, 404);
  }

  const form = await c.req.parseBody({ all: true });
  const raw = form["files"];
  const list: File[] = [];
  if (Array.isArray(raw)) {
    for (const x of raw) if (x instanceof File) list.push(x);
  } else if (raw instanceof File) {
    list.push(raw);
  }
  if (list.length === 0) return c.json({ error: "没有文件" }, 400);

  const saved: { path: string; name: string; size: number }[] = [];
  for (const f of list) {
    const safe = sanitizeName(f.name);
    // 不覆盖同名文件：这块地没有版本控制，上传一个同名文件把 agent 的产出顶掉
    // 是不可恢复的。加序号，让用户自己看着办。
    let dest = path.join(dir, safe);
    let n = 1;
    while (await exists(dest)) {
      const dot = safe.lastIndexOf(".");
      const stem = dot > 0 ? safe.slice(0, dot) : safe;
      const ext = dot > 0 ? safe.slice(dot) : "";
      dest = path.join(dir, `${stem}-${n}${ext}`);
      n++;
    }
    const buf = Buffer.from(await f.arrayBuffer());
    await fsp.writeFile(dest, buf);
    saved.push({ path: dest, name: path.basename(dest), size: buf.length });
  }
  return c.json({ files: saved });
});

// 文件名消毒：路径分隔符与控制字符一律换掉，且不许出现 ".." 这种整段。
// 单位是**文件名**，不是路径——所以任何分隔符都是异常输入。
function sanitizeName(name: string): string {
  const flat = name
    .replace(/[/\\]/g, "_")
    .replace(/[\x00-\x1f]/g, "")
    .trim()
    .slice(0, 120);
  if (!flat || flat === "." || flat === "..") return "file";
  return flat;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

export { filesRoute };
