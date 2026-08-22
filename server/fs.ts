import { Hono } from "hono";
import { currentUser } from "./auth/middleware.ts";
import { getAllowedPaths } from "./auth/users.ts";
import { canonicalizePattern, matchesAnyPattern } from "./auth/paths.ts";
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
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
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
    const entries = await fs.readdir(dir, { withFileTypes: true });
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

fsRoute.get("/scan", async (c) => {
  const home = os.homedir();
  const dirs = await walkDirs(home);
  // Only offer what this account may actually open. Cosmetic — the binding
  // check still happens server-side when a path is used (OpenProjectDialog
  // accepts hand-typed paths) — but offering unopenable folders is worse than
  // not listing them.
  //
  // Patterns are canonicalised once, then matched synchronously: realpath'ing
  // each of up to 2000 directories would be pointless work for a picker.
  const patterns = await Promise.all(
    getAllowedPaths(currentUser(c)!.id).map(canonicalizePattern),
  );
  return c.json({ dirs: dirs.filter((d) => matchesAnyPattern(d, patterns)), home });
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
