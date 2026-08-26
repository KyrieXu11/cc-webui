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
      if (!e.isDirectory()) continue;
      if (!shouldKeep(e.name)) continue;
      const full = path.join(dir, e.name);
      results.push(full);
      if (depth + 1 < maxDepth) queue.push({ dir: full, depth: depth + 1 });
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
const RAW_MAX_BYTES = 10 * 1024 * 1024; // 10 MB cap for image preview

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

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
    const mime = IMAGE_MIME[ext] ?? "application/octet-stream";
    const data = await fs.readFile(p);
    return new Response(data, {
      headers: {
        "content-type": mime,
        "cache-control": "private, max-age=60",
        "content-length": String(stat.size),
      },
    });
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
    const result = entries
      .filter((e) => !TREE_IGNORE.has(e.name))
      .map((e) => ({
        name: e.name,
        path: path.join(dir, e.name),
        type: e.isDirectory() ? "dir" : "file",
      }))
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
    for (const d of await walkDirs(root)) {
      if (matchesAnyPattern(d, patterns)) seen.add(d);
      if (seen.size >= 2000) break;
    }
    if (seen.size >= 2000) break;
  }
  return c.json({ dirs: [...seen], home });
});

fsRoute.get("/recents", async (c) => {
  return c.json({ recents: listOpenedProjects(currentUser(c)!.id) });
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
