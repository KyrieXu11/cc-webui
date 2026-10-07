import type { AgentProvider, EffortLevel, PermissionMode } from "./settings";
import type { ImageAttachment } from "./types";

export type { ImageAttachment };

export interface StreamChatParams {
  prompt: string;
  sessionId: string | null;
  clientTurnId?: string;
  cwd?: string;
  agentProvider?: AgentProvider;
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  images?: ImageAttachment[];
  signal?: AbortSignal;
}

export async function* streamChat(
  params: StreamChatParams
): AsyncGenerator<any> {
  const base = params.agentProvider === "codex" ? "/api/codex/chat" : "/api/chat";
  const res = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: params.prompt,
      sessionId: params.sessionId,
      clientTurnId: params.clientTurnId || undefined,
      cwd: params.cwd || undefined,
      model: params.model || undefined,
      permissionMode: params.permissionMode || undefined,
      effort: params.effort || undefined,
      images:
        params.images && params.images.length > 0 ? params.images : undefined,
    }),
    signal: params.signal,
  });

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null);
    if (res.status === 409) {
      if (data?.error === "session_busy" || data?.error === "turn_busy") {
        throw new Error(
          `${data.error}: ${data.message ?? "session is still processing"}`
        );
      }
    }
    // 403 / 404 从中间件来，而且带着**唯一**能解释发生了什么的那句话：
    // 「这个目录不在你账号可以打开的范围内」。裸 `HTTP 403` 在共享会话上尤其
    // 难懂 —— 会话读得好好的，一发消息就死，而原因是它的 cwd 落在你的白名单
    // 之外（server/auth/middleware.ts 的 checkPaths）。
    const detail = data?.detail || data?.error;
    throw new Error(detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (event === "done") return;
      if (event === "error") {
        try {
          const err = JSON.parse(data);
          throw new Error(err.message || "stream error");
        } catch (e) {
          if (e instanceof Error && e.message !== "stream error") throw e;
          throw new Error("stream error");
        }
      }
      if (!data) continue;
      try {
        const parsed = JSON.parse(data);
        if (event === "memory_updated") {
          if (typeof window !== "undefined") window.dispatchEvent(new Event("cc-webui:memory-updated"));
          continue;
        }
        yield parsed;
      } catch {
        /* skip malformed */
      }
    }
  }
}

// Subscribe to an in-flight chat turn on the server. Used on mount / after
// session switch to pick up a turn that's still generating (because the user
// refreshed mid-stream, or started it in another tab). Server replays the
// turn's buffered SDK messages, then streams live until done.
//
// onMsg is called with the parsed SDK message — same shape the stream from
// POST /chat emits. Client should feed each msg into applySDKMessage.
// Returns an unsubscribe fn that closes the EventSource.
export function connectAttach(
  params: {
    sessionId?: string | null;
    clientTurnId?: string | null;
    agentProvider?: AgentProvider;
  },
  onMsg: (m: any) => void,
  onDone?: (reason: "done" | "error" | "no-inflight") => void
): () => void {
  const qs = new URLSearchParams();
  if (params.sessionId) qs.set("sessionId", params.sessionId);
  if (params.clientTurnId) qs.set("clientTurnId", params.clientTurnId);
  const base = params.agentProvider === "codex" ? "/api/codex/chat" : "/api/chat";
  const es = new EventSource(`${base}/attach?${qs}`);
  const forward = (e: Event) => {
    const data = (e as MessageEvent).data;
    if (!data) return;
    try {
      onMsg(JSON.parse(data));
    } catch {
      /* skip malformed */
    }
  };
  // All SDK msg types go over the "message" event by default when the server
  // writes the `event:` field — but addEventListener is needed per-type for
  // custom event names. Cover everything the server can emit.
  for (const t of [
    "system",
    "assistant",
    "user",
    "stream_event",
    "permission_request",
    "permission_resolved",
    "codex_event",
    "foreground_started",
    "foreground_ended",
    "wakeup_pending",
    "wakeup_turn_started",
    // 慢工具的心跳（每 30 秒一帧）。⚠️ 这张列表是白名单——不加进来，
    // 事件在 EventSource 层就被丢了，前端连看都看不到。
    "tool_progress",
    // 这一轮实际用的 effort（server/chat.ts 在 buffer 第一条发）。看别人正在跑的
    // 一轮时，状态行只能靠它，不能读自己的设置。
    "turn_meta",
    "turn_user",
  ]) {
    es.addEventListener(t, forward);
  }
  es.addEventListener("memory_updated", () => window.dispatchEvent(new Event("cc-webui:memory-updated")));
  es.addEventListener("done", () => {
    onDone?.("done");
    es.close();
  });
  es.addEventListener("error", () => {
    onDone?.("error");
    es.close();
  });
  es.addEventListener("no-inflight", () => {
    onDone?.("no-inflight");
    es.close();
  });
  return () => es.close();
}

// Poll the server for the set of sessionIds currently generating. Used by
// the sidebar to render an "in-flight" indicator next to each session.
export async function getInflightSessions(
  agentProvider: AgentProvider = "claude"
): Promise<Set<string>> {
  const base = agentProvider === "codex" ? "/api/codex/chat" : "/api/chat";
  const res = await fetch(`${base}/inflight`);
  if (!res.ok) return new Set();
  const data = (await res.json().catch(() => null)) as
    | { sessionIds?: string[] }
    | null;
  return new Set(data?.sessionIds ?? []);
}

// Request the server to stop an in-flight turn. Lookup prefers clientTurnId,
// falls back to sessionId. Fire-and-forget from the client's perspective —
// the stream's "done" event arrives via the existing SSE channel.
/**
 * 中途插话：把一条消息塞进**正在跑的**那一轮（服务端往 claude CLI 那根已经开着的
 * stdin 多写一行）。
 *
 * ⚠️ **`unavailable` 不是错误。** 服务端三种「插不进去」（这一轮刚结束 / CLI 还没起
 * 来 / 不走 stdin 协议）合流成同一个 409，对用户是同一件事——「现在插不进去，那条
 * 留在排队里等这一轮结束」。抛异常会让界面把它报成故障。
 *
 * ⚠️ Codex 没有这条路：`codex exec` 的 stdin 不是控制协议。调用方自己按 provider 拦。
 */
export async function steerChat(params: {
  sessionId?: string | null;
  clientTurnId?: string | null;
  text: string;
}): Promise<{ ok: boolean; unavailable?: boolean; message?: string }> {
  const res = await fetch("/api/chat/steer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: params.sessionId || undefined,
      clientTurnId: params.clientTurnId || undefined,
      text: params.text,
    }),
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, unavailable: true, message: body?.message };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.detail || body?.error || `steer failed: ${res.status}`);
  }
  return { ok: true };
}

export async function cancelChat(params: {
  sessionId?: string | null;
  clientTurnId?: string | null;
  agentProvider?: AgentProvider;
}): Promise<{ ok: boolean; reason?: string }> {
  const base = params.agentProvider === "codex" ? "/api/codex/chat" : "/api/chat";
  const res = await fetch(`${base}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: params.sessionId || undefined,
      clientTurnId: params.clientTurnId || undefined,
    }),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`cancel failed: ${res.status}`);
  }
  return res.json().catch(() => ({ ok: false }));
}
