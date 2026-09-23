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

// 下载（决策 18）。一个文件直接下，多个由服务端打成一个 zip。
//
// **不做「连续触发 N 次下载」**：浏览器把第二个之后的下载当弹窗拦（Chrome 会问
// 「是否允许下载多个文件」），用户误点一次「阻止」之后，此后所有下载都**静默**
// 失败——页面这边收不到任何事件，看着就是按钮坏了。一次请求一个文件没有这个问题。
//
// 用 <a download> 而不是 fetch → blob：blob 要把整个文件先读进浏览器内存，而取件台
// 里可能是几百 MB 的产出；交给浏览器还白拿原生的进度条和「继续下载」。代价是服务端
// 出错时（文件正好被 agent 删了）浏览器会把那段 JSON 存成文件，但那一份小得一眼能
// 认出来，比一个吃内存的实现划算。
//
// ⚠️ `download` 属性必须留空字符串，不能省：省了的话出错响应（没有
// content-disposition）会让浏览器**导航**过去，整个页面就没了；留空则文件名仍然
// 取服务端的 content-disposition（同源时它优先于这个属性）。
export function downloadFiles(paths: string[]): void {
  if (paths.length === 0) return;
  const qs = paths.map((p) => `path=${encodeURIComponent(p)}`).join("&");
  const a = document.createElement("a");
  a.href = `/api/files/download?${qs}`;
  a.download = "";
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
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

/** 在 dir 下建一个文件夹。名字不合法/重名时服务端会拒，理由原样带回来给用户看。 */
export async function createFolder(
  dir: string,
  name: string
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const res = await fetch("/api/files/mkdir", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir, name }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    path?: string;
    error?: string;
    detail?: string;
  };
  if (!res.ok) {
    // detail 是目录白名单中间件给的那句（「这个目录不在你账号可以打开的范围内」），
    // 它常常是唯一能解释发生了什么的一句话。
    return { ok: false, message: body.detail || body.error || `HTTP ${res.status}` };
  }
  return { ok: true, path: body.path! };
}

/**
 * 把若干文件/文件夹移动到 dest。逐个成败——和删除一样是**部分成功**的语义：
 * 同名冲突、白名单外的路径都只让那一条失败，不会把整批回滚。
 */
export async function moveFiles(
  paths: string[],
  dest: string
): Promise<{ moved: { from: string; to: string }[]; failed: { path: string; error: string }[] }> {
  const res = await fetch("/api/files/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths, dest }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    moved?: { from: string; to: string }[];
    failed?: { path: string; error: string }[];
    error?: string;
    detail?: string;
  };
  if (!res.ok) {
    // 整条请求就被拒了（目标目录不在白名单里等），把它摊成「每个都失败」，
    // 调用方只需要处理一种形状。
    const message = body.detail || body.error || `HTTP ${res.status}`;
    return { moved: [], failed: paths.map((p) => ({ path: p, error: message })) };
  }
  return { moved: body.moved ?? [], failed: body.failed ?? [] };
}

/** 原地改名（文件和文件夹都行）。失败时把服务端那句理由原样带回来。 */
export async function renameEntry(
  path: string,
  name: string
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const res = await fetch("/api/files/rename", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, name }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    path?: string;
    error?: string;
    detail?: string;
  };
  if (!res.ok) {
    return { ok: false, message: body.detail || body.error || `HTTP ${res.status}` };
  }
  return { ok: true, path: body.path! };
}
