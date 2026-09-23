// 项目记忆（只读）的前端一半。服务端在 server/memory-routes.ts，那里写着为什么
// 只读、为什么单开一条路由。这里只有「取」和两个纯函数，没有任何写操作。

export type Memory = {
  file: string;
  name: string;
  description: string;
  type: string;
  modified: string;
  body: string;
  truncated: boolean;
};

export type ProjectMemory = {
  dir: string | null;
  index: string | null;
  memories: Memory[];
};

export async function getProjectMemory(cwd: string): Promise<ProjectMemory> {
  const res = await fetch(`/api/memory?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
    throw new Error(b.detail || b.error || `读取记忆失败：${res.status}`);
  }
  return (await res.json()) as ProjectMemory;
}

export type IndexEntry = { title: string; file: string; hook: string };

// MEMORY.md 一行一条：`- [标题](文件.md) — 一句话`。认不出的行（标题、空行、
// 手写的说明）直接跳过 —— 索引原文另外整段可看，不会因此丢东西。
export function parseMemoryIndex(md: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*\[([^\]]+)\]\(([^)\s]+\.md)\)\s*(?:[—–-]+\s*)?(.*)$/.exec(line);
    if (m) out.push({ title: m[1], file: m[2], hook: m[3].trim() });
  }
  return out;
}

// 列表的顺序：先按索引里的顺序，再补上**不在索引里**的（CLI 写了文件却没进索引，
// 或者索引里那行被删了）——它们照样是会被读到的记忆，不能因为没进索引就看不见。
export function orderMemories(
  index: IndexEntry[],
  memories: Memory[],
): Array<{ memory: Memory; title: string; hook: string; indexed: boolean }> {
  const byFile = new Map(memories.map((m) => [m.file, m]));
  const seen = new Set<string>();
  const out: Array<{ memory: Memory; title: string; hook: string; indexed: boolean }> = [];
  for (const e of index) {
    const m = byFile.get(e.file);
    if (!m || seen.has(e.file)) continue;
    seen.add(e.file);
    out.push({ memory: m, title: e.title, hook: e.hook || m.description, indexed: true });
  }
  for (const m of [...memories].sort((a, b) => a.name.localeCompare(b.name))) {
    if (seen.has(m.file)) continue;
    out.push({ memory: m, title: m.name, hook: m.description, indexed: false });
  }
  return out;
}

// 正文里的 [[其它记忆]] 变成可点的站内链接（MemoryDialog 在捕获阶段接住点击）。
export const MEMORY_LINK_PREFIX = "#memory:";
export function linkifyMemoryRefs(body: string): string {
  return body.replace(/\[\[([^\]\n]+)\]\]/g, (_, name: string) => {
    const n = name.trim();
    return `[${n}](${MEMORY_LINK_PREFIX}${encodeURIComponent(n)})`;
  });
}
