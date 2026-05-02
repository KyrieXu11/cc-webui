import type {
  GroupConfig,
  GroupIndexRow,
  GroupParticipant,
  GroupSseEvent,
  GroupTurnEntry,
  ImageAttachment,
} from "./types";

export async function listGroups(): Promise<GroupIndexRow[]> {
  const r = await fetch("/api/groups");
  if (!r.ok) return [];
  const j = await r.json();
  return Array.isArray(j.groups) ? j.groups : [];
}

export async function createGroup(input: {
  title: string;
  cwd: string;
  participants?: GroupParticipant[];
  pipeline?: ("claude" | "codex")[];
}): Promise<{ id: string }> {
  const r = await fetch("/api/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`createGroup failed (${r.status}): ${t}`);
  }
  return r.json();
}

export async function fetchGroup(
  gid: string,
): Promise<{
  config: GroupConfig;
  messages: GroupTurnEntry[];
  inFlight: boolean;
}> {
  const r = await fetch(`/api/groups/${gid}`);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`fetchGroup failed (${r.status}): ${t}`);
  }
  return r.json();
}

export async function updateGroupConfig(
  gid: string,
  patch: Partial<GroupConfig>,
): Promise<void> {
  const r = await fetch(`/api/groups/${gid}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`updateGroupConfig failed (${r.status}): ${t}`);
  }
}

export async function deleteGroup(gid: string): Promise<void> {
  const r = await fetch(`/api/groups/${gid}`, { method: "DELETE" });
  if (!r.ok && r.status !== 404) {
    const t = await r.text();
    throw new Error(`deleteGroup failed (${r.status}): ${t}`);
  }
}

export async function stopGroupTurn(gid: string): Promise<void> {
  await fetch(`/api/groups/${gid}/stop`, { method: "POST" });
}

// Stream a new turn via POST /turn. Yields parsed SSE events as they arrive.
export type GroupTurnRequest = {
  text: string;
  recipients: ("claude" | "codex" | "all")[];
  images?: ImageAttachment[];
  quote?: { agent: "claude" | "codex"; text: string };
};

export async function* streamGroupTurn(
  gid: string,
  body: GroupTurnRequest,
  signal?: AbortSignal,
): AsyncGenerator<GroupSseEvent> {
  const r = await fetch(`/api/groups/${gid}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok || !r.body) {
    const t = await r.text();
    throw new Error(`streamGroupTurn failed (${r.status}): ${t}`);
  }
  yield* parseSse(r.body, signal);
}

// Attach to an existing in-flight turn (refresh recovery / multi-tab).
export async function* attachGroupStream(
  gid: string,
  signal?: AbortSignal,
): AsyncGenerator<GroupSseEvent> {
  const r = await fetch(`/api/groups/${gid}/stream`, { signal });
  if (!r.ok || !r.body) return;
  yield* parseSse(r.body, signal);
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<GroupSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    if (signal?.aborted) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      return;
    }
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      return;
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    const blocks = buf.split("\n\n");
    buf = blocks.pop() ?? "";
    for (const block of blocks) {
      let event = "message";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (event === "ka") continue;
      const data = dataLines.join("\n");
      if (!data) continue;
      try {
        const parsed = JSON.parse(data);
        yield parsed as GroupSseEvent;
      } catch {
        /* ignore malformed */
      }
    }
  }
}
