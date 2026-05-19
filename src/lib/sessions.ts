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
