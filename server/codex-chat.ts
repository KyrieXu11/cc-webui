import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import {
  Codex,
  type ApprovalMode,
  type ModelReasoningEffort,
  type SandboxMode,
} from "@openai/codex-sdk";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const codexChat = new Hono();

type BufferedMsg = { event: string; data: string };

interface Subscriber {
  write: (event: string, data: string) => void;
  close: () => void;
}

interface InFlightCodexChat {
  reqId: string;
  clientTurnId: string | undefined;
  threadId: string | undefined;
  messages: BufferedMsg[];
  subscribers: Set<Subscriber>;
  status: "running" | "done" | "error";
  errorMsg?: string;
  cancelRequested: boolean;
  abort: AbortController;
}

const activeCodexChats = new Map<string, InFlightCodexChat>();
const activeCodexChatsByClientTurn = new Map<string, InFlightCodexChat>();

function expandHome(p: string | undefined): string | undefined {
  if (!p) return undefined;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function removeEntryIfSelf(entry: InFlightCodexChat): void {
  if (entry.threadId && activeCodexChats.get(entry.threadId) === entry) {
    activeCodexChats.delete(entry.threadId);
  }
  if (
    entry.clientTurnId &&
    activeCodexChatsByClientTurn.get(entry.clientTurnId) === entry
  ) {
    activeCodexChatsByClientTurn.delete(entry.clientTurnId);
  }
}

async function attachStreamToEntry(
  stream: SSEStreamingApi,
  entry: InFlightCodexChat
): Promise<void> {
  const subId = Math.random().toString(36).slice(2, 7);
  const tag = `[codex sub ${entry.reqId}/${subId}]`;
  let writeCount = 0;
  const queue: BufferedMsg[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const doWake = () => {
    if (!wake) return;
    const r = wake;
    wake = null;
    r();
  };

  const snapshot = entry.messages.slice();
  const sub: Subscriber = {
    write: (event, data) => {
      if (closed) return;
      queue.push({ event, data });
      doWake();
    },
    close: () => {
      closed = true;
      doWake();
    },
  };
  entry.subscribers.add(sub);
  console.log(
    `${tag} attached, snapshot=${snapshot.length}, status=${entry.status}`
  );
  stream.onAbort(() => {
    closed = true;
    doWake();
    console.log(`${tag} onAbort, wrote=${writeCount}`);
  });

  try {
    for (const m of snapshot) {
      if (closed) break;
      try {
        await stream.writeSSE(m);
        writeCount++;
      } catch (e) {
        console.log(
          `${tag} replay write threw after ${writeCount}:`,
          (e as any)?.message
        );
        closed = true;
        break;
      }
    }
    while (!closed || queue.length > 0) {
      if (queue.length === 0) {
        if (closed) break;
        await new Promise<void>((r) => {
          wake = r;
        });
        continue;
      }
      const item = queue.shift()!;
      try {
        await stream.writeSSE(item);
        writeCount++;
      } catch (e) {
        console.log(
          `${tag} live write threw after ${writeCount}:`,
          (e as any)?.message
        );
        closed = true;
        break;
      }
    }
  } finally {
    entry.subscribers.delete(sub);
    console.log(`${tag} detached, total wrote=${writeCount}`);
  }
}

function mapPermissionMode(mode: string | undefined): {
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalMode;
} {
  if (mode === "bypassPermissions") {
    return { sandboxMode: "danger-full-access", approvalPolicy: "never" };
  }
  if (mode === "plan") {
    return { sandboxMode: "read-only", approvalPolicy: "never" };
  }
  return { sandboxMode: "workspace-write", approvalPolicy: "never" };
}

function mapEffort(effort: string | undefined): ModelReasoningEffort {
  if (effort === "low" || effort === "medium" || effort === "high") {
    return effort;
  }
  if (effort === "xhigh" || effort === "max") return "xhigh";
  return "medium";
}

function fanoutFactory(entry: InFlightCodexChat) {
  return (event: string, data: string) => {
    const item: BufferedMsg = { event, data };
    entry.messages.push(item);
    for (const sub of entry.subscribers) sub.write(event, data);
  };
}

codexChat.post("/chat", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const prompt: string = body.prompt ?? "";
  const threadId: string | undefined =
    typeof body.sessionId === "string" ? body.sessionId : undefined;
  const clientTurnId: string | undefined =
    typeof body.clientTurnId === "string" && body.clientTurnId
      ? body.clientTurnId
      : undefined;
  const cwd = expandHome(body.cwd || process.env.CC_WEBUI_CWD);
  const model: string | undefined =
    typeof body.model === "string" ? body.model : undefined;
  const effort: string | undefined =
    typeof body.effort === "string" ? body.effort : undefined;
  const permissionMode: string | undefined =
    typeof body.permissionMode === "string" ? body.permissionMode : undefined;

  if (!prompt.trim()) {
    return c.json({ error: "prompt required" }, 400);
  }
  if (Array.isArray(body.images) && body.images.length > 0) {
    return c.json(
      { error: "codex image attachments are not supported yet" },
      400
    );
  }
  if (threadId && activeCodexChats.has(threadId)) {
    const prior = activeCodexChats.get(threadId)!;
    return c.json(
      {
        error: "session_busy",
        message: `Codex thread ${threadId} is still processing prior message (reqId ${prior.reqId})`,
      },
      409
    );
  }
  if (clientTurnId && activeCodexChatsByClientTurn.has(clientTurnId)) {
    const prior = activeCodexChatsByClientTurn.get(clientTurnId)!;
    return c.json(
      {
        error: "turn_busy",
        message: `Codex turn ${clientTurnId} is still processing (reqId ${prior.reqId})`,
      },
      409
    );
  }

  const reqId = randomUUID().slice(0, 8);
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
  console.log(
    `[codex ${reqId}] start resume=${threadId ?? "-"} cwd=${cwd ?? "-"}` +
      ` model=${model ?? "default"} mode=${permissionMode ?? "default"}` +
      ` prompt=${JSON.stringify(prompt.slice(0, 80))}`
  );

  const entry: InFlightCodexChat = {
    reqId,
    clientTurnId,
    threadId,
    messages: [],
    subscribers: new Set(),
    status: "running",
    cancelRequested: false,
    abort: new AbortController(),
  };
  if (threadId) activeCodexChats.set(threadId, entry);
  if (clientTurnId) activeCodexChatsByClientTurn.set(clientTurnId, entry);

  const fanout = fanoutFactory(entry);

  (async () => {
    try {
      const codex = new Codex();
      const { sandboxMode, approvalPolicy } = mapPermissionMode(permissionMode);
      const threadOptions = {
        model,
        workingDirectory: cwd,
        skipGitRepoCheck: true,
        sandboxMode,
        approvalPolicy,
        modelReasoningEffort: mapEffort(effort),
      };
      const thread = threadId
        ? codex.resumeThread(threadId, threadOptions)
        : codex.startThread(threadOptions);
      const { events } = await thread.runStreamed(prompt, {
        signal: entry.abort.signal,
      });

      let eventCount = 0;
      for await (const ev of events) {
        if (entry.cancelRequested) break;
        eventCount++;
        if (eventCount <= 20 || eventCount % 50 === 0) {
          console.log(`[codex ${reqId}] event #${eventCount} ${ev.type} @${elapsed()}`);
        }
        if (ev.type === "thread.started") {
          entry.threadId = ev.thread_id;
          activeCodexChats.set(ev.thread_id, entry);
        }
        fanout("codex_event", JSON.stringify(ev));
      }

      console.log(
        `[codex ${reqId}] ${entry.cancelRequested ? "cancelled" : "done"} events=${eventCount} in ${elapsed()}`
      );
      entry.status = "done";
      fanout("done", "");
    } catch (err) {
      if (entry.cancelRequested) {
        entry.status = "done";
        fanout("done", "");
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[codex ${reqId}] ERROR at ${elapsed()}:`, err);
      entry.status = "error";
      entry.errorMsg = message;
      fanout("error", JSON.stringify({ message }));
    } finally {
      for (const sub of [...entry.subscribers]) sub.close();
      removeEntryIfSelf(entry);
    }
  })().catch((err) =>
    console.error(`[codex ${reqId}] unhandled in detached task:`, err)
  );

  return streamSSE(c, async (stream) => {
    await attachStreamToEntry(stream, entry);
  });
});

codexChat.post("/chat/cancel", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const threadId: string | undefined =
    typeof body.sessionId === "string" ? body.sessionId : undefined;
  const clientTurnId: string | undefined =
    typeof body.clientTurnId === "string" ? body.clientTurnId : undefined;
  const entry =
    (clientTurnId ? activeCodexChatsByClientTurn.get(clientTurnId) : undefined) ??
    (threadId ? activeCodexChats.get(threadId) : undefined);
  if (!entry) return c.json({ ok: false, reason: "not_found" }, 404);
  if (entry.status !== "running") {
    return c.json({ ok: false, reason: `already_${entry.status}` });
  }
  entry.cancelRequested = true;
  entry.abort.abort();
  return c.json({ ok: true });
});

codexChat.get("/chat/inflight", (c) => {
  return c.json({ sessionIds: Array.from(activeCodexChats.keys()) });
});

codexChat.get("/chat/attach", (c) => {
  const threadId = c.req.query("sessionId");
  const clientTurnId = c.req.query("clientTurnId");
  return streamSSE(c, async (stream) => {
    if (!threadId && !clientTurnId) {
      await stream.writeSSE({ event: "no-inflight", data: "" });
      return;
    }
    const entry =
      (threadId ? activeCodexChats.get(threadId) : undefined) ??
      (clientTurnId ? activeCodexChatsByClientTurn.get(clientTurnId) : undefined);
    if (!entry) {
      await stream.writeSSE({ event: "no-inflight", data: "" });
      return;
    }
    await attachStreamToEntry(stream, entry);
  });
});

export { codexChat };
