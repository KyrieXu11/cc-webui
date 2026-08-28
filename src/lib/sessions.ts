import type { AgentProvider } from "./settings";

export type SessionSummary = {
  sessionId: string;
  provider: AgentProvider;
  summary: string;
  lastModified: number;
  cwd?: string;
  firstPrompt?: string;
  customTitle?: string;
};

export type SessionMessage = {
  type: "user" | "assistant" | "system";
  uuid: string;
  session_id: string;
  message: unknown;
  timestamp?: string;
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

export async function deleteSession(
  id: string,
  cwd?: string,
  provider: AgentProvider = "claude"
): Promise<void> {
  const qs = new URLSearchParams();
  if (cwd) qs.set("cwd", cwd);
  qs.set("provider", provider);
  await fetch(`/api/sessions/${id}?${qs.toString()}`, {
    method: "DELETE",
  });
}
