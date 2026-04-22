export type RecentProject = { path: string; lastUsed: number };

export type TreeEntry = {
  name: string;
  path: string;
  type: "file" | "dir";
};

export async function readFile(
  absPath: string
): Promise<{ content: string; truncated: boolean } | null> {
  const qs = new URLSearchParams({ path: absPath });
  const res = await fetch(`/api/fs/read?${qs.toString()}`);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data?.content && data.content !== "") return null;
  return { content: data.content, truncated: !!data.truncated };
}

export async function listTree(absPath: string): Promise<TreeEntry[]> {
  const qs = new URLSearchParams({ path: absPath });
  const res = await fetch(`/api/fs/tree?${qs.toString()}`);
  if (!res.ok) return [];
  const { entries } = await res.json();
  return entries ?? [];
}

export async function scanProjects(): Promise<{
  dirs: string[];
  home: string;
}> {
  const res = await fetch("/api/fs/scan");
  if (!res.ok) throw new Error("scan failed");
  return res.json();
}

export async function getHome(): Promise<string> {
  const res = await fetch("/api/fs/home");
  if (!res.ok) throw new Error("home failed");
  const { home } = await res.json();
  return home;
}

export async function getRecents(): Promise<RecentProject[]> {
  const res = await fetch("/api/fs/recents");
  if (!res.ok) throw new Error("recents failed");
  const { recents } = await res.json();
  return recents ?? [];
}

export async function addRecent(path: string): Promise<RecentProject[]> {
  const res = await fetch("/api/fs/recents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) return [];
  const { recents } = await res.json();
  return recents ?? [];
}

export async function removeRecent(path: string) {
  await fetch("/api/fs/recents", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

export function tildify(p: string, home: string): string {
  if (!p) return "";
  if (!home) return p;
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}天前`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}个月前`;
  return `${Math.floor(mo / 12)}年前`;
}
