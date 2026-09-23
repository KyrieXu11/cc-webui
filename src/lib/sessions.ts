import type { AgentProvider } from "./settings";

export type SessionSummary = {
  sessionId: string;
  provider: AgentProvider;
  summary: string;
  lastModified: number;
  cwd?: string;
  firstPrompt?: string;
  customTitle?: string;
  /** 我是不是 owner。**管理员看别人的会话时也是 false** —— 想知道能不能管，
   *  用 `mine || isAdmin`。服务端故意不把两者揉在一起（见 server/sessions.ts）。 */
  mine?: boolean;
  /** owner 的用户名，无主则 null。 */
  ownerName?: string | null;
  /** 有值 = 这条会话是**被共享**给我才看得见的，值是共享者的用户名。 */
  sharedBy?: string;
  /** 这条会话被共享给了几个人（0 = 没共享出去）。 */
  sharedCount?: number;
};

export type ShareRow = {
  userId: string;
  username: string;
  sharedBy: string;
  createdAt: number;
};

export type DirectoryUser = {
  id: string;
  username: string;
  role: "admin" | "user";
};

export type SessionMessage = {
  type: "user" | "assistant" | "system";
  uuid: string;
  session_id: string;
  message: unknown;
  timestamp?: string;
  /** 这一行的 content block 在 API 消息里的真实下标，见 processor 的 `blockBase`。 */
  api_block_index?: number;
};

export type CodexSessionTurn = {
  provider: "codex";
  prompt: string;
  startedAt: number;
  events: unknown[];
};

export type SessionHistoryItem = SessionMessage | CodexSessionTurn;

/**
 * 搜索用的全量窗口。首页「最近项目」只列最近 60 个，但搜索得能翻到底 —— 落在窗口
 * 外面的会话搜不到，比没有搜索更糟（用户以为不存在）。
 *
 * 实测（786 个 claude 会话，625 个项目目录，暖缓存）：
 *   limit=60 → 147ms · 200 → 212ms · 500 → 471ms · 1000 → 786 个全拿到，677ms
 * 每条大约 0.86ms（`listClaudeSessions` 要读每个 jsonl 的头 + 尾 256KB 找 ai-title）。
 * 所以纯前端过滤够用，不必为搜索另写一个服务端接口。**它是天花板**：真超过 1000 个
 * 会话时最老的那批搜不到，那时候再考虑服务端。
 */
export const SEARCH_WINDOW = 1000;

export async function listSessions(
  limit = 30,
  cwd?: string,
  provider: AgentProvider | "all" = "all"
): Promise<SessionSummary[]> {
  const qs = new URLSearchParams();
  qs.set("limit", String(limit));
  if (cwd) qs.set("cwd", cwd);
  qs.set("provider", provider);
  const res = await fetch(`/api/sessions?${qs.toString()}`);
  if (!res.ok) return [];
  const { sessions } = await res.json();
  return sessions ?? [];
}

export async function getSessionMessages(
  id: string,
  cwd?: string,
  limit = 5000,
  provider: AgentProvider = "claude"
): Promise<SessionHistoryItem[]> {
  const qs = new URLSearchParams();
  if (cwd) qs.set("cwd", cwd);
  qs.set("limit", String(limit));
  qs.set("provider", provider);
  const res = await fetch(`/api/sessions/${id}/messages?${qs.toString()}`);
  if (!res.ok) return [];
  const { messages } = await res.json();
  return messages ?? [];
}

/**
 * 删一条会话（真删磁盘上那个 jsonl，没有回收站）。
 *
 * ⚠️ **必须看 res.ok。** 原来这里是光秃秃一个 `await fetch(...)`，调用方跟着无条件把
 * 那一行从列表里抹掉 —— 服务端 404 / 403 也一样「删成功」，直到下次刷新它又回来。
 * 用户 2026-09-20 报的就是这个（「我早上删除了，但是为什么还在呢？」）。
 */
export async function deleteSession(
  id: string,
  cwd?: string,
  provider: AgentProvider = "claude"
): Promise<void> {
  const qs = new URLSearchParams();
  if (cwd) qs.set("cwd", cwd);
  qs.set("provider", provider);
  const res = await fetch(`/api/sessions/${id}?${qs.toString()}`, {
    method: "DELETE",
  });
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as {
    reason?: string;
    detail?: string;
    error?: string;
  };
  if (res.status === 404) {
    throw new Error(
      body.reason === "not_found"
        ? "这条会话的记录文件已经不在了（列表可能是旧的，刷新一下）"
        : "没有权限删这条会话（共享给你的会话只能读，删不掉）"
    );
  }
  throw new Error(body.detail || body.error || `删除失败：HTTP ${res.status}`);
}

// ─── 共享 ────────────────────────────────────────────────────────────────────
//
// ⚠️ 这三条路由在服务端都是 **owner 级** 的（server/auth/policy.ts）：被共享者
// 调用会拿到 404。UI 层照着 `mine || isAdmin` 隐藏入口，但真正拦住的是那边。

export async function listUserDirectory(): Promise<DirectoryUser[]> {
  const res = await fetch("/api/auth/directory");
  if (!res.ok) return [];
  return (await res.json()).users ?? [];
}

export type ShareState = {
  /** false = 我不是这个会话的归属人（服务端回了 404）。UI 据此解释而不是装死。 */
  allowed: boolean;
  shares: ShareRow[];
  owner: { id: string; username: string } | null;
};

export async function getShares(id: string): Promise<ShareState> {
  const res = await fetch(`/api/sessions/${id}/shares`);
  if (!res.ok) return { allowed: false, shares: [], owner: null };
  const data = await res.json();
  return { allowed: true, shares: data.shares ?? [], owner: data.owner ?? null };
}

/** 整份名单替换。传空数组 = 取消全部共享。 */
export async function setShares(
  id: string,
  userIds: string[],
  provider: AgentProvider = "claude",
): Promise<ShareRow[]> {
  const res = await fetch(`/api/sessions/${id}/shares?provider=${provider}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userIds }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "共享失败");
  return (await res.json()).shares ?? [];
}

export async function transferSession(
  id: string,
  userId: string,
  provider: AgentProvider = "claude",
): Promise<void> {
  const res = await fetch(`/api/sessions/${id}/transfer?provider=${provider}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "转交失败");
}
