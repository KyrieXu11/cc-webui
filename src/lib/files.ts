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
