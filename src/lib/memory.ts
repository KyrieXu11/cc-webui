// 统一项目记忆的只读浏览。旧 Claude 来源仅供服务端迁移，不在日常 UI 展示。

export type Memory = {
  file: string;
  name: string;
  description: string;
  type: string;
  modified: string;
  body: string;
  truncated: boolean;
  revision?: number;
  provider?: string;
};

export type ProjectMemory = {
  dir: string | null;
  index: string | null;
  memories: Memory[];
  enabled?: boolean;
  total?: number;
  nextCursor?: number | null;
};

export async function getProjectMemory(cwd: string, cursor = 0): Promise<ProjectMemory> {
  const res = await fetch(`/api/project-memory?cwd=${encodeURIComponent(cwd)}&cursor=${cursor}`);
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
    throw new Error(b.detail || b.error || `读取记忆失败：${res.status}`);
  }
  return (await res.json()) as ProjectMemory;
}

export type IndexEntry = { title: string; file: string; hook: string };
export type MemoryItem = { memory: Memory; title: string; hook: string; indexed: boolean };

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
): MemoryItem[] {
  const byFile = new Map(memories.map((m) => [m.file, m]));
  const seen = new Set<string>();
  const out: MemoryItem[] = [];
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

export function filterMemories(items: MemoryItem[], query: string): MemoryItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return items;
  return items.filter(({ memory: m, title, hook }) => {
    const fields = [title, hook, m.name, m.file, m.description, m.body].map(s => s.toLowerCase());
    return terms.every(term => fields.some(field => field.includes(term)));
  });
}

export function memorySearchSnippet(item: MemoryItem, query: string): string {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const metadata = [item.title, item.hook, item.memory.name, item.memory.description].join(" ").toLowerCase();
  if (!terms.length || terms.every(term => metadata.includes(term))) return item.hook;
  const body = item.memory.body.replace(/\s+/g, " ");
  const hits = terms.map(term => body.toLowerCase().indexOf(term)).filter(at => at >= 0);
  if (!hits.length) return item.hook;
  const start = Math.max(0, Math.min(...hits) - 28), end = Math.min(body.length, start + 120);
  return `正文：${start ? "…" : ""}${body.slice(start, end)}${end < body.length ? "…" : ""}`;
}

export function mergeMemoryPage(current: ProjectMemory, next: ProjectMemory): ProjectMemory {
  const memories = new Map(current.memories.map(m => [m.file, m]));
  for (const memory of next.memories) memories.set(memory.file, memory);
  return { ...next, index: [current.index, next.index].filter(Boolean).join("\n"), memories: [...memories.values()] };
}

// 正文里的 [[其它记忆]] 变成可点的站内链接（MemoryDialog 在捕获阶段接住点击）。
export const MEMORY_LINK_PREFIX = "#memory:";
export function linkifyMemoryRefs(body: string): string {
  return body.replace(/\[\[([^\]\n]+)\]\]/g, (_, name: string) => {
    const n = name.trim();
    return `[${n}](${MEMORY_LINK_PREFIX}${encodeURIComponent(n)})`;
  });
}
