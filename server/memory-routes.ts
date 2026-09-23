// 项目记忆（只读）：Claude CLI 给每个项目自动维护的那份记忆 ——
// `~/.claude/projects/<slug>/memory/` 下的 MEMORY.md（索引）+ 每条一个 .md
// （frontmatter 里是 name / description / metadata.type / metadata.modified）。
//
// ⚠️ **只读，不许写**（用户 2026-09-23：「注意，不可编辑，只读」）。这个目录是
// CLI 自己的存储，和终端里的 claude 共用，写坏了影响的是之后每一轮对话。所以这里
// 只有一条 GET，没有 PUT / DELETE；前端也没有任何编辑入口。
//
// 为什么是一条专门的路由，而不是走 /api/fs/read：这个目录在 ~/.claude 下面，不在
// 任何人的目录白名单里（也不该在）。能看哪个项目的记忆，由「你能不能打开这个项目」
// 决定 —— policy 表对 query 里的 cwd 做白名单检查；这里只从 cwd 推导目录，**不收
// 任何调用方给的文件名**，读哪些文件完全由 readdir 决定。

import { Hono } from "hono";
import { promises as fs } from "node:fs";
import path from "node:path";
import { projectSlug, projectsDir } from "./claude-sessions.ts";

const memoryRoute = new Hono();

// 一条记忆几 KB。两道闸只防失控的目录 / 文件，不是正常路径上会碰到的。
const MAX_FILES = 300;
const MAX_BYTES = 256 * 1024;

export type MemoryEntry = {
  file: string;
  name: string;
  description: string;
  type: string;
  modified: string;
  body: string;
  truncated: boolean;
};

// frontmatter 只认这里用得到的那几个键，嵌套的（metadata 下面那层）压平。
// 不是通用 YAML 解析器，也不需要是：格式是 CLI 写的，认不出的键直接忽略。
export function parseMemoryFile(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  const meta: Record<string, string> = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { meta, body: raw };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv || !kv[2].trim()) continue;
    meta[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: raw.slice(m[0].length) };
}

async function readCapped(file: string): Promise<{ text: string; truncated: boolean }> {
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const truncated = bytesRead > MAX_BYTES;
    return {
      text: buf.subarray(0, Math.min(bytesRead, MAX_BYTES)).toString("utf8"),
      truncated,
    };
  } finally {
    await fh.close();
  }
}

// CLI 用的是它**看到的** cwd 算 slug，也就是 cc-webui 起进程时传的那个字符串。
// 先按原样找；找不到再试 realpath（/tmp → /private/tmp 这类写法差异）。
async function memoryDirFor(cwd: string): Promise<string | null> {
  const given = path.resolve(cwd);
  const candidates = [given];
  const real = await fs.realpath(given).catch(() => null);
  if (real && real !== given) candidates.push(real);
  for (const c of candidates) {
    const dir = path.join(projectsDir(), projectSlug(c), "memory");
    const st = await fs.stat(dir).catch(() => null);
    if (st?.isDirectory()) return dir;
  }
  return null;
}

memoryRoute.get("/", async (c) => {
  const cwd = c.req.query("cwd") ?? "";
  const dir = await memoryDirFor(cwd);
  if (!dir) return c.json({ dir: null, index: null, memories: [] });

  const names = (await fs.readdir(dir))
    .filter((n) => n.endsWith(".md"))
    .sort()
    .slice(0, MAX_FILES);

  let index: string | null = null;
  const memories: MemoryEntry[] = [];
  for (const n of names) {
    const p = path.join(dir, n);
    // lstat 而不是 stat：目录里一个指向别处的 symlink 不该把别处的内容带出来。
    const st = await fs.lstat(p).catch(() => null);
    if (!st?.isFile()) continue;
    const { text, truncated } = await readCapped(p);
    if (n === "MEMORY.md") {
      index = text;
      continue;
    }
    const { meta, body } = parseMemoryFile(text);
    memories.push({
      file: n,
      name: meta.name || n.replace(/\.md$/, ""),
      description: meta.description ?? "",
      type: meta.type ?? "",
      modified: meta.modified ?? st.mtime.toISOString(),
      body,
      truncated,
    });
  }
  return c.json({ dir, index, memories });
});

export { memoryRoute };
