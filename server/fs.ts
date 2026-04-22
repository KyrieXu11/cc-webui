import { Hono } from "hono";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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
  return c.json({ dirs, home });
});

const RECENTS_PATH = path.join(os.homedir(), ".cc-webui", "recents.json");

type Recent = { path: string; lastUsed: number };

async function loadRecents(): Promise<Recent[]> {
  try {
    const raw = await fs.readFile(RECENTS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveRecents(recents: Recent[]) {
  await fs.mkdir(path.dirname(RECENTS_PATH), { recursive: true });
  await fs.writeFile(RECENTS_PATH, JSON.stringify(recents, null, 2));
}

fsRoute.get("/recents", async (c) => {
  const recents = await loadRecents();
  return c.json({ recents });
});

fsRoute.post("/recents", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const p: string = body.path;
  if (!p) return c.json({ error: "path required" }, 400);
  const recents = await loadRecents();
  const filtered = recents.filter((r) => r.path !== p);
  filtered.unshift({ path: p, lastUsed: Date.now() });
  const trimmed = filtered.slice(0, 20);
  await saveRecents(trimmed);
  return c.json({ recents: trimmed });
});

fsRoute.delete("/recents", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const p: string = body.path;
  const recents = await loadRecents();
  await saveRecents(recents.filter((r) => r.path !== p));
  return c.json({ ok: true });
});

export { fsRoute };
