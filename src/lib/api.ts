import type { EffortLevel, PermissionMode } from "./settings";

export type ImageAttachment = {
  name?: string;
  mediaType: string;
  data: string;
};

export interface StreamChatParams {
  prompt: string;
  sessionId: string | null;
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
