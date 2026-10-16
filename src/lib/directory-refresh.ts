import type { TreeEntry } from "./fs";

export type DirectorySnapshot = {
  path: string;
  revision: number;
  entries: TreeEntry[] | null;
  error: string | null;
};

export function beginDirectoryRefresh(previous: DirectorySnapshot, path: string): DirectorySnapshot {
  return previous.path === path ? { ...previous, error: null } : { path, revision: -1, entries: null, error: null };
}

export function failDirectoryRefresh(previous: DirectorySnapshot, path: string, message: string, status?: number): DirectorySnapshot {
  const snapshot = beginDirectoryRefresh(previous, path);
  // 短暂网络故障保留旧列表；失去权限或目录消失不能继续伪装成有效数据。
  return { ...snapshot, entries: status === 401 || status === 403 || status === 404 ? null : snapshot.entries, error: message };
}

export function directoryNeedsRead(snapshot: DirectorySnapshot, path: string, revision: number): boolean {
  return snapshot.path !== path || snapshot.revision !== revision || snapshot.entries === null;
}

// 刷新多个已展开目录时最多四个请求在途；不预读收起的子树，也不缓存授权结果。
export function createDirectoryLoader(read: (path: string, signal: AbortSignal) => Promise<TreeEntry[]>, concurrency = 4) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid directory read concurrency");
  let active = 0;
  type Job = { path: string; signal: AbortSignal; resolve: (entries: TreeEntry[]) => void; reject: (error: unknown) => void; onAbort: () => void };
  const waiting: Job[] = [];
  const pump = () => {
    while (active < concurrency && waiting.length) {
      const job = waiting.shift()!;
      job.signal.removeEventListener("abort", job.onAbort);
      if (job.signal.aborted) { job.reject(new DOMException("Aborted", "AbortError")); continue; }
      active++;
      Promise.resolve().then(() => read(job.path, job.signal)).then(job.resolve, job.reject).finally(() => { active--; pump(); });
    }
  };
  return (path: string, signal: AbortSignal): Promise<TreeEntry[]> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const job: Job = { path, signal, resolve, reject, onAbort: () => {
      const index = waiting.indexOf(job);
      if (index !== -1) { waiting.splice(index, 1); reject(new DOMException("Aborted", "AbortError")); }
    } };
    signal.addEventListener("abort", job.onAbort, { once: true });
    waiting.push(job); pump();
  });
}
