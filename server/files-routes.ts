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
import { createReadStream, promises as fsp } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { currentUser } from "./auth/middleware.ts";
import { visibilityFor } from "./auth/scope.ts";
import { getAllowedPaths } from "./auth/users.ts";
import {
  assertCanOpen,
  canonicalizePattern,
  patternRoot,
} from "./auth/paths.ts";
import {
  forgetSessionFiles,
  listSessionFiles,
  recordDeletion,
  relocateSessionFiles,
} from "./session-files.ts";
import { ZIP_MAX_ENTRY_BYTES, zipStream } from "./zip.ts";

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
// 删一个**空**文件夹；删不了就返回给用户看的原因，删掉了返回 null。
//
// ⚠️ 只用 rmdir，**永远不用 rm({recursive})**：递归删目录是这个仓库出过事故的
// 形状，而取件台的删除是真删、无回收站。rmdir 自己就拒绝非空目录（ENOTEMPTY），
// 「是不是空的」和「删」是同一个系统调用，中间没有窗口让别的东西钻进来。
// 下面那次 readdir 只用来认出「只剩 .DS_Store」，**不拿它判断空不空**。
//
// 两个例外：
// · Finder 往任何打开过的文件夹里塞一个 .DS_Store，用户眼里那就是空文件夹。
//   只剩它的时候先把它清掉。别的隐藏文件（.git 之类）不算，照样拒。
// · 白名单规则本身的根目录不删（比如工作区那个目录）：界面上它不是一行，
//   能点到这儿的只有手拼的请求，而删掉它等于把账号的地基抽走。
async function removeEmptyDir(
  target: string,
  patterns: string[]
): Promise<string | null> {
  for (const p of patterns) {
    const root = patternRoot(await canonicalizePattern(p));
    if (root && path.resolve(root) === target) return "不能删白名单的根目录";
  }
  const entries = await fsp.readdir(target);
  if (entries.length > 0 && entries.every((n) => n === ".DS_Store")) {
    await fsp.unlink(path.join(target, ".DS_Store")).catch(() => {});
  }
  try {
    await fsp.rmdir(target);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      return "文件夹不是空的，只能删空文件夹";
    }
    throw err;
  }
}

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
      if (st.isDirectory()) {
        const refused = await removeEmptyDir(target, patterns);
        if (refused) {
          failed.push({ path: raw, error: refused });
          continue;
        }
        recordDeletion({
          userId: user.id,
          username: user.username,
          sessionId,
          path: target,
          size: 0,
        });
        console.log(
          `[files] delete-dir by=${user.username} session=${sessionId || "-"} path=${target}`
        );
        deleted.push(raw);
        continue;
      }
      if (!st.isFile()) {
        failed.push({ path: raw, error: "只能删文件或空文件夹" });
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

// 下载（决策 18）。一个文件原样流回，多选打成一个 zip。
//
// ⚠️ 白名单为什么又在处理器里查（和上面那条 delete 同源，但成因不同）：`path` 在
// 这里是**可重复的 query**（`?path=a&path=b`），而中间件的 valueFrom 读的是
// `c.req.query(key)` —— **只有第一个值**。在 policy 表里声明
// `paths: [{from:"query",key:"path"}]` 会让第二个之后的路径完全不过检查，而且看起来
// 像查过了。所以那边是 handlerScoped，这里逐个查，一个都不能漏。
//
// 一条不合格就整条请求失败，而不是悄悄少打包一个：下载少了一个文件是**看不见的**，
// 用户要到解压之后才发现。
//
// 流式返回（`Readable.toWeb`，照 client-routes.ts 那条）：取件台里可能是几百 MB 的
// 产出，读进内存再发等于把它复制一份到服务进程里。
filesRoute.get("/download", async (c) => {
  // 去重：同一个路径打两遍会在 zip 里变成两个同名条目，解压时后一个盖前一个。
  const raws = [...new Set((c.req.queries("path") ?? []).filter((p) => !!p))];
  if (raws.length === 0) return c.json({ error: "path 必填" }, 400);
  // URL 长度是有上限的（nginx 默认 8k 请求行），而这棵树只能一行一行右键选，
  // 真选到 100 个之前用户早就换别的办法了。挡在这里比让 nginx 回一个 414 好懂。
  if (raws.length > 100) {
    return c.json({ error: "一次最多下载 100 个文件" }, 400);
  }

  const user = currentUser(c)!;
  const patterns = getAllowedPaths(user.id);

  const files: { path: string; size: number; mtimeMs: number }[] = [];
  for (const raw of raws) {
    let target: string;
    try {
      // 和 delete 一样：用它返回的规范化路径去读，不用请求里那个字符串。
      target = await assertCanOpen(raw, patterns);
    } catch {
      return c.json(
        {
          error: "path not allowed",
          detail: `${raw} 不在你账号可以打开的范围内`,
        },
        403
      );
    }
    let st;
    try {
      st = await fsp.stat(target);
    } catch {
      return c.json({ error: `文件不存在：${raw}` }, 404);
    }
    // 目录不在 v1 范围内（docs/file-manager.md「v1 不做」），而且树上也选不中。
    if (!st.isFile()) return c.json({ error: "只能下载文件" }, 400);
    if (raws.length > 1 && st.size > ZIP_MAX_ENTRY_BYTES) {
      return c.json({ error: `${path.basename(target)} 超过 4GiB，打不进 zip` }, 413);
    }
    files.push({ path: target, size: st.size, mtimeMs: st.mtimeMs });
  }

  if (files.length === 1) {
    const only = files[0];
    return new Response(
      Readable.toWeb(createReadStream(only.path)) as unknown as ReadableStream,
      {
        headers: {
          // 一律 octet-stream：让浏览器一定是「保存」而不是「渲染」。
          // （`/api/fs/raw` 那条会照实回 image/svg+xml 之类，那是预览要的；
          //  下载这条没有理由把用户的文件当同源文档渲染。）
          "content-type": "application/octet-stream",
          "content-length": String(only.size),
          // 不许缓存：URL 是稳定的（就是那个路径），而 agent 随时会重写这个文件，
          // 缓存下来等于哪天下到一份旧的还看不出来。
          "cache-control": "no-store",
          "content-disposition": contentDisposition(path.basename(only.path)),
        },
      }
    );
  }

  // 包里的名字＝相对公共父目录的路径。两个不同目录下的同名文件因此不会撞车，
  // 而全在一个目录里时它就退化成裸文件名。
  const root = commonDir(files.map((f) => f.path));
  const stream = zipStream(
    files.map((f) => ({
      path: f.path,
      name: path.relative(root, f.path).split(path.sep).join("/"),
      mtimeMs: f.mtimeMs,
    }))
  );
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      "content-type": "application/zip",
      "cache-control": "no-store",
      // 刻意不给 content-length：store 模式虽然算得出来，但那是按 stat 那一刻的
      // 大小算的，而 agent 完全可能在下载途中重写其中一个文件。长度对不上的响应
      // 会被截断成坏包，分块传输则最多是内容旧了一点。
      "content-disposition": contentDisposition(
        `${path.basename(root) || "files"}.zip`
      ),
    },
  });
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

// 重命名（原地换个名字，文件和文件夹都行）。
//
// ⚠️ 和 move 一样两头都查白名单：同一个目录里换名字**也可能越界**——白名单是 glob，
// `~/x/*.md` 这种模式下把 a.md 改成 a.txt 就掉出去了。
// ⚠️ 同样地，`fs.rename` 会静默覆盖同名文件，所以撞名一律拒。
filesRoute.post("/rename", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    path?: unknown;
    name?: unknown;
  };
  const raw = typeof body.path === "string" ? body.path : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!raw) return c.json({ error: "path 必填" }, 400);
  const bad = entryNameProblem(name);
  if (bad) return c.json({ error: bad }, 400);

  const user = currentUser(c)!;
  const patterns = getAllowedPaths(user.id);

  let src: string;
  try {
    src = await assertCanOpen(raw, patterns);
  } catch {
    return c.json({ error: "不在你可访问的目录内" }, 403);
  }
  if (path.basename(src) === name) {
    // 没改动就当成功：用户在输入框里直接回车是很正常的手势，
    // 为此弹一句错误只会让人以为哪里做错了。
    return c.json({ path: src, name });
  }
  const dest = path.join(path.dirname(src), name);
  try {
    await assertCanOpen(dest, patterns);
  } catch {
    return c.json({ error: "改成这个名字之后就不在你可访问的范围内了" }, 403);
  }

  try {
    if (!(await exists(src))) return c.json({ error: "文件不存在" }, 404);
    if (await exists(dest)) {
      return c.json({ error: `这个目录里已经有「${name}」了` }, 409);
    }
    await fsp.rename(src, dest);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
  console.log(`[files] rename by=${user.username} ${src} -> ${dest}`);
  // 目录改名的话，它底下每一行也要跟着改（relocateSessionFiles 里那段前缀替换）。
  const moves = [{ from: src, to: dest }];
  if (raw !== src) moves.push({ from: raw, to: path.join(path.dirname(raw), name) });
  relocateSessionFiles(moves);
  return c.json({ path: dest, name });
});

// 移动（重命名到另一个目录）。
//
// ⚠️ 白名单查两头：**源和目标都要查**，且都用 assertCanOpen 返回的规范化路径去动
// 文件——只查源的话，白名单内的文件能被搬到白名单外去；只查目标的话，别人的文件
// 能被搬进来。和 delete 一样是 handlerScoped（paths 是数组，中间件的 valueFrom
// 只读得到一个字符串）。
//
// ⚠️ **`fs.rename` 在 POSIX 上会静默覆盖同名文件**。这块地没有版本控制也没有回收站，
// 覆盖 = 不可恢复，所以同名一律拒（不像上传那样加序号：上传是「多一个文件」，
// 移动加序号则是把用户以为的一次整理变成两个半成品）。
filesRoute.post("/move", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    paths?: unknown;
    dest?: unknown;
  };
  const paths = Array.isArray(body.paths)
    ? body.paths.filter((p): p is string => typeof p === "string" && !!p)
    : [];
  const destRaw = typeof body.dest === "string" ? body.dest : "";
  if (paths.length === 0) return c.json({ error: "paths 必填" }, 400);
  if (!destRaw) return c.json({ error: "dest 必填" }, 400);

  const user = currentUser(c)!;
  const patterns = getAllowedPaths(user.id);

  let destDir: string;
  try {
    destDir = await assertCanOpen(destRaw, patterns);
  } catch {
    return c.json({ error: "目标目录不在你可访问的范围内" }, 403);
  }
  try {
    if (!(await fsp.stat(destDir)).isDirectory()) {
      return c.json({ error: "目标不是目录" }, 400);
    }
  } catch {
    return c.json({ error: "目标目录不存在" }, 404);
  }

  const moved: { from: string; to: string }[] = [];
  const failed: { path: string; error: string }[] = [];
  const relocations: { from: string; to: string }[] = [];

  for (const raw of paths) {
    let src: string;
    try {
      src = await assertCanOpen(raw, patterns);
    } catch {
      failed.push({ path: raw, error: "不在你可访问的目录内" });
      continue;
    }
    const name = path.basename(src);
    const dest = path.join(destDir, name);

    if (path.dirname(src) === destDir) {
      failed.push({ path: raw, error: "已经在这个目录里了" });
      continue;
    }
    // 把文件夹拖进它自己（或它的子孙）里 —— rename 在多数平台会回 EINVAL，
    // 但报错文案没法看，而且「移动完东西不见了」是这个操作最吓人的失败方式。
    if (dest === src || dest.startsWith(src + path.sep)) {
      failed.push({ path: raw, error: "不能移动到它自己里面" });
      continue;
    }
    try {
      if (await exists(dest)) {
        failed.push({ path: raw, error: `目标目录里已经有「${name}」了` });
        continue;
      }
      await fsp.rename(src, dest);
      console.log(`[files] move by=${user.username} ${src} -> ${dest}`);
      moved.push({ from: raw, to: dest });
      // registry 里源路径可能是原始写法也可能是规范化写法（见 delete 里那段注释），
      // 两种都改，各自配对到对应写法的新路径上。
      relocations.push({ from: src, to: dest });
      if (raw !== src) {
        relocations.push({ from: raw, to: path.join(destRaw, name) });
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // 跨设备（外接盘、网络卷）时 rename 是不允许的，只能复制再删。
      // 先 cp 成功了才 rm —— 反过来就是「复制失败 + 原件已经没了」。
      if (code === "EXDEV") {
        try {
          await fsp.cp(src, dest, { recursive: true, errorOnExist: true, force: false });
          await fsp.rm(src, { recursive: true });
          console.log(`[files] move(xdev) by=${user.username} ${src} -> ${dest}`);
          moved.push({ from: raw, to: dest });
          relocations.push({ from: src, to: dest });
          if (raw !== src) {
            relocations.push({ from: raw, to: path.join(destRaw, name) });
          }
          continue;
        } catch (err2) {
          failed.push({
            path: raw,
            error: err2 instanceof Error ? err2.message : String(err2),
          });
          continue;
        }
      }
      failed.push({
        path: raw,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  relocateSessionFiles(relocations);
  return c.json({ moved, failed });
});

// 新建文件夹。
//
// ⚠️ 和上传**故意不同的两点**：
//   1. 名字不消毒，**不合法就拒**。上传时把 "a/b.png" 悄悄改成 "a_b.png" 是合理的
//      （名字来自文件系统，用户没在打字）；而这里是用户刚敲进去的，改掉它等于
//      「点了确定，出来一个不是我要的文件夹」。
//   2. 重名不加序号，回 409。上传加序号是为了不覆盖 agent 的产出；建文件夹时
//      「已经有一个了」本身就是用户要知道的答案，给个 xxx-1 反而制造第二个。
//
// 路径逃逸不用在这里防：name 里不许出现任何分隔符，dir 由 policy.ts 的目录白名单
// 中间件管（"POST /api/files/mkdir" 那条的 paths）。
filesRoute.post("/mkdir", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    dir?: unknown;
    name?: unknown;
  };
  const dir = typeof body.dir === "string" ? body.dir : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!dir) return c.json({ error: "dir 必填" }, 400);
  const bad = entryNameProblem(name);
  if (bad) return c.json({ error: bad }, 400);

  try {
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) return c.json({ error: "dir 不是目录" }, 400);
  } catch {
    return c.json({ error: "目录不存在" }, 404);
  }

  const dest = path.join(dir, name);
  if (await exists(dest)) {
    return c.json({ error: `「${name}」已经存在了` }, 409);
  }
  try {
    // recursive:false —— 上面刚确认过不存在，这里再 recursive 就会把「并发建了
    // 同名文件夹」也吞成成功。
    await fsp.mkdir(dest);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
  return c.json({ path: dest, name });
});

// 返回一句人能看懂的拒绝理由，合法则返回 null。新建文件夹和重命名共用：
// 两者的输入都是「用户刚敲进去的一个名字」，规矩一样。
function entryNameProblem(name: string): string | null {
  if (!name) return "名字不能为空";
  if (name.length > 120) return "名字太长了（最多 120 个字符）";
  if (/[/\\]/.test(name)) return "名字里不能有 / 或 \\";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return "名字里有不可见的控制字符";
  if (name === "." || name === "..") return "这个名字被文件系统占用了";
  return null;
}

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

// RFC 6266 / 5987。中文文件名**必须**走 `filename*`，只写 `filename=` 的话浏览器
// 拿到的是乱码（这个仓库里的产出十有八九是中文名）。ASCII 那一半留着兜底。
//
// ⚠️ 控制字符要先清掉：文件名里是可以有换行的（POSIX 只禁 `/` 和 NUL），而一个
// 换行会把这个响应头劈成两半。
function contentDisposition(name: string): string {
  const clean = name.replace(/[\x00-\x1f\x7f]/g, "_");
  const ascii =
    clean.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download";
  // encodeURIComponent 不转义 `'()*`，但它们不是 RFC 5987 的 attr-char。
  const utf8 = encodeURIComponent(clean).replace(
    /['()*]/g,
    (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase()
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

// 一组文件的公共父目录。全在同一个目录里时就是那个目录。
function commonDir(paths: string[]): string {
  const parts = paths.map((p) => path.dirname(p).split(path.sep));
  const first = parts[0];
  let n = first.length;
  for (const other of parts.slice(1)) {
    n = Math.min(n, other.length);
    for (let i = 0; i < n; i++) {
      if (other[i] !== first[i]) {
        n = i;
        break;
      }
    }
  }
  return first.slice(0, n).join(path.sep) || path.sep;
}

export { filesRoute };
