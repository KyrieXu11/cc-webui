// 取件台的 API 客户端。术语见 CONTEXT.md，设计见 docs/file-manager.md。

export type ConversationFile = {
  path: string;
  name: string;
  dir: string;
  size: number;
  mtimeMs: number;
  firstSeenMs: number;
};

// 本对话文件。没有 sessionId（还没起过 turn）时天然是空列表，不是错误。
export async function listConversationFiles(
  sessionId: string | null
): Promise<ConversationFile[]> {
  if (!sessionId) return [];
  const res = await fetch(
    `/api/files?sessionId=${encodeURIComponent(sessionId)}`
  );
  if (!res.ok) throw new Error(`列出文件失败：${res.status}`);
  const body = (await res.json()) as { files?: ConversationFile[] };
  return body.files ?? [];
}

export function humanSize(n: number): string {
  if (!n) return "—"; // 0 写成「0 B」看着像坏了
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 今天的只写时刻，今年的写月日，往年的才带年份 —— 取件台里绝大多数文件都是
// 刚生成的，年份天天占位没意义。
export function humanTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const hm = `${d.getHours()}:${d.getMinutes().toString().padStart(2, "0")}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return hm;
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear()
    ? `${md} ${hm}`
    : `${d.getFullYear()}年${md}`;
}

// 取件台自己的读：比 lib/fs.ts 的 readFile 多返 mtimeMs+size，乐观锁要用。
// 没有改那个旧函数，因为它有别的调用方（目录树预览），不需要这两个字段。
export type FileContent = {
  content: string;
  truncated: boolean;
  mtimeMs: number;
  size: number;
};

export async function readFileVersioned(
  absPath: string
): Promise<FileContent> {
  const res = await fetch(`/api/fs/read?path=${encodeURIComponent(absPath)}`);
  if (!res.ok) throw new Error(`读取失败：${res.status}`);
  const d = (await res.json()) as Partial<FileContent>;
  return {
    content: d.content ?? "",
    truncated: !!d.truncated,
    mtimeMs: d.mtimeMs ?? 0,
    size: d.size ?? 0,
  };
}

export type SaveResult =
  | { ok: true; mtimeMs: number; size: number }
  | { ok: false; conflict: boolean; message: string };

// 保存必须带上打开时看到的版本。409 = 编辑期间文件被改过（很可能是 agent），
// 这时**不覆盖**，让调用方提示重新打开（决策 12）。
export async function saveFile(
  absPath: string,
  content: string,
  ifMatch: { mtimeMs: number; size: number }
): Promise<SaveResult> {
  const res = await fetch("/api/files/content", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: absPath, content, ifMatch }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) {
    return {
      ok: true,
      mtimeMs: Number(body.mtimeMs ?? 0),
      size: Number(body.size ?? 0),
    };
  }
  return {
    ok: false,
    conflict: res.status === 409,
    message:
      typeof body.detail === "string"
        ? body.detail
        : typeof body.error === "string"
          ? body.error
          : `保存失败：${res.status}`,
  };
}

export type DeleteResult = {
  deleted: string[];
  failed: { path: string; error: string }[];
};

// 真删，没有回收站。调用方必须先确认过（决策 13）。
export async function deleteFiles(
  paths: string[],
  sessionId: string | null
): Promise<DeleteResult> {
  const res = await fetch("/api/files/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths, sessionId: sessionId ?? "" }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? `删除失败：${res.status}`);
  }
  return (await res.json()) as DeleteResult;
}

// 上传到「本文件夹」。目标目录走 query —— 白名单检查读的是那儿（见
// server/files-routes.ts 的 ⚠️）。
export async function uploadToDir(
  dir: string,
  files: FileList | File[]
): Promise<{ files: { path: string; name: string; size: number }[] }> {
  const form = new FormData();
  for (const f of Array.from(files)) form.append("files", f);
  const res = await fetch(
    `/api/files/upload?dir=${encodeURIComponent(dir)}`,
    { method: "POST", body: form }
  );
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? `上传失败：${res.status}`);
  }
  return (await res.json()) as {
    files: { path: string; name: string; size: number }[];
  };
}
