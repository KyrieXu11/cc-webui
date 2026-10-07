import { Hono } from "hono";
import { currentUser } from "./auth/middleware.ts";
import { getAllowedPaths } from "./auth/users.ts";
import {
  canonicalizePattern,
  matchesAnyPattern,
  normalizePath,
  patternRoot,
} from "./auth/paths.ts";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DirectoryScanCache } from "./directory-scan-cache.ts";

import {
  listOpenedProjects,
  recordOpenedProject,
  removeOpenedProject,
} from "./opened-projects.ts";

const fsRoute = new Hono();

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".pnpm",
  ".yarn",
  "dist",
  "build",
  "out",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".Trash",
  "Library",
  "Applications",
  "Music",
  "Movies",
  "Pictures",
  "Public",
  "Photos Library.photoslibrary",
]);

const KEEP_HIDDEN = new Set([".claude", ".config", ".codex", ".cursor"]);

function shouldKeep(name: string): boolean {
  if (IGNORE_DIRS.has(name)) return false;
  if (name.startsWith(".") && !KEEP_HIDDEN.has(name)) return false;
  if (name.endsWith(".app") || name.endsWith(".photoslibrary")) return false;
  return true;
}

// 一个不回话的目录不能把整个服务拖死。
//
// macOS 的 TCC 对 launchd 起的进程干的正是这件事：读 ~/Documents / ~/Desktop /
// ~/Downloads 时它既不返回也不报错，而是**永远挂着**——因为没有前台可以弹授权框。
// 更糟的是 Promise.race **取消不了那个 syscall**：每挂一次就永久占掉一个 libuv
// 线程池线程（默认只有 4 个），四次之后这个进程里所有文件读写全部排队等死，连静态
// 首页都发不出来。所以除了超时，还必须把这种目录**记下来别再碰**。
//
// 名单是进程级的，重启即清空——这样管理员在系统设置里补了「完全磁盘访问权限」
// 之后，重启服务就能恢复，不需要改任何配置。
const READDIR_TIMEOUT_MS = 800;
const unresponsiveDirs = new Set<string>();

async function readdirOrGiveUp(
  dir: string,
): Promise<Array<import("node:fs").Dirent> | null> {
  if (unresponsiveDirs.has(dir)) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const entries = await Promise.race([
      fs.readdir(dir, { withFileTypes: true }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), READDIR_TIMEOUT_MS);
      }),
    ]);
    if (entries === null) {
      unresponsiveDirs.add(dir);
      console.warn(
        `[cc-webui] fs: ${dir} 在 ${READDIR_TIMEOUT_MS}ms 内没有响应，本进程后续不再读它。` +
          " macOS 上这通常是 TCC：到「系统设置 → 隐私与安全性 → 完全磁盘访问权限」" +
          " 里把跑这个服务的 node 可执行文件加进去，然后重启服务。",
      );
      return null;
    }
    return entries;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ⚠️ **`Dirent.isDirectory()` 对符号链接恒为 false。** readdir(withFileTypes) 给的是
// lstat 语义：软链只有 `isSymbolicLink()` 为真。不管它的话，指向目录的软链在树里被
// 标成 file、展不开，在项目扫描里直接被跳过（用户 2026-09-17 报的 `design ->
// ~/code/python/quant/design`）。
//
// ⚠️ 跟随软链要跑一次 stat，所以**必须带超时**，理由和 readdirOrGiveUp 一模一样：
// 软链可以指向 ~/Documents 那种在 launchd 下永久挂起的目录，一次挂起就永久占掉一个
// libuv 线程池线程。坏链（stat 抛 ENOENT）当普通文件，别让树炸掉。
async function isDirFollowingLinks(
  full: string,
  e: import("node:fs").Dirent,
): Promise<boolean> {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const st = await Promise.race([
      fs.stat(full),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), READDIR_TIMEOUT_MS);
      }),
    ]);
    return st !== null && st.isDirectory();
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function walkDirs(
  root: string,
  maxDepth = 3,
  maxItems = 2000,
  timeoutMs = 4000
): Promise<string[]> {
  const results: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
  const start = Date.now();

  while (queue.length > 0 && results.length < maxItems) {
    if (Date.now() - start > timeoutMs) break;
    const { dir, depth } = queue.shift()!;
    const entries = await readdirOrGiveUp(dir);
    if (!entries) continue;
    for (const e of entries) {
      // 先按名字筛：shouldKeep 是纯字符串判断，放前面能省掉对被忽略项的 stat。
      if (!shouldKeep(e.name)) continue;
      const full = path.join(dir, e.name);
      if (!(await isDirFollowingLinks(full, e))) continue;
      results.push(full);
      // ⚠️ **不跟着软链往下走**：软链可以成环（a/link -> a），BFS 就绕不出来了。
      // 深度/条数/超时三道闸都拦不住一个转得飞快的环 —— 它每一圈都在产出新结果。
      // 软链本身仍然是一条可选项，只是不替你展开它下面的子树。
      if (!e.isSymbolicLink() && depth + 1 < maxDepth) {
        queue.push({ dir: full, depth: depth + 1 });
      }
      if (results.length >= maxItems) break;
    }
  }
  return results;
}

fsRoute.get("/home", (c) => c.json({ home: os.homedir() }));

const TREE_IGNORE = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "out",
  ".DS_Store",
]);

const READ_MAX_BYTES = 256 * 1024; // 256 KB cap for diff-context reads
// 图片 + PDF 都走这条路由。上限抬到 50MB 是为了 PDF：扫描件动辄十几兆，
// 卡在 10MB 的话前端那个 <iframe> 里显示的是一段 JSON 报错，看着像坏了。
// ⚠️ 这里是 readFile 整个读进内存的，不是流式——单用户自托管才敢这么写。
const RAW_MAX_BYTES = 50 * 1024 * 1024;

const RAW_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  // 必须显式给出：octet-stream 会让浏览器直接下载，内置 PDF viewer 根本不出场。
  pdf: "application/pdf",
};

// HTML 预览的沙箱档位。**iframe 上的 sandbox 属性和下面那条 CSP 必须写成同一套**：
// 两者同时生效时浏览器取的是**交集**，CSP 只给 `allow-scripts` 的话，iframe 上写的
// allow-modals / allow-forms 会被一起削掉（`alert()` 静默失效、表单提不出去），
// 而人是照着 iframe 那行去 debug 的，根本想不到是响应头把它砍了。
// 前端那份写在 src/lib/filepreview.ts 的 HTML_SANDBOX，改一处就得改两处。
const HTML_SANDBOX = "allow-scripts allow-popups allow-forms allow-modals";

fsRoute.get("/read", async (c) => {
  const p = c.req.query("path");
  if (!p) return c.json({ error: "path required" }, 400);
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile()) return c.json({ error: "not a file" }, 400);
    const truncated = stat.size > READ_MAX_BYTES;
    const handle = await fs.open(p, "r");
    try {
      const buf = Buffer.alloc(Math.min(stat.size, READ_MAX_BYTES));
      await handle.read(buf, 0, buf.length, 0);
      const content = buf.toString("utf-8");
      return c.json({
        content,
        size: stat.size,
        truncated,
        // 取件台的乐观锁用它：保存时带回来比对，变了就拒绝覆盖
        // （docs/file-manager.md 决策 12）。
        mtimeMs: stat.mtimeMs,
      });
    } finally {
      await handle.close();
    }
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      404
    );
  }
});

fsRoute.get("/raw", async (c) => {
  const p = c.req.query("path");
  if (!p) return c.json({ error: "path required" }, 400);
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile()) return c.json({ error: "not a file" }, 400);
    if (stat.size > RAW_MAX_BYTES) {
      return c.json({ error: `file too large (> ${RAW_MAX_BYTES} bytes)` }, 413);
    }
    const ext = path.extname(p).slice(1).toLowerCase();
    // `?render=1` 是**唯一**能让这条路由回 text/html 的开关，而且只认 .html/.htm。
    // 为什么不干脆按扩展名无条件回 text/html：这条路由是**同源**的，回了 text/html
    // 就等于给这台机器开了一个同源 XSS —— agent 有 shell，往白名单里落一个 .html，
    // 用户在新标签页点开它，脚本就跑在本站源上，能读登录 cookie / localStorage、
    // 能以登录身份打所有 /api/*。这仓库是多用户的，那等于横向越权。
    const render = (ext === "html" || ext === "htm") && c.req.query("render") === "1";
    // charset 显式钉 utf-8：agent 产出的 html 就是 utf-8，而不给 charset 的话
    // 没写 <meta> 的页面会按浏览器区域设置猜，中文直接乱码。
    const mime = render
      ? "text/html; charset=utf-8"
      : (RAW_MIME[ext] ?? "application/octet-stream");
    const headers: Record<string, string> = {
      "content-type": mime,
      "cache-control": "private, max-age=60",
      "content-length": String(stat.size),
      // 类型已经显式给了就别让浏览器再去猜 —— 它猜错的方向恰好是「当成 HTML 执行」。
      "x-content-type-options": "nosniff",
    };
    if (render) {
      // ⚠️ **这条不是给 iframe 用的**（iframe 那侧自己带 sandbox 属性），是给
      // 「用户/agent 直接导航到这个 URL」那条路兜底的：`?render=1` 谁都能拼，
      // 没有它的话直接打开就是一个**同源**文档，前端那个 sandbox 等于白设。
      // CSP 的 sandbox 让它在顶层导航下也拿到一个 opaque origin：脚本照跑，
      // 但 cookie / localStorage / 同源 fetch 一样都够不着本站。
      headers["content-security-policy"] = `sandbox ${HTML_SANDBOX}`;
      // agent 随时会重写这个文件，而 max-age=60 会让「刚改完再打开」看到上一版。
      // 这条路由读的是本机文件，省那一次 IO 换来的是让人怀疑人生的一分钟。
      headers["cache-control"] = "private, no-store";
    } else if (ext === "svg") {
      // 顺手堵掉同一类的老洞：SVG 是**可以带 `<script>` 的文档格式**，而它一直回
      // image/svg+xml，直接导航打开就在本站源上执行。加 sandbox（连 allow-scripts
      // 都不给）即可；CSP 响应头对 `<img>` 拉到的图片是被忽略的，所以 ImageView
      // 那条路一点不受影响。
      headers["content-security-policy"] = "sandbox";
    }
    const data = await fs.readFile(p);
    return new Response(data, { headers });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      404
    );
  }
});

fsRoute.get("/tree", async (c) => {
  const dir = c.req.query("path");
  if (!dir) return c.json({ error: "path required" }, 400);
  try {
    const entries = await readdirOrGiveUp(dir);
    if (!entries) {
      return c.json(
        {
          entries: [],
          error: `${dir} 没有响应`,
          detail:
            "这个目录在超时内没有回应。macOS 上通常是系统隐私授权：需要给运行本服务的 node 加上「完全磁盘访问权限」再重启服务。",
        },
        504,
      );
    }
    const result = (
      await Promise.all(
        entries
          .filter((e) => !TREE_IGNORE.has(e.name))
          .map(async (e) => {
            const full = path.join(dir, e.name);
            const type: "dir" | "file" = (await isDirFollowingLinks(full, e))
              ? "dir"
              : "file";
            return { name: e.name, path: full, type };
          }),
      )
    )
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return c.json({ entries: result });
  } catch (err) {
    return c.json(
      {
        entries: [],
        error: err instanceof Error ? err.message : String(err),
      },
      500
    );
  }
});

// 只遍历这个账号真正可能打开的地方。
//
// 原来是「走完整个 $HOME，再按白名单过滤」：对一个只被授权了一个目录的账号，
// 那两千次 readdir 全是白干的——而且正是它把 ~/Documents 这类目录卷了进来
// （launchd 下会永久挂起，见 readdirOrGiveUp）。
//
// 白名单里任何一条「哪儿都行」的模式（管理员默认的 `**`）仍然退回到走 $HOME：
// 对一个项目选择器来说那才是它的意思，从 / 开始走只会更慢更没用。
function scanRootsFor(patterns: readonly string[], home: string): string[] {
  const roots: string[] = [];
  for (const raw of patterns) {
    const root = patternRoot(raw);
    if (!root || root === path.sep) return [home];
    roots.push(root);
  }
  // 去掉被别人包住的：`~/code/**` 和 `~/code/a/**` 同时在时只走前者。
  return roots
    .filter((r, i) => !roots.some((o, j) => j !== i && r.startsWith(o + path.sep)))
    .filter((r, i, all) => all.indexOf(r) === i);
}

const directoryScans = new DirectoryScanCache(walkDirs);

fsRoute.get("/scan", async (c) => {
  const home = os.homedir();
  // Only offer what this account may actually open. Cosmetic — the binding
  // check still happens server-side when a path is used (OpenProjectDialog
  // accepts hand-typed paths) — but offering unopenable folders is worse than
  // not listing them.
  //
  // Patterns are canonicalised once, then matched synchronously: realpath'ing
  // each of up to 2000 directories would be pointless work for a picker.
  const user = currentUser(c)!;
  const allowed = getAllowedPaths(user.id);
  const roots = scanRootsFor(allowed, home);
  const patterns = await Promise.all(allowed.map(canonicalizePattern));

  const seen = new Set<string>();
  for (const raw of roots) {
    // Canonicalise first: the patterns are realpath'd (canonicalizePattern), and
    // on macOS a root under /tmp or /var would otherwise never match them.
    const root = await normalizePath(raw);
    // The root itself is openable too — walkDirs only returns children, and for
    // a workspace-only account the root IS the whole grant. ($HOME is excluded:
    // it is the fallback for `**`, not a project.)
    if (root !== home && matchesAnyPattern(root, patterns)) seen.add(root);
    for (const d of await directoryScans.get(root, c.req.query("refresh") === "1")) {
      if (matchesAnyPattern(d, patterns)) seen.add(d);
      if (seen.size >= 2000) break;
    }
    if (seen.size >= 2000) break;
  }
  // A cold walk can take seconds. A grant revoked while it was running must
  // also disappear, not survive until the next request/cache expiry.
  const currentPatterns = await Promise.all(getAllowedPaths(user.id).map(canonicalizePattern));
  return c.json({ dirs: [...seen].filter((d) => matchesAnyPattern(d, currentPatterns)), home });
});

fsRoute.get("/recents", async (c) => {
  const userId = currentUser(c)!.id;
  if (getAllowedPaths(userId).length === 0) return c.json({ recents: [] });
  const candidates = await Promise.all(listOpenedProjects(userId).map(async (recent) => ({
    recent, normalized: await normalizePath(recent.path),
  })));
  const patterns = await Promise.all(getAllowedPaths(userId).map(canonicalizePattern));
  return c.json({ recents: candidates
    .filter(({ normalized }) => matchesAnyPattern(normalized, patterns))
    .map(({ recent }) => recent) });
});

fsRoute.post("/recents", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const p: string = body.path;
  if (!p) return c.json({ error: "path required" }, 400);
  const userId = currentUser(c)!.id;
  recordOpenedProject(p, userId);
  return c.json({ recents: listOpenedProjects(userId) });
});

fsRoute.delete("/recents", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const p: string = body.path;
  if (p) removeOpenedProject(p, currentUser(c)!.id);
  return c.json({ ok: true });
});

export { fsRoute };
