export type SessionSummary = {
  sessionId: string;
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
};

export async function listSessions(
  limit = 30,
  cwd?: string
): Promise<SessionSummary[]> {
  const qs = new URLSearchParams();
  qs.set("limit", String(limit));
  if (cwd) qs.set("cwd", cwd);
  const res = await fetch(`/api/sessions?${qs.toString()}`);
  if (!res.ok) return [];
  const { sessions } = await res.json();
  return sessions ?? [];
}

export async function getSessionMessages(
  id: string,
  cwd?: string,
  limit = 5000
): Promise<SessionMessage[]> {
  const qs = new URLSearchParams();
  if (cwd) qs.set("cwd", cwd);
  qs.set("limit", String(limit));
  const res = await fetch(`/api/sessions/${id}/messages?${qs.toString()}`);
  if (!res.ok) return [];
  const { messages } = await res.json();
  return messages ?? [];
}

export async function deleteSession(id: string, cwd?: string): Promise<void> {
  const qs = new URLSearchParams();
  if (cwd) qs.set("cwd", cwd);
  await fetch(`/api/sessions/${id}?${qs.toString()}`, {
    method: "DELETE",
  });
}
