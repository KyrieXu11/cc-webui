import type { EffortLevel, PermissionMode } from "./settings";
import type { ImageAttachment } from "./types";

export type { ImageAttachment };

export interface StreamChatParams {
  prompt: string;
  sessionId: string | null;
  clientTurnId?: string;
  cwd?: string;
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  images?: ImageAttachment[];
  signal?: AbortSignal;
}

export async function* streamChat(
  params: StreamChatParams
): AsyncGenerator<any> {
  const res = await fetch("/api/chat", {
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
    if (res.status === 409) {
      const data = await res.json().catch(() => null);
      if (data?.error === "session_busy" || data?.error === "turn_busy") {
        throw new Error(
          `${data.error}: ${data.message ?? "session is still processing"}`
        );
      }
    }
    throw new Error(`HTTP ${res.status}`);
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
  params: { sessionId?: string | null; clientTurnId?: string | null },
  onMsg: (m: any) => void,
  onDone?: (reason: "done" | "error" | "no-inflight") => void
): () => void {
  const qs = new URLSearchParams();
  if (params.sessionId) qs.set("sessionId", params.sessionId);
  if (params.clientTurnId) qs.set("clientTurnId", params.clientTurnId);
  const es = new EventSource(`/api/chat/attach?${qs}`);
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
    "foreground_started",
    "foreground_ended",
    "wakeup_pending",
    "wakeup_turn_started",
  ]) {
    es.addEventListener(t, forward);
  }
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
export async function getInflightSessions(): Promise<Set<string>> {
  const res = await fetch("/api/chat/inflight");
  if (!res.ok) return new Set();
  const data = (await res.json().catch(() => null)) as
    | { sessionIds?: string[] }
    | null;
  return new Set(data?.sessionIds ?? []);
}

// Request the server to stop an in-flight turn. Lookup prefers clientTurnId,
// falls back to sessionId. Fire-and-forget from the client's perspective —
// the stream's "done" event arrives via the existing SSE channel.
export async function cancelChat(params: {
  sessionId?: string | null;
  clientTurnId?: string | null;
}): Promise<{ ok: boolean; reason?: string }> {
  const res = await fetch("/api/chat/cancel", {
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
